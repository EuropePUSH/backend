// index.js (ESM)
import express from "express";
import cors from "cors";
import crypto from "crypto";
import fs from "fs/promises";
import fss from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import ffmpegBin from "ffmpeg-static";
import { execa } from "execa";
import fetch from "node-fetch"; // ensure node-fetch@3 is in package.json

// ----------------- ENV -----------------
const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.API_KEY || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";

const TT_CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY || "";
const TT_CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET || "";
// Public base URL of THIS server (with custom domain if you have it)
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://api.europepush.com";
const TT_REDIRECT = `${PUBLIC_BASE_URL}/auth/tiktok/callback`;

// ----------------- APP -----------------
const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "10mb" }));

// simple in-memory token store by session (demo). Replace with DB later.
const sessions = new Map(); // sessionId -> { access_token, refresh_token, open_id, scope, expires_at }
function getSessionId(req) {
  // allow Bearer, or cookie 'sid', or query sid
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  if (req.query.sid) return String(req.query.sid);
  const cookie = req.headers.cookie || "";
  const m = cookie.match(/sid=([^;]+)/);
  return m ? m[1] : null;
}
function setSessionCookie(res, sid) {
  res.setHeader("Set-Cookie", `sid=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`);
}

// ----------------- HEALTH -----------------
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    env: {
      has_api_key: !!API_KEY,
      has_supabase: !!SUPABASE_URL && !!SUPABASE_SERVICE_KEY,
      has_tiktok: !!TT_CLIENT_KEY && !!TT_CLIENT_SECRET,
      redirect: TT_REDIRECT,
    },
  });
});

// ----------------- TIKTOK AUTH: JSON-ONLY HELPERS -----------------
function buildAuthorizeUrl(state = "state_epush_123") {
  const scopes = ["user.info.basic", "video.upload", "video.publish"].join(",");
  const params = new URLSearchParams({
    client_key: TT_CLIENT_KEY,
    scope: scopes,
    response_type: "code",
    redirect_uri: TT_REDIRECT,
    state,
  });
  return `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`;
}

async function exchangeCodeForToken(code) {
  const params = new URLSearchParams({
    client_key: TT_CLIENT_KEY,
    client_secret: TT_CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
    redirect_uri: TT_REDIRECT,
  });
  const r = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
    body: params.toString(),
  });
  const data = await r.json();
  if (!r.ok || data.error) {
    const e = new Error("oauth_exchange_failed");
    e.meta = data;
    throw e;
  }
  return data; // { access_token, refresh_token, open_id, scope, expires_in, refresh_expires_in, ... }
}

async function getUserInfo(accessToken) {
  const r = await fetch("https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await r.json();
  return data; // { data: { user: {...} } } or error
}

// ---------- ROUTES FOR UI (always JSON) ----------

// 1) Get authorize URL (UI opens this in a popup or same tab)
app.get("/auth/tiktok/url", (_req, res) => {
  try {
    if (!TT_CLIENT_KEY) {
      return res.status(500).json({ ok: false, error: "missing_client_key" });
    }
    res.json({ ok: true, authorize_url: buildAuthorizeUrl() });
  } catch (err) {
    res.status(500).json({ ok: false, error: "internal", detail: String(err) });
  }
});

// 2) OAuth callback. If UI calls it (fetch), we return JSON; if user visits in browser, we also return JSON.
app.get("/auth/tiktok/callback", async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;
    if (error) return res.status(400).json({ ok: false, error, error_description });

    if (!code) return res.status(400).json({ ok: false, error: "missing_code" });

    const tokens = await exchangeCodeForToken(String(code));
    // Save to session
    const sid = crypto.randomBytes(16).toString("hex");
    const now = Date.now();
    const expires_at = now + (tokens.expires_in || 3600) * 1000;
    sessions.set(sid, {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      open_id: tokens.open_id,
      scope: tokens.scope,
      expires_at,
    });
    setSessionCookie(res, sid);

    // try user info (optional)
    let me = null;
    try {
      me = await getUserInfo(tokens.access_token);
    } catch {
      me = null;
    }
    res.json({
      ok: true,
      state,
      sid,
      tokens: {
        open_id: tokens.open_id,
        scope: tokens.scope,
        expires_at,
      },
      me,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: "callback_failed", detail: err?.meta ?? String(err) });
  }
});

// 3) Status endpoint for UI (“Check Connection Status”)
app.get("/auth/tiktok/status", async (req, res) => {
  try {
    const sid = getSessionId(req);
    if (!sid || !sessions.has(sid)) {
      return res.json({ ok: true, connected: false });
    }
    const s = sessions.get(sid);
    const now = Date.now();
    const expired = now >= s.expires_at;
    let profile = null;
    if (!expired) {
      try {
        const me = await getUserInfo(s.access_token);
        profile = me?.data?.user ?? null;
      } catch {
        profile = null;
      }
    }
    res.json({
      ok: true,
      connected: !expired,
      open_id: s.open_id,
      scope: s.scope,
      expires_at: s.expires_at,
      profile,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: "status_failed", detail: String(err) });
  }
});

// 4) Minimal publish (sandbox). UI sends { job_id, caption? }.
// For now this just echoes; wire up real upload later.
app.post("/tiktok/post", async (req, res) => {
  try {
    const sid = getSessionId(req);
    if (!sid || !sessions.has(sid)) {
      return res.status(401).json({ ok: false, error: "not_connected" });
    }
    const { job_id, caption } = req.body || {};
    if (!job_id) return res.status(400).json({ ok: false, error: "missing_job_id" });

    // TODO: pull the mp4 from your Supabase outputs/jobs/{job_id}/..., then call TikTok upload+publish
    // For now, stub success:
    res.json({ ok: true, published: "sandbox", job_id, caption: caption || "" });
  } catch (err) {
    res.status(500).json({ ok: false, error: "post_failed", detail: String(err) });
  }
});

// 5) Debug: show if keys are present (JSON only)
app.get("/auth/tiktok/debug", (_req, res) => {
  res.json({
    client_key_present: !!TT_CLIENT_KEY,
    client_key_len: TT_CLIENT_KEY.length,
    client_secret_present: !!TT_CLIENT_SECRET,
    client_secret_len: TT_CLIENT_SECRET.length,
    redirect_uri: TT_REDIRECT,
  });
});

// ----------------- (your existing /jobs, ffmpeg etc.) -----------------
// Keep your existing render/job routes here. (Omitted for brevity; no changes needed for this bug.)

// ----------------- SERVER -----------------
app.listen(PORT, () => {
  console.log(`✅ Server on ${PORT}`);
  console.log(`🔗 Base URL: ${PUBLIC_BASE_URL}`);
});
