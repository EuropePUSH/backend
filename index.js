// index.js (ESM)

import express from "express";
import cors from "cors";
import crypto from "crypto";
import fs from "fs/promises";
import fss from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import ffmpegBin from "ffmpeg-static";
import { execa } from "execa";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

// ----------------- Setup -----------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// ----------------- ENV -----------------
const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.API_KEY || "";

// Supabase (STORAGE for output files)
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// TikTok OAuth
const TIKTOK_CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY || "";
const TIKTOK_CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET || "";

// Hvis du bruger custom domæne:
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://api.europepush.com";
// (fallback kunne være Render URL: https://backend-ipt2.onrender.com )

const TIKTOK_REDIRECT_URL =
  process.env.TIKTOK_REDIRECT_URL ||
  `${PUBLIC_BASE_URL.replace(/\/$/, "")}/auth/tiktok/callback`;

// ----------------- Simple auth middleware -----------------
function requireKey(req, res, next) {
  const key = req.headers["x-api-key"];
  if (!API_KEY || key !== API_KEY) {
    return res.status(401).json({ error: "missing_or_invalid_api_key" });
  }
  next();
}

// ----------------- Persistence (TikTok accounts) -----------------
// Enkel fil-baseret storage så vi kan demo. (Skift til DB når klar)
const ACCOUNTS_FILE = path.join(__dirname, "tiktok_accounts.json");

async function loadAccounts() {
  try {
    const raw = await fs.readFile(ACCOUNTS_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return []; // tom
  }
}
async function saveAccounts(list) {
  await fs.writeFile(ACCOUNTS_FILE, JSON.stringify(list, null, 2), "utf8");
}
async function upsertAccount(account) {
  const list = await loadAccounts();
  const idx = list.findIndex((a) => a.open_id === account.open_id);
  if (idx >= 0) list[idx] = { ...list[idx], ...account };
  else list.push(account);
  await saveAccounts(list);
}

// ----------------- Utilities -----------------
function makeJobId() {
  return "job_" + crypto.randomBytes(6).toString("hex");
}
async function downloadToTemp(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Download failed: ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const tmpFile = path.join(os.tmpdir(), "in_" + crypto.randomBytes(6).toString("hex") + ".mp4");
  await fs.writeFile(tmpFile, buf);
  return tmpFile;
}
async function runFFmpeg(inPath, outPath) {
  const vf =
    "scale=w=1080:h=1920:force_original_aspect_ratio=decrease:flags=lanczos+accurate_rnd+full_chroma_int," +
    "pad=1080:1920:(1080-iw*min(1080/iw\\,1920/ih))/2:(1920-ih*min(1080/iw\\,1920/ih))/2," +
    "crop=1080-4:1920-4:2:2,pad=1080:1920:(1080-iw)/2:(1920-ih)/2";

  const args = [
    "-y",
    "-hide_banner",
    "-nostdin",
    "-threads",
    "1",
    "-i",
    inPath,
    "-vf",
    vf,
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
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    outPath,
  ];
  await execa(ffmpegBin, args, { stdout: "inherit", stderr: "inherit" });
}

async function uploadBufferToSupabase(buffer, key) {
  const { error } = await supabase.storage
    .from("outputs")
    .upload(key, buffer, { contentType: "video/mp4", upsert: true });
  if (error) throw error;
  const { data } = supabase.storage.from("outputs").getPublicUrl(key);
  return data.publicUrl;
}

// ----------------- In-memory job store -----------------
const jobs = new Map(); // id -> { id, source_url, status, out_url, error }

// ----------------- Health -----------------
app.get("/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ----------------- TikTok: debug + start + callback + accounts -----------------
app.get("/auth/tiktok/debug", (_req, res) => {
  res.json({
    client_key_present: !!TIKTOK_CLIENT_KEY,
    client_key_len: TIKTOK_CLIENT_KEY.length,
    client_key_preview: TIKTOK_CLIENT_KEY ? TIKTOK_CLIENT_KEY.slice(0, 4) + "…" + TIKTOK_CLIENT_KEY.slice(-4) : "",
    client_secret_present: !!TIKTOK_CLIENT_SECRET,
    client_secret_len: TIKTOK_CLIENT_SECRET.length,
    redirect_uri: TIKTOK_REDIRECT_URL,
  });
});

app.get("/auth/tiktok/start", (_req, res) => {
  if (!TIKTOK_CLIENT_KEY) return res.status(500).send("Missing TikTok client key");
  const state = "state_epush_123";
  const scopes = ["user.info.basic", "video.upload", "video.publish"].join(",");
  const authorize = new URL("https://www.tiktok.com/v2/auth/authorize/");
  authorize.searchParams.set("client_key", TIKTOK_CLIENT_KEY);
  authorize.searchParams.set("scope", scopes);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("redirect_uri", TIKTOK_REDIRECT_URL);
  authorize.searchParams.set("state", state);
  res.redirect(authorize.toString());
});

app.get("/auth/tiktok/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query;
  if (error) return res.status(400).send(`TikTok error: ${error} - ${error_description || ""}`);
  if (!code) return res.status(400).send("missing code");

  // 1) Exchange code for tokens
  const tokenResp = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body: new URLSearchParams({
      client_key: TIKTOK_CLIENT_KEY,
      client_secret: TIKTOK_CLIENT_SECRET,
      code: String(code),
      grant_type: "authorization_code",
      redirect_uri: TIKTOK_REDIRECT_URL,
    }),
  });
  const tokens = await tokenResp.json();

  // 2) Try fetch user info with required fields (avoid 400)
  let me = { warn: "user.info returned non-JSON" };
  try {
    if (tokens.access_token) {
      const meResp = await fetch("https://open.tiktokapis.com/v2/user/info/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokens.access_token}`,
        },
        body: JSON.stringify({ fields: ["open_id", "display_name"] }),
      });
      const meJson = await meResp.json();
      me = meJson;

      // Persist account for dropdown:
      const open_id = meJson?.data?.user?.open_id || tokens.open_id || null;
      if (open_id) {
        await upsertAccount({
          open_id,
          display_name: meJson?.data?.user?.display_name || "TikTok User",
          tokens, // gem rå tokens i demo – byt til krypteret/DB i prod
          connected_at: new Date().toISOString(),
        });
      }
    }
  } catch (e) {
    me = { warn: "user.info fetch failed", error: String(e?.message || e) };
  }

  // Nem tekstlig kvittering (demo)
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(
    `TikTok Login OK\nstate: ${state}\n\n${JSON.stringify({ tokens }, null, 2)}\n${JSON.stringify(
      { me },
      null,
      2
    )}\n\nGem tokens i din database/session i stedet for at vise dem i produktion.`
  );
});

// Liste over tilkoblede konti (til dropdown)
app.get("/tiktok/accounts", requireKey, async (_req, res) => {
  const list = await loadAccounts();
  const view = list.map((a) => ({
    open_id: a.open_id,
    display_name: a.display_name || "TikTok User",
    connected_at: a.connected_at,
  }));
  res.json(view);
});

// (Stub) Post til TikTok sandbox – accepterer job + caption + konto og svarer “queued”
app.post("/tiktok/sandbox/post", requireKey, async (req, res) => {
  const { job_id, open_id, caption } = req.body || {};
  if (!job_id || !open_id) return res.status(400).json({ error: "missing job_id or open_id" });

  const job = jobs.get(job_id);
  if (!job || job.status !== "done" || !job.out_url) {
    return res.status(400).json({ error: "job_not_ready" });
  }

  // Find konto
  const accounts = await loadAccounts();
  const acc = accounts.find((a) => a.open_id === open_id);
  if (!acc) return res.status(404).json({ error: "account_not_found" });

  // DEMO: vi svarer queued og logger. (Skift til rigtig TikTok publish når klar)
  console.log("[SANDBOX POST] would post to TikTok:", { open_id, caption, video_url: job.out_url });
  return res.json({
    status: "queued",
    note: "Demo stub – video_url accepteret. Skift senere til rigtig TikTok publish.",
    open_id,
    job_id,
    video_url: job.out_url,
  });
});

// ----------------- Jobs pipeline -----------------
app.post("/jobs", requireKey, async (req, res) => {
  const { source_video_url } = req.body || {};
  if (!source_video_url) return res.status(400).json({ error: "missing source_video_url" });

  const id = makeJobId();
  jobs.set(id, { id, source_url: source_video_url, status: "queued" });
  res.json({ id, status: "queued" });

  // kør async
  try {
    const inPath = await downloadToTemp(source_video_url);
    const outPath = path.join(os.tmpdir(), `out_${id}.mp4`);
    jobs.set(id, { ...jobs.get(id), status: "processing" });
    await runFFmpeg(inPath, outPath);

    const buffer = await fs.readFile(outPath);
    const key = `jobs/${id}/clip_${Date.now()}.mp4`;
    const publicUrl = await uploadBufferToSupabase(buffer, key);

    jobs.set(id, { ...jobs.get(id), status: "done", out_url: publicUrl });
  } catch (e) {
    console.error("Job error:", e);
    jobs.set(id, { ...jobs.get(id), status: "error", error: String(e?.message || e) });
  }
});

app.get("/jobs/:id", requireKey, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "not_found" });
  res.json(job);
});

// ----------------- Start server -----------------
app.listen(PORT, () => {
  console.log("✅ Server on", PORT);
  console.log("🔧 PUBLIC_BASE_URL:", PUBLIC_BASE_URL);
  console.log("🔧 TIKTOK_REDIRECT_URL:", TIKTOK_REDIRECT_URL);
});
