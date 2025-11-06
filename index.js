// index.js — EuropePush backend (DEDUPER: no text overlay) + low-RAM FFmpeg + Supabase
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

console.log("🔧 ENV SUPABASE_URL:", SUPABASE_URL ? "present" : "MISSING");
console.log("🔧 ENV SUPABASE_SERVICE_KEY:", SUPABASE_SERVICE_KEY ? "present" : "MISSING");
console.log("🔧 ENV API_KEY:", API_KEY ? "present" : "MISSING");

const supabase = (SUPABASE_URL && SUPABASE_SERVICE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;

const TMP_DIR = "/tmp";
const nowISO = () => new Date().toISOString();
const clamp = (n,a,b)=>Math.max(a,Math.min(b,n));
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
async function uploadFilePathToStorage(jobId, filePath){
  const key = `jobs/${jobId}/clip_v1.mp4`;
  const buf = await fs.readFile(filePath); // buffer upload (stabil på Node 18+)
  console.log("UPLOAD buffer bytes:", buf.length);
  const { error: upErr } = await supabase.storage.from("outputs").upload(key, buf, {
    contentType: "video/mp4",
    upsert: true
  });
  if (upErr) throw upErr;
  const { data } = supabase.storage.from("outputs").getPublicUrl(key);
  return data.publicUrl;
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

// ---------- FFmpeg (DEDUPER: no text) ----------
function vfChainDedupe({ jitterSeed = 0 }) {
  // mikro-ændringer for at bryde perceptual hash uden synlig forskel
  const px = 2 + (jitterSeed % 5);         // 2..6 px crop fra hver kant
  const hueDeg = 0.3 + (jitterSeed % 3)*0.1; // 0.3..0.5 grader hue-shift
  const noiseStrength = 1;                 // lav film-grain

  return [
    "scale=w=1080:h=1920:force_original_aspect_ratio=decrease",
    "pad=1080:1920:(1080-iw*min(1080/iw\\,1920/ih))/2:(1920-ih*min(1080/iw\\,1920/ih))/2",
    `crop=1080-${px*2}:1920-${px*2}:${px}:${px}`,
    "pad=1080:1920:(1080-iw)/2:(1920-ih)/2",
    `hue=h=${hueDeg}*PI/180:s=1`,
    `noise=alls=${noiseStrength}:allf=t`
  ].join(",");
}

async function runFfmpeg(inPath, outPath, jobId = "job"){
  // deterministisk seed ud fra jobId
  let seed = 0;
  for (const ch of String(jobId)) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;

  const vf = vfChainDedupe({ jitterSeed: seed });

  // lyd: tiny fade in/out + 0.99x tempo (næsten usynligt, bryder audio hash)
  const af = [
    "atrim=start=0",
    "asetpts=N/SR/TB",
    "afade=t=in:ss=0:d=0.03",
    "afade=t=out:st=TN-0.03:d=0.03",
    "atempo=0.99"
  ].join(",");

  const args = [
    "-y", "-hide_banner", "-nostdin",
    "-threads", "1", "-filter_threads", "1", "-filter_complex_threads", "1",
    "-i", inPath,
    "-vf", vf,
    "-af", af,
    "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p",
    "-preset", "veryfast", "-crf", "23",
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    outPath
  ];

  console.log("FFmpeg (dedupe) args:", args.join(" "));
  try {
    const { stdout, stderr } = await execa(ffmpeg, args, { all: true });
    if (stdout) console.log("FFMPEG OUT:", stdout.slice(-4000));
    if (stderr) console.log("FFMPEG ERR:", stderr.slice(-4000));
  } catch (err){
    console.error("❌ FFmpeg error:", err.message);
    if (err.all) console.error("FFMPEG LOGS:", String(err.all).slice(-8000));
    throw err;
  }
  const { size } = await fs.stat(outPath);
  console.log("FFmpeg output bytes:", size);
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

// ---------- Jobs ----------
app.post("/jobs", async (req, res) => {
  try{
    const p = req.body || {};
    const sourceUrl = typeof p.source_video_url==="string" ? p.source_video_url.trim() : "";
    const sourceB64 = typeof p.source_video_base64==="string" ? p.source_video_base64 : "";
    let sourceType=null;
    if (sourceUrl && sourceUrl.toLowerCase().endsWith(".mp4")) sourceType="url";
    else if (sourceB64) sourceType="base64";
    else return res.status(400).json({error:"Provide source_video_url (.mp4) OR source_video_base64"});

    const preset = String(p.preset_id || "dedupe");
    const variations = clamp(parseInt(p.variations||1,10),1,50);
    const targetPlatforms = uniq(p.target_platforms||[]);
    const accounts = {
      tiktok: uniq(p.accounts?.tiktok||[]),
      instagram: uniq(p.accounts?.instagram||[]),
      youtube: uniq(p.accounts?.youtube||[])
    };
    const webhookStatusUrl = p.webhook_status_url || null;
    const jobId = "job_" + Math.random().toString(36).slice(2,10);

    await dbCreateJob({
      job_id: jobId, created_at: nowISO(),
      state:"queued", progress:0,
      input:{ source: sourceType==="url"?sourceUrl:"(base64)", preset, variations, targetPlatforms, accounts, mode:"dedupe" }
    });

    res.status(201).json({ job_id: jobId, state: "queued", progress: 0 });

    // 35%
    setTimeout(async ()=>{
      await dbUpdateState(jobId,"processing",35);
      await notify(webhookStatusUrl,{job_id:jobId,state:"processing",progress:35});
    },600);

    // 70% — stream, ffmpeg (dedupe), upload
    setTimeout(async ()=>{
      const inPath = path.join(TMP_DIR, `in_${jobId}.mp4`);
      const outPath = path.join(TMP_DIR, `out_${jobId}.mp4`);
      try{
        if (sourceType==="url") await downloadUrlToFile(sourceUrl, inPath);
        else await writeBase64ToFile(sourceB64, inPath);

        try{
          await runFfmpeg(inPath, outPath, jobId);
        }catch(fferr){
          console.error("FFmpeg failed — using original file:", fferr.message);
          await fs.copyFile(inPath, outPath);
        }

        const url = await uploadFilePathToStorage(jobId, outPath);
        const out = [{ url, caption: null, hashtags: null }];

        await dbSetOutputs(jobId, out);
        await dbUpdateState(jobId,"processing",70,{ outputs: out.map(o=>o.url) });
        await notify(webhookStatusUrl,{job_id:jobId,state:"processing",progress:70,outputs: out.map(o=>o.url) });
      }catch(e){
        console.error("upload pipeline error:", e);
        await dbUpdateState(jobId,"failed",100,{ error: String(e.message||e) });
        await notify(webhookStatusUrl,{job_id:jobId,state:"failed",progress:100,error:String(e.message||e)});
        return;
      }finally{
        for (const pth of [inPath, outPath]) { try { await fs.unlink(pth); } catch {} }
      }
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
