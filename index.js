import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

// -------------------------
// CONFIG
// -------------------------
const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(
  cors({
    origin: [
      "https://europepush.com",
      "http://localhost:3000",
      "https://www.europepush.com",
    ],
    credentials: true,
  })
);

// -------------------------
// SUPABASE
// -------------------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const TIKTOK_CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
const TIKTOK_CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
const REDIRECT_URL = "https://api.europepush.com/auth/tiktok/callback";

// -------------------------
// TIKTOK AUTH URL
// -------------------------
app.get("/auth/tiktok/url", (req, res) => {
  const state = "state_epush_" + Math.random().toString(36).substring(2, 8);

  const authorize_url = `https://www.tiktok.com/v2/auth/authorize/?client_key=${TIKTOK_CLIENT_KEY}&response_type=code&scope=user.info.basic,video.upload,video.publish&redirect_uri=${encodeURIComponent(
    REDIRECT_URL
  )}&state=${state}`;

  return res.json({ ok: true, authorize_url, state });
});

// -------------------------
// TIKTOK CALLBACK
// -------------------------
app.get("/auth/tiktok/callback", async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!code) return res.status(400).json({ error: "Missing code" });

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
          code,
          grant_type: "authorization_code",
          redirect_uri: REDIRECT_URL,
        }).toString(),
      }
    );

    const tokenData = await tokenResp.json();

    if (!tokenData.open_id)
      return res.status(400).json({ error: "Token exchange failed", tokenData });

    // save account
    await supabase.from("tiktok_accounts").upsert({
      open_id: tokenData.open_id,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_in: tokenData.expires_in,
    });

    return res.send(`
      <h1>TikTok Login OK</h1>
      <p>You can close this window and return to EuropePUSH</p>
    `);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "callback_failed", details: err });
  }
});

// -------------------------
// CHECK STATUS
// -------------------------
app.get("/auth/tiktok/status", async (req, res) => {
  const { data } = await supabase.from("tiktok_accounts").select("*").limit(1);

  if (!data || data.length === 0) {
    return res.json({ ok: true, connected: false });
  }

  return res.json({
    ok: true,
    connected: true,
    account: data[0],
  });
});

// -------------------------
// LIST ACCOUNTS
// -------------------------
app.get("/tiktok/accounts", async (req, res) => {
  const { data, error } = await supabase.from("tiktok_accounts").select("*");

  if (error) return res.status(500).json({ error });

  return res.json({ ok: true, accounts: data });
});

// -------------------------
// CREATE JOB
// -------------------------
app.post("/jobs", async (req, res) => {
  try {
    const { source_video_url, postToTikTok, tiktok_account_ids } = req.body;

    if (!source_video_url)
      return res.status(400).json({ error: "Missing source_video_url" });

    const job_id =
      "job_" + Math.random().toString(36).substring(2, 10).toLowerCase();

    await supabase.from("jobs").insert({
      job_id,
      state: "queued",
      progress: 0,
      input: {
        accounts: tiktok_account_ids || [],
        source_video_url,
        postToTikTok,
      },
    });

    return res.json({ ok: true, job_id });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "job_creation_failed", details: err });
  }
});

// -------------------------
// GET JOB STATUS  (CRITICAL)
// -------------------------
app.get("/jobs/:job_id", async (req, res) => {
  try {
    const job_id = req.params.job_id;

    const { data, error } = await supabase
      .from("jobs")
      .select("*")
      .eq("job_id", job_id)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: "job_not_found" });
    }

    return res.json({
      ok: true,
      job: {
        job_id: data.job_id,
        state: data.state,
        progress: data.progress,
        input: data.input,
        output: data.output || null,
        error_message: data.error_message || null,
      },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "job_fetch_failed", details: err });
  }
});

// -------------------------
app.get("/", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.listen(3000, () => console.log("Backend running on port 3000"));
