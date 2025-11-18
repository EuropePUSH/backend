// index.js (ESM, Europepush backend + TikTok uploader, TikTok-optimized encode + ekstra debug)

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
const BACKEND_VERSION = "2025-11-18-tiktok-uploader-v4-debug";

console.log("🚀 Europepush backend starting, version:", BACKEND_VERSION);

const allowedOrigins = [
  "https://europepush.com",
  "https://www.europepush.com",
  "https://app.base44.com",
  "http://localhost:3000",
  "http://localhost:5173",
];

// CORS debug
app.use((req, res, next) => {
  const origin = req.headers.origin || "NO_ORIGIN";
  console.log(`[CORS] Origin: ${origin}  Path: ${req.method} ${req.path}`);
  next();
});

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
  credentials: true,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

// ----------------- SIMPLE DEBUG VERSION -----------------
app.get("/debug/version", (req, res) => {
  res.json({ ok: true, version: BACKEND_VERSION });
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
  console.log("[JOB]", job_id, "updateJobInDb patch:", patch);
  const { error } = await supabase
    .from("jobs")
    .update(patch)
    .eq("job_id", job_id);
  if (error) {
    console.error("Supabase update job error:", error);
    throw error;
  }
}

// ----------------- TIKTOK HELPERS -----------------
async function uploadVideoToTikTokInbox(accessToken, videoUrl) {
  const endpoint =
    "https://open.tiktokapis.com/v2/post/publish/inbox/video/init/";

  const body = {
    source_info: {
      source: "PULL_FROM_URL",
      video_url: videoUrl,
    },
  };

  console.log("[TikTok] Calling inbox upload with URL:", videoUrl);

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify(body),
  });

  const json = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    const code = json?.error?.code || resp.status;
    const msg = json?.error?.message || resp.statusText;
    console.error("[TikTok] HTTP error:", code, msg, json);
    throw new Error(`tiktok_upload_http_error: ${code} ${msg}`);
  }

  if (!json || !json.error || json.error.code !== "ok") {
    const code = json?.error?.code || "unknown";
    const msg = json?.error?.message || "unknown";
    console.error("[TikTok] API error:", code, msg, json);
    throw new Error(`tiktok_upload_error: ${code} ${msg}`);
  }

  if (!json.data || !json.data.publish_id) {
    console.error("[TikTok] Missing publish_id in response:", json);
    throw new Error("tiktok_upload_missing_publish_id");
  }

  return {
    publish_id: json.data.publish_id,
  };
}

// ----------------- HEALTH -----------------
app.get("/health", (req, res) => {
  res.json({ ok: true, status: "healthy" });
});

// ----------------- JOB WORKER -----------------
async function processJob(job_id, input) {
  let tmpIn = null;
  let tmpOut = null;

  console.log("[JOB]", job_id, "processJob start, input:", input);

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

    // Progress 10 – vi har accepteret jobbet
    await updateJobInDb(job_id, {
      state: "processing",
      progress: 10,
    });

    console.log(
      "[JOB]",
      job_id,
      "Downloading video from",
      source_video_url
    );
    const resp = await fetch(source_video_url);
    if (!resp.ok) {
      throw new Error(`download_failed_status_${resp.status}`);
    }
    const arrBuf = await resp.arrayBuffer();
    const buf = Buffer.from(arrBuf);

    tmpIn = path.join(os.tmpdir(), `in_${job_id}.mp4`);
    tmpOut = path.join(os.tmpdir(), `out_${job_id}.mp4`);
    await fs.writeFile(tmpIn, buf);
    console.log("[JOB]", job_id, "Downloaded file bytes:", buf.length);

    // ----------------- FFmpeg -----------------
    const ffArgs = [
      "-y",
      "-hide_banner",
      "-nostdin",
      "-threads",
      "2",
      "-i",
      tmpIn,
      "-vf",
      "scale=w=1080:h=1920:force_original_aspect_ratio=decrease:flags=lanczos,pad=1080:1920:(1080-iw)/2:(1920-ih)/2",
      "-c:v",
      "libx264",
      "-profile:v",
      "high",
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "medium",
      "-crf",
      "19",
      "-metadata",
      "title=Europepush ContentMølle Export",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      tmpOut,
    ];

    console.log("[JOB]", job_id, "FFmpeg args:", ffArgs.join(" "));
    await execa(ffmpegBin, ffArgs, {
      stdout: process.stdout,
      stderr: process.stderr,
    });

    console.log("[JOB]", job_id, "FFmpeg completed");

    // Progress 40 – encode færdig
    await updateJobInDb(job_id, {
      state: "processing",
      progress: 40,
    });

    // ----------------- READ OUTPUT FILE -----------------
    console.log("[JOB]", job_id, "Reading encoded file");
    const fileBuf = await fs.readFile(tmpOut);
    console.log("[JOB]", job_id, "Encoded file size:", fileBuf.length);

    // Progress 60 – ved at uploade til Supabase
    await updateJobInDb(job_id, {
      state: "processing",
      progress: 60,
    });

    // ----------------- SUPABASE STORAGE UPLOAD -----------------
    const storagePath = `jobs/${job_id}/clip_${Date.now()}.mp4`;
    console.log("[JOB]", job_id, "Uploading to Supabase at", storagePath);

    const upload = await supabase.storage
      .from("outputs")
      .upload(storagePath, fileBuf, {
        contentType: "video/mp4",
        upsert: true,
      });

    if (upload.error) {
      console.error("[JOB]", job_id, "Supabase upload error:", upload.error);
      throw new Error(`supabase_upload_failed: ${upload.error.message}`);
    }

    const { data: publicUrlData } = supabase.storage
      .from("outputs")
      .getPublicUrl(storagePath);

    const outputUrl = publicUrlData.publicUrl;
    console.log("[JOB]", job_id, "UPLOAD_OK, public URL:", outputUrl);

    // Progress 70 – video klar i storage
    await updateJobInDb(job_id, {
      state: "processing",
      progress: 70,
    });

    let outputs = [
      {
        idx: 0,
        url: outputUrl,
        caption,
        hashtags,
      },
    ];

    // ----------------- TIKTOK UPLOAD (INBOX) -----------------
    let tiktok_results = [];

    if (
      postToTikTok &&
      Array.isArray(tiktok_account_ids) &&
      tiktok_account_ids.length > 0
    ) {
      console.log(
        "[JOB]",
        job_id,
        "TikTok upload requested for accounts:",
        tiktok_account_ids
      );

      const { data: accounts, error: accError } = await supabase
        .from("tiktok_accounts")
        .select("id, open_id, access_token, tokens, profile")
        .in("id", tiktok_account_ids);

      if (accError) {
        console.error(
          "[JOB]",
          job_id,
          "Supabase tiktok_accounts fetch error:",
          accError
        );
      } else if (!accounts || accounts.length === 0) {
        console.warn(
          "[JOB]",
          job_id,
          "No matching TikTok accounts found for ids:",
          tiktok_account_ids
        );
      } else {
        for (const acc of accounts) {
          try {
            const tokensJson = acc.tokens || {};
            const profileJson = acc.profile || {};

            const accessToken =
              tokensJson.access_token ||
              tokensJson.accessToken ||
              acc.access_token ||
              null;

            const openId =
              profileJson?.data?.user?.open_id ||
              tokensJson.open_id ||
              acc.open_id ||
              acc.id;

            if (!accessToken) {
              throw new Error("missing_access_token_for_account");
            }

            const result = await uploadVideoToTikTokInbox(
              accessToken,
              outputUrl
            );

            console.log(
              "[JOB]",
              job_id,
              "TikTok upload OK for account:",
              acc.id,
              "open_id:",
              openId,
              "publish_id:",
              result.publish_id
            );

            tiktok_results.push({
              account_id: acc.id,
              open_id: openId,
              publish_id: result.publish_id,
              status: "ok",
            });
          } catch (err) {
            console.error(
              "[JOB]",
              job_id,
              "TikTok upload failed for account:",
              acc.id,
              "open_id:",
              acc.open_id,
              err
            );

            tiktok_results.push({
              account_id: acc.id,
              open_id: acc.open_id || null,
              publish_id: null,
              status: "error",
              error_message: err.message || String(err),
            });
          }
        }
      }
    }

    outputs[0].tiktok = tiktok_results;

    // Progress 90 – alt output samlet
    await updateJobInDb(job_id, {
      state: "processing",
      progress: 90,
    });

    // ----------------- MARK COMPLETED -----------------
    await updateJobInDb(job_id, {
      state: "completed",
      progress: 100,
      output: outputs,
      error_message: null,
    });

    console.log("[JOB]", job_id, "Job completed");
  } catch (err) {
    console.error("[JOB]", job_id, "Job worker failed:", err);
    try {
      await updateJobInDb(job_id, {
        state: "failed",
        progress: 100,
        error_message: err.message || String(err),
      });
    } catch (e2) {
      console.error(
        "[JOB]",
        job_id,
        "Also failed to mark job failed in DB:",
        e2
      );
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

    console.log("[JOB]", job_id, "POST /jobs input:", input);

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
    state: "state_epush_" + crypto.randomBytes(4).toString("hex"),
  });

  const authorize_url = `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`;
  res.json({ ok: true, authorize_url });
});

// Manual test-redirect
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

// Callback fra TikTok
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

    if (me.error && me.error.code !== "ok") {
      console.error("TikTok user info error:", me);
    } else {
      console.log("TikTok user info:", me);
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

    const upsertPayload = {
      id: open_id,
      open_id,
      display_name,
      avatar_url,
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: expiresAt,
      tokens,
      profile: me,
    };

    const { error: accError } = await supabase
      .from("tiktok_accounts")
      .upsert(upsertPayload, { onConflict: "id" });

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
          <p>Tokens are stored in the database. You can now close this window.</p>
        </body>
      </html>
    `);
  } catch (err) {
    console.error("TikTok callback error:", err);
    return res.status(500).send("TikTok callback internal error");
  }
});

// Status
app.get("/auth/tiktok/status", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("tiktok_accounts")
      .select("id, open_id, display_name, avatar_url")
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

// Liste kontoer
app.get("/tiktok/accounts", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("tiktok_accounts")
      .select("id, open_id, display_name, avatar_url");

    if (error) {
      console.error("Supabase tiktok_accounts list error:", error);
      return res.json({
        ok: true,
        accounts: [],
        debug_error: error.message || String(error),
      });
    }

    return res.json({
      ok: true,
      accounts: data || [],
    });
  } catch (err) {
    console.error("GET /tiktok/accounts error:", err);
    return res.json({
      ok: true,
      accounts: [],
      debug_error: String(err),
    });
  }
});

// ----------------- START SERVER -----------------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
