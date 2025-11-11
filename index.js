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

// ----------------- ENV -----------------
const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.API_KEY || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const VIDEO_JITTER = (process.env.VIDEO_JITTER || "").toLowerCase() === "true";

const TT_CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY || "";
const TT_CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET || "";
const TT_REDIRECT =
  process.env.TIKTOK_REDIRECT_URL ||
  "https://backend-ipt2.onrender.com/auth/tiktok/callback";

// ----------------- APP SETUP -----------------
const app = express();
app.use(cors());
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ extended: true, limit: "100mb" }));

// --- TikTok URL verification ---
app.get("/tiktokCyf5rIYx6ICSKpiqIGzMRNbWc7m4SPoW.txt", (req, res) => {
  res.type("text/plain").send("tiktok-developers-site-verification=Cyf5rIYx6ICSKpiqIGzMRNbWc7m4SPoW");
});

// ----------------- SUPABASE -----------------
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ----------------- TIKTOK OAUTH -----------------
const TT_SCOPES = ["user.info.basic", "video.upload", "video.publish"];

function tiktokAuthorizeUrl() {
  const params = new URLSearchParams({
    client_key: TT_CLIENT_KEY,
    scope: TT_SCOPES.join(","),
    response_type: "code",
    redirect_uri: TT_REDIRECT,
    state: "state_epush_123",
  });
  return `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`;
}

app.get("/auth/tiktok/debug", (req, res) => {
  res.json({
    client_key_present: !!TT_CLIENT_KEY,
    client_key_len: TT_CLIENT_KEY.length,
    client_secret_present: !!TT_CLIENT_SECRET,
    client_secret_len: TT_CLIENT_SECRET.length,
    redirect_uri: TT_REDIRECT,
  });
});

app.get("/auth/tiktok/url", (req, res) => {
  res.json({ authorize_url: tiktokAuthorizeUrl() });
});

app.get("/auth/tiktok/start", (req, res) => {
  res.redirect(tiktokAuthorizeUrl());
});

app.get("/auth/tiktok/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    return res.status(400).send(`OAuth Error: ${error}`);
  }
  if (!code) {
    return res.status(400).send("Missing code");
  }

  try {
    const tokenUrl = "https://open.tiktokapis.com/v2/oauth/token/";
    const response = await fetch(tokenUrl, {
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

    const data = await response.json();
    console.log("TikTok Token Response:", data);

    if (data.access_token) {
      res.send(
        `<h2>✅ Login success!</h2><p>Access Token: ${data.access_token}</p>`
      );
    } else {
      res.status(400).json(data);
    }
  } catch (err) {
    console.error("TikTok Callback Error:", err);
    res.status(500).send("Internal Server Error");
  }
});

// ---- ALT authorize base (fallback) ----
function tiktokAuthorizeUrlAlt() {
  const params = new URLSearchParams({
    client_key: TT_CLIENT_KEY,
    scope: "user.info.basic",           // hold den minimal til login-test
    response_type: "code",
    redirect_uri: TT_REDIRECT,
    state: "state_epush_123",
  });
  // Alternativ host (nogle setups kræver denne)
  return `https://open.tiktokapis.com/v2/oauth/authorize/?${params.toString()}`;
}

// Ekstra route der bruger alternativ host:
app.get("/auth/tiktok/start2", (req, res) => {
  res.redirect(tiktokAuthorizeUrlAlt());
});

// ----------------- JOBS ENDPOINT -----------------
app.post("/jobs", async (req, res) => {
  try {
    const { apiKey, videoBase64, filename } = req.body;
    if (apiKey !== API_KEY) return res.status(403).json({ error: "Invalid API key" });

    const tmpIn = path.join(os.tmpdir(), `in_${crypto.randomUUID()}.mp4`);
    const tmpOut = path.join(os.tmpdir(), `out_${crypto.randomUUID()}.mp4`);

    await fs.writeFile(tmpIn, Buffer.from(videoBase64, "base64"));
    console.log("Downloaded to file:", tmpIn);

    const args = [
      "-y",
      "-hide_banner",
      "-nostdin",
      "-threads", "1",
      "-i", tmpIn,
      "-vf", "scale=w=1080:h=1920:force_original_aspect_ratio=decrease,pad=1080:1920:(1080-iw)/2:(1920-ih)/2",
      "-c:v", "libx264",
      "-preset", "fast",
      "-crf", "20",
      "-c:a", "copy",
      "-movflags", "+faststart",
      tmpOut,
    ];

    await execa(ffmpegBin, args);
    console.log("✅ FFmpeg done");

    const fileBuffer = await fs.readFile(tmpOut);
    const jobId = `job_${crypto.randomUUID()}`;
    const uploadPath = `jobs/${jobId}/${filename || "output.mp4"}`;

    const { data, error } = await supabase.storage
      .from("outputs")
      .upload(uploadPath, fileBuffer, { contentType: "video/mp4", upsert: true });

    if (error) throw error;

    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/outputs/${uploadPath}`;
    console.log("✅ Uploaded to Supabase:", publicUrl);

    res.json({ jobId, url: publicUrl });
  } catch (err) {
    console.error("Job Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------- START SERVER -----------------
app.listen(PORT, () => {
  console.log(`✅ Server on ${PORT}`);
});
