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

// ===== 設定 =====
const PORT = parseInt(process.env.PORT, 10) || 3000;
const CORS_ORIGIN = (process.env.CORS_ORIGIN || '*').split(',').map((s) => s.trim());
const VIDEO_DIR = process.env.VIDEO_DIR || path.join(__dirname, 'videos');
const VIDEO_URL_PREFIX = process.env.VIDEO_URL_PREFIX || '/videos';
const PUBLIC_HOST = process.env.PUBLIC_HOST || '';
const PIPELINE_API_URL = process.env.PIPELINE_API_URL || '';
const PIPELINE_API_TOKEN = process.env.PIPELINE_API_TOKEN || '';
const DEMUCS_MODEL = process.env.DEMUCS_MODEL || 'htdemucs';
const DEMUCS_FORCE_CPU = (process.env.DEMUCS_FORCE_CPU || 'false').toLowerCase() === 'true';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

// ===== Express & HTTP Server =====
const app = express();
app.use(express.json({ limit: '1mb' }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CORS_ORIGIN, methods: ['GET', 'POST'] },
});

// ===== 靜態託管 =====
app.use(express.static(path.join(__dirname, 'public')));

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
      // 寬鬆 CORS：tv.html 同源連線原則上不需要，但 <video crossorigin="anonymous">
      // 會讓瀏覽器要求 CORS 才能把媒體餵給 MediaElementSource/Web Audio；
      // 也避免 LAN 內 IP 直連時被擋。
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    },
  })
);

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
// 策略：
//   1. 預設內建 SONG_LIBRARY (寫死的測試影片，跨網穩定)
//   2. 若 VIDEO_DIR 有 .mp4 檔，自動併入歌曲庫 (從檔名解析標題)
//
// 注意：SONG_LIBRARY 是「合併」視圖，內建歌曲固定不變；
// 本機檔案隨 VIDEO_DIR 變化動態合併，因此透過 rebuildLibrary() 即時更新。
const BUILT_IN_SONGS = [
  {
    id: 'song-001',
    title: 'Big Buck Bunny',
    artist: 'Blender Foundation',
    duration: '10:34',
    src: 'http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
    cover: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/images/BigBuckBunny.jpg',
  },
  {
    id: 'song-002',
    title: 'Elephants Dream',
    artist: 'Blender Foundation',
    duration: '10:53',
    src: 'http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
    cover: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/images/ElephantsDream.jpg',
  },
  {
    id: 'song-003',
    title: 'For Bigger Blazes',
    artist: 'Google',
    duration: '00:15',
    src: 'http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
    cover: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/images/ForBiggerBlazes.jpg',
  },
  {
    id: 'song-004',
    title: 'For Bigger Escape',
    artist: 'Google',
    duration: '00:15',
    src: 'http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4',
    cover: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/images/ForBiggerEscapes.jpg',
  },
  {
    id: 'song-005',
    title: 'For Bigger Fun',
    artist: 'Google',
    duration: '01:00',
    src: 'http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4',
    cover: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/images/ForBiggerFun.jpg',
  },
  {
    id: 'song-006',
    title: 'For Bigger Joyrides',
    artist: 'Google',
    duration: '00:15',
    src: 'http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4',
    cover: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/images/ForBiggerJoyrides.jpg',
  },
];

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
  return [...BUILT_IN_SONGS, ...scanLocalVideos()];
}

let SONG_LIBRARY = buildSongLibrary();
log('info', '歌曲庫已載入', { builtIn: BUILT_IN_SONGS.length, local: SONG_LIBRARY.length - BUILT_IN_SONGS.length });

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

  const fresh = buildSongLibrary();
  const freshIds = new Set(fresh.map((s) => s.id));
  const freshLocal = new Set(
    fresh.filter((s) => s.source === 'local').map((s) => s.src)
  );

  const added = [...freshLocal].filter((x) => !previousLocal.has(x));
  const removed = [...previousLocal].filter((x) => !freshLocal.has(x));

  if (added.length === 0 && removed.length === 0) {
    return { changed: false, added: 0, removed: 0 };
  }

  SONG_LIBRARY = fresh;
  log('info', '歌曲庫已更新', { added: added.length, removed: removed.length });
  io.emit('library_updated', { songs: SONG_LIBRARY });
  return { changed: true, added: added.length, removed: removed.length };
}

// ===== RESTful API =====
app.get('/api/songs', (req, res) => {
  res.json({ success: true, songs: SONG_LIBRARY });
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
  if (PIPELINE_API_URL) {
    console.log(`  🎬 Pipeline: ${PIPELINE_API_URL}`);
  } else {
    console.log('  🎬 Pipeline: (未啟用)');
  }
  console.log('═══════════════════════════════════════════');
  console.log('');
});
