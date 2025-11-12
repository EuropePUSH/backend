// index.js (ESM) — EuropePUSH backend: TikTok OAuth + /jobs stub + JSON-safe responses

import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import crypto from "crypto";

const PORT = Number(process.env.PORT || 10000);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://api.europepush.com";
const TT_CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY || "";
const TT_CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET || "";
const TT_REDIRECT = `${PUBLIC_BASE_URL}/auth/tiktok/callback`;

const CORS_WHITELIST = (process.env.CORS_WHITELIST || "")
  .split(",").map(s => s.trim()).filter(Boolean);

const app = express();

// ---------- CORS ----------
const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (CORS_WHITELIST.length === 0) return cb(null, true);
    if (CORS_WHITELIST.includes(origin)) return cb(null, true);
    return cb(new Error("CORS blocked"), false);
  },
  credentials: true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-api-key"]
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.use(express.json({ limit: "5mb" }));
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  next();
});

// ---------- In-memory TikTok auth ----------
let tikTokAuth = null;

// ---------- Utils ----------
function qs(o){return Object.entries(o).map(([k,v])=>`${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")}
function mask(s){return !s?"":s.slice(0,3)+"…"+s.slice(-3)}
async function fetchJSON(url, opts){const r=await fetch(url,opts);const t=await r.text();try{return{ok:r.ok,status:r.status,json:JSON.parse(t)}}catch{return{ok:r.ok,status:r.status,raw:t}}}

// ---------- TikTok helpers ----------
async function exchangeCodeForToken(code){
  const body=new URLSearchParams({
    client_key:TT_CLIENT_KEY,client_secret:TT_CLIENT_SECRET,
    code,grant_type:"authorization_code",redirect_uri:TT_REDIRECT
  });
  const r=await fetch("https://open.tiktokapis.com/v2/oauth/token/",{
    method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body});
  return await r.json();
}

// ---------- Routes ----------
app.get("/health",(_,res)=>res.json({ok:true,ts:Date.now()}));

// TikTok OAuth URL
app.get("/auth/tiktok/url",(_,res)=>{
  const state="state_"+crypto.randomBytes(4).toString("hex");
  const url="https://www.tiktok.com/v2/auth/authorize/?" + qs({
    client_key:TT_CLIENT_KEY,
    scope:"user.info.basic,video.upload,video.publish",
    response_type:"code",redirect_uri:TT_REDIRECT,state});
  res.json({authorize_url:url,state});
});

// Callback
app.get("/auth/tiktok/callback",async(req,res)=>{
  const {code,error}=req.query;
  let payload={ok:false};
  try{
    if(error) payload={ok:false,error};
    else if(!code) payload={ok:false,error:"missing_code"};
    else{
      const tok=await exchangeCodeForToken(code);
      tikTokAuth={...tok.data,obtained:Date.now()};
      payload={ok:true,tokens:{...tok.data,refresh_token:"•••"},open_id:tok.data.open_id||null};
    }
  }catch(e){payload={ok:false,error:"callback_failed",detail:String(e)}}
  res.status(200).type("html").send(`
<script>
  if(window.opener){
    window.opener.postMessage({type:"tiktok_oauth_result",data:${JSON.stringify(payload)}}, "*");
    window.close();
  } else {
    document.body.innerText="You can close this window.";
  }
</script>`);
});

// Status
app.get("/auth/tiktok/status",(_,res)=>{
  if(!tikTokAuth?.access_token) return res.json({connected:false});
  res.json({connected:true,open_id_preview:mask(tikTokAuth.open_id)});
});

// TikTok account info
app.get("/tiktok/account",(_,res)=>{
  if(!tikTokAuth?.access_token) return res.json({connected:false,account:null});
  res.json({connected:true,account:{open_id:tikTokAuth.open_id,label:`Sandbox · ${mask(tikTokAuth.open_id)}`}});
});

// ---------- JOBS endpoint ----------
app.post("/jobs",async(req,res)=>{
  try{
    const {source_video_url,postToTikTok,tiktok_account_ids}=req.body||{};
    if(!source_video_url) return res.status(400).json({ok:false,error:"missing_source_video_url"});

    const jobId="job_"+crypto.randomBytes(6).toString("hex");

    // simulate video render
    const jobInfo={id:jobId,source_video_url,created_at:Date.now()};

    if(postToTikTok){
      if(!tikTokAuth?.access_token) return res.status(401).json({ok:false,error:"tiktok_not_connected"});
      // you could here call POST /tiktok/post
      return res.json({ok:true,message:"Video uploaded + ready to post to TikTok (stub)",job:jobInfo});
    }

    res.json({ok:true,message:"Render job created (stub)",job:jobInfo});
  }catch(e){
    res.status(500).json({ok:false,error:"server_error",detail:String(e)});
  }
});

// ---------- JSON 404 fallback ----------
app.use((req,res)=>res.status(404).json({ok:false,error:"not_found",path:req.path}));

app.listen(PORT,()=>console.log(`✅ API running on ${PORT}`));
