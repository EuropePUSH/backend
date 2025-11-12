// index.js (ESM) — EuropePUSH backend (OAuth TikTok Sandbox compatible)

import express from "express";
import cors from "cors";
import fetch from "node-fetch"; // npm i node-fetch@3
import crypto from "crypto";

// ----------------- ENV -----------------
const PORT = Number(process.env.PORT || 10000);

// Din offentlige base-URL (brug samme domæne overalt!)
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://api.europepush.com";

// TikTok (S A N D B O X) nøgler
const TT_CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY || "";
const TT_CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET || "";

// Redirect skal være IDENTISK her og i TikTok Developer Portal (Sandbox → Login Kit)
const TT_REDIRECT = `${PUBLIC_BASE_URL}/auth/tiktok/callback`;

// Tillad simple test-UI’er (Base44 m.m.)
const app = express();
app.use(cors({ origin: "*"}));
app.use(express.json({ limit: "5mb" }));

// ----------------- Minimal in-memory “session” -----------------
// For demo/sandbox: gemmer tokens i RAM (1 bruger). I prod: brug DB.
let tikTokAuth = null;
// shape:
// {
//   access_token, refresh_token, expires_in, refresh_expires_in,
//   open_id, scope, obtain_at (Date.now())
// }

// ----------------- Helpers -----------------
const q = (params) =>
  Object.entries(params)
    .filter(([,v]) => v !== undefined && v !== null && v !== "")
    .map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

function mask(str, keep = 3) {
  if (!str) return "";
  if (str.length <= keep) return "*".repeat(str.length);
  return str.slice(0, keep) + "…" + str.slice(-keep);
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
  try {
    const json = JSON.parse(text);
    return { status: r.status, ok: r.ok, json, raw: text };
  } catch {
    return { status: r.status, ok: r.ok, json: null, raw: text };
  }
}

async function exchangeCodeForToken(code) {
  const url = "https://open.tiktokapis.com/v2/oauth/token/";
  const body = {
    client_key: TT_CLIENT_KEY,
    client_secret: TT_CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
    redirect_uri: TT_REDIRECT
  };

  const res = await ttFetchJSON(url, { method: "POST", body: JSON.stringify(body) });
  if (!res.ok) {
    const err = new Error("TikTok token exchange failed");
    err.meta = res;
    throw err;
  }
  return res.json.data || res.json; // TikTok svarer data/obj afhængigt af produkt
}

async function fetchUserInfo(access_token) {
  // Simpelt kald til user.info.basic
  const url = "https://open.tiktokapis.com/v2/user/info/";
  const body = { fields: ["open_id"] };
  const res = await ttFetchJSON(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${access_token}` },
    body: JSON.stringify(body)
  });
  return res;
}

// ----------------- Routes -----------------

app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// Fejlfinding — viser hvilke værdier serveren faktisk bruger
app.get("/auth/tiktok/debug", (_req, res) => {
  res.json({
    client_key_present: !!TT_CLIENT_KEY,
    client_key_len: TT_CLIENT_KEY.length,
    client_key_preview: TT_CLIENT_KEY ? `${TT_CLIENT_KEY.slice(0,4)}…${TT_CLIENT_KEY.slice(-4)}` : "",
    client_secret_present: !!TT_CLIENT_SECRET,
    client_secret_len: TT_CLIENT_SECRET.length,
    redirect_uri: TT_REDIRECT,
    public_base_url: PUBLIC_BASE_URL,
    has_tokens: !!tikTokAuth,
    open_id_preview: tikTokAuth?.open_id ? mask(tikTokAuth.open_id) : null
  });
});

// Giver korrekt authorize-URL (brug denne i Base44 UI)
app.get("/auth/tiktok/url", (_req, res) => {
  const state = "state_epush_" + crypto.randomBytes(4).toString("hex");
  const scope = "user.info.basic,video.upload,video.publish";

  const authorizeUrl =
    "https://www.tiktok.com/v2/auth/authorize/?" +
    q({
      client_key: TT_CLIENT_KEY,
      scope,
      response_type: "code",
      redirect_uri: TT_REDIRECT,
      state
    });

  res.json({ authorize_url: authorizeUrl });
});

// TikTok redirect rammer her. Vi bytter code -> tokens og henter open_id
app.get("/auth/tiktok/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query;

  try {
    if (error) {
      return res
        .status(400)
        .send(`<pre>TikTok Login ERROR\n\n${error}: ${error_description || ""}\nstate: ${state || ""}</pre>`);
    }
    if (!code) {
      return res.status(400).send("<pre>Missing code</pre>");
    }

    const tokens = await exchangeCodeForToken(code);

    // Gem midlertidigt
    tikTokAuth = {
      ...tokens,
      obtain_at: Date.now()
    };

    // Hent open_id (så Base44 kan vise "connected")
    const me = await fetchUserInfo(tokens.access_token);
    if (me.ok && me.json?.data?.user?.open_id) {
      tikTokAuth.open_id = me.json.data.user.open_id;
    }

    // Simpelt menneskeligt svar (så du kan debug i browser)
    res
      .status(200)
      .send(
        `<pre>TikTok Login OK\nstate: ${state || ""}\n\n${JSON.stringify(
          { tokens: { ...tokens, refresh_token: "•••masked•••" }, me: me.json || me.raw },
          null,
          2
        )}\n\nGem tokens i din database/session i stedet for at vise dem i produktion.</pre>`
      );
  } catch (err) {
    console.error("TT TOKEN EXCHANGE FAILED", {
      using_redirect: TT_REDIRECT,
      client_key_len: TT_CLIENT_KEY?.length,
      detail: err?.meta || String(err)
    });

    const meta = err?.meta;
    return res
      .status(500)
      .send(
        `<pre>TikTok Login ERROR\n\n${JSON.stringify(
          {
            message: "Token exchange failed",
            redirect_used: TT_REDIRECT,
            tiktok_response: meta || null
          },
          null,
          2
        )}</pre>`
      );
  }
});

// Status til Base44 — fortæller om der er en forbundet TikTok-bruger
app.get("/auth/tiktok/status", (_req, res) => {
  if (!tikTokAuth?.access_token) {
    return res.json({ connected: false });
  }
  return res.json({
    connected: true,
    open_id: tikTokAuth.open_id || null,
    open_id_preview: tikTokAuth.open_id ? mask(tikTokAuth.open_id) : null,
    scope: tikTokAuth.scope || null
  });
});

// (Stub) Post til TikTok — klar til at udvides med Sandbox upload/publish flow.
// Lad Base44 kalde denne efter render-job, så vi har en fast integration.
app.post("/tiktok/post", async (req, res) => {
  if (!tikTokAuth?.access_token || !tikTokAuth?.open_id) {
    return res.status(401).json({
      ok: false,
      error: "not_connected",
      message: "Connect TikTok under 'TikTok Connect & Post' først."
    });
  }

  // Modtag fra Base44:
  const { video_url, caption } = req.body || {};

  if (!video_url) {
    return res.status(400).json({
      ok: false,
      error: "missing_video_url",
      message: "Send { video_url } i request body."
    });
  }

  // Her kan du implementere TikTok Sandbox “upload by URL + publish”-flow.
  // Indtil vi aktiverer det fuldt ud, svarer vi 501 så UI’en kan vise tydelig besked.
  return res.status(501).json({
    ok: false,
    error: "not_implemented_yet",
    message:
      "Endpoint er klar, men posting til TikTok (Sandbox) er ikke aktiveret i denne build. OAuth og status virker.",
    received: { video_url, caption }
  });
});

// ----------------- Start -----------------
app.listen(PORT, () => {
  console.log(`✅ Server on ${PORT}`);
  console.log(`🔧 PUBLIC_BASE_URL: ${PUBLIC_BASE_URL}`);
  console.log(`🔧 TT_REDIRECT:     ${TT_REDIRECT}`);
});
