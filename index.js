// index.js — backend with FFmpeg + Supabase + persistent TikTok OAuth + robust CORS/connect flow
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";
import { execa } from "execa";
import ffmpeg from "ffmpeg-static";
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import crypto from "crypto";

// ---------- ENV ----------
const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.API_KEY || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const VIDEO_JITTER = (process.env.VIDEO_JITTER || "").toLowerCase() === "true";

const TIKTOK_CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY || "";
const TIKTOK_CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET || "";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://api.europepush.com";
const TIKTOK_REDIRECT = `${PUBLIC_BASE_URL}/auth/tiktok/callback`;

// ---------- Clients ----------
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ---------- App ----------
const app = express();

// Strong CORS + preflight (prevents “Failed to fetch” from OPTIONS)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, x-api-key"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Also keep cors() for good measure
app.use(cors());
app.use(express.json({ limit: "25mb" }));

// ---------- Tiny in-memory job store ----------
const jobs = new Map();

// ---------- TikTok auth persistence ----------
const AUTH_FILE = path.join(process.cwd(), "tiktok_auth.json");
let tikTokAuth = null;
if (fs.existsSync(AUTH_FILE)) {
  try {
    tikTokAuth = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
  } catch {}
}
const saveTikTokAuth = (data) => {
  tikTokAuth = data;
  fs.writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2));
};

// ---------- Helpers ----------
const nowId = (pfx = "job") =>
  `${pfx}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

const downloadToTmp = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download failed: ${r.status} ${r.statusText}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const tmp = path.join(os.tmpdir(), `in_${nowId("vid")}.mp4`);
  await fsp.writeFile(tmp, buf);
  return tmp;
};

const runFFmpeg = async (inPath) => {
  const outPath = path.join(os.tmpdir(), `out_${nowId("clip")}.mp4`);
  const scalePad =
    "scale=w=1080:h=1920:force_original_aspect_ratio=decrease:flags=lanczos+accurate_rnd+full_chroma_int," +
    "pad=1080:1920:(1080-iw*min(1080/iw\\,1920/ih))/2:(1920-ih*min(1080/iw\\,1920/ih))/2," +
    "crop=1080-4:1920-4:2:2,pad=1080:1920:(1080-iw)/2:(1920-ih)/2";
  const vf = VIDEO_JITTER ? `${scalePad},hue=h=0.4*PI/180:s=1` : `${scalePad}`;

  const args = [
    "-y",
    "-hide_banner",
    "-nostdin",
    "-threads",
    "1",
    "-filter_threads",
    "1",
    "-filter_complex_threads",
    "1",
    "-i",
    inPath,
    "-vf",
    vf,
    "-r",
    "30",
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-c:v",
    "libx264",
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "fast",
    "-crf",
    "20",
    "-tune",
    "fastdecode",
    "-x264-params",
    "ref=3:bframes=3:rc-lookahead=12:keyint=150:min-keyint=30:scenecut=0",
    "-maxrate",
    "3500k",
    "-bufsize",
    "7000k",
    "-max_muxing_queue_size",
    "1024",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    outPath,
  ];
  await execa(ffmpeg, args, { stdio: "inherit" });
  return outPath;
};

const uploadToSupabase = async (localPath, destPath) => {
  const data = await fsp.readFile(localPath);
  const { error } = await supabase.storage
    .from("outputs")
    .upload(destPath, data, { upsert: true, contentType: "video/mp4" });
  if (error) throw error;
  const { data: pub } = supabase.storage.from("outputs").getPublicUrl(destPath);
  return pub?.publicUrl;
};

const qs = (obj) =>
  Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

const tikTokToken = async ({ code }) => {
  const body = new URLSearchParams({
    client_key: TIKTOK_CLIENT_KEY,
    client_secret: TIKTOK_CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
    redirect_uri: TIKTOK_REDIRECT,
  });
  const r = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  return r.json();
};

// ---------- Health ----------
app.get("/health", (_req, res) =>
  res.json({ ok: true, uptime: process.uptime(), tikTokConnected: !!tikTokAuth?.access_token })
);

// ---------- TikTok OAuth ----------

// JSON connect endpoint (UI fetches this, opens returned URL)
app.get("/auth/tiktok/connect", (req, res) => {
  const state = "state_epush_" + crypto.randomBytes(4).toString("hex");
  const authorize_url =
    "https://www.tiktok.com/v2/auth/authorize/?" +
    qs({
      client_key: TIKTOK_CLIENT_KEY,
      scope: "user.info.basic,video.upload,video.publish",
      response_type: "code",
      redirect_uri: TIKTOK_REDIRECT,
      state,
    });
  res.json({ ok: true, authorize_url, state });
});

// Legacy helpers (kept for compatibility)
app.get("/auth/tiktok/url", (req, res) => {
  const state = "state_epush_" + crypto.randomBytes(4).toString("hex");
  const url =
    "https://www.tiktok.com/v2/auth/authorize/?" +
    qs({
      client_key: TIKTOK_CLIENT_KEY,
      scope: "user.info.basic,video.upload,video.publish",
      response_type: "code",
      redirect_uri: TIKTOK_REDIRECT,
      state,
    });
  res.json({ authorize_url: url, state });
});

app.get("/auth/tiktok/start", (req, res) => {
  const to = `${PUBLIC_BASE_URL}/auth/tiktok/connect`;
  res.type("html").send(`
    <script>
      fetch('${to}')
        .then(r => r.json())
        .then(j => window.location.href = j.authorize_url)
        .catch(e => document.body.innerText = 'err: '+ e);
    </script>`);
});

// Callback: persist tokens, notify opener, close
app.get("/auth/tiktok/callback", async (req, res) => {
  const { code, error, error_description, state } = req.query;
  if (error) {
    return res
      .status(400)
      .type("html")
      .send(`<pre>OAuth error: ${String(error_description || error)}</pre>`);
  }
  const tok = await tikTokToken({ code });
  if (tok?.data?.access_token) saveTikTokAuth(tok.data);

  // HTML posts a message back to opener (Base44) and closes
  res.type("html").send(`
    <html><body>
      <script>
        try {
          window.opener && window.opener.postMessage(
            { type: "tiktok_connected", ok: ${!!tok?.data?.access_token}, state: "${state||""}" },
            "*"
          );
        } catch (e) {}
        document.body.innerHTML = '<pre>TikTok Login OK</pre>';
        setTimeout(() => window.close(), 300);
      </script>
    </body></html>
  `);
});

app.get("/auth/tiktok/status", (req, res) => {
  res.json({
    connected: !!tikTokAuth?.access_token,
    open_id: tikTokAuth?.open_id || null,
    expires_in: tikTokAuth?.expires_in || null,
  });
});

app.get("/auth/tiktok/debug", (req, res) => {
  res.json({
    client_key_present: !!TIKTOK_CLIENT_KEY,
    client_key_len: TIKTOK_CLIENT_KEY.length,
    client_secret_present: !!TIKTOK_CLIENT_SECRET,
    client_secret_len: TIKTOK_CLIENT_SECRET.length,
    redirect_uri: TIKTOK_REDIRECT,
    connected: !!tikTokAuth?.access_token,
    open_id: tikTokAuth?.open_id || null,
  });
});

// Accounts for UI dropdown (one sandbox account = open_id)
app.get("/tiktok/accounts", (req, res) => {
  if (!tikTokAuth?.open_id) return res.json({ accounts: [] });
  res.json({
    accounts: [
      {
        id: tikTokAuth.open_id,
        display_name: "Sandbox user",
        type: "tiktok_sandbox",
      },
    ],
  });
});

// ---------- Jobs API ----------
const requireApiKey = (req, res, next) => {
  const key = req.get("x-api-key");
  if (!API_KEY || key !== API_KEY) return res.status(401).json({ error: "unauthorized" });
  next();
};

app.post("/jobs", requireApiKey, async (req, res) => {
  const { source_video_url, postToTikTok = false, tiktok_account_ids = [], caption } = req.body || {};
  if (!source_video_url) return res.status(400).json({ error: "missing_source_video_url" });

  const id = nowId("job");
  jobs.set(id, { id, status: "downloading", created_at: Date.now() });
  res.json({ ok: true, job_id: id }); // respond immediately

  try {
    const inPath = await downloadToTmp(source_video_url);
    jobs.get(id).status = "rendering";

    const outPath = await runFFmpeg(inPath);

    const destKey = `outputs/jobs/${id}/clip_${Date.now()}.mp4`;
    const publicUrl = await uploadToSupabase(outPath, destKey);

    jobs.set(id, {
      ...jobs.get(id),
      status: "done",
      output_url: publicUrl,
      caption: caption || null,
    });

    if (postToTikTok) {
      if (!tikTokAuth?.access_token) {
        jobs.get(id).tiktok = { posted: false, reason: "not_connected" };
      } else {
        jobs.get(id).tiktok = {
          posted: false,
          queued: true,
          mode: "simulated_sandbox",
          note:
            "Real pull_by_url needs domain verification of the exact file host; marked as queued for demo.",
          target_account: tiktok_account_ids?.[0] || tikTokAuth.open_id || null,
          caption: caption || null,
          video_url: publicUrl,
        };
      }
    }

    try { await fsp.unlink(inPath); } catch {}
    try { await fsp.unlink(outPath); } catch {}
  } catch (e) {
    jobs.set(id, { ...jobs.get(id), status: "error", error: String(e?.message || e) });
  }
});

app.get("/jobs/:id", requireApiKey, (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: "not_found" });
  res.json(j);
});

// ---------- Boot ----------
app.listen(PORT, () => {
  console.log("✅ Server on", PORT);
  console.log("🔗 Base URL:", PUBLIC_BASE_URL);
  console.log("🎥 VIDEO_JITTER:", VIDEO_JITTER);
});
