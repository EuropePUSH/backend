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
import fetch from "node-fetch";

// ----------------- ENV -----------------
const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.API_KEY || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const VIDEO_JITTER = (process.env.VIDEO_JITTER || "").toLowerCase() === "true";

const TT_CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY || "";
const TT_CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET || "";
// OBS: denne skal matche TikTok Login Kit redirect URL
const TT_REDIRECT =
  process.env.TIKTOK_REDIRECT_URL ||
  "https://api.europepush.com/auth/tiktok/callback";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ----------------- CORS (med credentials) -----------------
const allowedOrigins = [
  "https://europepush.com",
  "https://www.europepush.com",
  "http://localhost:3000",
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Access-Control-Allow-Credentials", "true");
    res.header("Vary", "Origin");
  }

  res.header(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,DELETE,OPTIONS"
  );
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, X-API-KEY, x-api-key"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

// ----------------- BODY PARSING -----------------
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

// ----------------- HELPERS -----------------
function randomId(prefix = "job") {
  return `${prefix}_${crypto.randomBytes(4).toString("hex")}`;
}

function requireApiKey(req, res, next) {
  if (!API_KEY) return next(); // hvis du ikke vil bruge API-keys lige nu
  const key =
    req.headers["x-api-key"] || req.headers["X-API-KEY"] || req.query.api_key;
  if (!key || key !== API_KEY) {
    return res.status(401).json({ ok: false, error: "invalid_api_key" });
  }
  next();
}

// ----------------- HEALTH -----------------
app.get("/", (req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
  });
});

// =======================================================
// ===============   TIKTOK OAUTH FLOW   =================
// =======================================================

// Debug endpoint — kan kaldes fra browser
app.get("/auth/tiktok/debug", (req, res) => {
  const key = TT_CLIENT_KEY || "";
  const secret = TT_CLIENT_SECRET || "";
  res.json({
    client_key_present: !!key,
    client_key_len: key.length,
    client_key_preview: key ? `${key.slice(0, 4)}…${key.slice(-4)}` : null,
    client_secret_present: !!secret,
    client_secret_len: secret.length,
    client_secret_preview: secret
      ? `${secret.slice(0, 4)}…${secret.slice(-4)}`
      : null,
    redirect_uri: TT_REDIRECT,
  });
});

// 1) Returner authorize URL til frontend (Base44 + eget UI)
app.get("/auth/tiktok/url", (req, res) => {
  if (!TT_CLIENT_KEY || !TT_REDIRECT) {
    return res.status(500).json({
      ok: false,
      error: "tiktok_not_configured",
    });
  }

  const state = `state_epush_${crypto.randomBytes(4).toString("hex")}`;
  const scope = [
    "user.info.basic",
    "video.upload",
    "video.publish",
  ].join(",");

  const params = new URLSearchParams({
    client_key: TT_CLIENT_KEY,
    response_type: "code",
    redirect_uri: TT_REDIRECT,
    scope,
    state,
  });

  const authorize_url = `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`;

  res.json({
    ok: true,
    authorize_url,
    state,
  });
});

// 2) Simpel helper til connect-knappen – bare proxy til /auth/tiktok/url
app.get("/auth/tiktok/connect", (req, res) => {
  if (!TT_CLIENT_KEY || !TT_REDIRECT) {
    return res.status(500).json({
      ok: false,
      error: "tiktok_not_configured",
    });
  }

  const state = `state_epush_${crypto.randomBytes(4).toString("hex")}`;
  const scope = [
    "user.info.basic",
    "video.upload",
    "video.publish",
  ].join(",");

  const params = new URLSearchParams({
    client_key: TT_CLIENT_KEY,
    response_type: "code",
    redirect_uri: TT_REDIRECT,
    scope,
    state,
  });

  const authorize_url = `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`;

  res.json({
    ok: true,
    authorize_url,
    state,
  });
});

// 3) Callback fra TikTok – exchange code → tokens → user info → gem konto
app.get("/auth/tiktok/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    return res
      .status(400)
      .send(
        `<pre>TikTok Login ERROR\n\n${error}: ${error_description}</pre>`
      );
  }

  if (!code) {
    return res.status(400).send("<pre>Missing code</pre>");
  }

  if (!TT_CLIENT_KEY || !TT_CLIENT_SECRET || !TT_REDIRECT) {
    return res
      .status(500)
      .send("<pre>TikTok env vars missing on server.</pre>");
  }

  let tokenPayload = null;
  let mePayload = null;
  let htmlError = null;

  try {
    // ---- Exchange code for tokens ----
    const tokenParams = new URLSearchParams({
      client_key: TT_CLIENT_KEY,
      client_secret: TT_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: TT_REDIRECT,
    });

    const tokenResp = await fetch(
      "https://open.tiktokapis.com/v2/oauth/token/",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: tokenParams.toString(),
      }
    );

    const tokenJson = await tokenResp.json();
    tokenPayload = tokenJson;

    if (!tokenResp.ok || !tokenJson.access_token) {
      htmlError = `Token exchange failed: ${JSON.stringify(tokenJson, null, 2)}`;
      throw new Error(htmlError);
    }

    const accessToken = tokenJson.access_token;

    // ---- Fetch user info ----
    const fields = ["open_id", "display_name", "avatar_url"].join(",");
    const meResp = await fetch(
      `https://open.tiktokapis.com/v2/user/info/?fields=${encodeURIComponent(
        fields
      )}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    const meJson = await meResp.json();
    mePayload = meJson;

    if (!meResp.ok || !meJson.data || !meJson.data.user) {
      htmlError = `User info fetch failed: ${JSON.stringify(meJson, null, 2)}`;
      throw new Error(htmlError);
    }

    const user = meJson.data.user;
    const openId = user.open_id;

    // ---- Gem / opdatér konto i Supabase ----
    await supabase
      .from("tiktok_accounts")
      .upsert(
        {
          id: openId,
          username: user.username || null, // nogle konti har evt. ikke username
          display_name: user.display_name || null,
          avatar_url: user.avatar_url || null,
          tokens: tokenJson,
          profile: meJson,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "id" }
      );

    const pretty = (obj) => JSON.stringify(obj, null, 2);

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`
      <pre>
TikTok Login OK
state: ${state || "n/a"}

tokens:
${pretty(tokenPayload)}

me:
${pretty(mePayload)}

Gem tokens i din database/session i stedet for at vise dem i produktion.
      </pre>
    `);
  } catch (e) {
    const pretty = (obj) => JSON.stringify(obj, null, 2);
    res
      .status(500)
      .send(
        `<pre>TikTok Login ERROR\n\n${e.message}\n\n${htmlError || ""}\n\ntokens:\n${pretty(
          tokenPayload
        )}\n\nme:\n${pretty(mePayload)}</pre>`
      );
  }
});

// 4) Status endpoint – brugt af Base44 UI
app.get("/auth/tiktok/status", async (req, res) => {
  // simpelt: bare check om der OVERHOVEDET findes en konto
  const { data, error } = await supabase
    .from("tiktok_accounts")
    .select("id")
    .limit(1);

  if (error) {
    return res.status(500).json({
      ok: false,
      error: "supabase_error",
      detail: error.message,
    });
  }

  res.json({
    ok: true,
    connected: !!(data && data.length > 0),
  });
});

// 5) Liste af konti – til Accounts dropdown osv.
app.get("/tiktok/accounts", async (req, res) => {
  const { data, error } = await supabase
    .from("tiktok_accounts")
    .select("id, username, display_name, avatar_url, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    return res.status(500).json({
      ok: false,
      error: "supabase_error",
      detail: error.message,
    });
  }

  res.json({
    ok: true,
    accounts: data || [],
  });
});

// =======================================================
// ===============        JOBS API        ================
// =======================================================

// POST /jobs  (bruges af Base44 UI "Create Job")
app.post("/jobs", requireApiKey, async (req, res) => {
  try {
    const input = req.body || {};

    const job_id = randomId("job");
    const now = new Date().toISOString();

    const { error } = await supabase.from("jobs").insert({
      job_id,
      state: "processing",
      progress: 0,
      input,
      output: null,
      error_message: null,
      created_at: now,
      updated_at: now,
    });

    if (error) {
      console.error("Supabase insert job error:", error);
      return res.status(500).json({
        ok: false,
        error: "supabase_insert_error",
        detail: error.message,
      });
    }

    // "Fake" render + upload i baggrunden
    // Her kunne du i fremtiden:
    //  - lave variationer pr. TikTok-konto
    //  - kalde TikTok upload/publish for hver konto
    (async () => {
      try {
        // Simuler lidt behandling
        await new Promise((resolve) => setTimeout(resolve, 1500));

        const sourceUrl = input.source_video_url || null;
        const caption = input.caption || null;
        const hashtags = input.hashtags || [];

        const outputItems = [];
        if (sourceUrl) {
          outputItems.push({
            id: 1,
            job_id,
            idx: 0,
            url: sourceUrl,
            caption,
            hashtags,
          });
        }

        await supabase
          .from("jobs")
          .update({
            state: "completed",
            progress: 100,
            output: outputItems,
            updated_at: new Date().toISOString(),
          })
          .eq("job_id", job_id);
      } catch (err) {
        console.error("Background job error:", err);
        await supabase
          .from("jobs")
          .update({
            state: "failed",
            progress: 100,
            error_message: err.message,
            updated_at: new Date().toISOString(),
          })
          .eq("job_id", job_id);
      }
    })().catch((e) => console.error(e));

    res.status(200).json({
      ok: true,
      job_id,
      state: "processing",
      progress: 0,
    });
  } catch (err) {
    console.error("POST /jobs error:", err);
    res.status(500).json({
      ok: false,
      error: "internal_error",
      detail: err.message,
    });
  }
});

// GET /jobs/:job_id  (polling fra Dashboard)
app.get("/jobs/:job_id", async (req, res) => {
  const { job_id } = req.params;

  const { data, error } = await supabase
    .from("jobs")
    .select("*")
    .eq("job_id", job_id)
    .maybeSingle();

  if (error) {
    console.error("Supabase get job error:", error);
    return res.status(500).json({
      ok: false,
      error: "supabase_error",
      detail: error.message,
    });
  }

  if (!data) {
    return res.status(404).json({
      ok: false,
      error: "job_not_found",
    });
  }

  res.json({
    ok: true,
    job: {
      job_id: data.job_id,
      state: data.state,
      progress: data.progress,
      input: data.input,
      output: data.output || [],
      error_message: data.error_message || null,
    },
  });
});

// (valgfrit) Liste jobs til dashboard-historik
app.get("/jobs", async (req, res) => {
  const limit = Number(req.query.limit || 20);

  const { data, error } = await supabase
    .from("jobs")
    .select("job_id, state, progress, created_at, updated_at, input, output")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    return res.status(500).json({
      ok: false,
      error: "supabase_error",
      detail: error.message,
    });
  }

  res.json({
    ok: true,
    jobs: data || [],
  });
});

// ----------------- START SERVER -----------------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
