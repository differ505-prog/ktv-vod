#!/usr/bin/env node
/**
 * KTV Telegram Bot (long polling, no HTTPS, 0 cost)
 *
 * 收到含 YouTube 網址的訊息 → POST 到本機 KTV server /api/process-youtube
 * → 立即 reply user「已送 pipeline」
 * → 之後每 30s 查 /api/jobs/:id, 完成 / 失敗時 push 通知
 *
 * 啟動: BOT_TOKEN=xxx node ktv-pipeline/telegram_bot.js
 * 取得 BOT_TOKEN: Telegram 找 @BotFather → /newbot
 */

import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('[skip] BOT_TOKEN 環境變數未設定 → Bot 不啟動');
  console.error('  設定方式:');
  console.error('    1. Telegram 找 @BotFather → /newbot → 取得 token');
  console.error('    2. NAS 上 echo "TELEGRAM_BOT_TOKEN=xxx" >> /home/vibe/ktv-vod/.env');
  console.error('    3. cd /home/vibe/ktv-vod && docker compose up -d telegram-bot');
  process.exit(0);
}

const KTV_API = process.env.KTV_API || 'http://localhost:3000';
const PIPELINE_API_TOKEN = process.env.PIPELINE_API_TOKEN || ''; // 跟 server.js 一致 (可選)
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 2000);   // Telegram long polling
const JOB_CHECK_MS    = Number(process.env.JOB_CHECK_MS    || 30000);  // job 狀態輪詢
const ALLOWED_USERS   = (process.env.ALLOWED_USERS || '')               // 可選白名單 (逗號分隔 Telegram user id)
  .split(',').map(s => s.trim()).filter(Boolean);
const JOB_STORE_PATH  = process.env.JOB_STORE_PATH || '/data/telegram-jobs.json';

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ─── DNS / 網路可達性偵測（未來防衛性編程）──────────────────────────
// ktv-net 為純 IPv4 網路, Docker 內嵌 DNS 可能返回 IPv6 位址,
// 導致 Node.js fetch 無法連線。此診斷區塊在啟動時提前發現問題,
// 避免上線後只能看 [poll] error 卻不知道根因。──────────────────────

const PREFER_IPV4 = process.env.NODE_OPTIONS?.includes('dns-result-order=ipv4first');

function logNetDiagnosis() {
  console.log('[net-diag] 網路環境偵測:');
  console.log(`[net-diag]   NODE_OPTIONS=${process.env.NODE_OPTIONS || '(未設定)'}`);
  console.log(`[net-diag]   預期 DNS 優先 IPv4: ${PREFER_IPV4 ? '是 ✓' : '否 ✗ (可能問題!)'}`);
  console.log(`[net-diag]   DNS nameserver: 127.0.0.11 (Docker 內嵌, 會返回 AAAA IPv6 記錄)`);
}

async function diagnoseTelegramReachability() {
  console.log('[net-diag] 測試 Telegram API 可達性...');
  const target = `${TELEGRAM_API}/getMe`;

  // 測試 DNS 解析結果（A 記錄 = IPv4）
  const ipv4 = await dns.promises.resolve4('api.telegram.org').then(a => a?.[0]).catch(() => null);
  console.log(`[net-diag]   api.telegram.org → IPv4: ${ipv4 || '解析失敗'}`);

  if (!ipv4) {
    console.error('[net-diag] ✗ DNS A 記錄解析失敗 (pure IPv6 or unreachable)');
    return false;
  }

  // 用 Node.js 內建 fetch（跟 pollLoop 同樣邏輯）做真實連線測試
  try {
    const r = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timeout: 5 }),
      signal: AbortSignal.timeout(10000),
    });
    const body = await r.text().catch(() => '(無法解析 body)');
    // 401 = token 無效但網路 OK, 403/404 = 網路 OK, 5xx = 網路 OK
    console.log(`[net-diag] ✓ Telegram API 可達 (HTTP ${r.status}): ${body.slice(0, 120)}`);
    return true;
  } catch (err) {
    console.error(`[net-diag] ✗ 無法連線 Telegram API: ${err.cause?.message || err.message}`);
    console.error('[net-diag]   可能原因:');
    if (!PREFER_IPV4) {
      console.error('[net-diag]   1. ktv-net 為純 IPv4 網路, 但 DNS 返回 IPv6 位址');
      console.error('[net-diag]      → 修復: docker-compose.yml 設定 NODE_OPTIONS=--dns-result-order=ipv4first');
    }
    console.error('[net-diag]   2. 網段防火牆封鎖 api.telegram.org (port 443)');
    console.error('[net-diag]   3. Proxy / VPN 設定問題');
    return false;
  }
}

// ─── 共用工具 ────────────────────────────────────────────────────

function ktvHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (PIPELINE_API_TOKEN) h.Authorization = `Bearer ${PIPELINE_API_TOKEN}`;
  return h;
}

// ---------- 共用工具 ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function tg(method, payload) {
  const r = await fetch(`${TELEGRAM_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Telegram ${method} failed: ${r.status} ${t}`);
  }
  return r.json();
}

const YT_REGEX = /(https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)[\w-]{11}(?:\S*)?)/i;

function extractYouTubeUrl(text) {
  const m = text.match(YT_REGEX);
  return m ? m[1] : null;
}

function isAllowed(userId) {
  return ALLOWED_USERS.length === 0 || ALLOWED_USERS.includes(String(userId));
}

// ---------- job 追蹤 (jobId + chatId 為 key,同一 chat 可同時追蹤多首) ----------
/** @type {Map<string, {url:string, jobId:string, chatId:number, sentAt:number}>} */
const sentJobs = new Map();

function trackingKey(jobId, chatId) {
  return `${jobId}:${chatId}`;
}

function loadJobs() {
  try {
    const jobs = JSON.parse(fs.readFileSync(JOB_STORE_PATH, 'utf8'));
    if (!Array.isArray(jobs)) throw new Error('job store 必須是陣列');
    for (const job of jobs) {
      if (!job?.jobId || !job?.url || !Number.isFinite(job?.chatId)) continue;
      sentJobs.set(trackingKey(String(job.jobId), job.chatId), { ...job, jobId: String(job.jobId) });
    }
    console.log(`[job-store] restored ${sentJobs.size} job(s)`);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[job-store] load failed:', err.message);
  }
}

function saveJobs() {
  try {
    fs.mkdirSync(path.dirname(JOB_STORE_PATH), { recursive: true });
    const tempPath = `${JOB_STORE_PATH}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify([...sentJobs.values()], null, 2));
    fs.renameSync(tempPath, JOB_STORE_PATH);
  } catch (err) {
    console.error('[job-store] save failed:', err.message);
  }
}

function trackJob(job) {
  const normalized = { ...job, jobId: String(job.jobId) };
  sentJobs.set(trackingKey(normalized.jobId, normalized.chatId), normalized);
  saveJobs();
}

function untrackJob(jobId, chatId) {
  sentJobs.delete(trackingKey(String(jobId), chatId));
  saveJobs();
}

async function sendToKTV(url) {
  const r = await fetch(`${KTV_API}/api/process-youtube`, {
    method: 'POST',
    headers: ktvHeaders(),
    body: JSON.stringify({ url }),
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

async function checkJob(jobId) {
  const r = await fetch(`${KTV_API}/api/jobs/${jobId}`, { headers: ktvHeaders() });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

// ---------- Telegram long polling ----------
let offset = 0;
let running = true;

async function pollOnce() {
  const r = await fetch(`${TELEGRAM_API}/getUpdates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      offset,
      timeout: 30,
      allowed_updates: ['message'],
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`getUpdates failed: ${r.status} ${t}`);
  }
  const data = await r.json();
  if (!data.ok) throw new Error(`Telegram API error: ${JSON.stringify(data)}`);

  for (const update of data.result || []) {
    offset = update.update_id + 1;
    const msg = update.message;
    if (!msg || !msg.text) continue;

    const chatId  = msg.chat.id;
    const userId  = msg.from?.id;
    const text    = msg.text.trim();

    // 指令: /start /help
    if (text === '/start' || text === '/help') {
      await tg('sendMessage', {
        chat_id: chatId,
        text: 'KTV 點歌 Bot\n\n把 YouTube 連結貼過來就行。\n範例: https://youtu.be/dQw4w9WgXcQ',
      });
      continue;
    }

    // 白名單
    if (!isAllowed(userId)) {
      await tg('sendMessage', {
        chat_id: chatId,
        text: `未授權 (你的 id: ${userId})`,
      });
      continue;
    }

    // 抓 YouTube URL
    const url = extractYouTubeUrl(text);
    if (!url) {
      await tg('sendMessage', {
        chat_id: chatId,
        text: '沒看到 YouTube 連結, 請貼 youtube.com 或 youtu.be 開頭的網址',
      });
      continue;
    }

    // 已送過的 URL (避免重複按)
    for (const [, job] of sentJobs) {
      if (job.url === url && Date.now() - job.sentAt < 10 * 60 * 1000) {
        await tg('sendMessage', {
          chat_id: chatId,
          text: `此 URL 已在 queue 中 (jobId: ${job.jobId || 'pending'})`,
        });
        return;
      }
    }

    // 送 pipeline
    try {
      const { status, data } = await sendToKTV(url);
      if (status === 429) {
        await tg('sendMessage', { chat_id: chatId, text: `太快: ${data.error || data.message || 'rate-limited'}` });
        continue;
      }
      if (status === 409 || data?.error === 'duplicate') {
        const existingJobId = data.existing_job_id || data.jobId;
        await tg('sendMessage', {
          chat_id: chatId,
          text: `此 URL 已在 pipeline queue 中\nJob: ${existingJobId || '?'}`,
        });
        if (existingJobId) {
          trackJob({ url, jobId: String(existingJobId), chatId, sentAt: Date.now() });
        }
        continue;
      }
      if (!data.success) {
        await tg('sendMessage', {
          chat_id: chatId,
          text: `Pipeline 拒收: ${data.error || JSON.stringify(data)}`,
        });
        continue;
      }
      const jobId = data.job_id || data.id || data.jobId;
      if (!jobId) {
        throw new Error(`Pipeline 未回傳 job id: ${JSON.stringify(data)}`);
      }
      trackJob({ url, jobId: String(jobId), chatId, sentAt: Date.now() });
      console.log(`[job-track] add ${jobId} chat=${chatId} total=${sentJobs.size}`);
      const queuePos = data.queue_position ? ` (queue 位置 #${data.queue_position})` : '';
      await tg('sendMessage', {
        chat_id: chatId,
        text: `已送 pipeline 🎤\nURL: ${url}\nJob: ${jobId}${queuePos}\n完成會自動通知`,
      });
    } catch (err) {
      await tg('sendMessage', {
        chat_id: chatId,
        text: `送 pipeline 失敗: ${err.message}`,
      });
    }
  }
}

async function pollLoop() {
  while (running) {
    try {
      await pollOnce();
    } catch (err) {
      const hint = err.cause?.message || err.message;
      // 提煉常見錯誤模式，給出具體修復指引
      if (hint.includes('getaddrinfo') || hint.includes('ENOTFOUND') || hint.includes('EAI_AGAIN')) {
        console.error(`[poll] ✗ DNS 解析失敗: ${hint}`);
        console.error('[poll]   → 確認 ktv-net 網路正常, 或設定 NODE_OPTIONS=--dns-result-order=ipv4first');
      } else if (hint.includes('ECONNREFUSED')) {
        console.error(`[poll] ✗ 連線被拒: ${hint}`);
      } else if (hint.includes('ETIMEDOUT') || hint.includes('timeout')) {
        console.error(`[poll] ✗ 連線超時: ${hint}`);
      } else {
        console.error('[poll] ✗ error:', hint);
      }
      await sleep(5000);
    }
  }
}

// ---------- job 完成通知輪詢 ----------
async function checkOneJob(job) {
  const jobId = job.jobId;
  try {
    const { status: httpStatus, data } = await checkJob(jobId);
    if (httpStatus !== 200) {
      console.error(`[job-check] ${jobId} HTTP ${httpStatus}: ${data.error || JSON.stringify(data)}`);
      return;
    }
    const status = data.status || data.state;
    if (status === 'completed' || status === 'done' || status === 'finished') {
      try {
        await tg('sendMessage', {
          chat_id: job.chatId,
          text: `✅ 完成: ${job.url}\n已加入點歌機, 可以去電視點了`,
        });
      } finally {
        // 即使 Telegram 通知失敗, 也要 untrack + 保留 log, 避免卡住
        untrackJob(jobId, job.chatId);
        console.log(`[job-notify] done ${jobId} chat=${job.chatId} remaining=${sentJobs.size}`);
      }
    } else if (status === 'failed' || status === 'error') {
      try {
        await tg('sendMessage', {
          chat_id: job.chatId,
          text: `❌ 失敗: ${job.url}\n${data.error || ''}`,
        });
      } finally {
        untrackJob(jobId, job.chatId);
        console.log(`[job-notify] failed ${jobId} chat=${job.chatId} remaining=${sentJobs.size}`);
      }
    }
  } catch (err) {
    console.error('[job-check]', jobId, err.message);
  }
}

async function jobCheckLoop() {
  while (running) {
    await sleep(JOB_CHECK_MS);
    // snapshot 一次, 避免迭代中 mutation 漏掉新加的 job
    const snapshot = [...sentJobs.values()];
    // 平行查詢 + 平行通知 (不受單一 await 阻塞其他 job)
    await Promise.allSettled(snapshot.map(checkOneJob));
  }
}

// ---------- 啟動 ----------
console.log('[start] KTV Telegram Bot');
console.log(`  KTV API: ${KTV_API}`);
console.log(`  Allowed users: ${ALLOWED_USERS.length === 0 ? '(all)' : ALLOWED_USERS.join(',')}`);
console.log(`  Job store: ${JOB_STORE_PATH}`);
logNetDiagnosis();
const telegramReachable = await diagnoseTelegramReachability();
if (!telegramReachable) {
  console.error('[start] Telegram API 不可達, 將進入 poll 並持續重試...');
}

loadJobs();

process.on('SIGINT',  () => { console.log('\n[stop] SIGINT');  running = false; });
process.on('SIGTERM', () => { console.log('\n[stop] SIGTERM'); running = false; });

pollLoop();
jobCheckLoop();
