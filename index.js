// index.js — EuropePush backend (FFmpeg + Supabase Storage + robust fallback)
// Env (Render): SUPABASE_URL, SUPABASE_SERVICE_KEY (service_role), API_KEY
// Storage: Supabase public bucket "outputs"

import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import ffmpeg from "ffmpeg-static";
import { execa } from "execa";
import fs from "fs/promises";
import path from "path";

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" })); // allow base64 video payloads

// ---------- ENV ----------
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
const SUPABASE_SERVICE_KEY = (process.env.SUPABASE_SERVICE_KEY || "").trim();
const API_KEY = (process.env.API_KEY || "").trim();

console.log("🔧 ENV SUPABASE_URL:", SUPABASE_URL ? "present" : "MISSING");
console.log("🔧 ENV SUPABASE_SERVICE_KEY:", SUPABASE_SERVICE_KEY ? "present" : "MISSING");
console.log("🔧 ENV API_KEY:", API_KEY ? "present" : "MISSING");

const supabase = (SUPABASE_URL && SUPABASE_SERVICE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;

// ---------- UTILS ----------
const nowISO = () => new Date().toISOString();
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const uniq = (arr) => [...new Set(arr || [])];

// ---------- AUTH (x-api-key on POST /jobs) ----------
app.use((req, res, next) => {
  if (req.method === "POST" && (req.path === "/jobs" || req.path === "/jobs/")) {
    const headerKey = (req.headers["x-api-key"] ?? "").toString().trim();
    if (!API_KEY || headerKey !== API_KEY) {
      console.log("AUTH DEBUG:", {
        env_len: API_KEY.length,
        header_len: headerKey.length,
        bearer_len: 0
      });
      return res.status(401).json({ error: "unauthorized" });
    }
  }
  next();
});

// ---------- DB HELPERS ----------
async function dbCreateJob(job) {
  if (!supabase) throw new Error("supabase not configured");
  const { error } = await supabase.from("jobs").insert({
    job_id: job.job_id,
    state: job.state,
    progress: job.progress,
    input: job.input
  });
  if (error) throw error;

  const { error: e2 } = await supabase.from("job_events").insert({
    job_id: job.job_id,
    state: "queued",
    progress: 0,
    payload: { created_at: job.created_at }
  });
  if (e2) throw e2;
}

async function dbUpdateState(job_id, state, progress, payload = null) {
  if (!supabase) throw new Error("supabase not configured");
  const { error } = await supabase.from("jobs").update({ state, progress }).eq("job_id", job_id);
  if (error) throw error;
  const { error: e2 } = await supabase.from("job_events").insert({ job_id, state, progress, payload });
  if (e2) throw e2;
}

async function dbSetOutputs(job_id, outputs) {
  if (!supabase) throw new Error("supabase not configured");
  await supabase.from("job_outputs").delete().eq("job_id", job_id);
  const rows = outputs.map((o, i) => ({
    job_id,
    idx: i + 1,
    url: o.url,
    caption: o.caption || null,
    hashtags: o.hashtags || null
  }));
  const { error } = await supabase.from("job_outputs").insert(rows);
  if (error) throw error;
}

async function dbGetJob(job_id) {
  if (!supabase) throw new Error("supabase not configured");
  const { data: job, error } = await supabase
    .from("jobs").select("*").eq("job_id", job_id).maybeSingle();
  if (error) throw error;
  if (!job) return null;

  const [{ data: outputs }, { data: events }] = await Promise.all([
    supabase.from("job_outputs").select("*").eq("job_id", job_id).order("idx", { ascending: true }),
    supabase.from("job_events").select("*").eq("job_id", job_id).order("id", { ascending: true })
  ]);

  return {
    job_id,
    created_at: job.created_at,
    state: job.state,
    progress: job.progress,
    input: job.input || {},
    outputs: (outputs || []).map(o => ({
      id: o.idx, url: o.url, caption: o.caption, hashtags: o.hashtags
    })),
    events: (events || []).map(e => ({
      at: e.at, state: e.state, progress: e.progress, payload: e.payload
    }))
  };
}

// ---------- STORAGE HELPERS ----------
async function fetchMp4ToBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

// robust base64 parser (accept data-URL or raw base64)
function parseBase64Video(input) {
  if (!input || typeof input !== "string") return null;
  let base64 = input.trim();
  const commaIdx = base64.indexOf(",");
  if (base64.startsWith("data:")) {
    if (commaIdx === -1) return null;
    base64 = base64.slice(commaIdx + 1);
  }
  try {
    const buf = Buffer.from(base64, "base64");
    console.log("BASE64 decoded bytes:", buf.length);
    return buf.length > 0 ? buf : null;
  } catch (e) {
    console.log("BASE64 decode error:", e.message);
    return null;
  }
}

async function uploadToStoragePublic(jobId, buf) {
  const pathKey = `jobs/${jobId}/clip_v1.mp4`;
  const { error: upErr } = await supabase
    .storage.from("outputs")
    .upload(pathKey, buf, { contentType: "video/mp4", upsert: true });
  if (upErr) throw upErr;
  const { data } = supabase.storage.from("outputs").getPublicUrl(pathKey);
  return data.publicUrl; // public bucket → direct URL
}

// ---------- FFmpeg HELPERS ----------
const TMP_DIR = "/tmp";

async function writeTemp(buf, filename) {
  const p = path.join(TMP_DIR, filename);
  await fs.writeFile(p, buf);
  return p;
}

async function processVideoTo1080x1920(inPath, outPath, { hook = "ICEBERG drop i dag ❄️", watermark = "@europepush" } = {}) {
  // Simple V1: scale+pad to 1080x1920 + two drawtext overlays
  const vf =
    "scale=w=1080:h=1920:force_original_aspect_ratio=decrease," +
    "pad=1080:1920:(1080-iw*min(1080/iw\\,1920/ih))/2:(1920-ih*min(1080/iw\\,1920/ih))/2," +
    `drawtext=text='${hook.replace(/:/g, '\\:').replace(/'/g, "\\'")}':fontcolor=white:fontsize=48:box=1:boxcolor=black@0.35:boxborderw=10:x=(w-text_w)/2:y=120,` +
    `drawtext=text='${watermark.replace(/:/g, '\\:').replace(/'/g, "\\'")}':fontcolor=white@0.7:fontsize=28:x=40:y=80`;

  const args = [
    "-y",
    "-i", inPath,
    "-vf", vf,
    "-c:v", "libx264",
    "-profile:v", "high",
    "-pix_fmt", "yuv420p",
    "-preset", "veryfast",
    "-crf", "23",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    outPath
  ];

  await execa(ffmpeg, args);
}

async function processBufferWithFFmpeg(buf, jobId, overlayOpts = {}) {
  const inPath = await writeTemp(buf, `in_${jobId}.mp4`);
  const outPath = path.join(TMP_DIR, `out_${jobId}.mp4`);
  await processVideoTo1080x1920(inPath, outPath, overlayOpts);
  const outBuf = await fs.readFile(outPath);
  return outBuf;
}

// ---------- NOTIFY ----------
async function notify(url, body) {
  try {
    if (!url || typeof url !== "string") return;
    if (!/^https?:\/\//i.test(url)) return;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) console.log("⚠️ webhook non-200:", res.status);
  } catch (e) {
    console.log("⚠️ webhook notify failed:", e.message);
  }
}

// ---------- HEALTH ----------
app.get("/", (_req, res) => res.json({ status: "API running" }));
app.get("/health", async (_req, res) => {
  try {
    if (!supabase) throw new Error("supabase not configured");
    const { error } = await supabase.from("jobs").select("count", { count: "exact", head: true });
    if (error) throw error;
    res.json({ up: true, db: true });
  } catch {
    res.status(500).json({ up: true, db: false });
  }
});

// ---------- JOBS ----------
app.post("/jobs", async (req, res) => {
  try {
    const p = req.body || {};

    // Accept either URL (.mp4) or base64
    const sourceUrl = typeof p.source_video_url === "string" ? p.source_video_url.trim() : "";
    const sourceB64 = typeof p.source_video_base64 === "string" ? p.source_video_base64 : "";

    let sourceType = null; // "url" | "base64"
    if (sourceUrl && sourceUrl.toLowerCase().endsWith(".mp4")) {
      sourceType = "url";
    } else if (sourceB64) {
      sourceType = "base64";
    } else {
      return res.status(400).json({ error: "Provide source_video_url (.mp4) OR source_video_base64 (data URL or raw base64)" });
    }

    const preset = String(p.preset_id || "default");
    const variations = clamp(parseInt(p.variations || 1, 10), 1, 50);
    const targetPlatforms = uniq(p.target_platforms || []);
    const accounts = {
      tiktok: uniq(p.accounts?.tiktok || []),
      instagram: uniq(p.accounts?.instagram || []),
      youtube: uniq(p.accounts?.youtube || [])
    };
    const soundStrategy = p.sound_strategy || null;
    const postingPolicy = p.posting_policy || null;
    const webhookStatusUrl = p.webhook_status_url || null;

    const jobId = "job_" + Math.random().toString(36).slice(2, 10);
    await dbCreateJob({
      job_id: jobId,
      created_at: nowISO(),
      state: "queued",
      progress: 0,
      input: {
        source: sourceType === "url" ? sourceUrl : "(base64)",
        preset, variations, targetPlatforms, accounts, soundStrategy, postingPolicy
      }
    });

    // Respond immediately (UI can start polling)
    res.status(201).json({ job_id: jobId, state: "queued", progress: 0 });

    // ---- Pipeline ----

    // 35% — accepted
    setTimeout(async () => {
      await dbUpdateState(jobId, "processing", 35);
      await notify(webhookStatusUrl, { job_id: jobId, state: "processing", progress: 35 });
    }, 600);

    // 70% — get buffer (url/base64), try FFmpeg; if it fails, upload original buffer
    setTimeout(async () => {
      try {
        let srcBuf;
        if (sourceType === "url") {
          srcBuf = await fetchMp4ToBuffer(sourceUrl);
          console.log("Downloaded source bytes:", srcBuf.length);
        } else {
          srcBuf = parseBase64Video(sourceB64);
          if (!srcBuf) throw new Error("invalid base64 input for video");
        }

        let editedBuf;
        try {
          editedBuf = await processBufferWithFFmpeg(srcBuf, jobId, {
            hook: "ICEBERG drop i dag ❄️",
            watermark: "@europepush"
          });
          console.log("FFmpeg output bytes:", editedBuf.length);
        } catch (fferr) {
          console.error("FFmpeg failed, falling back to original buffer:", fferr.message);
          editedBuf = srcBuf; // fallback → you still get a file
        }

        const url = await uploadToStoragePublic(jobId, editedBuf);

        const out = [{
          url,
          caption: "ICEBERG drop ❄️ — Følg for mere",
          hashtags: ["#europesnus", "#iceberg", "#fyp"]
        }];

        await dbSetOutputs(jobId, out);
        await dbUpdateState(jobId, "processing", 70, { outputs: out.map(o => o.url) });
        await notify(webhookStatusUrl, { job_id: jobId, state: "processing", progress: 70, outputs: out.map(o => o.url) });

      } catch (e) {
        console.error("upload pipeline error:", e);
        await dbUpdateState(jobId, "failed", 100, { error: String(e.message || e) });
        await notify(webhookStatusUrl, { job_id: jobId, state: "failed", progress: 100, error: String(e.message || e) });
        return;
      }
    }, 1800);

    // 100% — complete
    setTimeout(async () => {
      await dbUpdateState(jobId, "complete", 100);
      await notify(webhookStatusUrl, { job_id: jobId, state: "complete", progress: 100 });
    }, 3000);

  } catch (err) {
    console.error("❌ POST /jobs error:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

// GET /jobs/:job_id — status + outputs
app.get("/jobs/:job_id", async (req, res) => {
  try {
    const job = await dbGetJob(req.params.job_id);
    if (!job) return res.status(404).json({ error: "job not found" });
    res.json(job);
  } catch (err) {
    console.error("❌ GET /jobs/:id error:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

// Optional tolerance: GET /jobs?id=<job_id>
app.get("/jobs", async (req, res) => {
  const id = req.query.id || req.query.job_id;
  if (!id) return res.status(400).json({ error: "missing job_id" });
  try {
    const job = await dbGetJob(String(id));
    if (!job) return res.status(404).json({ error: "job not found" });
    res.json(job);
  } catch (err) {
    console.error("❌ GET /jobs (query) error:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

// ---------- START ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server on ${PORT}`));
