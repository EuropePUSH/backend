// index.js — EuropePush backend (Render + Supabase Storage)
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, API_KEY
// Storage: Supabase public bucket "outputs"

import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" })); // større payloads for base64

// ---------- ENV ----------
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
const SUPABASE_SERVICE_KEY = (process.env.SUPABASE_SERVICE_KEY || "").trim();
const API_KEY = (process.env.API_KEY || "").trim();

console.log("🔧 ENV SUPABASE_URL:", !!SUPABASE_URL ? "present" : "MISSING");
console.log("🔧 ENV SUPABASE_SERVICE_KEY:", !!SUPABASE_SERVICE_KEY ? "present" : "MISSING");
console.log("🔧 ENV API_KEY:", !!API_KEY ? "present" : "MISSING");

const supabase = (SUPABASE_URL && SUPABASE_SERVICE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;

// ---------- UTILS ----------
const nowISO = () => new Date().toISOString();
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const uniq = (arr) => [...new Set(arr || [])];

// ---------- AUTH (x-api-key på POST /jobs) ----------
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

function parseBase64Video(input) {
  if (!input || typeof input !== "string") return null;
  let base64 = input.trim();
  // data:video/mp4;base64,XXXX...
  const commaIdx = base64.indexOf(",");
  if (base64.startsWith("data:")) {
    if (commaIdx === -1) return null;
    base64 = base64.slice(commaIdx + 1);
  }
  if (!/^[A-Za-z0-9+/=\s]+$/.test(base64)) return null;
  try {
    const buf = Buffer.from(base64, "base64");
    if (buf.length < 10 * 1024) return null; // mindst ~10KB
    return buf;
  } catch {
    return null;
  }
}

async function uploadToStoragePublic(jobId, buf) {
  const path = `jobs/${jobId}/clip_v1.mp4`;
  const { error: upErr } = await supabase
    .storage.from("outputs")
    .upload(path, buf, { contentType: "video/mp4", upsert: true });
  if (upErr) throw upErr;
  const { data } = supabase.storage.from("outputs").getPublicUrl(path);
  return data.publicUrl; // public bucket → direkte URL
}

// ---------- UTIL ----------
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

    // Kilde: enten URL (.mp4) eller base64
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

    // Svar til UI med det samme
    res.status(201).json({ job_id: jobId, state: "queued", progress: 0 });

    // ---- Simpelt pipeline forløb ----

    // 35%
    setTimeout(async () => {
      await dbUpdateState(jobId, "processing", 35);
      await notify(webhookStatusUrl, { job_id: jobId, state: "processing", progress: 35 });
    }, 600);

    // 70% — hent buffer (URL eller base64) og upload til Storage
    setTimeout(async () => {
      try {
        let buf;
        if (sourceType === "url") {
          buf = await fetchMp4ToBuffer(sourceUrl);
        } else {
          buf = parseBase64Video(sourceB64);
          if (!buf) throw new Error("invalid base64 input for video");
        }

        const url = await uploadToStoragePublic(jobId, buf);

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

// Valgfri tolerance: GET /jobs?id=<job_id>
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
