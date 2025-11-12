// index.js — EuropePUSH backend (full, stable)
// Last updated: 2025-11-12

import express from "express";
import cors from "cors";
import crypto from "crypto";
import fs from "fs/promises";
import fss from "fs";
import path from "path";
import os from "os";
import { createClient } from "@supabase/supabase-js";
import ffmpegBin from "ffmpeg-static";
import { execa } from "execa";

// Node 18+ har global fetch
const fetchFn = (...args) => globalThis.fetch(...args);

// ----------------- ENV -----------------
const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.API_KEY || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://api.europepush.com";
const VIDEO_JITTER = (process.env.VIDEO_JITTER || "").toLowerCase() === "true";

// TikTok OAuth (Sandbox el. Production – det der står i env er det der bruges)
const TT_CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY || "";
const TT_CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET || "";
const TT_REDIRECT_URL =
  process.env.TIKTOK_REDIRECT_URL || `${PUBLIC_BASE_URL}/auth/tiktok/callback`;

// ----------------- APP -----------------
const app = express();
app.use(cors());
app.use(express.json());

// Root for sanity
app.get("/", (_req, res) => res.type("text/plain").send("EuropePUSH backend online"));

// Health
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ----------------- Supabase -----------------
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ----------------- TikTok DEBUG -----------------
app.get("/auth/tiktok/debug", (_req, res) => {
  res.json({
    client_key_present: !!TT_CLIENT_KEY,
    client_key_len: TT_CLIENT_KEY.length || 0,
    client_key_preview: TT_CLIENT_KEY ? `${TT_CLIENT_KEY.slice(0, 4)}…${TT_CLIENT_KEY.slice(-4)}` : null,
    client_secret_present: !!TT_CLIENT_SECRET,
    client_secret_len: TT_CLIENT_SECRET.length || 0,
    client_secret_preview: TT_CLIENT_SECRET ? `${TT_CLIENT_SECRET.slice(0, 3)}…${TT_CLIENT_SECRET.slice(-3)}` : null,
    redirect_uri: TT_REDIRECT_URL,
    public_base_url: PUBLIC_BASE_URL
  });
});

// ----------------- TikTok AUTH URL (JSON) -----------------
app.get("/auth/tiktok/url", (_req, res) => {
  if (!TT_CLIENT_KEY || !TT_REDIRECT_URL) {
    return res.status(500).json({ error: "missing_config" });
  }
  const scope = encodeURIComponent("user.info.basic,video.upload,video.publish");
  const redirect_uri = encodeURIComponent(TT_REDIRECT_URL);
  const state = "state_epush_123";
  const authorize_url =
    `https://www.tiktok.com/v2/auth/authorize/?client_key=${TT_CLIENT_KEY}` +
    `&scope=${scope}&response_type=code&redirect_uri=${redirect_uri}&state=${state}`;
  res.json({ authorize_url });
});

// ----------------- TikTok AUTH START (redirect) -----------------
app.get("/auth/tiktok/start", (_req, res) => {
  if (!TT_CLIENT_KEY || !TT_REDIRECT_URL) {
    return res.status(500).type("text/plain").send("Missing TikTok env config");
  }
  const scope = encodeURIComponent("user.info.basic,video.upload,video.publish");
  const redirect_uri = encodeURIComponent(TT_REDIRECT_URL);
  const state = "state_epush_123";
  const url =
    `https://www.tiktok.com/v2/auth/authorize/?client_key=${TT_CLIENT_KEY}` +
    `&scope=${scope}&response_type=code&redirect_uri=${redirect_uri}&state=${state}`;
  res.redirect(302, url);
});

// ----------------- TikTok AUTH CALLBACK -----------------
app.get("/auth/tiktok/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query;
  if (error) return res.status(400).send(`TikTok error: ${error} — ${error_description || ""}`);
  if (!code) return res.status(400).send("Missing code");

  try {
    const tokenResp = await fetchFn("https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: new URLSearchParams({
        client_key: TT_CLIENT_KEY,
        client_secret: TT_CLIENT_SECRET,
        code: String(code),
        grant_type: "authorization_code",
        redirect_uri: TT_REDIRECT_URL
      })
    });
    const tokens = await tokenResp.json();

    let me = null;
    if (tokens.access_token) {
      const meResp = await fetchFn("https://open.tiktokapis.com/v2/user/info/", {
        method: "GET",
        headers: { Authorization: `Bearer ${tokens.access_token}` }
      });
      me = await meResp.json();
    }

    res.type("html").send(`
      <h2>TikTok Login OK ✅</h2>
      <p>state: ${state || "-"}</p>
      <pre>${escapeHtml(JSON.stringify({ tokens }, null, 2))}</pre>
      <pre>${escapeHtml(JSON.stringify({ me }, null, 2))}</pre>
      <p><b>Note:</b> Gem tokens i DB i stedet for at vise dem i produktion.</p>
    `);
  } catch (e) {
    res.status(500).send(`Callback error: ${e.message || e}`);
  }
});

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// ----------------- Jobs (render + upload) -----------------
app.post("/jobs", async (req, res) => {
  const key = req.headers["x-api-key"];
  if (API_KEY && key !== API_KEY) return res.status(401).json({ error: "unauthorized" });

  const { source_video_url } = req.body || {};
  if (!source_video_url) return res.status(400).json({ error: "missing source_video_url" });

  const jobId = `job_${crypto.randomBytes(4).toString("hex")}`;
  console.log("RESPOND job:", jobId);
  res.json({ job_id: jobId, status: "processing" });

  try {
    const tmpIn = path.join(os.tmpdir(), `in_${jobId}.mp4`);
    const tmpOut = path.join(os.tmpdir(), `out_${jobId}.mp4`);

    const inResp = await fetchFn(source_video_url);
    const inBuf = Buffer.from(await inResp.arrayBuffer());
    await fs.writeFile(tmpIn, inBuf);
    console.log("Downloaded to file bytes:", inBuf.length);

    const vf = [
      "scale=w=1080:h=1920:force_original_aspect_ratio=decrease:flags=fast_bilinear",
      "pad=1080:1920:(1080-iw)/2:(1920-ih)/2"
    ].join(",");

    const ffArgs = [
      "-y", "-hide_banner", "-nostdin",
      "-threads", "1",
      "-filter_threads", "1",
      "-filter_complex_threads", "1",
      "-i", tmpIn,
      "-vf", vf,
      "-r", "30",
      "-map", "0:v:0", "-map", "0:a:0",
      "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p",
      "-preset", "ultrafast", "-crf", "21",
      "-c:a", "copy",
      "-movflags", "+faststart",
      tmpOut
    ];

    console.log("FFmpeg args:", ffArgs.join(" "));
    await execa(ffmpegBin, ffArgs, { stdout: "inherit", stderr: "inherit" });

    const outBuf = await fs.readFile(tmpOut);
    console.log("UPLOAD buffer bytes:", outBuf.length);

    const { data, error } = await supabase
      .storage.from("outputs")
      .upload(`jobs/${jobId}/clip_${Date.now()}.mp4`, outBuf, {
        contentType: "video/mp4",
        upsert: true
      });

    if (error) throw error;

    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${data.fullPath}`;
    console.log("UPLOAD_OK job:", jobId, "url:", publicUrl);
  } catch (err) {
    console.error("Job error:", err);
  }
});

// ----------------- Route inspector -----------------
app.get("/routes", (_req, res) => {
  const list = [];
  app._router.stack.forEach((m) => {
    if (m.route && m.route.path) {
      const methods = Object.keys(m.route.methods).join(",").toUpperCase();
      list.push({ methods, path: m.route.path });
    } else if (m.name === "router" && m.handle && m.handle.stack) {
      m.handle.stack.forEach((h) => {
        if (h.route && h.route.path) {
          const methods = Object.keys(h.route.methods).join(",").toUpperCase();
          list.push({ methods, path: h.route.path });
        }
      });
    }
  });
  res.json({ routes: list });
});

// ----------------- START -----------------
app.listen(PORT, () => {
  console.log(`✅ Server on ${PORT}`);
  console.log("🔧 PUBLIC_BASE_URL:", PUBLIC_BASE_URL);
  console.log("🔧 TIKTOK_REDIRECT_URL:", TT_REDIRECT_URL);

  // Print routes to logs
  const list = [];
  app._router.stack.forEach((m) => {
    if (m.route && m.route.path) {
      const methods = Object.keys(m.route.methods).join(",").toUpperCase();
      list.push(`${methods} ${m.route.path}`);
    } else if (m.name === "router" && m.handle && m.handle.stack) {
      m.handle.stack.forEach((h) => {
        if (h.route && h.route.path) {
          const methods = Object.keys(h.route.methods).join(",").toUpperCase();
          list.push(`${methods} ${h.route.path}`);
        }
      });
    }
  });
  console.log("🛣️ Registered routes:\n" + list.map((r) => "  - " + r).join("\n"));
});
