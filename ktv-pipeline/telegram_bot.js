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

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('[FATAL] BOT_TOKEN 環境變數未設定');
  console.error('  Telegram → @BotFather → /newbot → 取得 token');
  process.exit(1);
}

const KTV_API = process.env.KTV_API || 'http://localhost:3000';
const PIPELINE_API_TOKEN = process.env.PIPELINE_API_TOKEN || ''; // 跟 server.js 一致 (可選)
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 2000);   // Telegram long polling
const JOB_CHECK_MS    = Number(process.env.JOB_CHECK_MS    || 30000);  // job 狀態輪詢
const ALLOWED_USERS   = (process.env.ALLOWED_USERS || '')               // 可選白名單 (逗號分隔 Telegram user id)
  .split(',').map(s => s.trim()).filter(Boolean);

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

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

// ---------- job 追蹤 (in-memory) ----------
/** @type {Map<number, {url:string, jobId:string|null, chatId:number, sentAt:number}>} */
const sentJobs = new Map();

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
        const existingJobId = data.existing_job_id || data.jobId || '?';
        await tg('sendMessage', {
          chat_id: chatId,
          text: `此 URL 已在 pipeline queue 中\nJob: ${existingJobId}`,
        });
        sentJobs.set(chatId, { url, jobId: existingJobId, chatId, sentAt: Date.now() });
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
      sentJobs.set(chatId, { url, jobId, chatId, sentAt: Date.now() });
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
      console.error('[poll] error:', err.message);
      await sleep(5000);
    }
  }
}

// ---------- job 完成通知輪詢 ----------
async function jobCheckLoop() {
  while (running) {
    await sleep(JOB_CHECK_MS);
    for (const [chatId, job] of sentJobs.entries()) {
      if (!job.jobId) continue;
      try {
        const { data } = await checkJob(job.jobId);
        const status = data.status || data.state;
        if (status === 'completed' || status === 'done' || status === 'finished') {
          await tg('sendMessage', {
            chat_id: chatId,
            text: `✅ 完成: ${job.url}\n已加入點歌機, 可以去電視點了`,
          });
          sentJobs.delete(chatId);
        } else if (status === 'failed' || status === 'error') {
          await tg('sendMessage', {
            chat_id: chatId,
            text: `❌ 失敗: ${job.url}\n${data.error || ''}`,
          });
          sentJobs.delete(chatId);
        }
      } catch (err) {
        console.error('[job-check]', job.jobId, err.message);
      }
    }
  }
}

// ---------- 啟動 ----------
console.log('[start] KTV Telegram Bot');
console.log(`  KTV API: ${KTV_API}`);
console.log(`  Allowed users: ${ALLOWED_USERS.length === 0 ? '(all)' : ALLOWED_USERS.join(',')}`);

process.on('SIGINT',  () => { console.log('\n[stop] SIGINT');  running = false; });
process.on('SIGTERM', () => { console.log('\n[stop] SIGTERM'); running = false; });

pollLoop();
jobCheckLoop();
