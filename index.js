// index.js (ESM)
import express from "express";
import crypto from "crypto";
import os from "os";
import path from "path";
import fs from "fs/promises";
import fss from "fs";
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

const TT_CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY || "";
const TT_CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET || "";
const TT_REDIRECT = process.env.TIKTOK_REDIRECT_URL || ""; // fx https://api.europepush.com/auth/tiktok/callback

const PUBLIC_BASE = "https://api.europepush.com";

// ----------------- APP + CORS -----------------
const app = express();

const ALLOWED_ORIGINS = [
  "https://europepush.com",
  "https://www.europepush.com",
  "http://localhost:3000",
];

app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, x-api-key"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") {
    // Preflight
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json({ limit: "20mb" }));

// ----------------- HELPERS -----------------
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP = os.tmpdir();

// simpelt in-memory token-lager (brug DB i produktion)
let TIKTOK_TOKENS = /** @type {null | {
  access_token:string, refresh_token:string, open_id?:string, scope?:string
}} */ (null);

function requireApiKey(req, res, next) {
  const k = req.header("x-api-key") || "";
  if (!API_KEY || k !== API_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

function nowId(prefix) {
  return `${prefix}_${crypto.randomBytes(4).toString("hex")}`;
}

function buildTikTokAuthorizeURL() {
  const params = new URLSearchParams({
    client_key: TT_CLIENT_KEY,
    scope: "user.info.basic,video.upload,video.publish",
    response_type: "code",
    redirect_uri: TT_REDIRECT,
    state: nowId("state_epush"),
  });
  return `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`;
}

async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  try {
    return { status: res.status, ok: res.ok, json: JSON.parse(text) };
  } catch {
    return { status: res.status, ok: res.ok, text };
  }
}

async function downloadToTmp(url) {
  const id = nowId("in_job");
  const file = path.join(TMP, `${id}.mp4`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status}`);
  await new Promise((resolve, reject) => {
    const ws = fss.createWriteStream(file);
    res.body.pipe(ws);
    res.body.on("error", reject);
    ws.on("finish", resolve);
    ws.on("error", reject);
  });
  return file;
}

async function ffmpegTranscodeToVertical(inFile) {
  const id = nowId("out_job");
  const outFile = path.join(TMP, `${id}.mp4`);

  const vf =
    "scale=w=1080:h=1920:force_original_aspect_ratio=decrease:flags=fast_bilinear," +
    "pad=1080:1920:(1080-iw*min(1080/iw\\,1920/ih))/2:(1920-ih*min(1080/iw\\,1920/ih))/2," +
    "crop=1080-4:1920-4:2:2,pad=1080:1920:(1080-iw)/2:(1920-ih)/2";

  const args = [
    "-y",
    "-hide_banner",
    "-nostdin",
    "-threads",
    "1",
    "-i",
    inFile,
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
    "ultrafast",
    "-crf",
    "21",
    "-tune",
    "fastdecode",
    "-x264-params",
    "ref=1:bframes=2:rc-lookahead=8:keyint=120:min-keyint=24:scenecut=0",
    "-maxrate",
    "3500k",
    "-bufsize",
    "7000k",
    "-max_muxing_queue_size",
    "1024",
    "-c:a",
    "copy",
    "-movflags",
    "+faststart",
    outFile,
  ];

  await execa(ffmpegBin, args, { stdio: "inherit" });
  return outFile;
}

async function uploadToSupabase(localFile, jobId) {
  const bucket = "outputs";
  const key = `jobs/${jobId}/clip_${Date.now()}.mp4`;
  const fileBuf = await fs.readFile(localFile);
  const { error } = await supabase.storage.from(bucket).upload(key, fileBuf, {
    contentType: "video/mp4",
    upsert: true,
  });
  if (error) throw error;
  const { data } = supabase.storage.from(bucket).getPublicUrl(key);
  return data.publicUrl;
}

// ----------------- HEALTH -----------------
app.get("/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ----------------- TIKTOK OAUTH -----------------

// Base44 kalder denne for at få auth-link
app.all("/auth/tiktok/connect", (req, res) => {
  console.log("[/auth/tiktok/connect] method:", req.method);

  if (!TT_CLIENT_KEY || !TT_CLIENT_SECRET || !TT_REDIRECT) {
    console.error("TikTok keys/redirect misconfigured");
    return res
      .status(500)
      .json({ ok: false, error: "misconfigured_keys", authorize_url: null });
  }

  const url = buildTikTokAuthorizeURL();
  console.log("[/auth/tiktok/connect] authorize_url:", url);

  return res.status(200).json({
    ok: true,
    authorize_url: url,
  });
});

// status til UI – viser om der er tokens
app.get("/auth/tiktok/status", (_req, res) => {
  const connected = !!(TIKTOK_TOKENS && TIKTOK_TOKENS.access_token);
  res.json({
    ok: true,
    connected,
    open_id: TIKTOK_TOKENS?.open_id || null,
    scope: TIKTOK_TOKENS?.scope || null,
  });
});

// debug (viser kun længder, ikke secrets)
app.get("/auth/tiktok/debug", (_req, res) => {
  res.json({
    client_key_present: !!TT_CLIENT_KEY,
    client_key_len: TT_CLIENT_KEY.length,
    client_secret_present: !!TT_CLIENT_SECRET,
    client_secret_len: TT_CLIENT_SECRET.length,
    redirect_uri: TT_REDIRECT,
  });
});

// callback fra TikTok
app.get("/auth/tiktok/callback", async (req, res) => {
  const code = String(req.query.code || "");
  const state = String(req.query.state || "");
  if (!code) return res.status(400).send("missing code");

  const form = new URLSearchParams();
  form.set("client_key", TT_CLIENT_KEY);
  form.set("client_secret", TT_CLIENT_SECRET);
  form.set("grant_type", "authorization_code");
  form.set("code", code);
  form.set("redirect_uri", TT_REDIRECT);

  const tokenResp = await fetchJSON("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  let meInfo = { warn: "user.info not fetched" };

  if (tokenResp.ok && tokenResp.json?.access_token) {
    const access = tokenResp.json.access_token;
    const meUrl = "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name";
    const me = await fetchJSON(meUrl, {
      headers: { Authorization: `Bearer ${access}` },
    });

    if (me.ok && me.json?.data?.user) {
      const open_id = me.json.data.user.open_id;
      TIKTOK_TOKENS = {
        access_token: access,
        refresh_token: tokenResp.json.refresh_token,
        open_id,
        scope: tokenResp.json.scope || "",
      };
      meInfo = { data: me.json.data.user };
    } else {
      meInfo = {
        warn: "user.info returned error or non-JSON",
        status: me.status,
      };
    }
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(
    `<h1>TikTok Login OK</h1>
<pre>state: ${state}</pre>
<pre>${JSON.stringify({ tokens: tokenResp.json || tokenResp.text, me: meInfo }, null, 2)}</pre>
<small>Gem tokens i DB/session i stedet for at vise dem i produktion.</small>`
  );
});

// simpelt account-endpoint – 1 “konto” baseret på open_id
app.get("/tiktok/accounts", (_req, res) => {
  if (!TIKTOK_TOKENS?.open_id) {
    return res.json({ ok: true, accounts: [] });
  }
  res.json({
    ok: true,
    accounts: [
      {
        id: TIKTOK_TOKENS.open_id,
        label: `sandbox:${TIKTOK_TOKENS.open_id.slice(0, 6)}…`,
      },
    ],
  });
});

// ----------------- JOB PROCESSOR (async) -----------------
async function updateJob(jobId, patch) {
  await supabase.from("jobs").update(patch).eq("job_id", jobId);
}

async function processJob(jobId, payload) {
  try {
    const { source_video_url } = payload;

    await updateJob(jobId, { state: "processing", progress: 5 });

    const localIn = await downloadToTmp(source_video_url);
    await updateJob(jobId, { progress: 30 });

    const localOut = await ffmpegTranscodeToVertical(localIn);
    await updateJob(jobId, { progress: 70 });

    const publicUrl = await uploadToSupabase(localOut, jobId);
    await updateJob(jobId, { progress: 90 });

    // gem output
    await supabase.from("job_outputs").insert({
      job_id: jobId,
      idx: 0,
      url: publicUrl,
      caption: null,
      hashtags: null,
    });

    await updateJob(jobId, { state: "completed", progress: 100 });
    console.log("JOB_COMPLETED", jobId, publicUrl);
  } catch (err) {
    console.error("JOB_FAILED", jobId, err);
    await updateJob(jobId, { state: "failed", progress: 100 });
  }
}

// ----------------- JOBS API -----------------

// Opret job – Base44 kalder den her
app.post("/jobs", requireApiKey, async (req, res) => {
  try {
    const {
      source_video_url,
      postToTikTok = false,
      tiktok_account_ids = [],
      ...rest
    } = req.body || {};

    if (!source_video_url) {
      return res.status(400).json({ error: "source_video_url_required" });
    }

    if (postToTikTok) {
      if (!TIKTOK_TOKENS?.access_token) {
        return res.status(400).json({ error: "tiktok_not_connected" });
      }
      if (!Array.isArray(tiktok_account_ids) || tiktok_account_ids.length === 0) {
        return res.status(400).json({ error: "tiktok_account_ids_required" });
      }
    }

    const jobId = nowId("job");

    // 1) Opret job i DB med queued state
    await supabase.from("jobs").insert({
      job_id: jobId,
      state: "queued",
      progress: 0,
      input: { source_video_url, postToTikTok, tiktok_account_ids, ...rest },
    });

    // 2) Start async processing (download + ffmpeg + upload)
    processJob(jobId, { source_video_url, postToTikTok, tiktok_account_ids, ...rest }).catch(
      (err) => {
        console.error("processJob outer error", err);
      }
    );

    // 3) Svar til klienten med det samme
    res.json({
      ok: true,
      job_id: jobId,
      state: "queued",
      progress: 0,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// Hent job-status – Base44 poller denne
app.get("/jobs/:jobId", async (req, res) => {
  const jobId = req.params.jobId;
  try {
    const { data: jobs, error: jobErr } = await supabase
      .from("jobs")
      .select("*")
      .eq("job_id", jobId)
      .limit(1);

    if (jobErr) {
      console.error("jobs select error", jobErr);
      return res.status(500).json({ error: "db_error" });
    }

    const job = jobs?.[0];
    if (!job) {
      return res.status(404).json({ error: "job_not_found" });
    }

    const { data: outs, error: outErr } = await supabase
      .from("job_outputs")
      .select("*")
      .eq("job_id", jobId)
      .order("idx", { ascending: true });

    if (outErr) {
      console.error("job_outputs select error", outErr);
    }

    const outputs = (outs || []).map((o) => ({
      idx: o.idx,
      url: o.url,
      caption: o.caption,
      hashtags: o.hashtags,
    }));

    res.json({
      ok: true,
      job_id: job.job_id,
      state: job.state,
      progress: job.progress,
      output_url: outputs[0]?.url || null,
      outputs,
    });
  } catch (e) {
    console.error("GET /jobs/:jobId error", e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ----------------- ROOT + 404 -----------------
app.get("/", (_req, res) => {
  res.type("text").send("✅ EuropePUSH backend up");
});

app.use((req, res) => {
  res.status(404).type("text").send(`Cannot ${req.method} ${req.path}`);
});

// ----------------- START -----------------
app.listen(PORT, () => {
  console.log(`✅ Server on ${PORT}`);
  console.log(`🔧 SUPABASE_URL: ${SUPABASE_URL ? "present" : "missing"}`);
  console.log(`🔧 SUPABASE_SERVICE_KEY: ${SUPABASE_SERVICE_KEY ? "present" : "missing"}`);
  console.log(`🔧 API_KEY: ${API_KEY ? "present" : "missing"}`);
  console.log(
    `🔧 TikTok keys: key=${TT_CLIENT_KEY ? "present" : "missing"} secret=${
      TT_CLIENT_SECRET ? "present" : "missing"
    }`
  );
  console.log(`🔧 Redirect: ${TT_REDIRECT || "(missing)"}`);
  console.log(`🔗 Connect URL (backend): ${PUBLIC_BASE}/auth/tiktok/connect`);
});
