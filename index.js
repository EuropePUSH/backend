// index.js (ESM)

import express from "express";
import cors from "cors";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import ffmpegBin from "ffmpeg-static";
import { execa } from "execa";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

// ----------------- PATH FIX (ESM) -----------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ----------------- ENV -----------------
const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.API_KEY || "";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";

const TT_CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY || "";
const TT_CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET || "";
const TT_REDIRECT =
  process.env.TIKTOK_REDIRECT_URL ||
  "https://api.europepush.com/auth/tiktok/callback";

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("❌ Missing Supabase env vars");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ----------------- EXPRESS APP -----------------
const app = express();

const allowedOrigins = [
  "https://europepush.com",
  "https://www.europepush.com",
  "https://app.base44.com",
  "http://localhost:3000",
  "http://localhost:5173",
];

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
  })
);

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

// Preflight
app.options("*", (req, res) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,DELETE,OPTIONS"
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, x-api-key"
    );
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  return res.sendStatus(204);
});

// CORS headers på alle responses
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  next();
});

// ----------------- AUTH MIDDLEWARE -----------------
function requireApiKey(req, res, next) {
  if (!API_KEY) {
    return res
      .status(500)
      .json({ ok: false, error: "server_api_key_not_configured" });
  }
  const header = req.headers["x-api-key"];
  if (!header || header !== API_KEY) {
    return res.status(401).json({ ok: false, error: "invalid_api_key" });
  }
  next();
}

// ----------------- SUPABASE HELPERS -----------------
async function updateJobInDb(job_id, patch) {
  const { error } = await supabase.from("jobs").update(patch).eq("job_id", job_id);
  if (error) {
    console.error("Supabase update job error:", error);
    throw error;
  }
}

// ----------------- HEALTH -----------------
app.get("/health", (req, res) => {
  res.json({ ok: true, status: "healthy" });
});

// ----------------- JOB WORKER -----------------
async function processJob(job_id, input) {
  let tmpIn = null;
  let tmpOut = null;

  try {
    const {
      source_video_url,
      caption = null,
      hashtags = [],
      postToTikTok = false,
      tiktok_account_ids = [],
    } = input || {};

    if (!source_video_url) {
      throw new Error("missing_source_video_url");
    }

    console.log("Downloading video for job", job_id, "from", source_video_url);
    const resp = await fetch(source_video_url);
    if (!resp.ok) {
      throw new Error(`download_failed_status_${resp.status}`);
    }
    const arrBuf = await resp.arrayBuffer();
    const buf = Buffer.from(arrBuf);

    tmpIn = path.join(os.tmpdir(), `in_${job_id}.mp4`);
    tmpOut = path.join(os.tmpdir(), `out_${job_id}.mp4`);
    await fs.writeFile(tmpIn, buf);
    console.log("Downloaded to file bytes:", buf.length);

    const ffArgs = [
      "-y",
      "-hide_banner",
      "-nostdin",
      "-threads",
      "1",
      "-filter_threads",
      "1",
      "-filter_complex_threads",
      "1",
      "-i",
      tmpIn,
      "-vf",
      "scale=w=1080:h=1920:force_original_aspect_ratio=decrease:flags=fast_bilinear,pad=1080:1920:(1080-iw*min(1080/iw\\,1920/ih))/2:(1920-ih*min(1080/iw\\,1920/ih))/2,crop=1080-4:1920-4:2:2,pad=1080:1920:(1080-iw)/2:(1920-ih)/2",
      "-r",
      "30",
      "-map",
      "0:v:0",
      "-map",
      "0:a:0",
      "-c:v",
      "libx264",
      "-profile:v",
      "high",
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "ultrafast",
      "-crf",
      "21",
      "-tune",
      "fastdecode",
      "-x264-params",
      "ref=1:bframes=2:rc-lookahead=8:keyint=120:min-keyint=24:scenecut=0",
      "-maxrate",
      "3500k",
      "-bufsize",
      "7000k",
      "-max_muxing_queue_size",
      "1024",
      "-c:a",
      "copy",
      "-movflags",
      "+faststart",
      tmpOut,
    ];

    console.log("FFmpeg args:", ffArgs.join(" "));
    await execa(ffmpegBin, ffArgs, {
      stdout: process.stdout,
      stderr: process.stderr,
    });

    await updateJobInDb(job_id, {
      state: "processing",
      progress: 70,
    });

    const fileBuf = await fs.readFile(tmpOut);
    const storagePath = `jobs/${job_id}/clip_${Date.now()}.mp4`;

    const upload = await supabase.storage
      .from("outputs")
      .upload(storagePath, fileBuf, {
        contentType: "video/mp4",
        upsert: true,
      });

    if (upload.error) {
      throw new Error(`supabase_upload_failed: ${upload.error.message}`);
    }

    const { data: publicUrlData } = supabase.storage
      .from("outputs")
      .getPublicUrl(storagePath);

    const outputUrl = publicUrlData.publicUrl;
    console.log("UPLOAD_OK job:", job_id, "url:", outputUrl);

    let outputs = [
      {
        idx: 0,
        url: outputUrl,
        caption,
        hashtags,
      },
    ];

    if (postToTikTok && Array.isArray(tiktok_account_ids) && tiktok_account_ids.length > 0) {
      console.log("Would post to TikTok accounts:", tiktok_account_ids);
      // TODO: rigtig TikTok upload pr. account
    }

    await updateJobInDb(job_id, {
      state: "completed",
      progress: 100,
      output: outputs,
      error_message: null,
    });

    console.log("Job completed:", job_id);
  } catch (err) {
    console.error("Job worker failed", job_id, err);
    try {
      await updateJobInDb(job_id, {
        state: "failed",
        progress: 100,
        error_message: err.message || String(err),
      });
    } catch (e2) {
      console.error("Also failed to mark job failed in DB", e2);
    }
  } finally {
    if (tmpIn) {
      fs.unlink(tmpIn).catch(() => {});
    }
    if (tmpOut) {
      fs.unlink(tmpOut).catch(() => {});
    }
  }
}

// ----------------- JOB ROUTES -----------------
app.post("/jobs", requireApiKey, async (req, res) => {
  try {
    const {
      source_video_url,
      caption = null,
      hashtags = [],
      postToTikTok = false,
      tiktok_account_ids = [],
    } = req.body || {};

    if (!source_video_url) {
      return res
        .status(400)
        .json({ ok: false, error: "missing_source_video_url" });
    }

    const job_id = "job_" + crypto.randomBytes(4).toString("hex");

    const input = {
      source_video_url,
      caption,
      hashtags,
      postToTikTok,
      tiktok_account_ids,
    };

    const { data, error } = await supabase
      .from("jobs")
      .insert([
        {
          job_id,
          state: "processing",
          progress: 0,
          input,
          output: [],
          error_message: null,
        },
      ])
      .select("*")
      .single();

    if (error) {
      console.error("Supabase insert job error:", error);
      return res.status(500).json({
        ok: false,
        error: "supabase_insert_error",
        detail: error.message,
      });
    }

    processJob(job_id, input).catch((err) => {
      console.error("Background processJob crashed", job_id, err);
    });

    return res.json({
      ok: true,
      job_id,
      state: "processing",
      progress: 0,
      job: data,
    });
  } catch (err) {
    console.error("POST /jobs error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "internal_error", detail: String(err) });
  }
});

app.get("/jobs/:job_id", requireApiKey, async (req, res) => {
  const job_id = req.params.job_id;
  try {
    const { data, error } = await supabase
      .from("jobs")
      .select("*")
      .eq("job_id", job_id)
      .single();

    if (error) {
      if (error.code === "PGRST116") {
        return res.status(404).json({ ok: false, error: "job_not_found" });
      }
      console.error("Supabase get job error:", error);
      return res
        .status(500)
        .json({ ok: false, error: "supabase_get_job_error" });
    }

    return res.json({ ok: true, job: data });
  } catch (err) {
    console.error("GET /jobs/:job_id error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "internal_error", detail: String(err) });
  }
});

// ----------------- TIKTOK DEBUG -----------------
app.get("/auth/tiktok/debug", (req, res) => {
  res.json({
    client_key_present: !!TT_CLIENT_KEY,
    client_key_len: TT_CLIENT_KEY.length,
    client_key_preview:
      TT_CLIENT_KEY.length > 6
        ? `${TT_CLIENT_KEY.slice(0, 4)}…${TT_CLIENT_KEY.slice(-4)}`
        : TT_CLIENT_KEY,
    client_secret_present: !!TT_CLIENT_SECRET,
    client_secret_len: TT_CLIENT_SECRET.length,
    redirect_uri: TT_REDIRECT,
  });
});

// ----------------- TIKTOK AUTH FLOW -----------------
app.get("/auth/tiktok/url", (req, res) => {
  if (!TT_CLIENT_KEY || !TT_REDIRECT) {
    return res.status(500).json({
      ok: false,
      error: "missing_tiktok_env",
    });
  }

  const params = new URLSearchParams({
    client_key: TT_CLIENT_KEY,
    scope: "user.info.basic,video.upload,video.publish",
    response_type: "code",
    redirect_uri: TT_REDIRECT,
    state: "state_epush_123",
  });

  const authorize_url = `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`;
  res.json({ authorize_url });
});

app.get("/auth/tiktok/connect", (req, res) => {
  if (!TT_CLIENT_KEY || !TT_REDIRECT) {
    return res
      .status(500)
      .send("TikTok client key / redirect is not configured.");
  }

  const params = new URLSearchParams({
    client_key: TT_CLIENT_KEY,
    scope: "user.info.basic,video.upload,video.publish",
    response_type: "code",
    redirect_uri: TT_REDIRECT,
    state: "state_epush_" + crypto.randomBytes(4).toString("hex"),
  });

  const authorize_url = `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`;
  return res.redirect(authorize_url);
});

app.get("/auth/tiktok/callback", async (req, res) => {
  const { code, state } = req.query;

  if (!code) {
    return res.status(400).send("Missing code");
  }

  try {
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

    const tokens = await tokenResp.json();

    if (!tokenResp.ok || tokens.error) {
      console.error("TikTok token error:", tokens);
      return res.status(500).send(
        `<h1>TikTok Login Failed</h1>
         <p>${tokens.error_description || "Token error"}</p>`
      );
    }

    const accessToken = tokens.access_token;
    const refreshToken = tokens.refresh_token;
    const expiresIn = tokens.expires_in || 0;
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

    const meResp = await fetch(
      "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    const me = await meResp.json();

    if (me.error) {
      console.error("TikTok user info error:", me);
    }

    const user = me.data && me.data.user ? me.data.user : null;

    if (!user || !user.open_id) {
      return res.status(500).send(
        `<h1>TikTok Login Failed</h1>
         <p>Missing open_id from TikTok user info.</p>`
      );
    }

    const open_id = user.open_id;
    const display_name = user.display_name || "TikTok User";
    const avatar_url = user.avatar_url || null;

    const { error: authError } = await supabase.from("tiktok_auth").upsert(
      {
        tiktok_open_id: open_id,
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: expiresAt,
      },
      { onConflict: "tiktok_open_id" }
    );

    if (authError) {
      console.error("Supabase tiktok_auth upsert error:", authError);
    }

    const { error: accError } = await supabase.from("tiktok_accounts").upsert(
      {
        tiktok_open_id: open_id,
        display_name,
        avatar_url,
      },
      { onConflict: "tiktok_open_id" }
    );

    if (accError) {
      console.error("Supabase tiktok_accounts upsert error:", accError);
    }

    res.send(`
      <html>
        <body>
          <h1>TikTok Login OK</h1>
          <p>state: ${state || ""}</p>
          <pre>${JSON.stringify(
            {
              tokens: {
                has_access_token: !!accessToken,
                has_refresh_token: !!refreshToken,
                expires_at: expiresAt,
              },
              me,
            },
            null,
            2
          )}</pre>
          <p>Gem tokens i DB/session i stedet for at vise dem i produktion.</p>
        </body>
      </html>
    `);
  } catch (err) {
    console.error("TikTok callback error:", err);
    return res.status(500).send("TikTok callback internal error");
  }
});

app.get("/auth/tiktok/status", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("tiktok_accounts")
      .select("id, tiktok_open_id, display_name, avatar_url")
      .limit(1);

    if (error) {
      console.error("Supabase tiktok_accounts status error:", error);
      return res.json({ ok: false, connected: false, error: "supabase_error" });
    }

    if (!data || data.length === 0) {
      return res.json({ ok: true, connected: false });
    }

    return res.json({
      ok: true,
      connected: true,
      account: data[0],
    });
  } catch (err) {
    console.error("GET /auth/tiktok/status error:", err);
    return res.json({
      ok: false,
      connected: false,
      error: "internal_error",
    });
  }
});

// 🔥 FIXED VERSION – no .order() here
app.get("/tiktok/accounts", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("tiktok_accounts")
      .select("id, tiktok_open_id, display_name, avatar_url");

    if (error) {
      console.error("Supabase tiktok_accounts list error:", error);
      return res
        .status(500)
        .json({ ok: false, error: "supabase_error", detail: error.message });
    }

    return res.json({
      ok: true,
      accounts: data || [],
    });
  } catch (err) {
    console.error("GET /tiktok/accounts error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "internal_error", detail: String(err) });
  }
});

// ----------------- START SERVER -----------------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
