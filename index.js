// index.js — EuropePUSH backend (OAuth + base endpoints)
// Node 18+ required (global fetch available)

import express from "express";
import cors from "cors";

// -------------------- ENV --------------------
const PORT = Number(process.env.PORT || 10000);

// TikTok OAuth
const TT_CLIENT_KEY = (process.env.TIKTOK_CLIENT_KEY || "").trim();
const TT_CLIENT_SECRET = (process.env.TIKTOK_CLIENT_SECRET || "").trim();
const TT_REDIRECT_URL = (process.env.TIKTOK_REDIRECT_URL || "").trim();

// Scopes — match det du har valgt i TikTok Developer
// (i Sandbox typisk: user.info.basic,video.upload,video.publish)
const TT_SCOPES = [
  "user.info.basic",
  "video.upload",
  "video.publish",
];

// Sikker mask af nøgler i logs
const mask = (s) => (s && s.length > 8) ? `${s.slice(0,4)}…${s.slice(-4)}` : (s ? "****" : "");

// -------------------- APP --------------------
const app = express();
app.set("trust proxy", 1);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false }));

// ---------- Health & root ----------
app.get("/", (_req, res) => {
  res.type("text/plain").send("EuropePUSH backend OK");
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    ts: Date.now(),
    env: {
      port: PORT,
      tiktok_client_key_present: !!TT_CLIENT_KEY,
      tiktok_client_key_len: TT_CLIENT_KEY.length,
      tiktok_redirect_set: !!TT_REDIRECT_URL,
    }
  });
});

// -------------------- TikTok OAuth Helpers --------------------
function buildAuthorizeURL(state = "state_epush_123") {
  const base = "https://www.tiktok.com/v2/auth/authorize/";
  const params = new URLSearchParams({
    client_key: TT_CLIENT_KEY,
    scope: TT_SCOPES.join(","),
    response_type: "code",
    redirect_uri: TT_REDIRECT_URL,
    state,
  });
  return `${base}?${params.toString()}`;
}

async function exchangeCodeForTokens(code) {
  // TikTok Auth service (OAuth 2.0 — tiktok docs)
  const tokenURL = "https://open.tiktokapis.com/v2/oauth/token/";
  const body = new URLSearchParams({
    client_key: TT_CLIENT_KEY,
    client_secret: TT_CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
    redirect_uri: TT_REDIRECT_URL,
  });

  const resp = await fetch(tokenURL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error("Token exchange failed");
    err.meta = { status: resp.status, body: json };
    throw err;
  }
  return json; // { access_token, refresh_token, expires_in, scope, token_type, ... }
}

async function fetchTikTokMe(accessToken) {
  const meURL = "https://open.tiktokapis.com/v2/user/info/";
  const resp = await fetch(meURL, {
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    }
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error("Fetching /user/info failed");
    err.meta = { status: resp.status, body: json };
    throw err;
  }
  return json;
}

// -------------------- TikTok Debug Routes --------------------
// Hurtig sanity-check
app.get("/auth/tiktok/debug", (req, res) => {
  res.json({
    client_key_present: !!TT_CLIENT_KEY,
    client_key_len: TT_CLIENT_KEY.length,
    client_key_preview: mask(TT_CLIENT_KEY),
    client_secret_present: !!TT_CLIENT_SECRET,
    client_secret_len: TT_CLIENT_SECRET.length,
    client_secret_preview: mask(TT_CLIENT_SECRET),
    redirect_uri: TT_REDIRECT_URL || "MISSING",
    scopes: TT_SCOPES,
  });
});

// Viser den præcise authorize-URL backend konstruerer
app.get("/auth/tiktok/url", (req, res) => {
  // hvis man vil teste state: /auth/tiktok/url?state=abc123
  const state = (req.query.state || "state_epush_123").toString();
  if (!TT_CLIENT_KEY || !TT_REDIRECT_URL) {
    return res.status(500).json({
      error: "missing_env",
      detail: "TIKTOK_CLIENT_KEY eller TIKTOK_REDIRECT_URL mangler",
    });
  }
  res.json({ authorize_url: buildAuthorizeURL(state) });
});

// Sender browseren videre til TikTok (nemt klik-link)
app.get("/auth/tiktok/start", (req, res) => {
  const state = (req.query.state || "state_epush_123").toString();
  if (!TT_CLIENT_KEY || !TT_REDIRECT_URL) {
    return res.status(500).type("text/plain").send(
      "Missing env: TIKTOK_CLIENT_KEY eller TIKTOK_REDIRECT_URL"
    );
  }
  res.redirect(buildAuthorizeURL(state));
});

// Simpelt alternativt start-endpoint (kan bruges i UI)
app.get("/auth/tiktok/start2", (req, res) => {
  const url = buildAuthorizeURL("state_epush_123");
  res.type("text/html").send(
    `<meta charset="utf-8"><p>Open TikTok login:</p><p><a href="${url}">${url}</a></p>`
  );
});

// Callback fra TikTok
app.get("/auth/tiktok/callback", async (req, res) => {
  try {
    const code = (req.query.code || "").toString();
    const state = (req.query.state || "").toString();
    const errorReason = (req.query.error || "").toString();

    if (errorReason) {
      return res.status(400).type("text/plain").send(`TikTok error: ${errorReason}`);
    }
    if (!code) {
      return res
        .status(400)
        .type("text/plain")
        .send("Missing code (kom ikke tilbage fra TikTok med en authorization code).");
    }

    if (!TT_CLIENT_KEY || !TT_CLIENT_SECRET || !TT_REDIRECT_URL) {
      return res.status(500).type("text/plain").send(
        "Server misconfigured: mangler TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET / TIKTOK_REDIRECT_URL"
      );
    }

    const tokens = await exchangeCodeForTokens(code);
    // (Optionelt) hent basic user info for at bekræfte token virker
    let me = null;
    try {
      me = await fetchTikTokMe(tokens.access_token);
    } catch (e) {
      // Ikke fatalt for login-flowet, men nyttig debug
      me = { warn: "user.info fetch failed", meta: e.meta || null };
    }

    // Returnér læsbar side + JSON
    res
      .status(200)
      .type("html")
      .send(
        `<meta charset="utf-8">
         <h2>TikTok Login OK</h2>
         <p><strong>state:</strong> ${state || "(none)"} </p>
         <pre style="white-space:pre-wrap;">${JSON.stringify({ tokens, me }, null, 2)}</pre>
         <p>Gem tokens i din database/session i stedet for at vise dem i produktion.</p>`
      );
  } catch (err) {
    const meta = err.meta || null;
    res
      .status(500)
      .type("html")
      .send(
        `<meta charset="utf-8">
         <h2>OAuth fejl</h2>
         <pre style="white-space:pre-wrap;">${(err && err.message) || "Unknown"}</pre>
         <pre style="white-space:pre-wrap;">${JSON.stringify(meta, null, 2)}</pre>`
      );
  }
});

// Manual test: /auth/tiktok/me?access_token=XYZ
app.get("/auth/tiktok/me", async (req, res) => {
  try {
    const token = (req.query.access_token || "").toString();
    if (!token) return res.status(400).json({ error: "missing_access_token" });
    const me = await fetchTikTokMe(token);
    res.json(me);
  } catch (err) {
    res.status(500).json({ error: "fetch_me_failed", meta: err.meta || null });
  }
});

// --------------- (Valgfrit) Simple /jobs placeholders ---------------
// Hvis du allerede har en fungerende jobs-implementation, kan du fjerne disse
// eller lade dem være — de konflikter ikke hvis dine rigtige routes findes i en anden fil.
app.get("/jobs/:id", (req, res) => {
  res.json({ job_id: req.params.id, state: "demo", progress: 0 });
});

app.post("/jobs", (req, res) => {
  const { source_video_url } = req.body || {};
  if (!source_video_url) {
    return res.status(400).json({ error: "source_video_url required" });
  }
  // Returnér et fake job_id så UI kan fortsætte
  const jobId = `job_${Math.random().toString(36).slice(2, 10)}`;
  res.json({ job_id: jobId, state: "queued", progress: 0 });
});

// -------------------- Error handler --------------------
app.use((err, _req, res, _next) => {
  console.error("UNCAUGHT ERROR:", err);
  res.status(500).json({ error: "server_error" });
});

// -------------------- Start --------------------
app.listen(PORT, () => {
  console.log("✅ Server on", PORT);
  console.log("🔑 TIKTOK_CLIENT_KEY:", mask(TT_CLIENT_KEY));
  console.log("↩️  TIKTOK_REDIRECT_URL:", TT_REDIRECT_URL || "(missing)");
});
