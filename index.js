import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
// import { fetch } from "undici"; // kun hvis din Node < 18

const app = express();
app.use(cors());
app.use(express.json());

// ======== ENV CHECK ========
const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
console.log("🔧 ENV SUPABASE_URL:", SUPABASE_URL ? "present" : "MISSING");
console.log("🔧 ENV SUPABASE_SERVICE_KEY:", SUPABASE_SERVICE_KEY ? "present" : "MISSING");

// ======== SUPABASE CLIENT ========
const supabase = (SUPABASE_URL && SUPABASE_SERVICE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;

// ======== HELPERS ========
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const uniq  = (arr) => [...new Set(arr || [])];
const now   = () => new Date().toISOString();

async function notify(url, body) {
  try {
    if (!url || typeof url !== "string") return;
    if (!/^https?:\/\//i.test(url)) return;
    if (url.includes("base44-webhook-url")) return;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) console.log("⚠️ webhook non-200:", res.status);
  } catch (e) {
    console.log("⚠️ webhook notify failed (suppressed):", e.message);
  }
}

// ======== DB WRAPPERS (med HARD LOGS) ========
async function dbCreateJob(job) {
  if (!supabase) throw new Error("Supabase client not configured");
  console.log("📝 dbCreateJob", job.job_id);
  const { error } = await supabase.from("jobs").insert({
    job_id: job.job_id,
    state: job.state,
    progress: job.progress,
    input: job.input
  });
  if (error) {
    console.error("❌ dbCreateJob error:", error);
    throw error;
  }
  const { error: e2 } = await supabase.from("job_events").insert({
    job_id: job.job_id,
    state: "queued",
    progress: 0,
    payload: { created_at: job.created_at }
  });
  if (e2) {
    console.error("❌ db job_events insert error:", e2);
    throw e2;
  }
  console.log("✅ dbCreateJob done", job.job_id);
}

async function dbUpdateState(job_id, state, progress, payload = null) {
  if (!supabase) throw new Error("Supabase client not configured");
  console.log("📝 dbUpdateState", job_id, state, progress);
  const { error } = await supabase.from("jobs").update({ state, progress }).eq("job_id", job_id);
  if (error) {
    console.error("❌ dbUpdateState error:", error);
    throw error;
  }
  const { error: e2 } = await supabase.from("job_events").insert({ job_id, state, progress, payload });
  if (e2) {
    console.error("❌ db job_events insert error:", e2);
    throw e2;
  }
  console.log("✅ dbUpdateState done", job_id, state);
}

async function dbSetOutputs(job_id, outputs) {
  if (!supabase) throw new Error("Supabase client not configured");
  console.log("📝 dbSetOutputs", job_id, outputs.length);
  await supabase.from("job_outputs").delete().eq("job_id", job_id);
  const rows = outputs.map((o, i) => ({
    job_id, idx: i + 1, url: o.url, caption: o.caption, hashtags: o.hashtags
  }));
  const { error } = await supabase.from("job_outputs").insert(rows);
  if (error) {
    console.error("❌ dbSetOutputs error:", error);
    throw error;
  }
  console.log("✅ dbSetOutputs done", job_id);
}

async function dbGetJob(job_id) {
  if (!supabase) throw new Error("Supabase client not configured");
  console.log("🔎 dbGetJob", job_id);
  const { data: job, error: e1 } = await supabase
    .from("jobs").select("*").eq("job_id", job_id).maybeSingle();
  if (e1) throw e1;
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

// ======== ROUTES ========
app.get("/", (_req, res) => res.json({ status: "API running" }));

// 🔬 DB ping – viser om env/forbindelse er OK
app.get("/db/ping", async (_req, res) => {
  try {
    if (!supabase) throw new Error("Supabase client not configured");
    const { error } = await supabase.from("jobs").select("count", { count: "exact", head: true });
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    console.error("❌ /db/ping", e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// 🧪 test insert – skriver en dummy job-række (til at bekræfte DB WRITE)
app.post("/db/test-insert", async (_req, res) => {
  try {
    const jobId = "job_test_" + Math.random().toString(36).slice(2, 8);
    await dbCreateJob({
      job_id: jobId,
      created_at: now(),
      state: "queued",
      progress: 0,
      input: { test: true }
    });
    res.json({ ok: true, job_id: jobId });
  } catch (e) {
    console.error("❌ /db/test-insert", e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Create job – fra Base44
app.post("/jobs", async (req, res) => {
  const p = req.body || {};
  console.log("🚀 New Base44 job received:", JSON.stringify(p, null, 2));

  try {
    const source = String(p.source_video_url || "");
    if (!source.endsWith(".mp4")) {
      return res.status(400).json({ error: "source_video_url must be an MP4 url" });
    }
    const preset = String(p.preset_id || "default");
    const variations = clamp(parseInt(p.variations || 1, 10), 1, 50);
    const targetPlatforms = uniq(p.target_platforms || []);
    const accounts = {
      tiktok: uniq(p.accounts?.tiktok || []),
      instagram: uniq(p.accounts?.instagram || []),
      youtube: uniq(p.accounts?.youtube || []),
    };
    const soundStrategy = p.sound_strategy || null;
    const postingPolicy = p.posting_policy || null;
    const webhookStatusUrl = p.webhook_status_url || null;

    const jobId = "job_" + Math.random().toString(36).slice(2, 10);
    console.log("🆔 creating job:", jobId);

    await dbCreateJob({
      job_id: jobId,
      created_at: now(),
      state: "queued",
      progress: 0,
      input: { source, preset, variations, targetPlatforms, accounts, soundStrategy, postingPolicy }
    });

    res.status(201).json({ job_id: jobId, state: "queued", progress: 0 });

    // Simuleret workflow
    setTimeout(async () => {
      await dbUpdateState(jobId, "processing", 35);
      await notify(webhookStatusUrl, { job_id: jobId, state: "processing", progress: 35 });
    }, 800);

    setTimeout(async () => {
      const hooks = [
        "ICEBERG drop i dag ❄️", "Ny batch – er du klar?", "Bedre end kaffe?",
        "Du scroller – vi leverer 🚀", "Topkommentar får svar!"
      ];
      const ctas = [
        "Følg for mere", "Skriv ‘is’ hvis du vil se del 2",
        "Gem videoen til senere", "Tag en ven", "Hvad synes du?"
      ];
      const hashtags = ["#europesnus", "#nordic", "#fyp", "#shorts"];
      const baseOut = "https://files.example.com/" + jobId;

      const out = Array.from({ length: variations }).map((_, i) => ({
        url: `${baseOut}/clip_v${i + 1}.mp4`,
        caption: `${hooks[i % hooks.length]} — ${ctas[i % ctas.length]}`,
        hashtags
      }));

      await dbSetOutputs(jobId, out);
      await dbUpdateState(jobId, "processing", 70, { outputs: out.map(o => o.url) });
      await notify(webhookStatusUrl, { job_id: jobId, state: "processing", progress: 70, outputs: out.map(o => o.url) });
    }, 2000);

    setTimeout(async () => {
      await dbUpdateState(jobId, "complete", 100);
      await notify(webhookStatusUrl, { job_id: jobId, state: "complete", progress: 100 });
    }, 3500);

  } catch (err) {
    console.error("❌ POST /jobs error:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

// Job status
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

// Accounts mock
app.get("/accounts", (_req, res) => {
  res.json({
    tiktok: [{ id: "tk_main", handle: "@brandmain" }, { id: "tk_alt", handle: "@brandalt" }],
    instagram: [{ id: "ig_brand", handle: "@brandofficial" }],
    youtube: [{ id: "yt_brand", handle: "Brand Channel" }]
  });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server on ${PORT}`));
