import express from "express";
import cors from "cors";
// Hvis din Node version < 18, så kør: npm i undici
// import { fetch } from "undici";

const app = express();
app.use(cors());
app.use(express.json());

/** In-memory job store */
const jobs = new Map();

/** Tiny helpers */
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const uniq = (arr) => [...new Set(arr || [])];
const now = () => new Date().toISOString();

/** Robust webhook notifier */
async function notify(url, body) {
  try {
    if (!url || typeof url !== "string") return;
    if (!/^https?:\/\//i.test(url)) return;
    if (url.includes("base44-webhook-url")) return; // ignorer fake webhook

    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      console.log("⚠️ webhook non-200:", res.status);
    }
  } catch (e) {
    console.log("⚠️ webhook notify failed (suppressed):", e.message);
  }
}

/** Healthcheck */
app.get("/", (_req, res) => res.json({ status: "API running" }));

/** Create job */
app.post("/jobs", async (req, res) => {
  const p = req.body || {};

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
  const job = {
    job_id: jobId,
    created_at: now(),
    state: "queued",
    progress: 0,
    input: { source, preset, variations, targetPlatforms, accounts, soundStrategy, postingPolicy },
    outputs: [],
    events: [{ at: now(), state: "queued" }],
  };

  jobs.set(jobId, job);
  console.log("🚀 New Base44 job received:", JSON.stringify(p, null, 2));

  res.status(201).json({ job_id: jobId, state: job.state, progress: job.progress });

  // ---- Simuleret workflow ----

  // 1️⃣ queued -> processing
  setTimeout(async () => {
    const j = jobs.get(jobId);
    if (!j) return;
    j.state = "processing";
    j.progress = 35;
    j.events.push({ at: now(), state: "processing" });
    await notify(webhookStatusUrl, { job_id: jobId, state: j.state, progress: j.progress });
  }, 800);

  // 2️⃣ processing -> generate outputs
  setTimeout(async () => {
    const j = jobs.get(jobId);
    if (!j) return;

    const baseOut = "https://files.example.com/" + jobId;
    const hooks = [
      "ICEBERG drop i dag ❄️",
      "Ny batch – er du klar?",
      "Bedre end kaffe?",
      "Du scroller – vi leverer 🚀",
      "Topkommentar får svar!"
    ];
    const ctas = [
      "Følg for mere",
      "Skriv ‘is’ hvis du vil se del 2",
      "Gem videoen til senere",
      "Tag en ven",
      "Hvad synes du?"
    ];
    const hashtags = ["#europesnus", "#nordic", "#fyp", "#shorts"];

    const out = Array.from({ length: j.input.variations }).map((_, i) => {
      const hook = hooks[i % hooks.length];
      const cta = ctas[i % ctas.length];
      return {
        id: i + 1,
        url: `${baseOut}/clip_v${i + 1}.mp4`,
        caption: `${hook} — ${cta}`,
        hashtags
      };
    });

    j.outputs = out;
    j.progress = 70;
    await notify(webhookStatusUrl, { job_id: jobId, state: j.state, progress: j.progress, outputs: out.map(o => o.url) });
  }, 2000);

  // 3️⃣ processing -> complete
  setTimeout(async () => {
    const j = jobs.get(jobId);
    if (!j) return;
    j.state = "complete";
    j.progress = 100;
    j.events.push({ at: now(), state: "complete" });
    await notify(webhookStatusUrl, { job_id: jobId, state: j.state, progress: j.progress });
  }, 3500);
});

/** Get job status */
app.get("/jobs/:job_id", (req, res) => {
  const job = jobs.get(req.params.job_id);
  if (!job) return res.status(404).json({ error: "job not found" });
  res.json(job);
});

/** Mock accounts endpoint */
app.get("/accounts", (_req, res) => {
  res.json({
    tiktok: [{ id: "tk_main", handle: "@brandmain" }, { id: "tk_alt", handle: "@brandalt" }],
    instagram: [{ id: "ig_brand", handle: "@brandofficial" }],
    youtube: [{ id: "yt_brand", handle: "Brand Channel" }]
  });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server on ${PORT}`));
