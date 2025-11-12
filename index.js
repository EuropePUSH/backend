// index.js (ESM) — EuropePUSH backend (TikTok OAuth, robust CORS, popup-safe callback)

import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import crypto from "crypto";

const PORT = Number(process.env.PORT || 10000);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://api.europepush.com";
const TT_CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY || "";
const TT_CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET || "";
const TT_REDIRECT = `${PUBLIC_BASE_URL}/auth/tiktok/callback`;

// Optional: restrict who can call the API (comma-separated origins).
const CORS_WHITELIST = (process.env.CORS_WHITELIST || "")
  .split(",").map(s => s.trim()).filter(Boolean);

const app = express();

// ---------- CORS that works with credentials ----------
const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // curl/postman
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
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

// ---------- memory store (demo only) ----------
let tikTokAuth = null;

// ---------- helpers ----------
function qs(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}
function mask(s, keep = 3) {
  if (!s) return "";
  return s.length <= keep ? "*".repeat(s.length) : s.slice(0, keep) + "…" + s.slice(-keep);
}
async function fetchJSON(url, opts = {}) {
  const r = await fetch(url, opts);
  const t = await r.text();
  try { return { ok: r.ok, status: r.status, json: JSON.parse(t), raw: t }; }
  catch { return { ok: r.ok, status: r.status, json: null, raw: t }; }
}

// TikTok: exchange auth code -> tokens (MUST be x-www-form-urlencoded)
async function exchangeCodeForToken(code) {
  const body = new URLSearchParams({
    client_key: TT_CLIENT_KEY,
    client_secret: TT_CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
    redirect_uri: TT_REDIRECT
  });

  const res = await fetchJSON("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!res.ok) {
    const e = new Error("token_exchange_failed");
    e.meta = res;
    throw e;
  }
  return res.json.data || res.json;
}

async function fetchUserInfo(access_token) {
  // This endpoint accepts JSON
  return fetchJSON("https://open.tiktokapis.com/v2/user/info/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${access_token}`
    },
    body: JSON.stringify({ fields: ["open_id"] })
  });
}

// ---------- routes ----------
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

app.get("/auth/tiktok/debug", (_req, res) => {
  res.json({
    client_key_present: !!TT_CLIENT_KEY,
    client_key_len: TT_CLIENT_KEY.length,
    client_key_preview: TT_CLIENT_KEY ? `${TT_CLIENT_KEY.slice(0,4)}…${TT_CLIENT_KEY.slice(-4)}` : "",
    client_secret_present: !!TT_CLIENT_SECRET,
    client_secret_len: TT_CLIENT_SECRET.length,
    redirect_uri: TT_REDIRECT,
    public_base_url: PUBLIC_BASE_URL,
    cors_whitelist: CORS_WHITELIST,
    has_tokens: !!tikTokAuth,
    open_id_preview: tikTokAuth?.open_id ? mask(tikTokAuth.open_id) : null
  });
});

// Convenience: redirect immediately to TikTok (optional)
app.get("/auth/tiktok/start", (req, res) => {
  const state = "state_epush_" + crypto.randomBytes(4).toString("hex");
  const scope = "user.info.basic,video.upload,video.publish";
  const authorize_url =
    "https://www.tiktok.com/v2/auth/authorize/?" +
    qs({
      client_key: TT_CLIENT_KEY,
      scope,
      response_type: "code",
      redirect_uri: TT_REDIRECT,
      state
    });
  res.redirect(authorize_url);
});

// Return the authorize URL as JSON (what Base44 uses)
app.get("/auth/tiktok/url", (req, res) => {
  const state = "state_epush_" + crypto.randomBytes(4).toString("hex");
  const scope = "user.info.basic,video.upload,video.publish";
  const authorize_url =
    "https://www.tiktok.com/v2/auth/authorize/?" +
    qs({
      client_key: TT_CLIENT_KEY,
      scope,
      response_type: "code",
      redirect_uri: TT_REDIRECT,
      state
    });
  res.json({ authorize_url });
});

// IMPORTANT: popup-safe callback that posts result back to opener
app.get("/auth/tiktok/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query;
  const payload = { ok: false, state: state || null };

  try {
    if (error) {
      payload.error = error;
      payload.error_description = error_description || "";
    } else if (!code) {
      payload.error = "missing_code";
    } else {
      const tokens = await exchangeCodeForToken(code);
      tikTokAuth = { ...tokens, obtain_at: Date.now() };

      const me = await fetchUserInfo(tokens.access_token);
      if (me.ok && me.json?.data?.user?.open_id) tikTokAuth.open_id = me.json.data.user.open_id;

      payload.ok = true;
      payload.tokens = { ...tokens, refresh_token: "•••masked•••" };
      payload.open_id = tikTokAuth.open_id || null;
    }
  } catch (e) {
    payload.error = "callback_failed";
    payload.detail = e?.meta || String(e);
  }

  // If opened as a popup, send the result back to the opener and close.
  const html = `
<!doctype html>
<html><body>
<script>
  (function () {
    var data = ${JSON.stringify(payload)};
    try {
      if (window.opener && typeof window.opener.postMessage === 'function') {
        window.opener.postMessage({ type: 'tiktok_oauth_result', data }, '*');
      }
    } catch (e) {}
    // Fallback: show minimal text so user sees something if popup wasn't used
    document.body.innerHTML = '<pre>' + ${JSON.stringify(
      "TikTok Login OK (popup mode). You can close this window."
    )} + '\\n' + JSON.stringify(data, null, 2) + '</pre>';
    setTimeout(function(){ window.close(); }, 800);
  })();
</script>
</body></html>`;
  res.status(200).type("html").send(html);
});

// Frontend can poll this
app.get("/auth/tiktok/status", (_req, res) => {
  if (!tikTokAuth?.access_token) return res.json({ connected: false });
  res.json({
    connected: true,
    open_id: tikTokAuth.open_id || null,
    open_id_preview: tikTokAuth.open_id ? mask(tikTokAuth.open_id) : null,
    scope: tikTokAuth.scope || null
  });
});

// placeholder for future posting
app.post("/tiktok/post", (req, res) => {
  if (!tikTokAuth?.access_token || !tikTokAuth?.open_id)
    return res.status(401).json({ ok: false, error: "not_connected" });
  res.status(501).json({ ok: false, error: "not_implemented_yet" });
});

app.listen(PORT, () => {
  console.log(`✅ Server on ${PORT}`);
  console.log(`🔧 PUBLIC_BASE_URL: ${PUBLIC_BASE_URL}`);
  console.log(`🔧 TT_REDIRECT:     ${TT_REDIRECT}`);
  console.log(`🔧 CORS_WHITELIST: ${CORS_WHITELIST.join(",") || "(reflect any origin)"}`);
});
