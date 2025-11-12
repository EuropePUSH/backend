// index.js (ESM) — EuropePUSH backend (TikTok OAuth + robust CORS)

import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import crypto from "crypto";

const PORT = Number(process.env.PORT || 10000);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://api.europepush.com";
const TT_CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY || "";
const TT_CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET || "";
const TT_REDIRECT = `${PUBLIC_BASE_URL}/auth/tiktok/callback`;

// Optional: limit who can call (comma-separated list). If empty -> reflect any origin.
const CORS_WHITELIST = (process.env.CORS_WHITELIST || "").split(",").map(s => s.trim()).filter(Boolean);

const app = express();

// ---- CORS that works with credentials ----
const corsOptions = {
  origin: (origin, cb) => {
    // allow no-origin (curl/postman) and whitelisted origins
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

// JSON + small no-cache for API responses
app.use(express.json({ limit: "5mb" }));
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

// ---- In-memory tokens (demo) ----
let tikTokAuth = null;

// ---- helpers ----
const q = (params) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

function mask(str, keep = 3) {
  if (!str) return "";
  return str.length <= keep ? "*".repeat(str.length) : str.slice(0, keep) + "…" + str.slice(-keep);
}

async function ttFetchJSON(url, opts = {}) {
  const r = await fetch(url, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(opts.headers || {})
    }
  });
  const text = await r.text();
  try { return { status: r.status, ok: r.ok, json: JSON.parse(text), raw: text }; }
  catch { return { status: r.status, ok: r.ok, json: null, raw: text }; }
}

async function exchangeCodeForToken(code) {
  const res = await ttFetchJSON("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    body: JSON.stringify({
      client_key: TT_CLIENT_KEY,
      client_secret: TT_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: TT_REDIRECT
    })
  });
  if (!res.ok) { const e = new Error("TikTok token exchange failed"); e.meta = res; throw e; }
  return res.json.data || res.json;
}

async function fetchUserInfo(access_token) {
  return ttFetchJSON("https://open.tiktokapis.com/v2/user/info/", {
    method: "POST",
    headers: { Authorization: `Bearer ${access_token}` },
    body: JSON.stringify({ fields: ["open_id"] })
  });
}

// ---- routes ----
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

app.get("/auth/tiktok/url", (_req, res) => {
  const state = "state_epush_" + crypto.randomBytes(4).toString("hex");
  const scope = "user.info.basic,video.upload,video.publish";
  const authorize_url =
    "https://www.tiktok.com/v2/auth/authorize/?" +
    q({ client_key: TT_CLIENT_KEY, scope, response_type: "code", redirect_uri: TT_REDIRECT, state });
  res.json({ authorize_url });
});

app.get("/auth/tiktok/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query;
  try {
    if (error) return res.status(400).send(`<pre>TikTok Login ERROR\n\n${error}: ${error_description || ""}\nstate: ${state || ""}</pre>`);
    if (!code) return res.status(400).send("<pre>Missing code</pre>");

    const tokens = await exchangeCodeForToken(code);
    tikTokAuth = { ...tokens, obtain_at: Date.now() };

    const me = await fetchUserInfo(tokens.access_token);
    if (me.ok && me.json?.data?.user?.open_id) tikTokAuth.open_id = me.json.data.user.open_id;

    res.status(200).send(
      `<pre>TikTok Login OK\nstate: ${state || ""}\n\n${JSON.stringify(
        { tokens: { ...tokens, refresh_token: "•••masked•••" }, me: me.json || me.raw }, null, 2
      )}\n\nGem tokens i DB/session i stedet for at vise dem i produktion.</pre>`
    );
  } catch (err) {
    console.error("TT TOKEN EXCHANGE FAILED", { redirect: TT_REDIRECT, detail: err?.meta || String(err) });
    res.status(500).send(`<pre>TikTok Login ERROR\n\n${JSON.stringify({ redirect: TT_REDIRECT, resp: err?.meta || null }, null, 2)}</pre>`);
  }
});

app.get("/auth/tiktok/status", (_req, res) => {
  if (!tikTokAuth?.access_token) return res.json({ connected: false });
  res.json({
    connected: true,
    open_id: tikTokAuth.open_id || null,
    open_id_preview: tikTokAuth.open_id ? mask(tikTokAuth.open_id) : null,
    scope: tikTokAuth.scope || null
  });
});

app.post("/tiktok/post", async (req, res) => {
  if (!tikTokAuth?.access_token || !tikTokAuth?.open_id)
    return res.status(401).json({ ok: false, error: "not_connected", message: "Connect TikTok først." });

  const { video_url, caption } = req.body || {};
  if (!video_url)
    return res.status(400).json({ ok: false, error: "missing_video_url", message: "Send { video_url }." });

  // Placeholder:
  return res.status(501).json({
    ok: false, error: "not_implemented_yet",
    message: "OAuth virker; posting ikke aktiveret i denne build.",
    received: { video_url, caption }
  });
});

app.listen(PORT, () => {
  console.log(`✅ Server on ${PORT}`);
  console.log(`🔧 PUBLIC_BASE_URL: ${PUBLIC_BASE_URL}`);
  console.log(`🔧 TT_REDIRECT:     ${TT_REDIRECT}`);
  console.log(`🔧 CORS_WHITELIST: ${CORS_WHITELIST.join(",") || "(reflect any origin)"}`);
});
