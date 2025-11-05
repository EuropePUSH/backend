// index.js — EuropePush backend (Render + Supabase Storage)
// Requires: express, cors, @supabase/supabase-js
// Env vars (Render): SUPABASE_URL, SUPABASE_SERVICE_KEY, API_KEY

import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// ---------- ENV + SUPABASE ----------
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
const SUPABASE_SERVICE_KEY = (process.env.SUPABASE_SERVICE_KEY || "").trim();
const API_KEY = (process.env.API_KEY || "").trim();

console.log("🔧 ENV SUPABASE_URL:", SUPABASE_URL ? "present" : "MISSING");
console.log("🔧 ENV SUPABASE_SERVICE_KEY:", SUPABASE_SERVICE_KEY ? "present" : "MISSING");
console.log("🔧 ENV API_KEY:", API_KEY ? "present" : "MISSING");

const supabase = (SUPABASE_URL && SUPABASE_SERVICE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;

const nowISO = () => new Date().toISOString();
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const uniq = (arr) => [...new Set(arr || [])];

// ---------- SIMPLE AUTH (x-api-key) ----------
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

async function uploadToStoragePublic(jobId, buf) {
  // Bucket = "outputs" (public). Sti: jobs/<job_id>/clip_v1.mp4
  const path = `jobs/${jobId}/clip_v1.mp4`;
  const { error: upErr } = await supabase
    .storage.from("outputs")
    .upload(path, buf, { contentType: "video/mp4", upsert: true });
  if (upErr) throw upErr;

  const { data } = supabase.storage.from("outputs").getPublicUrl(path);
  return data.publicUrl; // direkte offentlig URL
}

// ---------- MISC ----------
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
    const source = String(p.source_video_url || "");
    if (!source || !source.toLowerCase().endsWith(".mp4")) {
      return res.status(400).json({ error: "source_video_url must be a .mp4 url" });
    }

    const preset = String(p.preset_id || "default");
    const variations = clamp(parseInt(p.variations || 1, 10), 1, 50); // vi uploader 1:1 i V1
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
      input: { source, preset, variations, targetPlatforms, accounts, soundStrategy, postingPolicy }
    });

    // Svar med det samme, så UI får job_id
    res.status(201).json({ job_id: jobId, state: "queued", progress: 0 });

    // Simpel simuleret pipeline:
    // 35% — accepteret og i gang
    setTimeout(async () => {
      await dbUpdateState(jobId, "processing", 35);
      await notify(webhookStatusUrl, { job_id: jobId, state: "processing", progress: 35 });
    }, 600);

    // 70% — hent kilde, upload til Storage (public), gem output
    setTimeout(async () => {
      try {
        const buf = await fetchMp4ToBuffer(source);
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

// Valgfri: accepter også GET /jobs?id=<job_id> (gør frontend mere tolerant)
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
