// index.js - EuropePUSH backend
// Type: ESM (package.json should have "type": "module")

import express from "express";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

// ---------- ENV ----------
const PORT = process.env.PORT || 10000;
const SUPABASE_URL = process.env.SUPABASE_URL;
// Support both names so we don't break your existing Render env:
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

const TIKTOK_CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
const TIKTOK_CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
// IMPORTANT: must match TikTok Login Kit redirect URI exactly
const TIKTOK_REDIRECT_URI =
  process.env.TIKTOK_REDIRECT_URI ||
  "https://api.europepush.com/auth/tiktok/callback";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ Missing Supabase env vars (SUPABASE_URL / SUPABASE_SERVICE_KEY)");
  // Stop here so Render ikke prøver at køre uden DB
  process.exit(1);
}

// ---------- SUPABASE ----------
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ---------- APP SETUP ----------
const app = express();
app.set("trust proxy", true);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ---------- CORS (with credentials) ----------
const ALLOWED_ORIGINS = [
  "https://europepush.com",
  "https://www.europepush.com",
  "http://localhost:3000",
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Access-Control-Allow-Credentials", "true");
  }
  res.header(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,PATCH,DELETE,OPTIONS"
  );
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-api-key"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

// ---------- SMALL HELPERS ----------
function randomState(prefix = "state_epush_") {
  return prefix + crypto.randomBytes(4).toString("hex");
}

// ---------- HEALTH ----------
app.get("/", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ======================================================
//                 TIKTOK OAUTH FLOW
// ======================================================

// 1) Frontend calls: GET /auth/tiktok/connect
//    -> Backend returns authorize_url + state
app.get("/auth/tiktok/connect", async (req, res) => {
  try {
    if (!TIKTOK_CLIENT_KEY || !TIKTOK_CLIENT_SECRET) {
      return res.status(500).json({
        ok: false,
        error: "tiktok_not_configured",
      });
    }

    const state = randomState();
    const params = new URLSearchParams({
      client_key: TIKTOK_CLIENT_KEY,
      response_type: "code",
      redirect_uri: TIKTOK_REDIRECT_URI,
      scope: "user.info.basic,video.upload,video.publish",
      state,
    });

    const authorize_url = `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`;

    return res.json({
      ok: true,
      authorize_url,
      state,
    });
  } catch (err) {
    console.error("TikTok connect error:", err);
    return res.status(500).json({
      ok: false,
      error: "tiktok_connect_error",
    });
  }
});

// 2) TikTok redirects back to this URL after login
app.get("/auth/tiktok/callback", async (req, res) => {
  const { code, state } = req.query;

  if (!code) {
    return res.status(400).send("Missing ?code in callback");
  }

  try {
    // ---- exchange code for tokens ----
    const tokenResp = await fetch(
      "https://open.tiktokapis.com/v2/oauth/token/",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_key: TIKTOK_CLIENT_KEY,
          client_secret: TIKTOK_CLIENT_SECRET,
          grant_type: "authorization_code",
          code,
          redirect_uri: TIKTOK_REDIRECT_URI,
        }),
      }
    );

    const tokens = await tokenResp.json();

    // Try to fetch user info (open_id, avatar, display_name)
    let mePayload = null;

    if (tokens.access_token) {
      const meResp = await fetch(
        "https://open.tiktokapis.com/v2/user/info/?fields=open_id,avatar_url,display_name",
        {
          headers: {
            Authorization: `Bearer ${tokens.access_token}`,
          },
        }
      );

      const meJson = await meResp.json();
      mePayload = meJson;

      try {
        const user = meJson?.data?.user;
        if (user?.open_id) {
          // Upsert TikTok account into Supabase
          await supabase.from("tiktok_accounts").upsert(
            {
              id: user.open_id,
              username: null,
              display_name: user.display_name ?? null,
              avatar_url: user.avatar_url ?? null,
              tokens,
              profile: user,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "id" }
          );
        }
      } catch (dbErr) {
        console.error("Supabase upsert tiktok_accounts error:", dbErr);
      }
    }

    // return simple debug page
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`
<!doctype html>
<html>
  <head><title>TikTok Login OK</title></head>
  <body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; white-space: pre; font-size: 14px;">
TikTok Login OK
state: ${state}

tokens:
${JSON.stringify(tokens, null, 2)}

me:
${JSON.stringify(mePayload, null, 2)}

Gem tokens i din database/session i stedet for at vise dem i produktion.
  </body>
</html>
    `);
  } catch (err) {
    console.error("TikTok callback error:", err);
    return res
      .status(500)
      .send("TikTok callback failed. Check backend logs for details.");
  }
});

// 3) Status for "TikTok Connect & Post" UI
app.get("/auth/tiktok/status", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("tiktok_accounts")
      .select("id, display_name, avatar_url")
      .limit(1);

    if (error) throw error;

    if (!data || data.length === 0) {
      return res.json({ ok: true, connected: false });
    }

    return res.json({
      ok: true,
      connected: true,
      account: data[0],
    });
  } catch (err) {
    console.error("Status error:", err);
    return res.json({
      ok: false,
      connected: false,
      error: "status_failed",
    });
  }
});

// 4) List TikTok accounts (for Create Job dropdown)
app.get("/tiktok/accounts", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("tiktok_accounts")
      .select("id, display_name, avatar_url")
      .order("created_at", { ascending: false });

    if (error) throw error;

    return res.json({
      ok: true,
      accounts: data ?? [],
    });
  } catch (err) {
    console.error("List tiktok accounts error:", err);
    return res.status(500).json({
      ok: false,
      error: "accounts_list_failed",
    });
  }
});

// ======================================================
//                       JOBS
// ======================================================

// POST /jobs  -> called from Base44 "Create Job" UI
app.post("/jobs", async (req, res) => {
  try {
    const {
      source_video_url,
      caption = null,
      hashtags = [],
      postToTikTok = false,
      tiktok_account_ids = [],
    } = req.body || {};

    if (!source_video_url) {
      return res.status(400).json({
        ok: false,
        error: "missing_source_video_url",
      });
    }

    const job_id = "job_" + crypto.randomBytes(4).toString("hex");
    const state = "processing";
    const progress = 0;

    const input = {
      source_video_url,
      caption,
      hashtags,
      postToTikTok,
      tiktok_account_ids,
    };

    const jobRow = {
      job_id,
      state,
      progress,
      input,
      output: [],
      error_message: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase.from("jobs").insert(jobRow);

    if (error) {
      console.error("Supabase insert job error:", error);
      return res.status(500).json({
        ok: false,
        error: "supabase_insert_error",
        detail: error.message,
      });
    }

    const job = {
      job_id,
      state,
      progress,
      input,
      output: [],
    };

    return res.status(200).json({
      ok: true,
      job_id,
      state,
      progress,
      job,
    });
  } catch (err) {
    console.error("Create job error:", err);
    return res.status(500).json({
      ok: false,
      error: "job_create_failed",
      detail: String(err.message || err),
    });
  }
});

// GET /jobs/:job_id -> polled by Dashboard and Base44 debug panel
app.get("/jobs/:job_id", async (req, res) => {
  const { job_id } = req.params;

  try {
    const { data, error } = await supabase
      .from("jobs")
      .select("*")
      .eq("job_id", job_id)
      .single();

    if (error && error.code === "PGRST116") {
      return res.status(404).json({
        ok: false,
        error: "job_not_found",
      });
    }

    if (error) throw error;

    return res.json({
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
  } catch (err) {
    console.error("Get job error:", err);
    return res.status(500).json({
      ok: false,
      error: "job_fetch_failed",
    });
  }
});

// ======================================================
//                START SERVER
// ======================================================

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
