// index.js (ESM)
import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";
import fs from "fs/promises";
import fss from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import ffmpegBin from "ffmpeg-static";
import { execa } from "execa";

// ---------- Config ----------
const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.API_KEY || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const VIDEO_JITTER = (process.env.VIDEO_JITTER || "").toLowerCase() === "true";

const TT_CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY || "";
const TT_CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET || "";
const TT_REDIRECT = process.env.TIKTOK_REDIRECT_URL || "";
const TIKTOK_SCOPES = ""; // hold den tom til ansøgning, kan udvides senere

// ---------- Init ----------
const app = express();
app.use(cors());
app.use(express.json({ limit: "4mb" }));

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.warn("⚠️ SUPABASE_URL / SUPABASE_SERVICE_KEY mangler.");
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ---------- Utils ----------
const tmpFile = (prefix, ext = ".mp4") =>
  path.join(os.tmpdir(), `${prefix}_${crypto.randomBytes(6).toString("hex")}${ext}`);

async function downloadToFile(url) {
  const inPath = tmpFile("in_job");
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Download failed: ${resp.status} ${await resp.text()}`);
  }
  const ab = await resp.arrayBuffer();
  const buf = Buffer.from(ab);
  await fs.writeFile(inPath, buf);
  console.log("Downloaded to file bytes:", buf.length);
  return inPath;
}

function jitterVal(base) {
  if (!VIDEO_JITTER) return base;
  // ±0.6% variation
  const f = 1 + (Math.random() * 1.2 - 0.6) / 100;
  return Math.max(0.5, base * f);
}

async function ffmpegTransform(inPath, outPath) {
  // Low-mem safe: én tråd + simple filtre, behold audio uændret
  const vf = [
    "scale=w=1080:h=1920:force_original_aspect_ratio=decrease:flags=lanczos+accurate_rnd+full_chroma_int",
    "pad=1080:1920:(1080-iw*min(1080/iw\\,1920/ih))/2:(1920-ih*min(1080/iw\\,1920/ih))/2",
    "crop=1080-4:1920-4:2:2",
    "pad=1080:1920:(1080-iw)/2:(1920-ih)/2",
    // en meget svag farve-jitter for at undgå perfekt bit-match
    "hue=h=0.4*PI/180:s=1"
  ].join(",");

  const x264 = [
    "ref=3",
    "bframes=3",
    `rc-lookahead=${Math.round(jitterVal(12))}`,
    `keyint=${Math.round(jitterVal(150))}`,
    `min-keyint=${Math.round(jitterVal(30))}`,
    "scenecut=0"
  ].join(":");

  const args = [
    "-y",
    "-hide_banner",
    "-nostdin",
    "-threads", "1",
    "-filter_threads", "1",
    "-filter_complex_threads", "1",
    "-i", inPath,
    "-vf", vf,
    "-map", "0:v:0",
    "-map", "0:a:0",
    "-c:v", "libx264",
    "-profile:v", "high",
    "-pix_fmt", "yuv420p",
    "-preset", "fast",
    "-crf", `${Math.round(jitterVal(20))}`,
    "-tune", "fastdecode",
    "-x264-params", x264,
    "-maxrate", "3500k",
    "-bufsize", "7000k",
    "-max_muxing_queue_size", "512",
    "-c:a", "copy",
    "-movflags", "+faststart",
    outPath
  ];

  console.log("FFmpeg args (low-mem aware):", args.join(" "));
  try {
    const { stdout, stderr } = await execa(ffmpegBin, args, { timeout: 5 * 60_000 });
    // valgfrit: console.log(stdout);
    // valgfrit: console.log(stderr);
  } catch (err) {
    console.error("FFmpeg failed — using original file:", err?.message || err);
    // Hvis ffmpeg crasher, lad os falde tilbage til inputfil (kopiér)
    await fs.copyFile(inPath, outPath);
  }
}

async function uploadFileBufferToStorage(jobId, filePath, filename) {
  const key = `jobs/${jobId}/${filename}`;
  const buf = await fs.readFile(filePath);
  console.log("UPLOAD buffer bytes:", buf.length);
  const { error: upErr } = await supabase
    .storage
    .from("outputs")
    .upload(key, buf, { contentType: "video/mp4", upsert: true });
  if (upErr) throw upErr;
  const { data } = supabase.storage.from("outputs").getPublicUrl(key);
  return data.publicUrl;
}

async function notifyWebhook(url, payload) {
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.warn("webhook notify failed:", e?.message || e);
  }
}

// ---------- Health ----------
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    env: {
      SUPABASE_URL: !!SUPABASE_URL,
      SUPABASE_SERVICE_KEY: !!SUPABASE_SERVICE_KEY,
      API_KEY: !!API_KEY
    }
  });
});

// ---------- API-key middleware (kun på POST /jobs) ----------
app.use((req, res, next) => {
  if (req.method === "POST" && req.path === "/jobs") {
    const key = req.headers["x-api-key"];
    if (!key || key !== API_KEY) {
      return res.status(401).json({ error: "unauthorized" });
    }
  }
  next();
});

// ---------- Opret job ----------
app.post("/jobs", async (req, res) => {
  const {
    source_video_url,
    preset_id = "Meme Cut",
    variations = 1,
    target_platforms = ["tiktok"],
    accounts = {},
    webhook_status_url = null
  } = req.body || {};

  if (!source_video_url || typeof source_video_url !== "string") {
    return res.status(400).json({ error: "source_video_url required" });
  }

  const job_id = `job_${crypto.randomBytes(4).toString("hex")}`;

  try {
    // 1) Insert job starter
    await supabase.from("jobs").insert({
      job_id,
      state: "queued",
      progress: 0,
      input: req.body
    });

    // 2) Download
    await supabase.from("job_events").insert({
      job_id, state: "downloading", progress: 5, payload: { url: source_video_url }
    });
    const inPath = await downloadToFile(source_video_url);

    // 3) FFmpeg (low-mem safe)
    await supabase.from("job_events").insert({
      job_id, state: "processing", progress: 30, payload: { preset_id }
    });
    const outName = `clip_${Date.now()}.mp4`;
    const outPath = tmpFile("out_job");
    await ffmpegTransform(inPath, outPath);

    // 4) Upload til Supabase Storage
    await supabase.from("job_events").insert({
      job_id, state: "uploading", progress: 80
    });
    const publicUrl = await uploadFileBufferToStorage(job_id, outPath, outName);

    // 5) Gem output
    await supabase.from("job_outputs").insert({
      job_id, idx: 0, url: publicUrl, caption: null, hashtags: null
    });

    // 6) Done
    await supabase.from("jobs").update({ state: "completed", progress: 100 }).eq("job_id", job_id);
    await supabase.from("job_events").insert({ job_id, state: "completed", progress: 100 });

    // Webhook (valgfrit)
    await notifyWebhook(webhook_status_url, { job_id, state: "completed", url: publicUrl });

    // Ryd tmp
    try { await fs.unlink(inPath); } catch {}
    try { await fs.unlink(outPath); } catch {}

    return res.json({ job_id, state: "queued", progress: 0 });
  } catch (e) {
    console.error("job error:", e);
    await supabase.from("jobs").update({ state: "failed", progress: 100 }).eq("job_id", job_id);
    await supabase.from("job_events").insert({
      job_id, state: "failed", progress: 100, payload: { message: e?.message || String(e) }
    });
    await notifyWebhook(req.body?.webhook_status_url, { job_id, state: "failed" });
    return res.status(500).json({ error: "job failed", job_id });
  }
});

// ---------- GET job ----------
app.get("/jobs/:id", async (req, res) => {
  const job_id = req.params.id;
  const { data: jobs, error: jerr } = await supabase.from("jobs").select("*").eq("job_id", job_id).maybeSingle();
  if (jerr || !jobs) return res.status(404).json({ error: "not found" });
  const { data: events } = await supabase.from("job_events").select("*").eq("job_id", job_id).order("id", { ascending: true });
  const { data: outputs } = await supabase.from("job_outputs").select("*").eq("job_id", job_id).order("idx", { ascending: true });
  res.json({ job: jobs, events, outputs });
});

// ============================================================
// =============== TikTok OAuth (Login + Callback) ============
// ============================================================
const TT_AUTH_URL = "https://www.tiktok.com/v2/auth/authorize/";
const TT_TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const TT_USERINFO_URL = "https://open.tiktokapis.com/v2/user/info/";

function formBody(obj) {
  return Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
}

// Start login
app.get("/auth/tiktok/login", (req, res) => {
  try {
    if (!TT_CLIENT_KEY || !TT_CLIENT_SECRET || !TT_REDIRECT) {
      return res.status(500).send("TikTok OAuth env mangler.");
    }
    const state = crypto.randomBytes(12).toString("hex");
    const url = new URL(TT_AUTH_URL);
    url.searchParams.set("client_key", TT_CLIENT_KEY);
    url.searchParams.set("redirect_uri", TT_REDIRECT);
    url.searchParams.set("response_type", "code");
    if (TIKTOK_SCOPES) url.searchParams.set("scope", TIKTOK_SCOPES);
    url.searchParams.set("state", state);
    return res.redirect(url.toString());
  } catch (e) {
    console.error("TT login redirect error:", e);
    return res.status(500).send("Login init failed");
  }
});

// Callback
app.get("/auth/tiktok/callback", async (req, res) => {
  try {
    const { code, error, error_description } = req.query;
    if (error) return res.status(400).send(`TikTok error: ${error} ${error_description || ""}`);
    if (!code) return res.status(400).send("Missing code");

    const tokenResp = await fetch(TT_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({
        client_key: TT_CLIENT_KEY,
        client_secret: TT_CLIENT_SECRET,
        code: code.toString(),
        grant_type: "authorization_code",
        redirect_uri: TT_REDIRECT
      })
    });
    if (!tokenResp.ok) {
      const t = await tokenResp.text();
      console.error("Token exchange failed:", tokenResp.status, t);
      return res.status(400).send("Token exchange failed");
    }
    const tokenJson = await tokenResp.json();
    const payload = tokenJson.data ?? tokenJson;
    const access_token = payload.access_token;
    const refresh_token = payload.refresh_token || null;
    let open_id = payload.open_id || null;
    const expires_in = Number(payload.expires_in || 0);

    if (!access_token) {
      console.error("No access_token in TikTok response:", tokenJson);
      return res.status(400).send("No access_token in response");
    }

    // Prøv at hente open_id hvis ikke givet
    if (!open_id) {
      try {
        const uiResp = await fetch(TT_USERINFO_URL, { headers: { Authorization: `Bearer ${access_token}` } });
        if (uiResp.ok) {
          const ui = await uiResp.json();
          open_id = ui?.data?.user?.open_id || ui?.open_id || null;
        }
      } catch {}
    }

    const expiresAt = expires_in ? new Date(Date.now() + expires_in * 1000).toISOString() : null;
    const { error: dberr } = await supabase.from("tiktok_accounts").insert({
      tiktok_open_id: open_id,
      access_token,
      refresh_token,
      expires_at: expiresAt
    });
    if (dberr) {
      console.error("Supabase insert error:", dberr);
      return res.status(500).send("Saved token failed");
    }

    return res.status(200).send(`
      <html><body style="font-family: system-ui; padding:24px">
        <h2>✅ TikTok konto forbundet</h2>
        <p>open_id: <code>${open_id || "ukendt"}</code></p>
        <p>Du kan lukke dette vindue.</p>
      </body></html>
    `);
  } catch (e) {
    console.error("TT callback error:", e);
    return res.status(500).send("Callback failed");
  }
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log("✅ Server on", PORT);
});
