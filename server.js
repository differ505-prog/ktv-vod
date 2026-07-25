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
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
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
function buildSongLibrary() {
  const builtIn = [
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

  // 從本機資料夾附加
  let local = [];
  try {
    if (fs.existsSync(VIDEO_DIR)) {
      const files = fs
        .readdirSync(VIDEO_DIR)
        .filter((f) => /\.(mp4|webm|mkv)$/i.test(f));
      let idx = 0;
      for (const f of files) {
        idx += 1;
        const name = path.basename(f, path.extname(f));
        // 檔名慣例：「歌手 - 標題」會自動切割
        const sep = name.indexOf(' - ');
        const artist = sep > 0 ? name.slice(0, sep).trim() : '本機歌曲';
        const title = sep > 0 ? name.slice(sep + 3).trim() : name;
        local.push({
          id: `local-${String(idx).padStart(3, '0')}`,
          title,
          artist,
          duration: '未知',
          src: toPublicUrl(f), // 透過 /videos prefix 提供
          cover: null,
          source: 'local',
        });
      }
    }
  } catch (err) {
    log('warn', '讀取 VIDEO_DIR 失敗', { err: err.message });
  }

  return [...builtIn, ...local];
}

const SONG_LIBRARY = buildSongLibrary();
log('info', '歌曲庫已載入', { builtIn: 6, local: SONG_LIBRARY.length - 6 });

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
