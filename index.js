// index.js
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
      "https://www.europepush.com",
      "http://localhost:3000",
    ],
    credentials: true,
  })
);

const PORT = Number(process.env.PORT || 10000);

// -------------------------
// SUPABASE
// -------------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing SUPABASE env vars");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// -------------------------
// TIKTOK CONFIG
// -------------------------
const TIKTOK_CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY || "";
const TIKTOK_CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET || "";
const TIKTOK_REDIRECT_URL =
  process.env.TIKTOK_REDIRECT_URL ||
  "https://api.europepush.com/auth/tiktok/callback";

// -------------------------
// HEALTH
// -------------------------
app.get("/", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// SIMPLE DEBUG
app.get("/auth/tiktok/debug", (req, res) => {
  res.json({
    client_key_present: !!TIKTOK_CLIENT_KEY,
    client_key_len: TIKTOK_CLIENT_KEY.length,
    redirect_uri: TIKTOK_REDIRECT_URL,
  });
});

// -------------------------
// TIKTOK AUTH URL
// -------------------------
app.get("/auth/tiktok/url", (req, res) => {
  if (!TIKTOK_CLIENT_KEY || !TIKTOK_CLIENT_SECRET) {
    return res.status(500).json({
      ok: false,
      error: "missing_tiktok_keys",
    });
  }

  const state = "state_epush_" + Math.random().toString(36).slice(2, 8);

  const authorize_url = `https://www.tiktok.com/v2/auth/authorize/?client_key=${TIKTOK_CLIENT_KEY}&response_type=code&scope=user.info.basic,video.upload,video.publish&redirect_uri=${encodeURIComponent(
    TIKTOK_REDIRECT_URL
  )}&state=${state}`;

  res.json({ ok: true, authorize_url, state });
});

// -------------------------
// TIKTOK CALLBACK
// -------------------------
app.get("/auth/tiktok/callback", async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!code) {
      return res
        .status(400)
        .send("Missing code. Make sure TikTok is calling this URL.");
    }

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
          redirect_uri: TIKTOK_REDIRECT_URL,
        }).toString(),
      }
    );

    const tokenData = await tokenResp.json();

    if (!tokenResp.ok || !tokenData.open_id) {
      console.error("Token exchange failed:", tokenData);
      return res.status(400).send(`
        <h1>TikTok Login failed</h1>
        <pre>${JSON.stringify(tokenData, null, 2)}</pre>
      `);
    }

    // gem / opdater konto
    const { error } = await supabase.from("tiktok_accounts").upsert(
      {
        open_id: tokenData.open_id,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_in: tokenData.expires_in,
      },
      { onConflict: "open_id" }
    );

    if (error) {
      console.error("Supabase upsert error:", error);
      return res.status(500).send("Failed to save TikTok account");
    }

    return res.send(`
      <h1>TikTok Login OK</h1>
      <p>You can close this tab and go back to EuropePUSH.</p>
    `);
  } catch (err) {
    console.error("Callback error:", err);
    return res.status(500).send("Internal error in TikTok callback");
  }
});

// -------------------------
// TIKTOK STATUS & ACCOUNTS
// -------------------------
app.get("/auth/tiktok/status", async (req, res) => {
  const { data, error } = await supabase
    .from("tiktok_accounts")
    .select("*")
    .limit(1);

  if (error) {
    console.error("status error:", error);
    return res.status(500).json({ ok: false, error: "supabase_error" });
  }

  if (!data || data.length === 0) {
    return res.json({ ok: true, connected: false });
  }

  return res.json({ ok: true, connected: true, account: data[0] });
});

app.get("/tiktok/accounts", async (req, res) => {
  const { data, error } = await supabase.from("tiktok_accounts").select("*");

  if (error) {
    console.error("accounts error:", error);
    return res.status(500).json({ ok: false, error: "supabase_error" });
  }

  return res.json({ ok: true, accounts: data });
});

// -------------------------
// JOBS – CREATE (FAKE RENDER)
// -------------------------
app.post("/jobs", async (req, res) => {
  try {
    const {
      source_video_url,
      postToTikTok,
      tiktok_account_ids,
      caption,
      hashtags,
    } = req.body || {};

    if (!source_video_url) {
      return res.status(400).json({ ok: false, error: "missing_source_video" });
    }

    const job_id =
      "job_" + Math.random().toString(36).substring(2, 10).toLowerCase();

    // 1) Indsæt job som allerede "completed"
    const { error: jobErr } = await supabase.from("jobs").insert({
      job_id,
      state: "completed",
      progress: 100,
      input: {
        source_video_url,
        postToTikTok: !!postToTikTok,
        tiktok_account_ids: tiktok_account_ids || [],
        caption: caption || null,
        hashtags: hashtags || [],
      },
      output: {
        urls: [source_video_url],
      },
    });

    if (jobErr) {
      console.error("Supabase insert job error:", jobErr);
      return res
        .status(500)
        .json({ ok: false, error: "job_insert_failed", details: jobErr });
    }

    // 2) Opret job_output med samme URL (idx 0)
    const { error: outErr } = await supabase.from("job_outputs").insert({
      job_id,
      idx: 0,
      url: source_video_url,
      caption: caption || null,
      hashtags: hashtags || [],
    });

    if (outErr) {
      console.error("Supabase job_output error:", outErr);
      // vi fejler ikke kaldet – jobbet er stadig completed
    }

    return res.json({ ok: true, job_id });
  } catch (err) {
    console.error("POST /jobs error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "job_creation_failed", details: String(err) });
  }
});

// -------------------------
// JOBS – GET STATUS
// -------------------------
app.get("/jobs/:job_id", async (req, res) => {
  try {
    const job_id = req.params.job_id;

    const { data: job, error: jobErr } = await supabase
      .from("jobs")
      .select("*")
      .eq("job_id", job_id)
      .single();

    if (jobErr || !job) {
      return res.status(404).json({ ok: false, error: "job_not_found" });
    }

    const { data: outputs, error: outErr } = await supabase
      .from("job_outputs")
      .select("*")
      .eq("job_id", job_id)
      .order("idx", { ascending: true });

    if (outErr) {
      console.error("job_outputs error:", outErr);
    }

    return res.json({
      ok: true,
      job: {
        job_id: job.job_id,
        state: job.state,
        progress: job.progress,
        input: job.input,
        output: outputs || [],
      },
    });
  } catch (err) {
    console.error("GET /jobs/:job_id error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "job_fetch_failed", details: String(err) });
  }
});

// -------------------------
// START SERVER
// -------------------------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
