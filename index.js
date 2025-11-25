// index.js
// Europepush backend – ContentMølle + TikTok uploader

import express from 'express';
import fetch from 'node-fetch';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import { nanoid } from 'nanoid';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'https://europepush.com';

// Version (for /debug/version)
const BACKEND_VERSION =
  process.env.BACKEND_VERSION || '2025-11-25-tiktok-username-v1';

// ---- Supabase setup -------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn(
    '[WARN] Supabase env vars missing – SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.'
  );
}

const supabase = SUPABASE_URL
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

async function updateJobInDb(jobId, patch) {
  if (!supabase) {
    console.log('[JOB]', jobId, 'updateJobInDb skipped (no supabase)');
    return;
  }
  console.log('[JOB]', jobId, 'updateJobInDb patch:', patch);
  const { error } = await supabase
    .from('jobs')
    .update(patch)
    .eq('id', jobId);
  if (error) {
    console.error('[JOB]', jobId, 'updateJobInDb error:', error);
  }
}

async function insertJobInDb(job) {
  if (!supabase) {
    console.log('[JOB]', job.id, 'insertJobInDb skipped (no supabase)');
    return;
  }
  const { error } = await supabase.from('jobs').insert(job);
  if (error) {
    console.error('[JOB]', job.id, 'insertJobInDb error:', error);
  }
}

async function getJobFromDb(jobId) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('jobs')
    .select('*')
    .eq('id', jobId)
    .single();
  if (error) {
    console.error('[JOB]', jobId, 'getJobFromDb error:', error);
    return null;
  }
  return data;
}

// generic Supabase upload helper
async function uploadOutputToSupabase(jobId, buffer) {
  if (!supabase) {
    console.log('[JOB]', jobId, 'Supabase upload skipped (no supabase)');
    return null;
  }

  const filePath = `jobs/${jobId}/clip_${Date.now()}.mp4`;
  console.log('[JOB]', jobId, 'Uploading to Supabase at', filePath);

  const { error } = await supabase.storage
    .from('outputs')
    .upload(filePath, buffer, {
      contentType: 'video/mp4',
      upsert: true,
    });

  if (error) {
    console.error('[JOB]', jobId, 'Supabase upload error:', error);
    throw error;
  }

  const { data: publicUrlData } = supabase.storage
    .from('outputs')
    .getPublicUrl(filePath);

  const url = publicUrlData?.publicUrl;
  console.log('[JOB]', jobId, 'UPLOAD_OK, public URL:', url);
  return url;
}

// ---- TikTok helpers -------------------------------------------------------

function buildCaption(caption, hashtags) {
  const tags =
    Array.isArray(hashtags) && hashtags.length
      ? ' ' +
        hashtags
          .map((t) => t.trim())
          .filter(Boolean)
          .map((t) => (t.startsWith('#') ? t : `#${t}`))
          .join(' ')
      : '';
  return (caption || '').trim() + tags;
}

// fetch basic profile to get username
async function fetchTikTokUserInfo(accessToken, openId) {
  try {
    const resp = await fetch(
      'https://open.tiktokapis.com/v2/user/info/?fields=display_name,username',
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'X-Tt-Account-Id': openId,
        },
      }
    );

    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({}));
      console.warn('[TikTok] user.info error:', errData);
      return null;
    }

    const data = await resp.json();
    const user = data?.data?.user || {};
    return user.display_name || user.username || null;
  } catch (err) {
    console.warn('[TikTok] user.info fetch error:', err.message);
    return null;
  }
}

// upload to inbox
async function uploadVideoToTikTokInbox({ jobId, account, videoUrl, caption, hashtags }) {
  const accessToken = account.access_token;
  const openId = account.open_id;

  if (!accessToken || !openId) {
    throw new Error('missing_access_token_for_account');
  }

  const fullCaption = buildCaption(caption, hashtags);

  const endpoint =
    'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/';

  const body = {
    source_info: {
      source: 'PULL_FROM_URL',
      video_url: videoUrl,
    },
    post_info: {
      title: fullCaption || 'Europepush ContentMølle export',
    },
  };

  console.log(
    '[TikTok] Calling inbox upload with URL:',
    videoUrl,
    'for open_id:',
    openId
  );

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-Tt-Account-Id': openId,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errorData = await resp.json().catch(() => ({}));
    console.error('[TikTok] HTTP error:', errorData?.error?.code, errorData);
    const msg = `tiktok_upload_http_error: ${
      errorData?.error?.code || resp.status
    } ${errorData?.error?.message || ''}`.trim();
    const err = new Error(msg);
    err.tiktok = errorData;
    throw err;
  }

  const data = await resp.json();
  const publishId =
    data?.data?.publish_id ||
    data?.data?.publish_id_str ||
    'UNKNOWN_PUBLISH_ID';

  console.log(
    '[TikTok] Upload OK job:',
    jobId,
    'open_id:',
    openId,
    'publish_id:',
    publishId
  );

  return {
    publish_id: publishId,
    raw: data,
  };
}

// Lookup TikTok account
async function getTikTokAccount(accountId, workspaceId) {
  if (!supabase) return null;
  const query = supabase
    .from('tiktok_accounts')
    .select('*')
    .eq('account_id', accountId)
    .limit(1);

  if (workspaceId) {
    query.eq('workspace_id', workspaceId);
  }

  const { data, error } = await query.single();
  if (error) {
    console.error('[TikTok] getTikTokAccount error:', error);
    return null;
  }
  return data;
}

// Clear TikTok connection
async function clearTikTokConnection(workspaceId) {
  if (!supabase) {
    console.log('[TikTok] clearTikTokConnection skipped (no supabase)');
    return;
  }
  const { error } = await supabase
    .from('tiktok_accounts')
    .delete()
    .eq('workspace_id', workspaceId);

  if (error) {
    console.error('[TikTok] clearTikTokConnection error:', error);
  } else {
    console.log(
      '[TikTok] Cleared TikTok tokens/accounts for workspace',
      workspaceId
    );
  }
}

// ---- CORS + logging middleware -------------------------------------------

app.use((req, res, next) => {
  const origin = req.headers.origin || 'NO_ORIGIN';
  console.log(`[CORS] Origin: ${origin}  Path: ${req.method} ${req.path}`);

  const allowedOrigins = new Set([
    FRONTEND_ORIGIN,
    'http://localhost:3000',
    'http://localhost:5173',
  ]);

  if (allowedOrigins.has(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }

  res.header(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Workspace-Id, X-Return-Json'
  );
  res.header(
    'Access-Control-Allow-Methods',
    'GET,POST,OPTIONS,PUT,PATCH,DELETE'
  );
  res.header('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

// ---- Basic routes ---------------------------------------------------------

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'europepush-backend',
    version: BACKEND_VERSION,
  });
});

app.get('/debug/version', (req, res) => {
  res.json({ version: BACKEND_VERSION });
});

// ---- TikTok auth routes ---------------------------------------------------

app.get('/auth/tiktok/status', async (req, res) => {
  const workspaceId = req.headers['x-workspace-id'];
  if (!workspaceId || !supabase) {
    return res.json({ connected: false, accounts: [] });
  }

  const { data, error } = await supabase
    .from('tiktok_accounts')
    .select('account_id, open_id, username')
    .eq('workspace_id', workspaceId);

  if (error) {
    console.error('[TikTok] status error:', error);
    return res.status(500).json({ connected: false, accounts: [] });
  }

  res.json({
    connected: data.length > 0,
    accounts: data,
  });
});

app.get('/auth/tiktok/connect', (req, res) => {
  const workspaceId = req.headers['x-workspace-id'] || 'no_workspace';
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  const redirectUri =
    process.env.TIKTOK_REDIRECT_URI ||
    'https://api.europepush.com/auth/tiktok/callback';

  const scopes = [
    'user.info.basic',
    'video.upload',
    'video.publish',
  ];

  const state = `state_epush_${nanoid(8)}_${workspaceId}`;

  const authUrl = new URL('https://www.tiktok.com/v2/auth/authorize/');
  authUrl.searchParams.set('client_key', clientKey);
  authUrl.searchParams.set('scope', scopes.join(','));
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);

  if (req.headers['x-return-json'] === '1') {
    return res.json({ ok: true, url: authUrl.toString(), state, workspaceId });
  }

  return res.redirect(authUrl.toString());
});

app.get('/auth/tiktok/callback', async (req, res) => {
  const { code, state } = req.query;
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
  const redirectUri =
    process.env.TIKTOK_REDIRECT_URI ||
    'https://api.europepush.com/auth/tiktok/callback';

  if (!code) {
    return res.status(400).send('Missing code');
  }

  const workspaceId =
    typeof state === 'string' ? state.split('_').slice(-1)[0] : 'no_workspace';

  let debugPayload = {
    ok: false,
    step: 'callback_start',
    workspaceId,
  };

  try {
    const tokenResp = await fetch(
      'https://open.tiktokapis.com/v2/oauth/token/',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_key: clientKey,
          client_secret: clientSecret,
          code,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
        }),
      }
    );

    if (!tokenResp.ok) {
      const errData = await tokenResp.json().catch(() => ({}));
      console.error('[TikTok] token exchange error:', errData);
      debugPayload = {
        ...debugPayload,
        ok: false,
        step: 'token_error',
        tokenError: errData,
      };
    } else {
      const tokenData = await tokenResp.json();
      const accessToken = tokenData.access_token;
      const openId = tokenData.open_id;
      const expiresIn = tokenData.expires_in;
      const refreshToken = tokenData.refresh_token;
      const refreshExpiresIn = tokenData.refresh_expires_in;
      const scope = tokenData.scope;

      let username = null;
      if (accessToken && openId) {
        username = await fetchTikTokUserInfo(accessToken, openId);
      }

      if (supabase) {
        const { error } = await supabase.from('tiktok_accounts').upsert(
          {
            workspace_id: workspaceId,
            account_id: openId,
            open_id: openId,
            access_token: accessToken,
            refresh_token: refreshToken,
            scope,
            expires_at: new Date(
              Date.now() + expiresIn * 1000
            ).toISOString(),
            refresh_expires_at: new Date(
              Date.now() + refreshExpiresIn * 1000
            ).toISOString(),
            username,
          },
          { onConflict: 'workspace_id,account_id' }
        );

        debugPayload.supabaseResult = error
          ? { ok: false, error }
          : { ok: true };
        if (error) {
          console.error('[TikTok] upsert error:', error);
        }
      }

      debugPayload = {
        ...debugPayload,
        ok: true,
        step: 'callback_done',
        tokenData: {
          access_token: accessToken,
          open_id: openId,
          expires_in: expiresIn,
          refresh_expires_in: refreshExpiresIn,
          scope,
          token_type: tokenData.token_type,
        },
      };
    }
  } catch (err) {
    console.error('[TikTok] callback error:', err);
    debugPayload = {
      ...debugPayload,
      ok: false,
      step: 'callback_exception',
      error: err.message,
    };
  }

  const redirectBack =
    process.env.TIKTOK_CONNECT_DONE_REDIRECT ||
    `${FRONTEND_ORIGIN}/tiktok-connect?status=connected`;

  if (req.query.debug === '1') {
    res.setHeader('Content-Type', 'application/json');
    return res.send(JSON.stringify(debugPayload, null, 2));
  }

  return res.redirect(redirectBack);
});

app.post('/auth/tiktok/clear', async (req, res) => {
  try {
    const workspaceId = req.headers['x-workspace-id'];
    if (!workspaceId) {
      return res
        .status(400)
        .json({ ok: false, error: 'missing_workspace_id' });
    }

    await clearTikTokConnection(workspaceId);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[TikTok] /auth/tiktok/clear error:', err);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

app.get('/tiktok/accounts', async (req, res) => {
  const workspaceId = req.headers['x-workspace-id'];
  if (!workspaceId || !supabase) {
    return res.json({ accounts: [] });
  }

  const { data, error } = await supabase
    .from('tiktok_accounts')
    .select('account_id, open_id, username')
    .eq('workspace_id', workspaceId);

  if (error) {
    console.error('[TikTok] accounts error:', error);
    return res.status(500).json({ accounts: [] });
  }

  res.json({ accounts: data || [] });
});

// ---- Jobs (ContentMølle → encode → Supabase → TikTok) --------------------

app.post('/jobs', async (req, res) => {
  const payload = req.body || {};
  const {
    source_video_url,
    caption = null,
    hashtags = [],
    postToTikTok = false,
    tiktok_account_ids = [],
  } = payload;

  if (!source_video_url) {
    return res.status(400).json({ error: 'missing_source_video_url' });
  }

  const jobId = `job_${nanoid(8)}`;
  console.log('[JOB]', jobId, 'POST /jobs input:', payload);

  const jobRecord = {
    id: jobId,
    state: 'queued',
    progress: 0,
    input: payload,
    output: null,
    error_message: null,
    created_at: new Date().toISOString(),
  };

  await insertJobInDb(jobRecord);

  processJob(jobId, payload).catch((err) => {
    console.error('[JOB]', jobId, 'UNHANDLED processJob error:', err);
  });

  res.json({ id: jobId, state: 'queued', progress: 0 });
});

app.get('/jobs/:id', async (req, res) => {
  const jobId = req.params.id;
  const job = await getJobFromDb(jobId);
  if (!job) {
    return res.status(404).json({ error: 'job_not_found' });
  }
  res.json(job);
});

// ---- Job processing -------------------------------------------------------

async function processJob(jobId, input) {
  console.log('[JOB]', jobId, 'processJob start, input:', input);

  await updateJobInDb(jobId, { state: 'processing', progress: 10 });

  const { source_video_url, caption, hashtags, postToTikTok, tiktok_account_ids } =
    input;

  console.log('[JOB]', jobId, 'Downloading video from', source_video_url);
  const sourceResp = await fetch(source_video_url);
  if (!sourceResp.ok) {
    const msg = `download_failed: ${sourceResp.status}`;
    console.error('[JOB]', jobId, msg);
    await updateJobInDb(jobId, {
      state: 'failed',
      progress: 100,
      error_message: msg,
    });
    return;
  }

  const sourceBuf = Buffer.from(await sourceResp.arrayBuffer());
  console.log(
    '[JOB]',
    jobId,
    'Downloaded file bytes:',
    sourceBuf.byteLength || sourceBuf.length
  );

  const tmpDir = os.tmpdir();
  const inFile = path.join(tmpDir, `in_${jobId}.mp4`);
  const outFile = path.join(tmpDir, `out_${jobId}.mp4`);

  await fs.writeFile(inFile, sourceBuf);

  const ffmpegArgs = [
    '-y',
    '-hide_banner',
    '-nostdin',
    '-threads',
    '2',
    '-i',
    inFile,
    '-vf',
    'scale=w=1080:h=1920:force_original_aspect_ratio=decrease:flags=lanczos,pad=1080:1920:(1080-iw)/2:(1920-ih)/2',
    '-c:v',
    'libx264',
    '-profile:v',
    'high',
    '-pix_fmt',
    'yuv420p',
    '-preset',
    'medium',
    '-crf',
    '19',
    '-metadata',
    'title=Europepush ContentMølle Export',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
    outFile,
  ];

  console.log('[JOB]', jobId, 'FFmpeg args:', ffmpegArgs.join(' '));

  await runFfmpeg(jobId, ffmpegArgs);
  console.log('[JOB]', jobId, 'FFmpeg completed');

  await updateJobInDb(jobId, { state: 'processing', progress: 40 });

  const encodedBuf = await fs.readFile(outFile);
  console.log('[JOB]', jobId, 'Encoded file size:', encodedBuf.length);

  await updateJobInDb(jobId, { state: 'processing', progress: 60 });

  const publicUrl = await uploadOutputToSupabase(jobId, encodedBuf);

  await updateJobInDb(jobId, { state: 'processing', progress: 70 });

  const tiktokResults = [];

  if (postToTikTok && Array.isArray(tiktok_account_ids)) {
    for (const accountId of tiktok_account_ids) {
      const workspaceId = null; // hook this up later if needed
      const account = await getTikTokAccount(accountId, workspaceId);

      try {
        if (!account) {
          throw new Error('missing_access_token_for_account');
        }

        const result = await uploadVideoToTikTokInbox({
          jobId,
          account,
          videoUrl: publicUrl,
          caption,
          hashtags,
        });

        tiktokResults.push({
          account_id: accountId,
          open_id: account.open_id,
          publish_id: result.publish_id,
          raw: result.raw,
        });
      } catch (err) {
        console.error(
          '[JOB]',
          jobId,
          'TikTok upload failed for account:',
          accountId,
          'open_id:',
          account?.open_id || null,
          'Error:',
          err.message
        );
        tiktokResults.push({
          account_id: accountId,
          open_id: account?.open_id || null,
          error: err.message || 'tiktok_upload_failed',
        });
      }
    }
  }

  await updateJobInDb(jobId, { state: 'processing', progress: 90 });

  const output = [
    {
      idx: 0,
      url: publicUrl,
      caption,
      hashtags,
      tiktok: tiktokResults,
    },
  ];

  await updateJobInDb(jobId, {
    state: 'completed',
    progress: 100,
    output,
    error_message: null,
  });

  console.log('[JOB]', jobId, 'Job completed');
}

function runFfmpeg(jobId, args) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args);

    ff.stderr.on('data', (data) => {
      process.stderr.write(data);
    });

    ff.on('error', (err) => {
      console.error('[JOB]', jobId, 'FFmpeg spawn error:', err);
      reject(err);
    });

    ff.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const err = new Error(`FFmpeg exited with code ${code}`);
        console.error('[JOB]', jobId, err.message);
        reject(err);
      }
    });
  });
}

// ---- Start server ---------------------------------------------------------

app.listen(PORT, () => {
  console.log(
    `🚀 Europepush backend starting, version: ${BACKEND_VERSION}`
  );
  console.log(`Server running on port ${PORT}`);
});
