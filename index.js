// index.js (ESM)
import express from "express";
import cors from "cors";
import crypto from "crypto";
import fs from "fs/promises";
import fss from "fs";
import path from "path";
import os from "os";
import { createClient } from "@supabase/supabase-js";

// ---------- ENV ----------
const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.API_KEY || ""; // optional protection of POST /tiktok/post
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";

const TT_CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY || "";
const TT_CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET || "";
const TT_REDIRECT = process.env.TIKTOK_REDIRECT_URL || "";

// ---------- BASIC APP ----------
const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

// ---------- SUPABASE ----------
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.warn("⚠️ Missing SUPABASE envs");
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ---------- UTILS ----------
const tikBase = "https://open.tiktokapis.com";
const oauthBase = "https://open.tiktokapis.com/v2";

function mask(str = "", left = 4, right = 3) {
  if (!str) return "";
  if (str.length <= left + right) return str;
  return str.slice(0, left) + "…" + str.slice(-right);
}

async function downloadToTemp(url) {
  const r = await fetch(url);
  if (!r.ok) {
    throw new Error(`Download failed ${r.status}`);
  }
  const tmp = path.join(os.tmpdir(), `dl_${crypto.randomBytes(8).toString("hex")}.mp4`);
  const file = fss.createWriteStream(tmp);
  await new Promise((resolve, reject) => {
    r.body.pipe(file);
    r.body.on("error", reject);
    file.on("finish", resolve);
  });
  return tmp;
}

// Optional persistence helper (no hard failure if table is missing)
async function saveTokensToSupabase(open_id, tokens) {
  try {
    await supabase
      .from("oauth_tokens")
      .upsert({
        provider: "tiktok",
        open_id,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        scope: tokens.scope || null,
        expires_at: tokens.expires_in ? Math.floor(Date.now() / 1000) + Number(tokens.expires_in) : null,
        updated_at: new Date().toISOString()
      }, { onConflict: "provider,open_id" });
  } catch (e) {
    console.warn("⚠️ Could not upsert oauth_tokens (ok for demo):", e?.message || e);
  }
}

// ---------- IN-MEMORY DEMO STORE ----------
/**
 * Structure:
 * TOKENS = {
 *   demo_user: {
 *     open_id: "...",
 *     access_token: "...",
 *     refresh_token: "...",
 *     scope: "user.info.basic,video.upload,video.publish",
 *     fetched_at: 1234567890
 *   }
 * }
 */
const TOKENS = Object.create(null);
const DEMO_USER_KEY = "demo_user"; // one-account demo

// ---------- MIDDLEWARE ----------
function requireApiKey(req, res, next) {
  if (!API_KEY) return next(); // disabled
  const k = req.get("x-api-key") || "";
  if (k && k === API_KEY) return next();
  return res.status(401).json({ error: "missing_or_invalid_api_key" });
}

// ---------- HEALTH ----------
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    tiktok_env: {
      client_key_present: !!TT_CLIENT_KEY,
      client_secret_present: !!TT_CLIENT_SECRET,
      redirect: TT_REDIRECT
    }
  });
});

// ---------- OAUTH: START ----------
app.get("/auth/tiktok/start", (req, res) => {
  if (!TT_CLIENT_KEY || !TT_REDIRECT) {
    return res.status(500).send("TikTok env missing");
  }
  const state = "state_epush_123"; // simple for demo
  const scope = encodeURIComponent("user.info.basic,video.upload,video.publish");
  const redirect_uri = encodeURIComponent(TT_REDIRECT);
  const url = `https://www.tiktok.com/v2/auth/authorize/?client_key=${TT_CLIENT_KEY}&scope=${scope}&response_type=code&redirect_uri=${redirect_uri}&state=${state}`;
  res.redirect(url);
});

// ---------- OAUTH: DEBUG URL ----------
app.get("/auth/tiktok/url", (_req, res) => {
  const state = "state_epush_123";
  const scope = encodeURIComponent("user.info.basic,video.upload,video.publish");
  const redirect_uri = encodeURIComponent(TT_REDIRECT);
  const url = `https://www.tiktok.com/v2/auth/authorize/?client_key=${TT_CLIENT_KEY}&scope=${scope}&response_type=code&redirect_uri=${redirect_uri}&state=${state}`;
  res.json({ authorize_url: url });
});

// ---------- OAUTH: CALLBACK ----------
app.get("/auth/tiktok/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query;
  if (error) {
    return res.status(400).send(`TikTok error: ${error}: ${error_description || ""}`);
  }
  if (!code) {
    return res.status(400).send("missing code");
  }
  try {
    // Exchange code -> tokens
    const tokenResp = await fetch(`${oauthBase}/oauth/token/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: new URLSearchParams({
        client_key: TT_CLIENT_KEY,
        client_secret: TT_CLIENT_SECRET,
        code: String(code),
        grant_type: "authorization_code",
        redirect_uri: TT_REDIRECT
      })
    });
    const tokens = await tokenResp.json();

    // Try fetch me (optional in sandbox; may 400)
    let me = { warn: "user.info fetch failed" };
    try {
      const meResp = await fetch(`${tikBase}/v2/user/info/`, {
        method: "GET",
        headers: { Authorization: `Bearer ${tokens.access_token}` }
      });
      const maybeJSON = await meResp.text();
      try {
        me = JSON.parse(maybeJSON);
      } catch {
        me = { warn: "user.info returned non-JSON", status: meResp.status };
      }
    } catch (e) {
      me = { warn: "user.info failed", error: e?.message || String(e) };
    }

    // Derive an open_id if present; otherwise stub (sandbox can omit)
    const open_id =
      me?.data?.user?.open_id ||
      me?.data?.user?.id ||
      tokens?.open_id ||
      "sandbox_open_id";

    TOKENS[DEMO_USER_KEY] = {
      open_id,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      scope: tokens.scope,
      fetched_at: Date.now()
    };
    // Try store in Supabase for persistence
    await saveTokensToSupabase(open_id, tokens);

    // Simple dev page
    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(`<!doctype html>
<html><head><meta charset="utf-8"><title>TikTok Login OK</title></head>
<body style="font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;">
<h1>TikTok Login OK</h1>
<p><b>state:</b> ${state}</p>
<pre>${escapeHTML(JSON.stringify({ tokens }, null, 2))}</pre>
<pre>${escapeHTML(JSON.stringify({ me }, null, 2))}</pre>
<p>Gem tokens i din database/session i stedet for at vise dem i produktion.</p>
</body></html>`);
  } catch (e) {
    console.error("OAuth callback error:", e);
    res.status(500).send("OAuth exchange failed");
  }
});

function escapeHTML(s) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// ---------- STATUS (til Base44) ----------
app.get("/auth/tiktok/status", async (_req, res) => {
  const t = TOKENS[DEMO_USER_KEY];
  if (!t) return res.json({ connected: false });
  res.json({
    connected: true,
    open_id: mask(t.open_id),
    scopes: t.scope || null,
    fetched_at: t.fetched_at
  });
});

// ---------- POST video (push_by_file) ----------
app.post("/tiktok/post", requireApiKey, async (req, res) => {
  try {
    const { job_id, caption } = req.body || {};
    if (!job_id) return res.status(400).json({ error: "job_id_required" });

    // Get output url from Supabase job_outputs
    const { data: outs, error: outsErr } = await supabase
      .from("job_outputs")
      .select("*")
      .eq("job_id", job_id)
      .order("idx", { ascending: true })
      .limit(1);
    if (outsErr) throw outsErr;
    if (!outs || outs.length === 0) {
      return res.status(404).json({ error: "no_output_for_job" });
    }
    const fileUrl = outs[0].url;
    if (!fileUrl) return res.status(400).json({ error: "output_has_no_url" });

    // Ensure tokens
    const t = TOKENS[DEMO_USER_KEY];
    if (!t?.access_token) {
      return res.status(401).json({ error: "not_connected_to_tiktok" });
    }

    // 1) Download to temp
    const tmpFile = await downloadToTemp(fileUrl);
    const fileStat = await fs.stat(tmpFile);

    // 2) INIT
    const initResp = await fetch(`${tikBase}/v2/video/init/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${t.access_token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        source_info: {
          source: "FILE_UPLOAD",
          video_size: fileStat.size,
          chunk_size: fileStat.size // single PUT
        }
      })
    });
    const initJson = await initResp.json();
    if (!initResp.ok) {
      throw new Error(`init failed ${initResp.status}: ${JSON.stringify(initJson)}`);
    }
    const uploadUrl = initJson?.data?.upload_url;
    const videoId = initJson?.data?.video_id;
    if (!uploadUrl || !videoId) {
      throw new Error("init missing upload_url/video_id");
    }

    // 3) UPLOAD (single PUT)
    await new Promise((resolve, reject) => {
      const stream = fss.createReadStream(tmpFile);
      fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "video/mp4" },
        body: stream
      })
        .then(async (upRes) => {
          if (!upRes.ok) {
            const txt = await upRes.text();
            reject(new Error(`upload failed ${upRes.status}: ${txt}`));
          } else {
            resolve();
          }
        })
        .catch(reject);
    });

    // 4) PUBLISH
    const publishResp = await fetch(`${tikBase}/v2/video/publish/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${t.access_token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        video_id: videoId,
        post_info: {
          title: caption || ""
        }
      })
    });
    const publishJson = await publishResp.json();

    // Cleanup temp
    try { await fs.unlink(tmpFile); } catch {}

    if (!publishResp.ok) {
      return res.status(502).json({ step: "publish", error: publishJson });
    }

    return res.json({
      ok: true,
      video_id: videoId,
      publish: publishJson
    });
  } catch (e) {
    console.error("tiktok/post error:", e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// ---------- DEBUG ----------
app.get("/auth/tiktok/debug", (_req, res) => {
  res.json({
    client_key_present: !!TT_CLIENT_KEY,
    client_key_len: TT_CLIENT_KEY.length,
    client_key_preview: TT_CLIENT_KEY ? `${TT_CLIENT_KEY.slice(0,4)}…${TT_CLIENT_KEY.slice(-4)}` : null,
    client_secret_present: !!TT_CLIENT_SECRET,
    client_secret_len: TT_CLIENT_SECRET.length,
    redirect_uri: TT_REDIRECT
  });
});

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`✅ Server on ${PORT}`);
});
