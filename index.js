// index.js (ESM)

import express from "express";
import cors from "cors";
import crypto from "crypto";
import fs from "fs/promises";
import fss from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import ffmpegBin from "ffmpeg-static";
import { execa } from "execa";
import fetch from "node-fetch";

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
  "https://api.europepush.com/auth/tiktok/callback";

// ----------------- GLOBALS -----------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("❌ Missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ----------------- HELPERS -----------------

function randomId(prefix = "job") {
  const r = crypto.randomBytes(4).toString("hex");
  return `${prefix}_${r}`;
}

async function ensureTmpDir() {
  const dir = path.join(os.tmpdir(), "europepush");
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (e) {
    // ignore
  }
  return dir;
}

async function downloadToTmpFile(url, jobId) {
  const tmpDir = await ensureTmpDir();
  const tmpPath = path.join(tmpDir, `${jobId}_source.mp4`);

  console.log("Downloading source video:", url);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download source video: ${res.status}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(tmpPath, buffer);
  console.log("Downloaded to:", tmpPath);
  return tmpPath;
}

async function runFfmpegVariant(inputPath, jobId, variantIdx = 0) {
  if (!ffmpegBin) {
    throw new Error("ffmpeg-static binary not found");
  }

  const tmpDir = await ensureTmpDir();
  const outPath = path.join(tmpDir, `${jobId}_v${variantIdx}.mp4`);

  // Lille variation pr. konto ved at ændre CRF en smule
  const baseCrf = 21;
  const crf = baseCrf + Math.min(variantIdx, 3); // 0→21, 1→22, 2→23, ...

  const vf = [
    "scale=w=1080:h=1920:force_original_aspect_ratio=decrease:flags=fast_bilinear",
    "pad=1080:1920:(1080-iw*min(1080/iw\\,1920/ih))/2:(1920-ih*min(1080/iw\\,1920/ih))/2",
    "crop=1080-4:1920-4:2:2",
    "pad=1080:1920:(1080-iw)/2:(1920-ih)/2"
  ].join(",");

  const args = [
    "-y",
    "-hide_banner",
    "-nostdin",
    "-threads", "1",
    "-filter_threads", "1",
    "-filter_complex_threads", "1",
    "-i", inputPath,
    "-vf", vf,
    "-r", "30",
    "-map", "0:v:0",
    "-map", "0:a:0",
    "-c:v", "libx264",
    "-profile:v", "high",
    "-pix_fmt", "yuv420p",
    "-preset", "ultrafast",
    "-crf", String(crf),
    "-tune", "fastdecode",
    "-x264-params",
    "ref=1:bframes=2:rc-lookahead=8:keyint=120:min-keyint=24:scenecut=0",
    "-maxrate", "3500k",
    "-bufsize", "7000k",
    "-max_muxing_queue_size", "1024",
    "-c:a", "copy",
    "-movflags", "+faststart",
    outPath
  ];

  console.log("FFmpeg args (variant", variantIdx, "):", args.join(" "));

  await execa(ffmpegBin, args, {
    stdio: "inherit"
  });

  console.log("FFmpeg OK, output:", outPath);
  return outPath;
}

async function uploadToSupabase(jobId, localPath) {
  const fileBuf = await fs.readFile(localPath);
  const fileName = `clip_${Date.now()}.mp4`;
  const bucketPath = `jobs/${jobId}/${fileName}`;

  const { error } = await supabase.storage
    .from("outputs")
    .upload(bucketPath, fileBuf, {
      contentType: "video/mp4",
      upsert: true
    });

  if (error) {
    console.error("Supabase upload error:", error);
    throw error;
  }

  const { data: pub } = supabase.storage
    .from("outputs")
    .getPublicUrl(bucketPath);

  console.log("UPLOAD_OK job:", jobId, "url:", pub.publicUrl);
  return pub.publicUrl;
}

async function saveJobRecord(job) {
  job.updated_at = new Date().toISOString();
  const { error } = await supabase.from("jobs").upsert(job);
  if (error) {
    console.error("Supabase upsert job error:", error);
  }
}

async function tiktokFetch(pathOrUrl, options = {}) {
  const base = "https://open.tiktokapis.com";
  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `${base}${pathOrUrl}`;
  const res = await fetch(url, options);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, data: json };
}

async function upsertTikTokAccount({ open_id, username, display_name, avatar_url, tokens, profile }) {
  const { error } = await supabase
    .from("tiktok_accounts")
    .upsert({
      id: open_id,
      username,
      display_name,
      avatar_url,
      tokens,
      profile,
      updated_at: new Date().toISOString()
    });

  if (error) {
    console.error("Supabase upsert tiktok_accounts error:", error);
    throw error;
  }
}

function buildTikTokAuthorizeUrl() {
  const scope = [
    "user.info.basic",
    "video.upload",
    "video.publish"
  ].join(",");
  const q = new URLSearchParams({
    client_key: TT_CLIENT_KEY,
    scope,
    response_type: "code",
    redirect_uri: TT_REDIRECT,
    state: "state_epush_123"
  });
  return `https://www.tiktok.com/v2/auth/authorize/?${q.toString()}`;
}

async function publishToTikTokForAccounts({ jobId, outputs, tiktokAccountIds }) {
  if (!Array.isArray(tiktokAccountIds) || !tiktokAccountIds.length) return [];

  const results = [];
  for (let i = 0; i < tiktokAccountIds.length; i++) {
    const accountId = tiktokAccountIds[i];
    try {
      const { data, error } = await supabase
        .from("tiktok_accounts")
        .select("id, username, display_name, tokens")
        .eq("id", accountId)
        .single();

      if (error || !data) {
        console.warn("No TikTok account for id:", accountId, error);
        results.push({
          account_id: accountId,
          ok: false,
          error: "account_not_found"
        });
        continue;
      }

      const tokens = data.tokens || {};
      const accessToken = tokens.access_token;

      // Hent den output, der matcher denne account (idx er samme som konto index)
      const out = outputs.find(o => o.tiktok_account_id === accountId);

      console.log(
        `[TikTok publish STUB] job=${jobId} → account=${data.username} id=${accountId} url=${out?.url}`
      );

      // TODO: Rigtig TikTok upload/publish når du er klar.
      // For nu mocker vi et video-id:
      const fakeVideoId = `sandbox_${jobId}_${accountId}`;
      results.push({
        account_id: accountId,
        username: data.username,
        ok: true,
        tiktok_video_id: fakeVideoId
      });
    } catch (err) {
      console.error("TikTok publish exception:", err);
      results.push({
        account_id: accountId,
        ok: false,
        error: "exception"
      });
    }
  }
  return results;
}

async function processJob(jobId, jobInput) {
  console.log("▶️ Start job processing:", jobId, jobInput);

  let job = {
    job_id: jobId,
    state: "processing",
    progress: 0,
    input: jobInput,
    output: [],
    error_message: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  await saveJobRecord(job);

  try {
    const localSource = await downloadToTmpFile(jobInput.source_video_url, jobId);

    const accountIds = Array.isArray(jobInput.tiktok_account_ids)
      ? jobInput.tiktok_account_ids
      : [];

    const variantsCount = accountIds.length || 1; // mindst 1 variant

    const outputs = [];

    for (let i = 0; i < variantsCount; i++) {
      const variantIdx = i;
      const localOut = await runFfmpegVariant(localSource, jobId, variantIdx);
      const publicUrl = await uploadToSupabase(jobId, localOut);

      const outputEntry = {
        idx: variantIdx,
        url: publicUrl,
        caption: jobInput.caption || null,
        hashtags: jobInput.hashtags || [],
        tiktok_account_id: accountIds[variantIdx] || null
      };
      outputs.push(outputEntry);

      job.output = outputs;
      job.progress = Math.round(((i + 1) / variantsCount) * 80); // 0–80% på render
      await saveJobRecord(job);
    }

    let tiktokResults = [];
    if (jobInput.postToTikTok && accountIds.length > 0) {
      tiktokResults = await publishToTikTokForAccounts({
        jobId,
        outputs,
        tiktokAccountIds: accountIds
      });
    }

    job.state = "completed";
    job.progress = 100;
    job.output = outputs.map(o => ({
      ...o,
      tiktok_results: tiktokResults.filter(r => r.account_id === o.tiktok_account_id)
    }));
    job.error_message = null;
    await saveJobRecord(job);

    console.log("✅ Job completed:", jobId);
  } catch (err) {
    console.error("❌ Job failed:", jobId, err);
    job.state = "failed";
    job.error_message = String(err?.message || err);
    job.progress = 100;
    await saveJobRecord(job);
  }
}

// ----------------- EXPRESS APP -----------------

const app = express();

app.use(
  cors({
    origin: [
      "https://europepush.com",
      "https://www.europepush.com",
      "https://base44.app",
      "http://localhost:3000",
      "http://localhost:4173",
      "http://localhost:5173"
    ],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-api-key"],
    maxAge: 86400
  })
);

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.header("Access-Control-Allow-Credentials", "false");
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, x-api-key"
  );
  res.header(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS"
  );
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json({ limit: "20mb" }));

// --------- BASIC ROUTES ---------

app.get("/", (req, res) => {
  res.json({ ok: true, service: "europepush-backend" });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// --------- JOB ROUTES ---------

app.post("/jobs", async (req, res) => {
  try {
    const key = req.header("x-api-key") || "";
    if (!API_KEY || key !== API_KEY) {
      return res.status(401).json({ ok: false, error: "invalid_api_key" });
    }

    const body = req.body || {};
    const source_video_url = body.source_video_url;
    if (!source_video_url) {
      return res.status(400).json({ ok: false, error: "missing_source_video_url" });
    }

    const jobId = randomId("job");
    const jobInput = {
      source_video_url,
      caption: body.caption || null,
      hashtags: Array.isArray(body.hashtags) ? body.hashtags : [],
      postToTikTok: !!body.postToTikTok,
      tiktok_account_ids: Array.isArray(body.tiktok_account_ids)
        ? body.tiktok_account_ids
        : []
    };

    const job = {
      job_id: jobId,
      state: "queued",
      progress: 0,
      input: jobInput,
      output: [],
      error_message: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    await saveJobRecord(job);

    // Respond med det samme – og kør job async
    res.json({ ok: true, job });

    processJob(jobId, jobInput).catch((err) => {
      console.error("Background job error:", err);
    });
  } catch (err) {
    console.error("POST /jobs error:", err);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.get("/jobs/:jobId", async (req, res) => {
  try {
    const jobId = req.params.jobId;
    const { data, error } = await supabase
      .from("jobs")
      .select("*")
      .eq("job_id", jobId)
      .single();

    if (error && error.code === "PGRST116") {
      return res.status(404).json({ ok: false, error: "job_not_found" });
    }

    if (error) {
      console.error("GET /jobs error:", error);
      return res.status(500).json({ ok: false, error: "supabase_error" });
    }

    res.json({ ok: true, job: data });
  } catch (err) {
    console.error("GET /jobs/:jobId exception:", err);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// --------- TIKTOK DEBUG ---------

app.get("/auth/tiktok/debug", (req, res) => {
  const key = TT_CLIENT_KEY;
  const secret = TT_CLIENT_SECRET;
  res.json({
    client_key_present: !!key,
    client_key_len: key.length,
    client_key_preview: key ? `${key.slice(0, 4)}…${key.slice(-4)}` : null,
    client_secret_present: !!secret,
    client_secret_len: secret.length,
    client_secret_preview: secret ? `${secret.slice(0, 4)}…${secret.slice(-4)}` : null,
    redirect_uri: TT_REDIRECT
  });
});

// URL til TikTok authorize (til test / debugging)
app.get("/auth/tiktok/url", (req, res) => {
  if (!TT_CLIENT_KEY || !TT_CLIENT_SECRET || !TT_REDIRECT) {
    return res.status(400).json({
      authorize_url: null,
      error: "missing_tiktok_env"
    });
  }
  const authorize_url = buildTikTokAuthorizeUrl();
  res.json({ authorize_url });
});

// Connect-endpoint til Base44 UI (åbnes i ny fane eller via fetch)
app.get("/auth/tiktok/connect", (req, res) => {
  if (!TT_CLIENT_KEY || !TT_CLIENT_SECRET || !TT_REDIRECT) {
    return res.status(400).json({
      ok: false,
      error: "missing_tiktok_env"
    });
  }
  const url = buildTikTokAuthorizeUrl();

  const accept = req.headers["accept"] || "";
  if (accept.includes("application/json")) {
    return res.json({ ok: true, authorize_url: url });
  } else {
    return res.redirect(url);
  }
});

// TikTok callback – gemmer konto i Supabase
app.get("/auth/tiktok/callback", async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;

    if (error) {
      console.error("TikTok callback error:", error, error_description);
      return res.status(400).send("TikTok login failed: " + error_description);
    }

    if (!code) {
      return res.status(400).send("Missing ?code i callback URL’en.");
    }

    const tokenRes = await tiktokFetch("/v2/oauth/token/", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
      },
      body: new URLSearchParams({
        client_key: TT_CLIENT_KEY,
        client_secret: TT_CLIENT_SECRET,
        grant_type: "authorization_code",
        redirect_uri: TT_REDIRECT,
        code
      }).toString()
    });

    console.log("TikTok token response:", tokenRes);

    if (tokenRes.status !== 200 || tokenRes.data.error) {
      return res
        .status(400)
        .send("TikTok token error: " + (tokenRes.data.error_description || tokenRes.data.error || "unknown"));
    }

    const tokens = tokenRes.data;
    const accessToken = tokens.access_token;

    const meRes = await tiktokFetch("/v2/user/info/", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      }
    });

    console.log("TikTok /user/info response:", meRes);

    const userData = meRes.data?.data?.user || {};
    const open_id = userData.open_id || tokens.open_id || crypto.randomUUID();
    const username = userData.username || userData.display_name || "unknown";
    const display_name = userData.display_name || username;
    const avatar_url = userData.avatar_url || userData.avatar_url_100 || null;

    await upsertTikTokAccount({
      open_id,
      username,
      display_name,
      avatar_url,
      tokens,
      profile: meRes.data
    });

    console.log("TikTok account saved:", open_id, username);

    const redirectBack = "https://europepush.com/tiktokconnectpost?connected=1";
    res.send(`
      <html>
        <body style="font-family: system-ui; padding: 20px;">
          <h2>TikTok login OK ✅</h2>
          <p>Du kan lukke dette vindue og gå tilbage til Europepush.</p>
          <a href="${redirectBack}">Tilbage til dashboard</a>
        </body>
      </html>
    `);
  } catch (err) {
    console.error("TikTok callback exception:", err);
    res.status(500).send("Server error i TikTok callback");
  }
});

// Status til Base44: er der nogen konti?
app.get("/auth/tiktok/status", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("tiktok_accounts")
      .select("id, username, display_name, avatar_url")
      .limit(1);

    if (error) {
      console.error("Supabase tiktok_accounts status error:", error);
      return res.json({ ok: false, connected: false, error: "supabase_error" });
    }

    const connected = !!(data && data.length > 0);
    res.json({
      ok: true,
      connected,
      accounts: data || []
    });
  } catch (err) {
    console.error("Status error:", err);
    res.json({ ok: false, connected: false, error: "exception" });
  }
});

// Liste af alle TikTok-konti (dropdown til flere konti)
app.get("/tiktok/accounts", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("tiktok_accounts")
      .select("id, username, display_name, avatar_url, created_at")
      .order("created_at", { ascending: true });

    if (error) {
      console.error("Supabase tiktok_accounts list error:", error);
      return res.status(500).json({ ok: false, error: "supabase_error" });
    }

    res.json({ ok: true, accounts: data || [] });
  } catch (err) {
    console.error("/tiktok/accounts exception:", err);
    res.status(500).json({ ok: false, error: "exception" });
  }
});

// ----------------- START SERVER -----------------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
