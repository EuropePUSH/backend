import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import fs from "fs";
import crypto from "crypto";

const PORT = process.env.PORT || 10000;
const PUBLIC_BASE_URL = "https://api.europepush.com";
const TT_CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY || "";
const TT_CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET || "";
const TT_REDIRECT = `${PUBLIC_BASE_URL}/auth/tiktok/callback`;

const app = express();
app.use(cors());
app.use(express.json());

const AUTH_FILE = "./tiktok_auth.json";

// Load token on startup
let tikTokAuth = null;
if (fs.existsSync(AUTH_FILE)) {
  try { tikTokAuth = JSON.parse(fs.readFileSync(AUTH_FILE)); } catch {}
}

// Save helper
function saveAuth(data) {
  tikTokAuth = data;
  fs.writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2));
}

function qs(o){return Object.entries(o).map(([k,v])=>`${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");}

async function fetchJSON(url, opts) {
  const r = await fetch(url, opts);
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { raw: t }; }
}

async function exchangeCodeForToken(code) {
  const body = new URLSearchParams({
    client_key: TT_CLIENT_KEY,
    client_secret: TT_CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
    redirect_uri: TT_REDIRECT
  });
  const r = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  return await r.json();
}

// --- ROUTES ---

app.get("/auth/tiktok/url", (req, res) => {
  const state = "state_" + crypto.randomBytes(4).toString("hex");
  const url =
    "https://www.tiktok.com/v2/auth/authorize/?" +
    qs({
      client_key: TT_CLIENT_KEY,
      scope: "user.info.basic,video.upload,video.publish",
      response_type: "code",
      redirect_uri: TT_REDIRECT,
      state
    });
  res.json({ authorize_url: url, state });
});

app.get("/auth/tiktok/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).send(error);
  const tokens = await exchangeCodeForToken(code);
  saveAuth(tokens.data);
  res.status(200).type("html").send(`
    <script>
      window.opener?.postMessage({ type: "tiktok_oauth_result", data: { ok: true } }, "*");
      window.close();
    </script>
  `);
});

app.get("/auth/tiktok/status", (req, res) => {
  res.json({ connected: !!tikTokAuth?.access_token });
});

app.post("/jobs", async (req, res) => {
  const { source_video_url, postToTikTok } = req.body;
  if (!source_video_url) return res.status(400).json({ error: "missing_source_video_url" });

  if (postToTikTok) {
    if (!tikTokAuth?.access_token)
      return res.status(401).json({ error: "tiktok_not_connected" });
    return res.json({ ok: true, message: "Simulated upload to TikTok (demo)" });
  }

  res.json({ ok: true, message: "Render job created (demo)" });
});

app.listen(PORT, () => console.log("✅ Demo backend running on", PORT));
