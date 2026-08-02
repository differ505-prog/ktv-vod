/**
 * KTV VOD System - 後端中控 (The Brain)
 *
 * 架構：所有狀態 (playlist / currentSong / audioMode) 由後端集中管理，
 * 手機 (Controller) 與電視 (Player) 只是接收廣播的無狀態前端。
 *
 * 部署設定：環境變數讀自 .env
 *   PORT              監聽 port
 *   VIDEO_DIR         歌曲庫影片目錄
 *   VIDEO_URL_PREFIX  對前端使用的公開 URL prefix
 *   CORS_ORIGIN       CORS 白名單
 *   PIPELINE_API_URL  Python Pipeline 服務 URL (選填)
 *   PIPELINE_API_TOKEN  Pipeline 認證 token
 */

require('dotenv').config();

const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Server } = require('socket.io');
const { exec, spawn } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

// ===== 設定 =====
const PORT = parseInt(process.env.PORT, 10) || 3000;
const CORS_ORIGIN = (process.env.CORS_ORIGIN || '*').split(',').map((s) => s.trim());
const VIDEO_DIR = process.env.VIDEO_DIR || path.join(__dirname, 'videos');
const VIDEO_URL_PREFIX = process.env.VIDEO_URL_PREFIX || '/videos';
const PUBLIC_HOST = process.env.PUBLIC_HOST || '';

// ===== PWA 背景音訊 =====
// iOS Safari <audio> 不吃 mp4 container 裡的 AAC,所以預先抽成 .m4a
// (AAC in MP4 without video track) 才能在 iOS PWA 鎖屏播。
//
// 兩個變體:audio-original = 原唱 (L+R mixed mono), audio-vocal-off = 純伴奏 (L only mono)。
// 由 ktv-pipeline/pwa_audio.py 抽出,放 NAS 的同一個 processed 目錄下的 audio 子目錄。
const AUDIO_DIR = process.env.AUDIO_DIR || path.join(path.dirname(VIDEO_DIR), 'audio');
const AUDIO_URL_PREFIX = '/audio';

// ===== 歌曲編輯持久化 =====
// 為什麼要持久化:  SONG_LIBRARY 純在記憶體,brain 重啟就清空。
//   rebuildLibrary 內的 restoredEdits 只能在「同一次重啟內」防覆寫,
//   跨重啟仍會回到 parseSongTitle 自動解析值。
// 持久化方案:  本地歌的 title/artist 編輯寫到 /ktv-data/song-edits.json,
//   以 src 為 key; 啟動時 + 每次 rebuild 後套用回 SONG_LIBRARY。
// 為什麼用 src 不用 id:  src 是磁碟檔名路徑,跨重啟穩定; id 會重編。
const SONG_EDITS_FILE = process.env.SONG_EDITS_FILE || path.join(path.dirname(VIDEO_DIR), 'song-edits.json');

// 預設編輯 seed：用來在「沒有持久檔」時替已命名的歌提供預設 title/artist
// 對應檔名 src (raw, 與 SONG_LIBRARY 上的 s.src 一致) → { title, artist }
// 用途: 跨重啟後人工 / 自動判斷錯誤的檔名可在這裡補一個預設
// (使用者若要在 UI 改,可覆蓋此處)
const SONG_EDITS_SEED = {
  '/videos/#周深_封神之曲《达拉崩吧》_ktv.mp4': { title: '达拉崩吧', artist: '周深' },
};

function readSongEdits() {
  try {
    let map = new Map();
    if (fs.existsSync(SONG_EDITS_FILE)) {
      const raw = fs.readFileSync(SONG_EDITS_FILE, 'utf8');
      const obj = JSON.parse(raw);
      map = new Map(Object.entries(obj || {}));
    }
    // 套用 seed (僅在「檔內沒有」時)
    for (const [src, val] of Object.entries(SONG_EDITS_SEED)) {
      if (!map.has(src)) map.set(src, val);
    }
    return map;
  } catch (e) {
    log('warn', '讀取 song-edits 失敗', { err: e.message, file: SONG_EDITS_FILE });
    return new Map(Object.entries(SONG_EDITS_SEED));
  }
}

function writeSongEdits(map) {
  try {
    const obj = Object.fromEntries(map);
    // atomic write: 寫到 .tmp 再 rename, 避免中途 crash 造成空檔
    const tmp = SONG_EDITS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, SONG_EDITS_FILE);
  } catch (e) {
    log('warn', '寫入 song-edits 失敗', { err: e.message, file: SONG_EDITS_FILE });
  }
}

/** 套用持久 edits 到 SONG_LIBRARY 內所有 local 歌 (用 src 對應) */
function applyPersistedEdits() {
  const edits = readSongEdits();
  if (edits.size === 0) return 0;
  let n = 0;
  for (const s of SONG_LIBRARY) {
    if (s.source === 'local' && s.src) {
      const e = edits.get(s.src);
      if (e && e.title && e.artist) {
        if (s.title !== e.title || s.artist !== e.artist) {
          s.title = e.title;
          s.artist = e.artist;
          n += 1;
        }
      }
    }
  }
  return n;
}

// ===== 三層防護 = Hard Delete 防呆 (Soft Delete + 密碼 + 不分檔不分伇列) =====
// TRASH_DIR: 軟刪除把檔案移到這裡,而不是 fs.unlink — 误刪能救回。
//   - 不直接暴露為 URL prefix (安全考量)
//   - 預設放 /ktv-data/_Trash (ktv-data volume 內),與 VIDEO_DIR 同層
//   - 為何不放 VIDEO_DIR 下:container 內 VIDEO_DIR (/ktv-data/processed) 是
//     root owned,ktv user 無法 mkdir 新子目錄 (會 permission denied)
//   - Docker entrypoint 會幫忙建立 + chown;若失敗,server 啟動時降級為 warning
const TRASH_DIR = process.env.TRASH_DIR || '/ktv-data/_Trash';
// HOST_PIN: 主揪模式密碼 (預設 0000,符合「4 位數」的 直覺慣例)
//   - 可從 .env 覆寫 (生產環境應該改)
//   - 注意：這是「用户友善的防護」,不替代真正的存取控管
//   - 但能擋掉派對上一堆人掃 QR 後誤觸的刪除
const HOST_PIN = process.env.HOST_PIN || '0000';
const PIPELINE_API_URL = process.env.PIPELINE_API_URL || '';
const PIPELINE_API_TOKEN = process.env.PIPELINE_API_TOKEN || '';
const DEMUCS_MODEL = process.env.DEMUCS_MODEL || 'htdemucs';
const DEMUCS_FORCE_CPU = (process.env.DEMUCS_FORCE_CPU || 'false').toLowerCase() === 'true';
// Pipeline 呼叫去重:同一 URL 在 N 秒內只送一次 (避免手機狂點)
const PIPELINE_DEDUP_SECONDS = parseInt(process.env.PIPELINE_DEDUP_SECONDS || '60', 10);
const recentPipelineCalls = new Map(); // url -> timestamp
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

// ===== 歌手白名單 =====
let ARTIST_LOOKUP = {};
function loadArtistLookup() {
  try {
    const p = path.join(__dirname, 'artist-lookup.json');
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
      // 過濾掉 _comment 等 meta key
      ARTIST_LOOKUP = Object.fromEntries(
        Object.entries(raw).filter(([k]) => !k.startsWith('_'))
      );
      log('info', '歌手白名單已載入', { count: Object.keys(ARTIST_LOOKUP).length });
    } else {
      log('warn', 'artist-lookup.json 不存在，使用自動解析');
    }
  } catch (e) {
    log('warn', '載入 artist-lookup.json 失敗', { err: e.message });
  }
}
loadArtistLookup();

const TV_CACHE_DIR = process.env.TV_CACHE_DIR || path.join(path.dirname(VIDEO_DIR), 'tv_cache');
const CONFIG_FILE = path.join(path.dirname(VIDEO_DIR), 'sync_config.json');

let TV_SYNC_OFFSET = 0.0;
try {
  if (fs.existsSync(CONFIG_FILE)) {
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (data.tvSyncOffset !== undefined) TV_SYNC_OFFSET = Number(data.tvSyncOffset) || 0.0;
  }
} catch(e) {}

function saveSyncConfig(offset) {
  TV_SYNC_OFFSET = offset;
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ tvSyncOffset: offset }));
  } catch(e) { log('warn', '寫入 config 失敗', { err: e.message }); }
}

// ===== Express & HTTP Server =====
const app = express();
app.use(express.json({ limit: '1mb' }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CORS_ORIGIN, methods: ['GET', 'POST'] },
  // 對外網 (Tailscale Funnel / 反向代理) 友善：拉長 ping 容忍時間,
  // 避免 idle 30 秒就被代理或 NAT 誤判斷線。
  pingInterval: 25000,
  pingTimeout: 60000,
});

// ===== 靜態託管 =====
// HTML 永遠不要 cache (browser 必須抓新版 — JS 用 query string 自行 bust)
// 其他靜態資源 (js/css/圖) 預設即可
app.use((req, res, next) => {
  if (req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
}, express.static(path.join(__dirname, 'public')));

// 影片檔案靜態託管 (支援 range request, 適合大型 mp4 串流)
app.use(
  VIDEO_URL_PREFIX,
  express.static(VIDEO_DIR, {
    fallthrough: true,
    index: false,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.mp4')) {
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Accept-Ranges', 'bytes');
      }
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    },
  })
);

// PWA 背景音訊 (預先抽好的 .m4a,iOS PWA 鎖屏播放用)
app.use(
  AUDIO_URL_PREFIX,
  express.static(AUDIO_DIR, {
    fallthrough: true,
    index: false,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.m4a')) {
        res.setHeader('Content-Type', 'audio/mp4');
        res.setHeader('Accept-Ranges', 'bytes');
      }
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      // .m4a 已被預先混合 (Vocal 已 baked-in),不需要 iOS 重新解 mp4 container
      res.setHeader('Cache-Control', 'public, max-age=86400');
    },
  })
);

// ===== JIT Shadow Library 路由 =====
app.get('/tv-videos/:filename', async (req, res) => {
  const filename = req.params.filename;
  if (!filename || filename.includes('..') || filename.includes('/')) {
    return res.status(400).send('Invalid filename');
  }

  const origPath = path.join(VIDEO_DIR, filename);
  if (!fs.existsSync(origPath)) {
    return res.status(404).send('Not found');
  }

  const sendVideo = (filePath) => {
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.sendFile(filePath);
  };

  // offset 極小時直接回傳原檔
  if (Math.abs(TV_SYNC_OFFSET) < 0.01) {
    return sendVideo(origPath);
  }

  const shadowFilename = `${TV_SYNC_OFFSET.toFixed(2)}_${filename}`;
  const shadowPath = path.join(TV_CACHE_DIR, shadowFilename);

  if (!fs.existsSync(shadowPath)) {
    log('info', '即時產生 TV 陰影檔', { filename, offset: TV_SYNC_OFFSET });
    try {
      // 刪除該歌曲的舊快取
      const existingFiles = fs.readdirSync(TV_CACHE_DIR);
      for (const f of existingFiles) {
        if (f.endsWith(`_${filename}`)) {
          try { fs.unlinkSync(path.join(TV_CACHE_DIR, f)); } catch(e) {}
        }
      }

      let cmd;
      if (TV_SYNC_OFFSET > 0) {
        cmd = `ffmpeg -y -itsoffset ${TV_SYNC_OFFSET} -i "${origPath}" -i "${origPath}" -map 0:v -map 1:a -c copy "${shadowPath}"`;
      } else {
        cmd = `ffmpeg -y -itsoffset ${Math.abs(TV_SYNC_OFFSET)} -i "${origPath}" -i "${origPath}" -map 1:v -map 0:a -c copy "${shadowPath}"`;
      }
      await execPromise(cmd);
    } catch(err) {
      log('error', '產生 TV 陰影檔失敗', { err: err.message });
      return sendVideo(origPath); // 失敗就 fallback 給原檔
    }
  }

  sendVideo(shadowPath);
});

/**
 * /tv-videos-no-range/:filename
 *   - 專供 Funnel 環境 (朋友家外網) 用,避免 Funnel proxy 對 Range request 的處理造成
 *     <video> element 內建 audio decoder buffer underrun → 機械音。
 *   - 一律 200 OK + 完整檔案,不設 Accept-Ranges,不處理 Range request。
 *   - WebKit/Chromium 收到完整 mp4 時,moov 在檔頭已就緒,mp4 demuxer 預載完整檔後,
 *     <video> 的 audio decoder 會切到大 buffer 模式,對後續抖動容忍度高很多。
 *
 * 變更紀錄:
 *   - 2026-08-01 新增 (解決朋友家 Funnel + MV 模式 機械音)
 */
app.get('/tv-videos-no-range/:filename', (req, res) => {
  const filename = req.params.filename;
  if (!filename || filename.includes('..') || filename.includes('/')) {
    return res.status(400).send('Invalid filename');
  }

  const origPath = path.join(VIDEO_DIR, filename);
  if (!fs.existsSync(origPath)) {
    return res.status(404).send('Not found');
  }

  // 取 TV_SYNC_OFFSET 偏移產出的 shadow 快取 (與 /tv-videos 同一份,共用 tv_cache dir)
  const filePath = Math.abs(TV_SYNC_OFFSET) < 0.01
    ? origPath
    : path.join(TV_CACHE_DIR, `${TV_SYNC_OFFSET.toFixed(2)}_${filename}`);

  if (!fs.existsSync(filePath)) {
    // shadow 還沒產出就 fallback 回原檔 (沒 itsoffset 時也會到這)
    return res.sendFile(origPath);
  }

  const stat = fs.statSync(filePath);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Accept-Ranges', 'none'); // ← 明確告訴 Funnel proxy 不要 Range
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cache-Control', 'public, max-age=86400'); // Funnel 環境下重複點歌不會再下載

  // 整檔讀進記憶體一次送完,不走 stream + Range 的 buffer 模式
  // 註:300MB 以下 mp4 都能這樣做,RAM 佔用可控
  fs.readFile(filePath, (err, buffer) => {
    if (err) {
      log('error', '/tv-videos-no-range 讀檔失敗', { file: filePath, err: err.message });
      return res.status(500).send('Internal Server Error');
    }
    res.end(buffer);
  });
});

// ===== 工具 =====
function log(level, msg, extra) {
  const order = { debug: 0, info: 1, warn: 2, error: 3 };
  if ((order[level] || 1) < (order[LOG_LEVEL] || 1)) return;
  const ts = new Date().toISOString();
  const tag = level.toUpperCase().padEnd(5);
  console.log(`[${ts}] ${tag} ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`);
}

function getLocalIp() {
  try {
    const interfaces = os.networkInterfaces();
    if (!interfaces) return '127.0.0.1';
    for (const name of Object.keys(interfaces)) {
      const ifaces = interfaces[name];
      if (!ifaces) continue;
      for (const iface of ifaces) {
        if (iface && iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
  } catch (err) {
    log('warn', 'getLocalIp 失敗, 降級使用 127.0.0.1', { err: err.message });
  }
  return '127.0.0.1';
}

function toPublicUrl(src) {
  if (!src) return src;
  if (/^https?:\/\//i.test(src)) return src; // 已是絕對 URL
  // 已是 /videos/... 形式就不動
  if (src.startsWith(VIDEO_URL_PREFIX)) return src;
  // 否則補上 prefix
  return VIDEO_URL_PREFIX + (src.startsWith('/') ? src : '/' + src);
}

// ===== 歌曲庫載入 =====
/**
 * 淨化本地檔名 → { title, artist }
 * 例如: "Coldplay_Viva_La_Vida_(Official_Video)_ktv" → { title: "Viva La Vida", artist: "Coldplay" }
 *       "Beyond_海闊天空_ktv" → { title: "海闊天空", artist: "Beyond" }
 *       "伍佰 & China Blue 淚橋(MV完整版)" → { title: "淚橋", artist: "伍佰 & China Blue" }
 */
function parseSongTitle(raw) {
  let s = String(raw);

  // 移除常見後綴
  s = s.replace(/_?(ktv|Official[_ ]?MV|Official[_ ]?Video|Official|Audio|Live|完整版|MV完整版)$/gi, '');
  s = s.replace(/\(Official_Video\)/gi, '');
  s = s.replace(/【MV】/g, '');
  s = s.replace(/\.mp4$/i, '');

  // 底線替換為空格
  let normalized = s.replace(/_/g, ' ').trim();
  if (!normalized) return { title: raw, artist: '未知歌手' };

  // ── 1. 白名單歌手匹配 ────────────────────────────────────────
  {
    const lower = normalized.toLowerCase();
    for (const [key, displayName] of Object.entries(ARTIST_LOOKUP)) {
      const kw = key.toLowerCase().replace(/_/g, ' ');
      if (lower.startsWith(kw + ' ') || lower.startsWith(kw + '\u3000')) {
        let titlePart = normalized.slice(kw.length).replace(/^[\s\u3000]+/, '').trim();
        titlePart = titlePart.replace(/^[《」（）()【】\[\]]+/, '').trim();
        if (titlePart) return { artist: displayName, title: titlePart };
      }
    }
  }

  // ── 2.「歌手 - 歌名」格式 ────────────────────────────────────
  if (normalized.includes(' - ')) {
    const parts = normalized.split(' - ').map((p) => p.trim());
    const title = parts.pop().replace(/^[《」（）()【】\[\]]+|[《」（）()【】\[\]]+$/g, '').trim();
    const artist = parts.join(' ').replace(/^[《」（）()【】\[\]]+|[《」（）()【】\[\]]+$/g, '').trim();
    if (title) return { artist: artist || '未知歌手', title };
  }

  // ── 3. [歌手]歌名 括號格式 ───────────────────────────────────
  {
    const m = normalized.match(/^[\[【(（](.+?)[\]】)）]\s*(.+)$/);
    if (m) return { artist: m[1].trim(), title: m[2].trim() };
  }

  // ── 4. Fallback：找歌名最長的拆分 ─────────────────────────────
  if (raw.includes('_')) {
    const tokens = normalized.split(' ');
    if (tokens.length >= 2) {
      let bestArtist = tokens[0];
      let bestTitle = tokens.slice(1).join(' ');
      for (let i = 1; i < Math.min(tokens.length, 5); i++) {
        const a = tokens.slice(0, i).join(' ');
        const t = tokens.slice(i).join(' ');
        if (t.length > bestTitle.length) { bestArtist = a; bestTitle = t; }
      }
      return { artist: bestArtist, title: bestTitle };
    }
  }

  return { title: normalized, artist: '未知歌手' };
}

// 策略:只顯示 VIDEO_DIR 下的 .mp4 檔,從檔名解析標題/歌手
// 之前有 6 首內建佔位假歌 (Big Buck Bunny 等) 已全部移除。
function scanLocalVideos() {
  const local = [];
  try {
    if (fs.existsSync(VIDEO_DIR)) {
      const files = fs
        .readdirSync(VIDEO_DIR)
        .filter((f) => /\.(mp4|webm|mkv)$/i.test(f));
      let idx = 0;
      for (const f of files) {
        idx += 1;
        const raw = path.basename(f, path.extname(f));
        // 跳過已經是 vocal_off 變體，避免在 library 重複出現
        if (/_vocal_off$/.test(raw)) continue;
        // 用 parseSongTitle 淨化檔名 → { title, artist }
        const { title, artist } = parseSongTitle(raw);
        // 若對應的 *_vocal_off.mp4 存在，就帶 srcVocalOff 給 TV 切換
        const vocalOffName = `${raw}_vocal_off.mp4`;
        const vocalOffExists = fs.existsSync(path.join(VIDEO_DIR, vocalOffName));
        // PWA 背景音訊:若有預先抽好的 .m4a (見 ktv-pipeline/pwa_audio.py),也帶給前端
        const audioOrigName = `${raw}.m4a`;
        const audioVocName = `${raw}-vocal-off.m4a`;
        const audioOrigExists = fs.existsSync(path.join(AUDIO_DIR, audioOrigName));
        const audioVocExists = fs.existsSync(path.join(AUDIO_DIR, audioVocName));
        local.push({
          id: `local-${String(idx).padStart(3, '0')}`,
          title,
          artist,
          duration: '未知',
          src: toPublicUrl(f), // 透過 /videos prefix 提供
          srcVocalOff: vocalOffExists ? toPublicUrl(vocalOffName) : null,
          // PWA 背景音訊:若有 .m4a 就提供 URL,iOS 鎖屏播放用
          audioOriginal: audioOrigExists ? `${AUDIO_URL_PREFIX}/${encodeURIComponent(audioOrigName)}` : null,
          audioVocalOff: audioVocExists ? `${AUDIO_URL_PREFIX}/${encodeURIComponent(audioVocName)}` : null,
          cover: null,
          source: 'local',
        });
      }
    }
  } catch (err) {
    log('warn', '讀取 VIDEO_DIR 失敗', { err: err.message });
  }
  return local;
}

function buildSongLibrary() {
  return scanLocalVideos();
}

let SONG_LIBRARY = buildSongLibrary();
const _initialAppliedEdits = applyPersistedEdits();
log('info', '歌曲庫已載入', { count: SONG_LIBRARY.length, appliedEdits: _initialAppliedEdits });

/**
 * 重新掃描 VIDEO_DIR 並比對差異。
 * - 有新增的 mp4 → 觸發 library_updated 並廣播給所有 client
 * - 有移除的 mp4 → 觸發 library_updated (前端會自己過濾)
 * 回傳 { changed: boolean, added: number, removed: number }
 */
function rebuildLibrary() {
  const previousIds = new Set(SONG_LIBRARY.map((s) => s.id));
  const previousLocal = new Set(
    SONG_LIBRARY.filter((s) => s.source === 'local').map((s) => s.src)
  );
  // 同時記住每首 local 歌的 srcVocalOff（含 null），給「vocal_off 檔出現/消失」時也能更新
  const previousVocalOff = new Map(
    SONG_LIBRARY.filter((s) => s.source === 'local').map((s) => [s.src, s.srcVocalOff || null])
  );

  const fresh = buildSongLibrary();
  const freshIds = new Set(fresh.map((s) => s.id));
  const freshLocal = new Set(
    fresh.filter((s) => s.source === 'local').map((s) => s.src)
  );

  const added = [...freshLocal].filter((x) => !previousLocal.has(x));
  const removed = [...previousLocal].filter((x) => !freshLocal.has(x));

  // 偵測 srcVocalOff 變動：同一首的 srcVocalOff 從 null → 有 或 反之
  let vocalOffChanged = false;
  for (const song of fresh.filter((s) => s.source === 'local')) {
    const prev = previousVocalOff.get(song.src);
    const cur = song.srcVocalOff || null;
    if (prev !== cur) {
      vocalOffChanged = true;
      log('info', 'srcVocalOff 變動', { title: song.title, from: prev, to: cur });
      break;
    }
  }

  if (added.length === 0 && removed.length === 0 && !vocalOffChanged) {
    return { changed: false, added: 0, removed: 0 };
  }

  // 把舊 library 中用戶編輯過 title/artist 的記錄合併回 fresh
  // (rebuildLibrary 只是重新掃描磁碟,磁碟上的 mp4 檔名不會變,變的只是 title/artist)
  // 注意: 這裡是「次級保護」,跨重啟的最終保護是 SONG_EDITS_FILE 持久化檔。
  const previousEdits = new Map();
  for (const s of SONG_LIBRARY) {
    if (s.source === 'local' && s.src) {
      previousEdits.set(s.src, { title: s.title, artist: s.artist });
    }
  }

  // 套用到 fresh：舊 library 有編輯過 → 用舊值覆蓋 fresh 的自動解析結果
  for (const s of fresh) {
    if (s.source === 'local') {
      const saved = previousEdits.get(s.src);
      if (saved) {
        s.title = saved.title;
        s.artist = saved.artist;
      }
    }
  }

  // 二次保險: 套用持久化 edits (覆蓋任何未被合併到的情況)
  const persistedEdits = readSongEdits();
  if (persistedEdits.size > 0) {
    for (const s of fresh) {
      if (s.source === 'local' && s.src) {
        const e = persistedEdits.get(s.src);
        if (e && e.title && e.artist) {
          s.title = e.title;
          s.artist = e.artist;
        }
      }
    }
  }

  SONG_LIBRARY = fresh;
  log('info', '歌曲庫已更新', { added: added.length, removed: removed.length, vocalOffChanged, restoredEdits: previousEdits.size, persistedEdits: persistedEdits.size });
  io.emit('library_updated', { songs: SONG_LIBRARY });

  // ===== 新歌自動加入播放清單 =====
  if (added.length > 0) {
    const newSongs = fresh.filter((s) => added.includes(s.src));

    // 判斷目前是否有「使用者自選」歌曲排隊中
    // addedBy 為 'Auto' 或 undefined 的算「系統自動」，其他才算使用者自選
    const hasUserSongs = playlist.some((s) => s.addedBy && s.addedBy !== 'Auto');

    for (const song of newSongs) {
      // 防重複：已在清單或正在播就跳過
      const alreadyQueued =
        playlist.some((s) => s.id === song.id) ||
        (currentSong && currentSong.id === song.id);
      if (alreadyQueued) continue;

      const queuedSong = {
        ...song,
        addedBy: 'Auto',
        addedAt: Date.now(),
      };

      if (!hasUserSongs) {
        // 沒有使用者自選歌曲 → 插到最前面，下一首就播
        playlist.unshift(queuedSong);
        log('info', '新歌插隊優先播放', { title: song.title });
      } else {
        // 有使用者自選歌曲排隊中 → 加到最後面，尊重使用者的點歌順序
        playlist.push(queuedSong);
        log('info', '新歌加入排程末尾', { title: song.title });
      }
    }

    if (!currentSong) {
      advanceToNextSong();
    } else {
      io.emit('playlist_updated', {
        playlist: [...playlist],
        currentSong,
      });
    }
  }

  return { changed: true, added: added.length, removed: removed.length };
}

// ===== 歌手白名單 REST API =====
app.get('/api/artists', (req, res) => {
  res.json({ success: true, artists: ARTIST_LOOKUP });
});

app.post('/api/artists', (req, res) => {
  const { key, displayName } = req.body || {};
  if (!key || typeof key !== 'string' || !displayName || typeof displayName !== 'string') {
    return res.status(400).json({ success: false, error: '需提供 key 與 displayName' });
  }
  const k = key.trim();
  const v = displayName.trim();
  if (!k || !v) return res.status(400).json({ success: false, error: 'key 與 displayName 不可為空' });

  ARTIST_LOOKUP[k] = v;
  try {
    const p = path.join(__dirname, 'artist-lookup.json');
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    raw[k] = v;
    fs.writeFileSync(p, JSON.stringify(raw, null, 2), 'utf-8');
    log('info', '更新歌手白名單', { key: k, displayName: v });
    // 重建歌曲庫讓解析立即生效
    setTimeout(() => { try { rebuildLibrary(); } catch (_) {} }, 100);
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: '寫入失敗: ' + e.message });
  }
});

app.delete('/api/artists/:key', (req, res) => {
  const k = decodeURIComponent(req.params.key);
  if (!k || !ARTIST_LOOKUP[k]) {
    return res.status(404).json({ success: false, error: '找不到該歌手' });
  }
  delete ARTIST_LOOKUP[k];
  try {
    const p = path.join(__dirname, 'artist-lookup.json');
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    delete raw[k];
    fs.writeFileSync(p, JSON.stringify(raw, null, 2), 'utf-8');
    log('info', '刪除歌手', { key: k });
    setTimeout(() => { try { rebuildLibrary(); } catch (_) {} }, 100);
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: '寫入失敗: ' + e.message });
  }
});

// ===== RESTful API =====
app.get('/api/songs', (req, res) => {
  res.json({ success: true, songs: SONG_LIBRARY });
});

/**
 * 主揪密碼驗證端點 (給前端 UX 用)。
 * 不回任何實質資訊 (success/fail 已足夠),不暴露 PIN,不做 session。
 *   - 失敗統一回 success:false,跟真實 invalid 並列,防側信道計時。
 *   - 唯一存在意義:讓前端可以「透過 server 驗」,而不是寫死 0000 在前端。
 */
app.post('/api/songs/host-verify', (req, res) => {
  const pin = String(req.body?.hostPin ?? '');
  // 用恆定時間比對,防 timing attack
  let ok = true;
  if (pin.length !== HOST_PIN.length) ok = false;
  for (let i = 0; i < Math.max(pin.length, HOST_PIN.length); i++) {
    if (pin[i] !== HOST_PIN[i]) ok = false;
  }
  // 無論成功失敗都加微小隨機抖動 — 反 profiling
  setTimeout(() => {
    if (!ok) log('warn', 'host-verify 失敗', { ip: req.ip });
    res.json({ success: ok });
  }, 80 + Math.floor(Math.random() * 60));
});

/**
 * 第 1 層 — 動作分離: 從「待播佇列」移除,但不刪檔。
 *
 * POST /api/songs/remove-from-queue
 * Body: { position: 0 }   // 佇列中的 index
 *
 * - 找不到/超出範圍 → 400
 * - 當前播放歌曲不在佇列內,所以移除永不影響正在播的歌
 * - 立刻廣播 playlist_updated,前端會同步
 */
app.post('/api/songs/remove-from-queue', (req, res) => {
  const position = parseInt(req.body?.position, 10);
  if (!Number.isInteger(position) || position < 0 || position >= playlist.length) {
    return res.status(400).json({ success: false, error: '無效的佇列位置' });
  }
  const removed = playlist.splice(position, 1)[0];
  log('info', '從佇列移除 (不刪檔)', { title: removed?.title, position });
  io.emit('playlist_updated', { playlist: [...playlist], currentSong });
  return res.json({ success: true, removed: { id: removed?.id, title: removed?.title } });
});

/**
 * 第 2 + 3 層: 主揪模式 + 軟刪除 — 移到 _Trash 資料夾,不 fs.unlink。
 *
 * POST /api/songs/delete
 * Body: { songId: 'song-003', hostPin: '0000', force: true }
 *
 * - src / srcVocalOff 都移走 (避免變成「唱原唱時還是舊檔」)
 * - hostPin 錯 → 401 (就算前端藏好,後端也要驗)
 * - 錯誤時的 cleanup: 若只 mv 成功一個檔,另一個還在原位 → 不要讓使用者以為刪乾淨
 *   所以先確認所有來源檔都存在,再一次性 mv
 * - force=true: 檔案不存在時仍刪除資料庫記錄（用於清理孤立的歌曲記錄）
 */
app.post('/api/songs/delete', (req, res) => {
  const songId = req.body?.songId;
  const hostPin = String(req.body?.hostPin ?? '');

  // 主揪模式驗證
  if (hostPin !== HOST_PIN) {
    log('warn', 'delete 嘗試但 hostPin 不對', { songId, ip: req.ip });
    return res.status(401).json({ success: false, error: '主揪密碼錯誤' });
  }

  const song = SONG_LIBRARY.find((s) => s.id === songId);
  if (!song) {
    return res.status(404).json({ success: false, error: '找不到這首歌' });
  }

  // 如果刪的是正在播放的歌曲 → 先切歌（停止播放並 advance）
  if (currentSong && currentSong.id === songId) {
    io.emit('stop_song');
    songHistory.push(currentSong);
    if (songHistory.length > 50) songHistory.shift();
    // 確保 playlist 裡也移除這首，避免 advanceToNextSong 還在佇列中看到它
    playlist = playlist.filter((s) => s.id !== songId);
    advanceToNextSong(true);
    log('info', '刪除正在播放的歌曲,已自動切歌', { songId });
  }

  // 計算實體檔案路徑 (src 是 URL,要還原到 VIDEO_DIR 的 basename)
  // 重要:pathname 會做 percent-encoding,但中文檔名磁碟上是 raw UTF-8
  //   所以需要 decodeURIComponent 才能對到實際檔案
  const sources = [];
  const srcBasename = decodeURIComponent(path.basename(new URL(song.src, 'http://x').pathname));
  const srcVocalBasename = song.srcVocalOff
    ? decodeURIComponent(path.basename(new URL(song.srcVocalOff, 'http://x').pathname))
    : null;
  sources.push({ role: 'src', abs: path.join(VIDEO_DIR, srcBasename), fileName: srcBasename, dir: VIDEO_DIR });
  if (srcVocalBasename) {
    sources.push({ role: 'srcVocalOff', abs: path.join(VIDEO_DIR, srcVocalBasename), fileName: srcVocalBasename, dir: VIDEO_DIR });
  }

  // PWA 背景音訊 .m4a (iOS 鎖屏播放用,見 ktv-pipeline/pwa_audio.py)
  // 與 mp4 一起搬到 trash,避免孤兒 m4a 佔空間。
  // audioOriginal/audioVocalOff URL 形式: /audio/<encoded-name>.m4a 與 /audio/<encoded-name>-vocal-off.m4a
  function audioBasenameFromUrl(audioUrl, suffix) {
    if (!audioUrl) return null;
    // audioUrl 可能是絕對 URL 或 /audio/xxx.m4a
    try {
      const u = new URL(audioUrl, 'http://x');
      return decodeURIComponent(path.basename(u.pathname));
    } catch (e) {
      return null;
    }
  }
  const audioOrigBasename = audioBasenameFromUrl(song.audioOriginal);
  const audioVocBasename = audioBasenameFromUrl(song.audioVocalOff);
  if (audioOrigBasename) {
    sources.push({ role: 'audioOriginal', abs: path.join(AUDIO_DIR, audioOrigBasename), fileName: audioOrigBasename, dir: AUDIO_DIR });
  }
  if (audioVocBasename) {
    sources.push({ role: 'audioVocalOff', abs: path.join(AUDIO_DIR, audioVocBasename), fileName: audioVocBasename, dir: AUDIO_DIR });
  }

  // 防呆 1: 同名檔案已存在於 trash → 加時間戳避免覆蓋
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); // ISO with `-` separator
  for (const s of sources) {
    s.trashName = fs.existsSync(path.join(TRASH_DIR, s.fileName))
      ? `${stamp}_${s.fileName}`
      : s.fileName;
  }

  // 防呆 2: 先確認所有來源檔都存在, 任一缺失就拒絕 (避免半刪狀態)
  // 但若明確指定 force=true，則允許純資料庫刪除（檔案可能已被外部搬走）
  const forceDelete = req.body?.force === true;
  const missingFiles = [];
  for (const s of sources) {
    if (!fs.existsSync(s.abs)) {
      missingFiles.push(s.fileName);
    }
  }
  if (missingFiles.length > 0 && !forceDelete) {
    log('warn', 'delete 拒絕: 來源檔不存在', { songId, files: missingFiles });
    return res.status(400).json({
      success: false,
      error: `來源檔不存在: ${missingFiles.join(', ')} (可能已被搬走?)`,
    });
  }
  if (missingFiles.length > 0) {
    log('warn', 'force delete: 檔案已不存在,僅移除資料庫記錄', { songId, files: missingFiles });
  }

  // 執行 mv（僅存在的檔案）
  try {
    for (const s of sources) {
      if (fs.existsSync(s.abs)) {
        fs.renameSync(s.abs, path.join(TRASH_DIR, s.trashName));
        log('info', 'soft delete', { from: s.abs, to: s.trashName });
      }
    }
  } catch (err) {
    log('error', 'soft delete 部分失敗,需手動復原', { err: err.message });
    return res.status(500).json({
      success: false,
      error: `搬移檔案失敗 (部分已進入垃圾桶): ${err.message}`,
    });
  }

  // 從 SONG_LIBRARY 移除 (frontend 不用再過濾,但保持乾淨)
  SONG_LIBRARY = SONG_LIBRARY.filter((s) => s.id !== songId);
  console.log('[delete] 從 SONG_LIBRARY 移除後, 剩下', SONG_LIBRARY.length, '首歌, id=', songId);

  // 確保 playlist_updated 也廣播（否則前端佇列 UI 不會更新）
  io.emit('playlist_updated', {
    playlist: [...playlist],
    currentSong,
  });
  // 廣播 library_updated,前端自然會過濾掉這首
  io.emit('library_updated', { songs: SONG_LIBRARY });

  log('info', 'soft delete 完成', { songId, title: song.title });
  return res.json({
    success: true,
    trashedTo: TRASH_DIR,
    moved: sources.map((s) => s.trashName),
  });
});

/**
 * 最後防線: 列出垃圾桶內容,方便「派對誤刪」隔天救回。
 * 不需要 hostPin — 這是唯讀,而且只暴露檔名 (不含路徑/雜湊)。
 */
app.get('/api/songs/trash', (req, res) => {
  try {
    if (!fs.existsSync(TRASH_DIR)) {
      return res.json({ success: true, items: [] });
    }
    const items = fs.readdirSync(TRASH_DIR)
      .filter((f) => /\.(mp4|webm|mkv|m4a)$/i.test(f))
      .map((f) => {
        const stat = fs.statSync(path.join(TRASH_DIR, f));
        return {
          fileName: f,
          sizeBytes: stat.size,
          mtime: stat.mtime.toISOString(),
        };
      })
      .sort((a, b) => b.mtime.localeCompare(a.mtime));   // 最近刪的在最上
    return res.json({ success: true, items });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * 把垃圾桶的檔案復原。
 * 檔名副檔名決定歸位: .m4a → AUDIO_DIR;其他 (mp4/webm/mkv) → VIDEO_DIR
 */
app.post('/api/songs/restore', (req, res) => {
  const fileName = req.body?.fileName;
  const hostPin = String(req.body?.hostPin ?? '');
  if (hostPin !== HOST_PIN) {
    return res.status(401).json({ success: false, error: '主揪密碼錯誤' });
  }
  if (!fileName || !/^[\w.\-\s()（）\[\]【】「」]+$/.test(fileName)) {
    return res.status(400).json({ success: false, error: '檔名不合法' });
  }
  // 根據副檔名決定目標 dir: .m4a → AUDIO_DIR, 其他 → VIDEO_DIR
  const targetDir = /\.m4a$/i.test(fileName) ? AUDIO_DIR : VIDEO_DIR;
  const src = path.join(TRASH_DIR, fileName);
  const dst = path.join(targetDir, fileName);
  if (!fs.existsSync(src)) {
    return res.status(404).json({ success: false, error: '垃圾桶找不到這個檔' });
  }
  if (fs.existsSync(dst)) {
    return res.status(409).json({ success: false, error: '目標位置已有同名檔,無法復原' });
  }
  try {
    // 確保目標 dir 存在 (.m4a 在 AUDIO_DIR 可能尚未建)
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    fs.renameSync(src, dst);
    log('info', '從垃圾桶復原', { fileName, to: dst });
    // fs.watch 會自動偵測,rebuildLibrary 也會在輪詢時跑 (保險起見手動呼叫)
    setTimeout(() => { try { rebuildLibrary(); } catch (_) {} }, 500);
    // 補抽 PWA 音軌: 復原的 mp4 在 trash 階段未必有 m4a, 背景觸發 pipeline 補抽
    triggerPwaAudioBackfill('restore');
    return res.json({ success: true, fileName });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'running',
    uptime: process.uptime(),
    currentSong,
    queueLength: playlist.length,
    audioMode,
    videoDir: VIDEO_DIR,
    localVideoCount: SONG_LIBRARY.filter((s) => s.source === 'local').length,
  });
});

app.get('/api/config', (req, res) => {
  res.json({
    success: true,
    config: {
      videoUrlPrefix: VIDEO_URL_PREFIX,
      pipelineEnabled: Boolean(PIPELINE_API_URL),
      publicHost: PUBLIC_HOST || getLocalIp(),
      port: PORT,
    },
  });
});

// ===== 觸發 Python Pipeline (處理 YouTube URL) =====
app.post('/api/process-youtube', async (req, res) => {
  const { url, title, artist } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ success: false, error: '缺少 url 參數' });
  }
  if (!PIPELINE_API_URL) {
    return res.status(503).json({
      success: false,
      error: 'Pipeline 服務未啟用 (請設定 PIPELINE_API_URL)',
    });
  }

  // 同 URL 短時間去重 (避免手機連點造成同時多發給 pipeline_server)
  const lastCall = recentPipelineCalls.get(url);
  const now = Date.now();
  if (lastCall && now - lastCall < PIPELINE_DEDUP_SECONDS * 1000) {
    const waitSec = Math.ceil((PIPELINE_DEDUP_SECONDS * 1000 - (now - lastCall)) / 1000);
    return res.status(429).json({
      success: false,
      error: 'too_recent',
      message: `此 URL ${waitSec}s 內已送過 pipeline,請稍候`,
    });
  }
  recentPipelineCalls.set(url, now);
  // 定期清理過期 (避免 map 膨脹)
  if (recentPipelineCalls.size > 200) {
    for (const [k, t] of recentPipelineCalls) {
      if (now - t > PIPELINE_DEDUP_SECONDS * 1000 * 10) recentPipelineCalls.delete(k);
    }
  }

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (PIPELINE_API_TOKEN) {
      headers.Authorization = `Bearer ${PIPELINE_API_TOKEN}`;
    }
    const r = await fetch(
      `${PIPELINE_API_URL.replace(/\/+$/, '')}/process`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          url,
          title,
          artist,
          model: DEMUCS_MODEL,
          force_cpu: DEMUCS_FORCE_CPU,
        }),
      }
    );
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json({ success: r.ok, ...data });
  } catch (err) {
    log('error', 'Pipeline 呼叫失敗', { err: err.message });
    res.status(502).json({ success: false, error: err.message });
  }
});

// ===== 查詢 Pipeline 任務狀態 (代理給 Python) =====
app.get('/api/jobs/:id', async (req, res) => {
  if (!PIPELINE_API_URL) {
    return res.status(503).json({ success: false, error: 'Pipeline 服務未啟用' });
  }
  try {
    const headers = {};
    if (PIPELINE_API_TOKEN) {
      headers.Authorization = `Bearer ${PIPELINE_API_TOKEN}`;
    }
    const r = await fetch(
      `${PIPELINE_API_URL.replace(/\/+$/, '')}/jobs/${encodeURIComponent(req.params.id)}`,
      { headers }
    );
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
  } catch (err) {
    log('error', '查詢 job 狀態失敗', { err: err.message });
    res.status(502).json({ success: false, error: err.message });
  }
});

// ===== 推測 pipeline 工作進度 =====
// 原理：pipeline 在 PROCESSED_DIR 對應的工作目錄裡會留下階段性檔案
//   - <work>/ktv_<hash>/video.mp4          → 下載中
//   - <work>/ktv_<hash>/separated/.../*.wav → AI 分離中
//   - <processed>/<name>_ktv.mp4           → 完成
//
// 我們根據「目前 PROCESSED_DIR 內最新的 mp4 修改時間 vs 各 work 檔案存在與否」
// 給一個粗略的 0~100 百分比給前端做進度條。
const PROCESSED_DIR = VIDEO_DIR;
const PIPELINE_WORK_DIR = process.env.PIPELINE_WORK_DIR || path.join(path.dirname(VIDEO_DIR), 'work');

function estimateWorkProgress() {
  try {
    if (!fs.existsSync(PIPELINE_WORK_DIR)) {
      return { stage: 'idle', percent: 0, detail: '等待任務' };
    }

    // 找最近修改的子目錄 (對應一首歌的處理)
    const subdirs = fs.readdirSync(PIPELINE_WORK_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const p = path.join(PIPELINE_WORK_DIR, d.name);
        const stat = fs.statSync(p);
        return { name: d.name, mtime: stat.mtimeMs, path: p };
      })
      .sort((a, b) => b.mtime - a.mtime);

    if (subdirs.length === 0) {
      return { stage: 'idle', percent: 0, detail: '等待任務' };
    }

    const latest = subdirs[0];
    const ageSec = (Date.now() - latest.mtime) / 1000;
    if (ageSec > 60) {
      // 超過 60 秒沒變動, 可能是閒置或任務剛結束
      return { stage: 'idle', percent: 0, detail: '等待任務' };
    }

    const contents = fs.readdirSync(latest.path);
    const hasVideo = contents.some((f) => f.endsWith('.mp4') || f.endsWith('.webm'));
    const separatedDir = contents.find((f) => f === 'separated');
    const hasSeparated = separatedDir
      ? fs.existsSync(path.join(latest.path, 'separated'))
      : false;

    // 階段判定
    let stage, percent, detail;
    if (!hasVideo && contents.length === 0) {
      stage = 'queued';
      percent = 5;
      detail = '排隊中...';
    } else if (hasVideo && !hasSeparated) {
      stage = 'downloading';
      percent = 25;
      detail = '下載影片中...';
    } else if (hasVideo && hasSeparated) {
      // 檢查 separated 子目錄是否有 wav
      const sepPath = path.join(latest.path, 'separated');
      const sepSubdirs = fs.readdirSync(sepPath, { withFileTypes: true })
        .filter((d) => d.isDirectory());
      const wavCount = sepSubdirs.length;
      if (wavCount === 0) {
        stage = 'separating';
        percent = 55;
        detail = 'AI 分離人聲中...';
      } else {
        stage = 'mixing';
        percent = 85;
        detail = '混音輸出中...';
      }
    } else {
      stage = 'processing';
      percent = 50;
      detail = '處理中...';
    }

    return { stage, percent, detail, workDir: latest.name };
  } catch (err) {
    return { stage: 'unknown', percent: 0, detail: '無法讀取', error: err.message };
  }
}

app.get('/api/work-progress', (req, res) => {
  res.json({ success: true, ...estimateWorkProgress() });
});

// ===== 全域狀態 (Single Source of Truth) =====
let playlist = [];
let currentSong = null;
let audioMode = 'original';
const songHistory = [];
// 自動播放時追蹤已播過的歌曲ID，避免短時間重複
const autoPlayedIds = new Set();
const AVOID_RECENT_COUNT = 20;
const SONG_TIMEOUT_MS = 5 * 60 * 1000;
let songTimeout;

function getNextSong() {
  if (playlist.length > 0) {
    return playlist.shift();
  }
  // 空佇列：隨機挑一首且近 N 首沒播過的
  const recentIds = new Set(Array.from(songHistory.slice(-AVOID_RECENT_COUNT)).map((s) => s.id));
  const candidates = SONG_LIBRARY.filter(
    (s) => !recentIds.has(s.id) && !autoPlayedIds.has(s.id)
  );
  // 若已全部播過一遍，重置追蹤
  if (candidates.length === 0) {
    autoPlayedIds.clear();
    candidates.push(...SONG_LIBRARY);
  }
  const next = candidates[Math.floor(Math.random() * candidates.length)];
  autoPlayedIds.add(next.id);
  return { ...next, addedBy: 'Auto', addedAt: Date.now() };
}

// ===== Socket.io 連線管理 =====
io.on('connection', (socket) => {
  log('info', '設備連線', { id: socket.id });

  socket.emit('sync_state', {
    currentSong,
    playlist: [...playlist],
    audioMode,
    songHistory: [...songHistory],
    tvSyncOffset: TV_SYNC_OFFSET,
  });

  socket.on('set_tv_sync_offset', (offset) => {
    let num = Number(offset);
    if (!isNaN(num)) {
      num = Math.max(-3.0, Math.min(3.0, num)); // 限定在 -3s ~ +3s 之間
      saveSyncConfig(num);
      log('info', '更新 TV 影音同步參數', { tvSyncOffset: num });
      io.emit('tv_sync_offset_updated', { tvSyncOffset: num });
    }
  });

  socket.on('add_song', (songData, ack) => {
    let song;
    if (typeof songData === 'string') {
      song = SONG_LIBRARY.find((s) => s.id === songData);
    } else if (songData && songData.id) {
      song = SONG_LIBRARY.find((s) => s.id === songData.id) || songData;
    }

    const reply = (payload) => {
      if (typeof ack === 'function') ack(payload);
    };

    if (!song) {
      log('warn', 'add_song 找不到歌曲', { songData, by: socket.id.substring(0, 6) });
      socket.emit('error_message', { message: '找不到這首歌' });
      reply({ ok: false, reason: 'not_found' });
      return;
    }

    if (playlist.some((s) => s.id === song.id)) {
      socket.emit('error_message', { message: '這首歌已在待播清單中' });
      reply({ ok: false, reason: 'duplicate' });
      return;
    }

    const queuedSong = {
      ...song,
      addedBy: socket.id.substring(0, 6),
      addedAt: Date.now(),
    };
    playlist.push(queuedSong);
    log('info', '加入佇列', { title: queuedSong.title, by: queuedSong.addedBy, via: socket.handshake.headers['x-forwarded-for'] || socket.handshake.address });
    reply({ ok: true, songId: song.id, title: song.title });

    // 自動喚醒 B: 廣播「有人點歌」給 TV,TV 顯示「已點播：xxx」toast 5 秒
    io.emit('song_added', {
      title: queuedSong.title,
      artist: queuedSong.artist,
      addedBy: queuedSong.addedBy,
    });

    const isAutoSong = !currentSong;
    if (isAutoSong) {
      // 沒人在播 → 直接播下一首
      advanceToNextSong();
    } else {
      // 不管上一首是 user 點還是 Auto 入的,只要「正在播」就不打斷
      // (使用者報 bug: 即便 currentSong.addedBy === 'Auto' 也要播完才切)
      io.emit('playlist_updated', {
        playlist: [...playlist],
        currentSong,
      });
    }
  });

  // 改名 / 改歌手（只更新記憶體中的 song 物件，不改檔名/不寫硬碟）
  // 同時更新 playlist 中的相同 id、currentSong、SONG_LIBRARY、songHistory
  socket.on('edit_song', ({ id, title, artist }) => {
    if (!id) return;
    const cleanTitle = typeof title === 'string' ? title.trim().slice(0, 100) : null;
    const cleanArtist = typeof artist === 'string' ? artist.trim().slice(0, 50) : null;
    if (!cleanTitle && !cleanArtist) return;

    const apply = (s) => {
      if (!s || s.id !== id) return false;
      if (cleanTitle) s.title = cleanTitle;
      if (cleanArtist) s.artist = cleanArtist;
      return true;
    };

    let changed = false;
    if (currentSong && apply(currentSong)) {
      io.emit('play_song', { currentSong });
      changed = true;
    }
    for (const s of playlist) {
      if (apply(s)) changed = true;
    }
    for (const s of SONG_LIBRARY) {
      if (apply(s)) changed = true;
    }
    for (const s of songHistory) {
      if (apply(s)) changed = true;
    }

    if (!changed) {
      log('warn', 'edit_song 找不到目標', { id });
      return;
    }

    // 持久化 - 從 SONG_LIBRARY 找到 local 歌的 src 寫檔
    const edited = SONG_LIBRARY.find((s) => s.id === id);
    if (edited && edited.source === 'local' && edited.src) {
      const edits = readSongEdits();
      edits.set(edited.src, {
        title: edited.title,
        artist: edited.artist,
        updatedAt: new Date().toISOString(),
      });
      writeSongEdits(edits);
    }

    log('info', '改名/改歌手', { id, title: cleanTitle, artist: cleanArtist });
    io.emit('playlist_updated', {
      playlist: [...playlist],
      currentSong,
    });
  });

  socket.on('skip_song', () => {
    if (!currentSong && playlist.length === 0) return;
    log('info', '切歌指令', { from: socket.id });

    io.emit('stop_song');
    if (currentSong) {
      songHistory.push(currentSong);
      if (songHistory.length > 50) songHistory.shift();
    }
    advanceToNextSong(true);
  });

  socket.on('toggle_vocal', (mode) => {
    if (!mode) {
      audioMode = audioMode === 'original' ? 'vocal_off' : 'original';
    } else {
      audioMode = mode === 'vocal_off' ? 'vocal_off' : 'original';
    }
    log('info', '切換音軌模式', { audioMode });
    io.emit('change_audio_mode', { audioMode });
  });

  // TV 沉浸模式切換:
  //   mobile 觸發 → server 廣播 'toggle_immersive' 給所有 client (tv 收到後執行 fullscreen)
  //                同時廣播 'immersive_state' 給所有 client (mobile 按鈕同步)
  //   tv 觸發    → 同樣廣播給所有 (例如 ESC 退出時由 tv 自己 emit,server 再回報)
  socket.on('toggle_immersive', ({ immersive } = {}) => {
    log('info', 'TV 沉浸模式', { immersive });
    // 用 io.emit 而非 socket.emit,確保 tv 自己也收到 (若 mobile 先觸發)
    io.emit('toggle_immersive', { immersive: !!immersive });
    io.emit('immersive_state', { immersive: !!immersive });
  });

  // 手動喚醒 (邀請朋友): mobile 按「邀請朋友」按鈕
  // → server 廣播 'show_qr' 給所有 client (含 tv 自己)
  // → tv 收到後叫醒 QR Panel 15 秒
  socket.on('show_qr', ({ durationMs } = {}) => {
    const ms = Math.min(60000, Math.max(3000, Number(durationMs) || 15000));
    log('info', 'TV 顯示 QR', { durationMs: ms });
    io.emit('show_qr', { durationMs: ms });
  });

  // 補抽 audio: 切到音樂模式時若發現 song 缺 audioOriginal/audioVocalOff,
  // tv 端會 emit request_audio_extract,server 用 ffmpeg 即時抽 audioOriginal
  // (伴奏版本留給背景 pipeline 處理)
  socket.on('request_audio_extract', ({ songId }) => {
    const song = SONG_LIBRARY.find((s) => s.id === songId);
    if (!song || song.source !== 'local') {
      log('warn', 'request_audio_extract: 找不到 song 或非本地', { songId });
      return;
    }
    const audioOrigName = `${song.raw || song.id.replace(/^local-/, '')}.m4a`;
    const target = path.join(AUDIO_DIR, audioOrigName);
    if (fs.existsSync(target)) {
      log('info', 'audio 檔已存在, 跳過', { audioOrigName });
      return;
    }
    const srcMp4 = song.src ? decodeURIComponent(new URL(song.src, 'http://x').pathname.replace(/^\/videos\//, '')) : null;
    if (!srcMp4) {
      log('warn', 'request_audio_extract: 找不到 mp4', { songId });
      return;
    }
    const srcPath = path.join(VIDEO_DIR, srcMp4);
    if (!fs.existsSync(srcPath)) {
      log('warn', 'request_audio_extract: mp4 不存在', { srcPath });
      return;
    }
    log('info', '開始抽 audioOriginal', { song: song.title, srcPath, target });
    // ffmpeg -i <mp4> -vn -ac 2 -ar 44100 -ab 128k -f ipod <m4a>
    const ff = spawn('ffmpeg', [
      '-y', '-i', srcPath,
      '-vn', '-ac', '2', '-ar', '44100', '-ab', '128k',
      '-f', 'ipod', target,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderrBuf = '';
    ff.stderr.on('data', (b) => { stderrBuf += b.toString().slice(-2048); });
    ff.on('close', (code) => {
      if (code === 0 && fs.existsSync(target)) {
        log('info', 'audioOriginal 抽完成', { audioOrigName, size: fs.statSync(target).size });
        // 更新 SONG_LIBRARY 中的 song 物件
        const idx = SONG_LIBRARY.findIndex((s) => s.id === songId);
        if (idx >= 0) {
          SONG_LIBRARY[idx].audioOriginal = `${AUDIO_URL_PREFIX}/${encodeURIComponent(audioOrigName)}`;
          io.emit('song_audio_ready', { songId, audioOriginal: SONG_LIBRARY[idx].audioOriginal });
        }
      } else {
        log('error', 'ffmpeg 抽 audio 失敗', { code, err: stderrBuf.split('\n').slice(-5).join('\n') });
      }
    });
  });

  socket.on('song_ended', () => {
    log('info', '歌曲播完', { from: socket.id, currentSong: currentSong?.title });
    clearTimeout(songTimeout);
    if (currentSong) {
      songHistory.push(currentSong);
      if (songHistory.length > 50) songHistory.shift();
    }
    advanceToNextSong();
  });

  socket.on('request_playlist', () => {
    socket.emit('playlist_updated', {
      playlist: [...playlist],
      currentSong,
    });
  });

  socket.on('disconnect', () => {
    log('info', '設備離線', { id: socket.id });
  });
});

function advanceToNextSong() {
  clearTimeout(songTimeout);
  const next = getNextSong();
  currentSong = next;
  const now = Date.now();

  io.emit('play_song', { currentSong, updatedAt: now });
  io.emit('playlist_updated', {
    playlist: [...playlist],
    currentSong,
    updatedAt: now,
  });
  // 不廣播 audioMode，保持用戶當前設定不變

  log('info', '現在播放', { title: currentSong.title, mode: audioMode });

  // 啟動超時計時（song_ended 沒來就自動切歌）
  songTimeout = setTimeout(() => {
    if (currentSong) {
      log('warn', 'song_ended 超時保險觸發', { currentSong: currentSong.title });
      io.emit('stop_song');
      songHistory.push(currentSong);
      if (songHistory.length > 50) songHistory.shift();
      advanceToNextSong();
    }
  }, SONG_TIMEOUT_MS);
}

/**
 * 確保 TRASH_DIR 存在。
 * 啟動時呼叫一次,後續 delete 動作就直接 rename,不需每次 mkdir。
 * 若 VIDEO_DIR 也不存在 (空資料夾/綁定掛載未完成),幫忙建 (只建 _Trash 不建 VIDEO_DIR,避免空殼)。
 */
function ensureTrashDir() {
  try {
    if (!fs.existsSync(VIDEO_DIR)) {
      fs.mkdirSync(VIDEO_DIR, { recursive: true });
      log('info', 'VIDEO_DIR 不存在, 已建立', { dir: VIDEO_DIR });
    }
    fs.mkdirSync(TRASH_DIR, { recursive: true });
    log('info', 'TRASH_DIR 已就緒', { dir: TRASH_DIR });
  } catch (err) {
    log('warn', '建立 TRASH_DIR 失敗 (delete 功能會降級)', { err: err.message });
  }
}

function ensureTvCacheDir() {
  try {
    if (!fs.existsSync(TV_CACHE_DIR)) {
      fs.mkdirSync(TV_CACHE_DIR, { recursive: true });
      log('info', 'TV_CACHE_DIR 不存在, 已建立', { dir: TV_CACHE_DIR });
    }
    // 啟動時清空快取避免佔用空間
    const files = fs.readdirSync(TV_CACHE_DIR);
    for (const f of files) {
      if (f.endsWith('.mp4')) {
        try { fs.unlinkSync(path.join(TV_CACHE_DIR, f)); } catch(e) {}
      }
    }
  } catch(e) { log('warn', '清理或建立 TV_CACHE_DIR 失敗', { err: e.message }); }
}

// ===== 啟動伺服器 =====
// 啟動後持續監看 VIDEO_DIR，新增/移除 mp4 時自動重掃歌曲庫並廣播給前端。
// 雙保險：
//   1. fs.watch   → 即時反應 (Docker bind mount 在某些環境可能漏事件)
//   2. setInterval 30s 輪詢 → fs.watch 漏觸發時強制掃一次
function startLibraryWatcher() {
  // ----- 即時監聽 (失敗就降級, 不可以讓 process 崩) -----
  try {
    if (!fs.existsSync(VIDEO_DIR)) {
      log('warn', 'VIDEO_DIR 不存在, 跳過 fs.watch', { dir: VIDEO_DIR });
    } else {
      // 用遞迴監聽 + try/catch 雙保險
      const watcher = fs.watch(
        VIDEO_DIR,
        { persistent: true, recursive: false },
        (eventType, filename) => {
          if (!filename) return;
          if (!/\.(mp4|webm|mkv)$/i.test(filename)) return;
          log('debug', 'fs.watch 觸發', { eventType, filename });
          // 給檔案系統一點時間寫完, 防 race condition
          setTimeout(() => {
            try { rebuildLibrary(); } catch (e) {
              log('warn', 'rebuildLibrary 失敗', { err: e.message });
            }
          }, 500);
        }
      );
      watcher.on('error', (err) => {
        log('warn', 'fs.watch 發生錯誤, 降級為純輪詢', { err: err.message });
      });
      log('info', '已啟動 VIDEO_DIR 即時監聽', { dir: VIDEO_DIR });
    }
  } catch (err) {
    log('warn', 'fs.watch 啟動失敗, 將以輪詢模式運作', { err: err.message });
  }

  // ----- 30 秒兜底輪詢 -----
  setInterval(() => {
    try { rebuildLibrary(); } catch (e) {
      log('warn', '輪詢 rebuildLibrary 失敗', { err: e.message });
    }
  }, 30 * 1000);
}

/**
 * 觸發 Pipeline 端的 PWA 背景音訊補抽 (idempotent, 非同步背景跑):
 *   - 啟動時一次: 把歷史「先有 mp4 後漏 m4a」的歌曲補抽
 *   - 之後每 30 分鐘兜底: 處理「電腦 cp 檔 / 垃圾桶復原」造成的 m4a 缺失
 * 失敗不會影響主服務 (pipeline 沒起來就 log warn 跳過)
 */
async function triggerPwaAudioBackfill(reason) {
  if (!PIPELINE_API_URL) return;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (PIPELINE_API_TOKEN) headers.Authorization = `Bearer ${PIPELINE_API_TOKEN}`;
    const r = await fetch(`${PIPELINE_API_URL.replace(/\/+$/, '')}/pwa-audio/backfill`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    });
    const data = await r.json().catch(() => ({}));
    log('info', 'PWA 音訊補抽觸發', { reason, http: r.status, running: data.running });
  } catch (err) {
    log('warn', 'PWA 音訊補抽觸發失敗 (不影響主服務)', { reason, err: err.message });
  }
}

startLibraryWatcher();
ensureTrashDir();
ensureTvCacheDir();

// 啟動立即觸發一次 (補歷史的漏網 m4a)
triggerPwaAudioBackfill('startup');
// 30 分鐘兜底輪詢
setInterval(() => triggerPwaAudioBackfill('interval-30m'), 30 * 60 * 1000);

server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIp();
  const displayHost = PUBLIC_HOST || ip;
  console.log('');
  console.log('═══════════════════════════════════════════');
  console.log('  🎤 KTV VOD System 已啟動 (Brain Online)');
  console.log('═══════════════════════════════════════════');
  console.log(`  📺 電視端：  http://${displayHost}:${PORT}/tv.html`);
  console.log(`  📱 手機端：  http://${displayHost}:${PORT}/mobile.html`);
  console.log(`  🔌 API：     http://localhost:${PORT}/api/songs`);
  console.log(`  📁 影片庫：  ${VIDEO_DIR}`);
  console.log(`  🗑️  垃圾桶：  ${TRASH_DIR}  (主揪模式 PIN: ${HOST_PIN === '0000' ? '0000 (預設)' : '已自訂'})`);
  if (PIPELINE_API_URL) {
    console.log(`  🎬 Pipeline: ${PIPELINE_API_URL}`);
  } else {
    console.log('  🎬 Pipeline: (未啟用)');
  }
  console.log('═══════════════════════════════════════════');
  console.log('');
});
