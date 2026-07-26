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
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

// ===== 設定 =====
const PORT = parseInt(process.env.PORT, 10) || 3000;
const CORS_ORIGIN = (process.env.CORS_ORIGIN || '*').split(',').map((s) => s.trim());
const VIDEO_DIR = process.env.VIDEO_DIR || path.join(__dirname, 'videos');
const VIDEO_URL_PREFIX = process.env.VIDEO_URL_PREFIX || '/videos';
const PUBLIC_HOST = process.env.PUBLIC_HOST || '';

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
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

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

  // offset 極小時直接回傳原檔
  if (Math.abs(TV_SYNC_OFFSET) < 0.01) {
    return res.sendFile(origPath);
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

      // 如果 offset > 0，代表聲音太慢，必須「畫面延遲」。所以視訊軌 +offset。
      // 如果 offset < 0，代表聲音太快，必須「聲音延遲」。所以音訊軌 +|offset|。
      let cmd;
      if (TV_SYNC_OFFSET > 0) {
        cmd = `ffmpeg -y -itsoffset ${TV_SYNC_OFFSET} -i "${origPath}" -i "${origPath}" -map 0:v -map 1:a -c copy "${shadowPath}"`;
      } else {
        cmd = `ffmpeg -y -itsoffset ${Math.abs(TV_SYNC_OFFSET)} -i "${origPath}" -i "${origPath}" -map 1:v -map 0:a -c copy "${shadowPath}"`;
      }
      await execPromise(cmd);
    } catch(err) {
      log('error', '產生 TV 陰影檔失敗', { err: err.message });
      return res.sendFile(origPath); // 失敗就 fallback 給原檔
    }
  }

  res.sendFile(shadowPath);
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
        const name = path.basename(f, path.extname(f));
        // 跳過已經是 vocal_off 變體，避免在 library 重複出現
        if (/_vocal_off$/.test(name)) continue;
        // 檔名慣例：「歌手 - 標題」會自動切割
        const sep = name.indexOf(' - ');
        const artist = sep > 0 ? name.slice(0, sep).trim() : '本機歌曲';
        const title = sep > 0 ? name.slice(sep + 3).trim() : name;
        // 若對應的 *_vocal_off.mp4 存在，就帶 srcVocalOff 給 TV 切換
        const vocalOffName = `${name}_vocal_off.mp4`;
        const vocalOffExists = fs.existsSync(path.join(VIDEO_DIR, vocalOffName));
        local.push({
          id: `local-${String(idx).padStart(3, '0')}`,
          title,
          artist,
          duration: '未知',
          src: toPublicUrl(f), // 透過 /videos prefix 提供
          srcVocalOff: vocalOffExists ? toPublicUrl(vocalOffName) : null,
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
log('info', '歌曲庫已載入', { count: SONG_LIBRARY.length });

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

  SONG_LIBRARY = fresh;
  log('info', '歌曲庫已更新', { added: added.length, removed: removed.length, vocalOffChanged });
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
 * Body: { songId: 'song-003', hostPin: '0000' }
 *
 * - src / srcVocalOff 都移走 (避免變成「唱原唱時還是舊檔」)
 * - hostPin 錯 → 401 (就算前端藏好,後端也要驗)
 * - 錯誤時的 cleanup: 若只 mv 成功一個檔,另一個還在原位 → 不要讓使用者以為刪乾淨
 *   所以先確認所有來源檔都存在,再一次性 mv
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

  // 計算實體檔案路徑 (src 是 URL,要還原到 VIDEO_DIR 的 basename)
  // 重要:pathname 會做 percent-encoding,但中文檔名磁碟上是 raw UTF-8
  //   所以需要 decodeURIComponent 才能對到實際檔案
  const sources = [];
  const srcBasename = decodeURIComponent(path.basename(new URL(song.src, 'http://x').pathname));
  const srcVocalBasename = song.srcVocalOff
    ? decodeURIComponent(path.basename(new URL(song.srcVocalOff, 'http://x').pathname))
    : null;
  sources.push({ role: 'src', abs: path.join(VIDEO_DIR, srcBasename), fileName: srcBasename });
  if (srcVocalBasename) {
    sources.push({ role: 'srcVocalOff', abs: path.join(VIDEO_DIR, srcVocalBasename), fileName: srcVocalBasename });
  }

  // 防呆 1: 同名檔案已存在於 trash → 加時間戳避免覆蓋
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); // ISO with `-` separator
  for (const s of sources) {
    s.trashName = fs.existsSync(path.join(TRASH_DIR, s.fileName))
      ? `${stamp}_${s.fileName}`
      : s.fileName;
  }

  // 防呆 2: 先確認所有來源檔都存在, 任一缺失就拒絕 (避免半刪狀態)
  for (const s of sources) {
    if (!fs.existsSync(s.abs)) {
      log('warn', 'delete 拒絕: 來源檔不存在', { songId, role: s.role, file: s.abs });
      return res.status(400).json({
        success: false,
        error: `來源檔不存在: ${s.fileName} (可能已被搬走?)`,
      });
    }
  }

  // 執行 mv
  try {
    for (const s of sources) {
      fs.renameSync(s.abs, path.join(TRASH_DIR, s.trashName));
      log('info', 'soft delete', { from: s.abs, to: s.trashName });
    }
  } catch (err) {
    // 已 mv 出去的無法自動復原 (只能手動從 trash 撿回)
    log('error', 'soft delete 部分失敗,需手動復原', { err: err.message });
    return res.status(500).json({
      success: false,
      error: `搬移檔案失敗 (部分已進入垃圾桶): ${err.message}`,
    });
  }

  // 從 SONG_LIBRARY 移除 (frontend 不用再過濾,但保持乾淨)
  SONG_LIBRARY = SONG_LIBRARY.filter((s) => s.id !== songId);

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
      .filter((f) => /\.(mp4|webm|mkv)$/i.test(f))
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
 * 把垃圾桶的檔案復原回 VIDEO_DIR。
 * 復原後會重建 SONG_LIBRARY,會自然納入這首。
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
  const src = path.join(TRASH_DIR, fileName);
  const dst = path.join(VIDEO_DIR, fileName);
  if (!fs.existsSync(src)) {
    return res.status(404).json({ success: false, error: '垃圾桶找不到這個檔' });
  }
  if (fs.existsSync(dst)) {
    return res.status(409).json({ success: false, error: '目標位置已有同名檔,無法復原' });
  }
  try {
    fs.renameSync(src, dst);
    log('info', '從垃圾桶復原', { fileName, to: dst });
    // fs.watch 會自動偵測,rebuildLibrary 也會在輪詢時跑 (保險起見手動呼叫)
    setTimeout(() => { try { rebuildLibrary(); } catch (_) {} }, 500);
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

function getNextSong() {
  if (playlist.length > 0) {
    return playlist.shift();
  }
  const fallbackIndex = songHistory.length % SONG_LIBRARY.length;
  const next = SONG_LIBRARY[fallbackIndex];
  return {
    ...next,
    addedBy: 'Auto',
    addedAt: Date.now(),
  };
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
      num = Math.max(-1.0, Math.min(1.0, num)); // 限定在 -1s ~ +1s 之間
      saveSyncConfig(num);
      log('info', '更新 TV 影音同步參數', { tvSyncOffset: num });
      io.emit('tv_sync_offset_updated', { tvSyncOffset: num });
    }
  });

  socket.on('add_song', (songData) => {
    let song;
    if (typeof songData === 'string') {
      song = SONG_LIBRARY.find((s) => s.id === songData);
    } else if (songData && songData.id) {
      song = SONG_LIBRARY.find((s) => s.id === songData.id) || songData;
    }

    if (!song) {
      socket.emit('error_message', { message: '找不到這首歌' });
      return;
    }

    const queuedSong = {
      ...song,
      addedBy: socket.id.substring(0, 6),
      addedAt: Date.now(),
    };
    playlist.push(queuedSong);
    log('info', '加入佇列', { title: queuedSong.title, by: queuedSong.addedBy });

    // 自動喚醒 B: 廣播「有人點歌」給 TV,TV 顯示「已點播：xxx」toast 5 秒
    io.emit('song_added', {
      title: queuedSong.title,
      artist: queuedSong.artist,
      addedBy: queuedSong.addedBy,
    });

    if (!currentSong) {
      advanceToNextSong();
    } else {
      io.emit('playlist_updated', {
        playlist: [...playlist],
        currentSong,
      });
    }
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

  socket.on('song_ended', () => {
    log('info', '歌曲播完', { from: socket.id });
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
  const next = getNextSong();
  currentSong = next;

  io.emit('play_song', { currentSong });
  io.emit('playlist_updated', {
    playlist: [...playlist],
    currentSong,
  });
  io.emit('change_audio_mode', { audioMode });

  log('info', '現在播放', { title: currentSong.title, mode: audioMode });
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

startLibraryWatcher();
ensureTrashDir();
ensureTvCacheDir();

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
