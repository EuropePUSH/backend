// index.js (ESM)
import express from "express";
import cors from "cors";
import crypto from "crypto";
import fs from "fs/promises";
import fss from "fs";
import os from "os";
import path from "path";
import { createClient } from "@supabase/supabase-js";
import ffmpegBin from "ffmpeg-static";
import { execa } from "execa";

// ----------------- ENV -----------------
const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.API_KEY || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const BASE_URL = process.env.BASE_URL || "";

// TikTok OAuth
const TT_CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY || "";
const TT_CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET || "";
const TT_REDIRECT = "https://api.europepush.com/auth/tiktok/callback";

// ----------------- APP -----------------
const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

// ---------- SUPABASE ----------
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

// ---------- HELPERS ----------
async function downloadToTmp(url) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "job_"));
  const out = path.join(tmpDir, `in_${crypto.randomBytes(6).toString("hex")}.mp4`);

  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Download failed ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(out, buf);
  console.log("Downloaded to file bytes:", buf.length);
  return out;
}

async function ffmpegProcess(inFile) {
  const outFile = path.join(path.dirname(inFile), `out_${crypto.randomBytes(6).toString("hex")}.mp4`);
  const args = [
    "-y", "-hide_banner", "-nostdin",
    "-threads", "1", "-filter_threads", "1",
    "-i", inFile,
    "-vf",
    "scale=w=1080:h=1920:force_original_aspect_ratio=decrease," +
      "pad=1080:1920:(1080-iw)/2:(1920-ih)/2," +
      "crop=1080-4:1920-4:2:2," +
      "pad=1080:1920:(1080-iw)/2:(1920-ih)/2",
    "-r", "30",
    "-map", "0:v:0", "-map", "0:a:0",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-preset", "ultrafast", "-crf", "21",
    "-c:a", "copy", "-movflags", "+faststart",
    outFile,
  ];

  try {
    const { stderr } = await execa(ffmpegBin, args);
    if (stderr) console.log(stderr);
  } catch (err) {
    console.error("FFmpeg error:", err.message);
    return inFile;
  }
  return outFile;
}

async function uploadFileToOutputs(jobId, filePath) {
  const key = `jobs/${jobId}/clip_${Date.now()}.mp4`;
  const buf = await fs.readFile(filePath);
  const { error } = await supabase.storage
    .from("outputs")
    .upload(key, buf, { contentType: "video/mp4", upsert: true });
  if (error) throw error;
  const { data } = supabase.storage.from("outputs").getPublicUrl(key);
  return data.publicUrl;
}

async function jobsInsert(jobId, state, progress, input) {
  await supabase.from("jobs").insert({ job_id: jobId, state, progress, input }).catch(() => {});
}
async function jobsUpdate(jobId, state, progress) {
  await supabase.from("jobs").update({ state, progress }).eq("job_id", jobId);
}
async function outputAdd(jobId, url) {
  await supabase.from("job_outputs").insert({ job_id: jobId, idx: 0, url });
}

// ---------- API-KEY MIDDLEWARE ----------
app.use((req, res, next) => {
  if (req.method === "POST" && req.path === "/jobs") {
    const key = req.headers["x-api-key"];
    if (!key || key !== API_KEY) return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

// ---------- ROUTES ----------
app.get("/health", (_req, res) => {
  res.json({ ok: true, base_url: BASE_URL || null });
});

// Create job
app.post("/jobs", async (req, res) => {
  try {
    const { source_video_url } = req.body || {};
    if (!source_video_url) return res.status(400).json({ error: "source_video_url required" });
    const jobId = `job_${crypto.randomBytes(8).toString("hex")}`;
    await jobsInsert(jobId, "queued", 0, { source_video_url });
    res.json({ job_id: jobId, state: "queued", progress: 0 });
    processJob(jobId, source_video_url);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function processJob(jobId, url) {
  try {
    await jobsUpdate(jobId, "downloading", 5);
    const inFile = await downloadToTmp(url);
    await jobsUpdate(jobId, "processing", 25);
    const outFile = await ffmpegProcess(inFile);
    await jobsUpdate(jobId, "uploading", 75);
    const publicUrl = await uploadFileToOutputs(jobId, outFile);
    await outputAdd(jobId, publicUrl);
    await jobsUpdate(jobId, "completed", 100);
  } catch (err) {
    await jobsUpdate(jobId, "failed", 100);
    console.error(err);
  }
}

// ---------- TIKTOK AUTH ----------
function buildAuthUrl(state = "state_epush_123") {
  const scope = ["user.info.basic", "video.upload", "video.publish"].join(",");
  const u = new URL("https://www.tiktok.com/v2/auth/authorize/");
  u.searchParams.set("client_key", TT_CLIENT_KEY);
  u.searchParams.set("scope", scope);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", TT_REDIRECT);
  u.searchParams.set("state", state);
  return u.toString();
}

app.get("/auth/tiktok/debug", (_req, res) => {
  res.json({
    client_key_present: !!TT_CLIENT_KEY,
    client_key_len: TT_CLIENT_KEY.length,
    client_secret_present: !!TT_CLIENT_SECRET,
    redirect_uri: TT_REDIRECT,
  });
});

app.get("/auth/tiktok/url", (_req, res) => {
  res.json({ authorize_url: buildAuthUrl() });
});

app.get("/auth/tiktok/start", (_req, res) => {
  if (!TT_CLIENT_KEY) return res.status(500).send("Missing client key");
  res.redirect(buildAuthUrl());
});

// --- PATCHED CALLBACK ---
app.get("/auth/tiktok/callback", async (req, res) => {
  const code = req.query.code;
  const state = req.query.state;
  res.setHeader("Content-Type", "text/html; charset=utf-8");

  if (!code)
    return res.status(400).send("<pre>missing code</pre>");

  try {
    const tokenRes = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_key: TT_CLIENT_KEY,
        client_secret: TT_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: TT_REDIRECT,
      }),
    });

    const tokenJson = await tokenRes.json();

    // Only fetch /user/info if access_token exists
    let meJson = { note: "user.info skipped (no access_token)" };
    if (tokenRes.ok && tokenJson?.access_token) {
      const meRes = await fetch("https://open.tiktokapis.com/v2/user/info/", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${tokenJson.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          fields: ["open_id", "display_name", "avatar_url"],
        }),
      });

      const ct = meRes.headers.get("content-type") || "";
      meJson = ct.includes("application/json")
        ? await meRes.json()
        : { warn: "user.info returned non-JSON", status: meRes.status };
    }

    const pretty = (o) => JSON.stringify(o, null, 2);
    res.status(200).send(`<!doctype html><pre><h1>TikTok Login OK</h1>
state: ${state || "-"}
{
"tokens": ${pretty(tokenJson)},
"me": ${pretty(meJson)}
}
Gem tokens i din database/session i stedet for at vise dem i produktion.</pre>`);
  } catch (err) {
    res.status(500).send(`<pre>${String(err?.message || err)}</pre>`);
  }
});

// ---------- START ----------
app.listen(PORT, () => console.log(`✅ Server on ${PORT}`));
