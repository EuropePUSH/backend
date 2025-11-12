// index.js (ESM) — EuropePUSH backend: TikTok OAuth + JSON-safe errors for /auth/* and /tiktok/*

import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import crypto from "crypto";

const PORT = Number(process.env.PORT || 10000);

// IMPORTANT: must match your public API base (used in TikTok redirect)
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://api.europepush.com";

// TikTok app creds (use your Sandbox or Production set!)
const TT_CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY || "";
const TT_CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET || "";
const TT_REDIRECT = `${PUBLIC_BASE_URL}/auth/tiktok/callback`;

// Comma-separated whitelist origins, e.g. "https://app.base44.io,https://studio.base44.io"
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

// ---------- Body & headers ----------
app.use(express.json({ limit: "5mb" }));
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

// ---------- In-memory store (demo) ----------
let tikTokAuth = null; // { access_token, refresh_token, open_id, scope, obtain_at, ... }

// ---------- Utils ----------
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
  const text = await r.text();
  try { return { ok: r.ok, status: r.status, json: JSON.parse(text), raw: text }; }
  catch { return { ok: r.ok, status: r.status, json: null, raw: text }; }
}

async function exchangeCodeForToken(code) {
  // TikTok wants x-www-form-urlencoded
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
    const err = new Error("token_exchange_failed");
    err.meta = res;
    throw err;
  }
  return res.json.data || res.json;
}

async function fetchUserInfo(access_token) {
  return fetchJSON("https://open.tiktokapis.com/v2/user/info/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${access_token}`
    },
    body: JSON.stringify({ fields: ["open_id"] })
  });
}

// ---------- Health & debug ----------
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));
app.get("/__whoami", (_req, res) => {
  res.json({
    ok: true,
    public_base_url: PUBLIC_BASE_URL,
    redirect_uri: TT_REDIRECT,
    cors_whitelist: CORS_WHITELIST,
    client_key_set: !!TT_CLIENT_KEY,
    client_secret_set: !!TT_CLIENT_SECRET
  });
});

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

// ---------- OAuth: build URL / start ----------
app.get("/auth/tiktok/url", (_req, res) => {
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
  res.json({ authorize_url, state });
});

app.get("/auth/tiktok/start", (_req, res) => {
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

// ---------- OAuth callback (popup-safe) ----------
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
      if (me.ok && me.json?.data?.user?.open_id) {
        tikTokAuth.open_id = me.json.data.user.open_id;
      }

      payload.ok = true;
      payload.tokens = { ...tokens, refresh_token: "•••masked•••" };
      payload.open_id = tikTokAuth.open_id || null;
    }
  } catch (e) {
    payload.error = "callback_failed";
    payload.detail = e?.meta || String(e);
  }

  const html = `
<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>TikTok Login</title>
<body style="font-family: -apple-system, system-ui, Segoe UI, Roboto, sans-serif">
<script>
  (function () {
    var data = ${JSON.stringify(payload)};
    try {
      if (window.opener && typeof window.opener.postMessage === 'function') {
        window.opener.postMessage({ type: 'tiktok_oauth_result', data }, '*');
      }
    } catch (e) {}
    document.body.innerHTML =
      '<pre style="white-space:pre-wrap;word-break:break-word;">TikTok Login OK (popup). You can close this window.\\n\\n'
      + JSON.stringify(data, null, 2) + '</pre>';
    setTimeout(function(){ window.close(); }, 900);
  })();
</script>
</body>`;
  res.status(200).type("html").send(html);
});

// ---------- Status & account ----------
app.get("/auth/tiktok/status", (_req, res) => {
  if (!tikTokAuth?.access_token) return res.json({ connected: false });
  res.json({
    connected: true,
    open_id: tikTokAuth.open_id || null,
    open_id_preview: tikTokAuth.open_id ? mask(tikTokAuth.open_id) : null,
    scope: tikTokAuth.scope || null
  });
});

app.get("/tiktok/account", (_req, res) => {
  if (!tikTokAuth?.access_token) return res.json({ connected: false, account: null });
  res.json({
    connected: true,
    account: {
      open_id: tikTokAuth.open_id || null,
      label: tikTokAuth.open_id ? `Sandbox · ${mask(tikTokAuth.open_id)}` : "Sandbox · <unknown>"
    }
  });
});

app.post("/auth/tiktok/clear", (_req, res) => {
  tikTokAuth = null;
  res.json({ ok: true });
});

// ---------- Example posting placeholder ----------
app.post("/tiktok/post", (req, res) => {
  if (!tikTokAuth?.access_token || !tikTokAuth?.open_id) {
    return res.status(401).json({ ok: false, error: "not_connected" });
  }
  // TODO: implement /video/upload + /video/publish with TikTok Sandbox.
  return res.status(501).json({ ok: false, error: "not_implemented_yet" });
});

// ---------- JSON 404 for /auth/* and /tiktok/* ----------
function jsonNotFound(req, res) {
  res.status(404).json({ ok: false, error: "not_found", path: req.path });
}
app.use("/auth", (req, res, next) => jsonNotFound(req, res));
app.use("/tiktok", (req, res, next) => jsonNotFound(req, res));

// ---------- JSON error handler for /auth/* and /tiktok/* ----------
app.use((err, req, res, _next) => {
  const wantsJson = req.path.startsWith("/auth/") || req.path.startsWith("/tiktok/");
  if (wantsJson) {
    return res.status(500).json({ ok: false, error: "server_error", message: err?.message || String(err) });
  }
  // Fallback: default HTML for non-API paths
  res.status(500).send("<h1>Server error</h1>");
});

app.listen(PORT, () => {
  console.log(`✅ Server on ${PORT}`);
  console.log(`🔧 PUBLIC_BASE_URL: ${PUBLIC_BASE_URL}`);
  console.log(`🔧 TT_REDIRECT:     ${TT_REDIRECT}`);
  console.log(`🔧 CORS_WHITELIST: ${CORS_WHITELIST.join(",") || "(any)"}`);
});
