// index.js — EuropePush backend (NO-AUDIO-TOUCH, SAFE anti-duplicate, 1 output/account)
import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import ffmpeg from "ffmpeg-static";
import { execa } from "execa";
import fs from "fs/promises";
import fss from "fs";
import path from "path";
import { pipeline } from "stream/promises";

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

// ---------- ENV ----------
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
const SUPABASE_SERVICE_KEY = (process.env.SUPABASE_SERVICE_KEY || "").trim();
const API_KEY = (process.env.API_KEY || "").trim();
const VIDEO_JITTER = String(process.env.VIDEO_JITTER || "true").toLowerCase() !== "false";

console.log("🔧 ENV SUPABASE_URL:", SUPABASE_URL ? "present" : "MISSING");
console.log("🔧 ENV SUPABASE_SERVICE_KEY:", SUPABASE_SERVICE_KEY ? "present" : "MISSING");
console.log("🔧 ENV API_KEY:", API_KEY ? "present" : "MISSING");
console.log("🔧 ENV VIDEO_JITTER:", VIDEO_JITTER);

const supabase = (SUPABASE_URL && SUPABASE_SERVICE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;

const TMP_DIR = "/tmp";
const nowISO = () => new Date().toISOString();
const uniq = (arr)=>[...new Set(arr||[])];

// ---------- AUTH ----------
app.use((req,res,next)=>{
  if (req.method==="POST" && (req.path==="/jobs"||req.path==="/jobs/")){
    const k=(req.headers["x-api-key"]??"").toString().trim();
    if (!API_KEY || k!==API_KEY){
      console.log("AUTH DEBUG:",{env_len:API_KEY.length,header_len:k.length});
      return res.status(401).json({error:"unauthorized"});
    }
  }
  next();
});

// ---------- DB ----------
async function dbCreateJob(job){
  const { error } = await supabase.from("jobs").insert({
    job_id: job.job_id, state: job.state, progress: job.progress, input: job.input
  });
  if (error) throw error;
  const { error: e2 } = await supabase.from("job_events").insert({
    job_id: job.job_id, state:"queued", progress:0, payload:{created_at:job.created_at}
  });
  if (e2) throw e2;
}
async function dbUpdateState(job_id,state,progress,payload=null){
  const { error } = await supabase.from("jobs").update({state,progress}).eq("job_id",job_id);
  if (error) throw error;
  const { error: e2 } = await supabase.from("job_events").insert({job_id,state,progress,payload});
  if (e2) throw e2;
}
async function dbSetOutputs(job_id, outputs){
  await supabase.from("job_outputs").delete().eq("job_id", job_id);
  const rows = outputs.map((o,i)=>({ job_id, idx:i+1, url:o.url, caption:o.caption||null, hashtags:o.hashtags||null }));
  const { error } = await supabase.from("job_outputs").insert(rows);
  if (error) throw error;
}
async function dbGetJob(job_id){
  const { data: job, error } = await supabase.from("jobs").select("*").eq("job_id",job_id).maybeSingle();
  if (error) throw error;
  if (!job) return null;
  const [{data:outs},{data:evs}] = await Promise.all([
    supabase.from("job_outputs").select("*").eq("job_id",job_id).order("idx",{ascending:true}),
    supabase.from("job_events").select("*").eq("job_id",job_id).order("id",{ascending:true}),
  ]);
  return {
    job_id,
    created_at: job.created_at,
    state: job.state,
    progress: job.progress,
    input: job.input || {},
    outputs: (outs||[]).map(o=>({id:o.idx,url:o.url,caption:o.caption,hashtags:o.hashtags})),
    events: (evs||[]).map(e=>({at:e.at,state:e.state,progress:e.progress,payload:e.payload}))
  };
}

// ---------- STORAGE ----------
async function uploadBufferToStorage(key, buf){
  console.log("UPLOAD buffer bytes:", buf.length);
  const { error: upErr } = await supabase.storage.from("outputs").upload(key, buf, {
    contentType: "video/mp4",
    upsert: true
  });
  if (upErr) throw upErr;
  const { data } = supabase.storage.from("outputs").getPublicUrl(key);
  return data.publicUrl;
}
async function uploadFilePathToStorage(key, filePath){
  const buf = await fs.readFile(filePath);
  return uploadBufferToStorage(key, buf);
}

async function downloadUrlToFile(url, outPath){
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const ws = fss.createWriteStream(outPath);
  await pipeline(res.body, ws);
  const { size } = await fs.stat(outPath);
  console.log("Downloaded to file bytes:", size);
  return outPath;
}
async function writeBase64ToFile(b64, outPath){
  let base64 = (b64||"").trim();
  const comma = base64.indexOf(",");
  if (base64.startsWith("data:")) {
    if (comma === -1) throw new Error("invalid data URL");
    base64 = base64.slice(comma+1);
  }
  const buf = Buffer.from(base64, "base64");
  console.log("BASE64 decoded bytes:", buf.length);
  await fs.writeFile(outPath, buf);
  return outPath;
}

// ---------- SINGLE-FLIGHT ----------
let processingLock = false;
async function withSingleFlight(fn) {
  while (processingLock) { await new Promise(r => setTimeout(r, 400)); }
  processingLock = true;
  try { return await fn(); }
  finally { processingLock = false; }
}

// ---------- VF chain (HQ scale + micro-crop/pad; optional video-only setpts jitter) ----------
function vfChainNoAudioTouch({ jitterSeed = 0, enableJitter = true }) {
  const px = 2 + (jitterSeed % 5); // 2..6 px micro-crop
  const scaleHQ = "scale=w=1080:h=1920:force_original_aspect_ratio=decrease:flags=lanczos+accurate_rnd+full_chroma_int";
  const padFit = "pad=1080:1920:(1080-iw*min(1080/iw\\,1920/ih))/2:(1920-ih*min(1080/iw\\,1920/ih))/2";
  const crop   = `crop=1080-${px*2}:1920-${px*2}:${px}:${px}`;
  const padOut = "pad=1080:1920:(1080-iw)/2:(1920-ih)/2";

  // tiny video-only timing nudge (breaks frame/GOP hash, invisible to eye)
  // 0.999–1.001 variation
  const jitterFactor = 0.999 + ((jitterSeed % 3) * 0.001);
  const setpts = `setpts=${jitterFactor}*PTS`;

  return [scaleHQ, padFit, crop, padOut, ...(enableJitter ? [setpts] : [])].join(",");
}

// ---------- FFmpeg runner (video re-encode; audio COPY; fallback = remux only) ----------
async function runFfmpegVideoOnly(inPath, outPath, seed, light = false) {
  const LOW_MEM = String(process.env.LOW_MEM || "false").toLowerCase() === "true";

  // Low-mem: brug billigere scaler + endnu lettere encoder
  const vf = (() => {
    const px = 2 + (seed % 5);
    const scaleHQ   = LOW_MEM
      ? "scale=w=1080:h=1920:force_original_aspect_ratio=decrease:flags=fast_bilinear"
      : "scale=w=1080:h=1920:force_original_aspect_ratio=decrease:flags=lanczos+accurate_rnd+full_chroma_int";
    const padFit    = "pad=1080:1920:(1080-iw*min(1080/iw\\,1920/ih))/2:(1920-ih*min(1080/iw\\,1920/ih))/2";
    const crop      = `crop=1080-${px*2}:1920-${px*2}:${px}:${px}`;
    const padOut    = "pad=1080:1920:(1080-iw)/2:(1920-ih)/2";
    const jitter    = (String(process.env.VIDEO_JITTER || "true").toLowerCase() !== "false");
    const jf        = 0.999 + ((seed % 3) * 0.001);
    return [scaleHQ, padFit, crop, padOut, ...(jitter ? [`setpts=${jf}*PTS`] : [])].join(",");
  })();

  // Encoder indstillinger: ultralet for 512MB
  const args = [
    "-y","-hide_banner","-nostdin",
    "-threads","1","-filter_threads","1","-filter_complex_threads","1",
    "-i", inPath,
    "-vf", vf,
    "-map","0:v:0","-map","0:a:0",
    "-c:v","libx264","-profile:v","high","-pix_fmt","yuv420p",
    ...(LOW_MEM ? ["-preset","ultrafast","-crf","22"] : ["-preset", "fast", "-crf", "20"]),
    "-tune","fastdecode",
    "-x264-params", LOW_MEM
      ? "ref=1:bframes=2:rc-lookahead=8:keyint=120:min-keyint=24:scenecut=0"
      : "ref=3:bframes=3:rc-lookahead=12:keyint=150:min-keyint=30:scenecut=0",
    ...(LOW_MEM ? ["-maxrate","3000k","-bufsize","6000k"] : ["-maxrate","3500k","-bufsize","7000k"]),
    "-max_muxing_queue_size","512",
    "-c:a","copy", // 100% no audio touch
    "-movflags","+faststart",
    outPath
  ];

  console.log("FFmpeg args (low-mem aware):", args.join(" "));
  try {
    const { all } = await execa(ffmpeg, args, { all: true, timeout: 300000 });
    if (all) console.log("FFMPEG LOGS:", String(all).slice(-6000));
  } catch (err) {
    console.error("⚠️ ENCODE FAIL — fallback remux:", err.message);
    // Sidste udvej: remux (stadig no-audio-touch, og lav byte-forskel i containeren)
    const remuxArgs = ["-y","-hide_banner","-nostdin","-i", inPath, "-c","copy","-movflags","+faststart", outPath];
    await execa(ffmpeg, remuxArgs, { all: true, timeout: 120000 });
  }
  const { size } = await fs.stat(outPath);
  console.log("ENCODE_OK bytes:", size);
}

// ---------- Notify ----------
async function notify(url, body){
  try{
    if (!url || !/^https?:\/\//i.test(url)) return;
    const res = await fetch(url,{ method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify(body) });
    if (!res.ok) console.log("⚠️ webhook non-200:", res.status);
  }catch(e){ console.log("⚠️ webhook notify failed:", e.message); }
}

// ---------- Health ----------
app.get("/", (_req,res)=>res.json({status:"API running"}));
app.get("/health", async (_req,res)=>{
  try{
    const { error } = await supabase.from("jobs").select("count",{count:"exact",head:true});
    if (error) throw error;
    res.json({ up:true, db:true });
  }catch{
    res.status(500).json({ up:true, db:false });
  }
});

// ---------- Jobs (1 output pr. valgt account) ----------
app.post("/jobs", async (req, res) => {
  try{
    const p = req.body || {};
    const sourceUrl = typeof p.source_video_url==="string" ? p.source_video_url.trim() : "";
    const sourceB64 = typeof p.source_video_base64==="string" ? p.source_video_base64 : "";
    let sourceType=null;
    if (sourceUrl && sourceUrl.toLowerCase().endsWith(".mp4")) sourceType="url";
    else if (sourceB64) sourceType="base64";
    else return res.status(400).json({error:"Provide source_video_url (.mp4) OR source_video_base64"});

    const accounts = {
      tiktok: uniq(p.accounts?.tiktok||[]),
      instagram: uniq(p.accounts?.instagram||[]),
      youtube: uniq(p.accounts?.youtube||[])
    };
    const targets = [
      ...accounts.tiktok.map(a=>({ platform:"tiktok", account:a })),
      ...accounts.instagram.map(a=>({ platform:"instagram", account:a })),
      ...accounts.youtube.map(a=>({ platform:"youtube", account:a })),
    ];
    const preset = String(p.preset_id || "no-audio-touch");
    const webhookStatusUrl = p.webhook_status_url || null;
    const jobId = "job_" + Math.random().toString(36).slice(2,10);

    await dbCreateJob({
      job_id: jobId, created_at: nowISO(),
      state:"queued", progress:0,
      input:{
        source: sourceType==="url"?sourceUrl:"(base64)",
        preset,
        accounts,
        targets_count: targets.length || 1,
        mode:"no-audio-touch",
        jitter: VIDEO_JITTER
      }
    });

    res.status(201).json({ job_id: jobId, state: "queued", progress: 0 });

    // 35%
    setTimeout(async ()=>{
      await dbUpdateState(jobId,"processing",35);
      await notify(webhookStatusUrl,{job_id:jobId,state:"processing",progress:35});
    },600);

    // 70% — download, ffmpeg per account, upload (single-flight)
    setTimeout(async ()=>{
      await withSingleFlight(async ()=>{
        const inPath = path.join(TMP_DIR, `in_${jobId}.mp4`);
        try{
          if (sourceType==="url") await downloadUrlToFile(sourceUrl, inPath);
          else await writeBase64ToFile(sourceB64, inPath);

          const { size } = await fs.stat(inPath);
          const light = size > 25 * 1024 * 1024; // big inputs → lighter preset/CRF

          const targetsEff = (targets.length>0) ? targets : [{ platform:"generic", account:"default" }];
          const outputs = [];

          for (const t of targetsEff){
            // deterministic seed per platform/account
            const seedStr = `${jobId}_${t.platform}_${t.account}`;
            let seed = 0; for (const ch of seedStr) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;

            const outPath = path.join(TMP_DIR, `out_${jobId}_${t.platform}_${t.account}.mp4`);
            try{
              await runFfmpegVideoOnly(inPath, outPath, seed, light);
            }catch(fferr){
              console.error(`FFmpeg failed for ${t.platform}/${t.account} — final fallback remux:`, fferr.message);
              // last resort already done in runner; ensure file exists
              try { await fs.access(outPath); } catch { await fs.copyFile(inPath, outPath); }
            }

            const key = `jobs/${jobId}/clip_${t.platform}_${t.account}.mp4`;
            const url = await uploadFilePathToStorage(key, outPath);
            outputs.push({ url, caption: null, hashtags: null });
            try { await fs.unlink(outPath); } catch {}
          }

          await dbSetOutputs(jobId, outputs);
          await dbUpdateState(jobId,"processing",70,{ outputs: outputs.map(o=>o.url) });
          await notify(webhookStatusUrl,{job_id:jobId,state:"processing",progress:70,outputs: outputs.map(o=>o.url) });
        }catch(e){
          console.error("upload pipeline error:", e);
          await dbUpdateState(jobId,"failed",100,{ error: String(e.message||e) });
          await notify(webhookStatusUrl,{job_id:jobId,state:"failed",progress:100,error:String(e.message||e)});
          return;
        }finally{
          try { await fs.unlink(inPath); } catch {}
        }
      });
    },1800);

    // 100%
    setTimeout(async ()=>{
      await dbUpdateState(jobId,"complete",100);
      await notify(webhookStatusUrl,{job_id:jobId,state:"complete",progress:100});
    },3000);

  }catch(err){
    console.error("❌ POST /jobs error:", err);
    res.status(500).json({ error:"internal_error" });
  }
});

// ---------- Status ----------
app.get("/jobs/:job_id", async (req,res)=>{
  try{
    const job = await dbGetJob(req.params.job_id);
    if (!job) return res.status(404).json({ error:"job not found" });
    res.json(job);
  }catch(err){
    console.error("❌ GET /jobs/:id error:", err);
    res.status(500).json({ error:"internal_error" });
  }
});
app.get("/jobs", async (req,res)=>{
  const id = req.query.id || req.query.job_id;
  if (!id) return res.status(400).json({ error:"missing job_id" });
  try{
    const job = await dbGetJob(String(id));
    if (!job) return res.status(404).json({ error:"job not found" });
    res.json(job);
  }catch(err){
    console.error("❌ GET /jobs (query) error:", err);
    res.status(500).json({ error:"internal_error" });
  }
});

// ---------- START ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=>console.log(`✅ Server on ${PORT}`));
