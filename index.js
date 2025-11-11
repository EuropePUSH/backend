// index.js (ESM)
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

// ----------------- INIT -----------------
const app = express();
app.use(cors());
app.use(express.json());

// ----------------- ENV -----------------
const PORT = Number(process.env.PORT || 10000);
const API_KEY = (process.env.API_KEY || "").trim();
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
const SUPABASE_SERVICE_KEY = (process.env.SUPABASE_SERVICE_KEY || "").trim();
const VIDEO_JITTER = (process.env.VIDEO_JITTER || "").toLowerCase() === "true";

const TT_CLIENT_KEY = (process.env.TIKTOK_CLIENT_KEY || "").trim();
const TT_CLIENT_SECRET = (process.env.TIKTOK_CLIENT_SECRET || "").trim();
const TT_REDIRECT =
  (process.env.TIKTOK_REDIRECT_URL || "https://backend-ipt2.onrender.com/auth/tiktok/callback").trim();

// ----------------- SUPABASE -----------------
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ----------------- UTILS -----------------
function genId(prefix = "job") {
  return `${prefix}_${crypto.randomBytes(4).toString("hex")}`;
}

// ----------------- HEALTH -----------------
app.get("/health", (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ----------------- TIKTOK OAUTH DEBUG -----------------
app.get("/auth/tiktok/debug", (req, res) => {
  res.json({
    client_key_present: !!TT_CLIENT_KEY,
    client_key_len: TT_CLIENT_KEY.length,
    client_key_preview: TT_CLIENT_KEY ? `${TT_CLIENT_KEY.slice(0,4)}…${TT_CLIENT_KEY.slice(-4)}` : null,
    client_secret_present: !!TT_CLIENT_SECRET,
    client_secret_len: TT_CLIENT_SECRET.length,
    client_secret_preview: TT_CLIENT_SECRET ? `${TT_CLIENT_SECRET.slice(0,4)}…${TT_CLIENT_SECRET.slice(-4)}` : null,
    redirect_uri: TT_REDIRECT
  });
});

app.get("/auth/tiktok/url", (req, res) => {
  if (!TT_CLIENT_KEY) return res.status(500).send("Missing TIKTOK_CLIENT_KEY");
  const url =
    "https://www.tiktok.com/v2/auth/authorize/?" +
    `client_key=${encodeURIComponent(TT_CLIENT_KEY)}` +
    `&scope=${encodeURIComponent("user.info.basic,video.upload,video.publish")}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(TT_REDIRECT)}` +
    `&state=${encodeURIComponent("state_epush_123")}`;
  res.json({ authorize_url: url });
});

app.get("/auth/tiktok/login", (req, res) => {
  if (!TT_CLIENT_KEY) return res.status(500).send("Missing TIKTOK_CLIENT_KEY");
  const url =
    "https://www.tiktok.com/v2/auth/authorize/?" +
    `client_key=${encodeURIComponent(TT_CLIENT_KEY)}` +
    `&scope=${encodeURIComponent("user.info.basic,video.upload,video.publish")}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(TT_REDIRECT)}` +
    `&state=${encodeURIComponent("state_epush_123")}`;
  res.redirect(url);
});

app.get("/auth/tiktok/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query;
  if (error)
    return res
      .status(400)
      .send(`TikTok error: ${error} ${error_description ? `— ${error_description}` : ""}`);
  if (!code) return res.status(400).send("Missing code – start via /auth/tiktok/login.");
  res.send(`✅ Modtog TikTok auth code: ${String(code).slice(0, 6)}...`);
});

// ----------------- JOBS ENDPOINT -----------------
app.post("/jobs", async (req, res) => {
  try {
    if (req.headers["x-api-key"] !== API_KEY) return res.status(403).send("Unauthorized");
    const { source_video_url } = req.body;
    if (!source_video_url) return res.status(400).send("Missing source_video_url");

    const jobId = genId();
    console.log("RESPOND job:", jobId);

    // --- Download video ---
    const tmpIn = path.join(os.tmpdir(), `in_${jobId}.mp4`);
    const tmpOut = path.join(os.tmpdir(), `out_${jobId}.mp4`);
    const resp = await fetch(source_video_url);
    const buf = Buffer.from(await resp.arrayBuffer());
    await fs.writeFile(tmpIn, buf);
    console.log("Downloaded to file bytes:", buf.length);

    // --- FFmpeg process (optimized) ---
    const ffArgs = [
      "-y",
      "-hide_banner",
      "-nostdin",
      "-threads", "1",
      "-filter_threads", "1",
      "-filter_complex_threads", "1",
      "-i", tmpIn,
      "-vf",
      "scale=w=1080:h=1920:force_original_aspect_ratio=decrease:flags=fast_bilinear," +
        "pad=1080:1920:(1080-iw*min(1080/iw\\,1920/ih))/2:(1920-ih*min(1080/iw\\,1920/ih))/2," +
        "crop=1080-4:1920-4:2:2," +
        "pad=1080:1920:(1080-iw)/2:(1920-ih)/2",
      "-r", "30",
      "-map", "0:v:0",
      "-map", "0:a:0",
      "-c:v", "libx264",
      "-profile:v", "high",
      "-pix_fmt", "yuv420p",
      "-preset", "ultrafast",
      "-crf", "21",
      "-tune", "fastdecode",
      "-x264-params", "ref=1:bframes=2:rc-lookahead=8:keyint=120:min-keyint=24:scenecut=0",
      "-maxrate", "3500k",
      "-bufsize", "7000k",
      "-max_muxing_queue_size", "1024",
      "-c:a", "copy",
      "-movflags", "+faststart",
      tmpOut,
    ];

    console.log("FFmpeg args:", ffArgs.join(" "));
    await execa(ffmpegBin, ffArgs);
    const stat = await fs.stat(tmpOut);
    console.log("Processed size bytes:", stat.size);

    // --- Upload to Supabase ---
    const fileBuffer = await fs.readFile(tmpOut);
    console.log("UPLOAD buffer bytes:", fileBuffer.length);

    const key = `jobs/${jobId}/clip_${Date.now()}.mp4`;
    const { error: upErr } = await supabase.storage
      .from("outputs")
      .upload(key, fileBuffer, {
        contentType: "video/mp4",
        upsert: true,
      });

    if (upErr) throw upErr;
    const { data } = supabase.storage.from("outputs").getPublicUrl(key);
    console.log("UPLOAD_OK job:", jobId, "url:", data.publicUrl);

    res.json({ ok: true, jobId, output_url: data.publicUrl });
  } catch (err) {
    console.error("Job error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ----------------- START SERVER -----------------
app.listen(PORT, () => {
  console.log(`✅ Server on ${PORT}`);
});
