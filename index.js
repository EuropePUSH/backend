// index.js (ESM)
import express from "express";
import cors from "cors";
import crypto from "crypto";
import fs from "fs/promises";
import fss from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import ffmpegBin from "ffmpeg-static";
import { execa } from "execa";

// ----------------- ENV -----------------
const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.API_KEY || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const BASE_URL = process.env.BASE_URL || ""; // fx https://api.europepush.com

// TikTok OAuth
const TT_CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY || "";
const TT_CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET || "";
const TT_REDIRECT = "https://api.europepush.com/auth/tiktok/callback"; // din DNS (CNAME) peger til Render

// ----------------- APP -----------------
const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

// ---------- DEBUG: print env presence ----------
console.log("🔧 ENV SUPABASE_URL:", SUPABASE_URL ? "present" : "missing");
console.log("🔧 ENV SUPABASE_SERVICE_KEY:", SUPABASE_SERVICE_KEY ? "present" : "missing");
console.log("🔧 ENV API_KEY:", API_KEY ? "present" : "missing");
console.log("🔧 ENV TIKTOK_CLIENT_KEY:", TT_CLIENT_KEY ? "present" : "missing");
console.log("🔧 ENV TIKTOK_CLIENT_SECRET:", TT_CLIENT_SECRET ? "present" : "missing");

// ---------- SUPABASE ----------
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false }
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

async function ffmpegProcess(inFile, jobId) {
  const outFile = path.join(path.dirname(inFile), `out_${crypto.randomBytes(6).toString("hex")}.mp4`);

  // Low-mem, hurtig transcode. Ingen tekstoverlay. Stabil scaling → 1080×1920
  const args = [
    "-y", "-hide_banner", "-nostdin",
    "-threads", "1", "-filter_threads", "1", "-filter_complex_threads", "1",
    "-i", inFile,
    "-vf",
    "scale=w=1080:h=1920:force_original_aspect_ratio=decrease:flags=fast_bilinear," +
      "pad=1080:1920:(1080-iw*min(1080/iw\\,1920/ih))/2:(1920-ih*min(1080/iw\\,1920/ih))/2," +
      "crop=1080-4:1920-4:2:2," +
      "pad=1080:1920:(1080-iw)/2:(1920-ih)/2",
    "-r", "30",
    "-map", "0:v:0", "-map", "0:a:0",
    "-c:v", "libx264",
    "-profile:v", "high",
    "-pix_fmt", "yuv420p",
    "-preset", "ultrafast",
    "-crf", "21",
    "-tune", "fastdecode",
    "-x264-params", "ref=1:bframes=2:rc-lookahead=8:keyint=120:min-keyint=24:scenecut=0",
    "-maxrate", "3500k", "-bufsize", "7000k",
    "-max_muxing_queue_size", "1024",
    "-c:a", "copy",
    "-movflags", "+faststart",
    outFile
  ];

  console.log("FFmpeg args:", args.join(" "));
  try {
    const { stdout, stderr } = await execa(ffmpegBin, args, { timeout: 5 * 60 * 1000 });
    if (stdout) console.log(stdout);
    if (stderr) console.log(stderr);
  } catch (err) {
    console.error("❌ FFmpeg error:", err.message);
    // fallback: aflever original hvis transcode crasher
    return inFile;
  }
  return outFile;
}

async function uploadFileToOutputs(jobId, filePath) {
  const key = `jobs/${jobId}/clip_${Date.now()}.mp4`;
  const stat = await fs.stat(filePath);
  const buf = await fs.readFile(filePath);
  console.log("UPLOAD buffer bytes:", buf.length);

  const { error } = await supabase
    .storage
    .from("outputs")
    .upload(key, buf, { contentType: "video/mp4", upsert: true });

  if (error) throw error;

  const { data } = supabase.storage.from("outputs").getPublicUrl(key);
  return data.publicUrl;
}

async function jobsInsert(jobId, state, progress, input) {
  const { error } = await supabase
    .from("jobs")
    .insert({ job_id: jobId, state, progress, input });

  if (error && !String(error.message).includes("duplicate")) {
    console.error("jobs insert error:", error);
  }
}

async function jobsUpdate(jobId, state, progress) {
  const { error } = await supabase
    .from("jobs")
    .update({ state, progress })
    .eq("job_id", jobId);

  if (error) console.error("jobs update error:", error);
}

async function eventsPush(jobId, payload) {
  await supabase.from("job_events").insert({
    job_id: jobId,
    state: payload?.state || null,
    progress: payload?.progress ?? null,
    payload
  });
}

async function outputAdd(jobId, url) {
  await supabase.from("job_outputs").insert({
    job_id: jobId,
    idx: 0,
    url
  });
}

// ---------- API-KEY MIDDLEWARE ----------
app.use((req, res, next) => {
  if (req.method === "POST" && req.path === "/jobs") {
    const key = req.headers["x-api-key"];
    if (!key || key !== API_KEY) {
      return res.status(401).json({ error: "unauthorized" });
    }
  }
  next();
});

// ---------- ROUTES ----------
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    base_url: BASE_URL || null,
    supabase: !!SUPABASE_URL,
    storage_bucket: "outputs"
  });
});

// Create job
app.post("/jobs", async (req, res) => {
  try {
    const { source_video_url } = req.body || {};
    if (!source_video_url || typeof source_video_url !== "string") {
      return res.status(400).json({ error: "source_video_url required" });
    }

    const jobId = `job_${crypto.randomBytes(8).toString("hex")}`;
    await jobsInsert(jobId, "queued", 0, { source_video_url });
    await eventsPush(jobId, { state: "queued" });

    // respond early
    res.json({ job_id: jobId, state: "queued", progress: 0 });
    // continue async
    processJob(jobId, source_video_url).catch(err =>
      console.error("processJob fatal:", err)
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal" });
  }
});

// Job status
app.get("/jobs/:id", async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase
    .from("jobs")
    .select("*")
    .eq("job_id", id)
    .single();

  if (error || !data) return res.status(404).json({ error: "not_found" });

  const { data: outputs } = await supabase
    .from("job_outputs")
    .select("url,caption,hashtags")
    .eq("job_id", id)
    .order("idx", { ascending: true });

  res.json({
    job_id: id,
    state: data.state,
    progress: data.progress,
    outputs: outputs || []
  });
});

// ---------- JOB WORKER ----------
async function processJob(jobId, url) {
  try {
    await jobsUpdate(jobId, "downloading", 5);
    await eventsPush(jobId, { state: "downloading", url });

    const inFile = await downloadToTmp(url);

    await jobsUpdate(jobId, "processing", 25);
    await eventsPush(jobId, { state: "processing", step: "ffmpeg" });

    const outFile = await ffmpegProcess(inFile, jobId);

    await jobsUpdate(jobId, "uploading", 75);
    await eventsPush(jobId, { state: "uploading" });

    const publicUrl = await uploadFileToOutputs(jobId, outFile);
    await outputAdd(jobId, publicUrl);

    await jobsUpdate(jobId, "completed", 100);
    await eventsPush(jobId, { state: "completed", url: publicUrl });
    console.log("UPLOAD_OK job:", jobId, "url:", publicUrl);
  } catch (err) {
    console.error("Job failed:", err);
    await jobsUpdate(jobId, "failed", 100);
    await eventsPush(jobId, { state: "failed", error: String(err?.message || err) });
  }
}

// ---------- TIKTOK OAUTH ----------
// Helper: auth URL
function buildAuthUrl(state = "state_epush_123") {
  const scope = [
    "user.info.basic",
    "video.upload",
    "video.publish"
  ].join(",");
  const u = new URL("https://www.tiktok.com/v2/auth/authorize/");
  u.searchParams.set("client_key", TT_CLIENT_KEY);
  u.searchParams.set("scope", scope);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", TT_REDIRECT);
  u.searchParams.set("state", state);
  return u.toString();
}

// Debug presence
app.get("/auth/tiktok/debug", (_req, res) => {
  res.json({
    client_key_present: !!TT_CLIENT_KEY,
    client_key_len: TT_CLIENT_KEY.length,
    client_key_preview: TT_CLIENT_KEY ? `${TT_CLIENT_KEY.slice(0,4)}…${TT_CLIENT_KEY.slice(-4)}` : null,
    client_secret_present: !!TT_CLIENT_SECRET,
    client_secret_len: TT_CLIENT_SECRET.length,
    client_secret_preview: TT_CLIENT_SECRET ? `${TT_CLIENT_SECRET.slice(0,3)}…${TT_CLIENT_SECRET.slice(-3)}` : null,
    redirect_uri: TT_REDIRECT
  });
});

// JSON: authorize url
app.get("/auth/tiktok/url", (_req, res) => {
  res.json({ authorize_url: buildAuthUrl() });
});

// Redirect the user to TikTok
app.get("/auth/tiktok/start", (_req, res) => {
  if (!TT_CLIENT_KEY) return res.status(500).send("Missing client key");
  res.redirect(buildAuthUrl());
});

// Callback: exchange code, fetch user
app.get("/auth/tiktok/callback", async (req, res) => {
  const code = req.query.code;
  const state = req.query.state;

  res.setHeader("Content-Type", "text/html; charset=utf-8");

  if (!code) {
    return res
      .status(400)
      .send(`<pre>missing code</pre>`);
  }

  try {
    // Exchange code for tokens
    const tokenRes = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_key: TT_CLIENT_KEY,
        client_secret: TT_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: TT_REDIRECT
      })
    });

    const tokens = await tokenRes.json();

    // Fetch user info (PATCHED: include 'fields' in body)
    let meObj = null;
    try {
      const meRes = await fetch("https://open.tiktokapis.com/v2/user/info/", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${tokens?.access_token || ""}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          fields: ["open_id", "display_name", "avatar_url"]
        })
      });
      meObj = await meRes.json();
    } catch (innerErr) {
      meObj = { warn: "user.info fetch failed", error: String(innerErr) };
    }

    // Simple demo output (gem tokens i DB i produktion)
    const pretty = (obj) => JSON.stringify(obj, null, 2);
    return res.status(200).send(
      `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>TikTok Login OK</title></head>
<body style="font-family: ui-monospace, Menlo, monospace; padding:24px">
<h1>TikTok Login OK</h1>
<b>state:</b> ${state || "-"}<br/>
<pre>{
"tokens": ${pretty(tokens)},
"me": ${pretty(meObj)}
}
</pre>
<p>Gem tokens i din database/session i stedet for at vise dem i produktion.</p>
</body></html>`
    );
  } catch (err) {
    console.error("OAuth callback error:", err);
    return res.status(500).send(`<pre>${String(err?.message || err)}</pre>`);
  }
});

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`✅ Server on ${PORT}`);
});
