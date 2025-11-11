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
const TT_REDIRECT = process.env.TIKTOK_REDIRECT_URL || "";

app.get("/auth/tiktok/debug", (req, res) => {
  const key = process.env.TIKTOK_CLIENT_KEY || "";
  const secret = process.env.TIKTOK_CLIENT_SECRET || "";
  res.json({
    client_key_present: !!key,
    client_key_len: key.length,
    client_secret_present: !!secret,
    client_secret_len: secret.length,
    redirect_uri: "https://backend-ipt2.onrender.com/auth/tiktok/callback"
  });
});


// ----------------- APP -----------------
const app = express();
app.use(cors({
  origin: true,
  credentials: false,
  allowedHeaders: ["Content-Type", "x-api-key"],
  methods: ["GET","POST","OPTIONS"]
}));
app.options("*", cors());
app.use(express.json({ limit: "10mb" }));

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.warn("⚠️ SUPABASE_URL / SUPABASE_SERVICE_KEY mangler.");
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ----------------- UTILS -----------------
const tmpFile = (prefix, ext = ".mp4") =>
  path.join(os.tmpdir(), `${prefix}_${crypto.randomBytes(6).toString("hex")}${ext}`);

async function downloadToFile(url) {
  const inPath = tmpFile("in_job");
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Download failed: ${resp.status} ${await resp.text()}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  await fs.writeFile(inPath, buf);
  console.log("Downloaded to file bytes:", buf.length);
  return inPath;
}

function jitterVal(base) {
  if (!VIDEO_JITTER) return base;
  const f = 1 + (Math.random() * 1.2 - 0.6) / 100; // ±0.6%
  return Math.max(0.5, base * f);
}

// HEVC/DolbyVision-safe, 60fps->30fps, hurtig encode. Fallback = remux.
async function ffmpegTransform(inPath, outPath) {
  const vf = [
    "scale=w=1080:h=1920:force_original_aspect_ratio=decrease:flags=fast_bilinear",
    "pad=1080:1920:(1080-iw*min(1080/iw\\,1920/ih))/2:(1920-ih*min(1080/iw\\,1920/ih))/2",
    "crop=1080-4:1920-4:2:2",
    "pad=1080:1920:(1080-iw)/2:(1920-ih)/2"
  ].join(",");

  const fpsArgs = ["-r", "30"]; // halve arbejdet ved 60fps kilder
  const crf = `${Math.round(jitterVal(21))}`;

  const args = [
    "-y","-hide_banner","-nostdin",
    "-threads","1","-filter_threads","1","-filter_complex_threads","1",
    "-i", inPath,
    "-vf", vf,
    ...fpsArgs,
    "-map","0:v:0","-map","0:a:0",
    "-c:v","libx264","-profile:v","high","-pix_fmt","yuv420p",
    "-preset","ultrafast","-crf", crf, "-tune","fastdecode",
    "-x264-params","ref=1:bframes=2:rc-lookahead=8:keyint=120:min-keyint=24:scenecut=0",
    "-maxrate","3500k","-bufsize","7000k",
    "-max_muxing_queue_size","1024",
    "-c:a","copy",
    "-movflags","+faststart",
    outPath
  ];

  console.log("FFmpeg args (HEVC-fast):", args.join(" "));
  try {
    await execa(ffmpegBin, args, { timeout: 10 * 60_000 }); // 10 min sikkerhedsnet
  } catch (e) {
    console.error("Encode fail, fallback to remux:", e.message);
    await execa(ffmpegBin, ["-y","-hide_banner","-nostdin","-i", inPath,"-c","copy","-movflags","+faststart", outPath], { timeout: 120_000 });
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
  console.log("UPLOAD_OK job:", jobId, "url:", data.publicUrl);
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

// ----------------- HEALTH -----------------
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

// ----------------- API-KEY (kun POST /jobs) -----------------
app.use((req, res, next) => {
  if (req.method === "POST" && req.path === "/jobs") {
    const key = req.headers["x-api-key"];
    if (!key || key !== API_KEY) return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

// ----------------- /jobs (ASYNC) -----------------
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
  await supabase.from("jobs").insert({
    job_id,
    state: "queued",
    progress: 0,
    input: req.body
  });

  // svar med det samme
  res.json({ job_id, state: "queued", progress: 0 });
  console.log("RESPOND job:", job_id);

  // kør i baggrunden
  (async () => {
    try {
      await supabase.from("job_events").insert({
        job_id, state: "downloading", progress: 5, payload: { url: source_video_url }
      });
      const inPath = await downloadToFile(source_video_url);

      await supabase.from("job_events").insert({
        job_id, state: "processing", progress: 30, payload: { preset_id }
      });
      const outName = `clip_${Date.now()}.mp4`;
      const outPath = tmpFile("out_job");
      await ffmpegTransform(inPath, outPath);

      await supabase.from("job_events").insert({
        job_id, state: "uploading", progress: 80
      });
      const publicUrl = await uploadFileBufferToStorage(job_id, outPath, outName);

      await supabase.from("job_outputs").insert({
        job_id, idx: 0, url: publicUrl, caption: null, hashtags: null
      });

      await supabase.from("jobs").update({ state: "completed", progress: 100 }).eq("job_id", job_id);
      await supabase.from("job_events").insert({ job_id, state: "completed", progress: 100 });

      await notifyWebhook(webhook_status_url, { job_id, state: "completed", url: publicUrl });

      try { await fs.unlink(inPath); } catch {}
      try { await fs.unlink(outPath); } catch {}
    } catch (e) {
      console.error("job error (bg):", e);
      await supabase.from("jobs").update({ state: "failed", progress: 100 }).eq("job_id", job_id);
      await supabase.from("job_events").insert({
        job_id, state: "failed", progress: 100, payload: { message: e?.message || String(e) }
      });
      await notifyWebhook(webhook_status_url, { job_id, state: "failed" });
    }
  })();
});

// ----------------- GET /jobs/:id -----------------
app.get("/jobs/:id", async (req, res) => {
  const job_id = req.params.id;
  const { data: job } = await supabase.from("jobs").select("*").eq("job_id", job_id).maybeSingle();
  if (!job) return res.status(404).json({ error: "not found" });
  const { data: events } = await supabase.from("job_events").select("*").eq("job_id", job_id).order("id", { ascending: true });
  const { data: outputs } = await supabase.from("job_outputs").select("*").eq("job_id", job_id).order("idx", { ascending: true });
  res.json({ job, events: events || [], outputs: outputs || [] });
});

// ----------------- DEBUG: latest -----------------
app.get("/debug/latest", async (req, res) => {
  const { data: j } = await supabase.from("jobs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!j) return res.status(404).json({ error: "no jobs" });
  const { data: o } = await supabase.from("job_outputs").select("*").eq("job_id", j.job_id).order("idx", { ascending: true });
  res.json({ job: j, outputs: o || [] });
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
    // scopes holdes tomme indtil review – kan udvides senere
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
    if (!access_token) return res.status(400).send("No access_token in response");

    // hent open_id hvis nødvendigt
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

// ----------------- START -----------------
app.listen(PORT, () => {
  console.log("✅ Server on", PORT);
});
