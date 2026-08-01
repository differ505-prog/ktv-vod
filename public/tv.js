/**
 * KTV 電視端 (The Puppet)
 * 職責：
 *  1. 接收後端 play_song / stop_song / change_audio_mode 並驅動 <video>
 *  2. 用 Web Audio API 建立「立體聲分離 → 單聲道複製」處理鏈，實現伴奏消除
 *  3. 影片播完時主動通知後端
 */

(() => {
  'use strict';

  // ===== 元素 =====
  const video = document.getElementById('player');
  const bgAudio = document.getElementById('bgAudio'); // 音樂模式背景播放
  const nowPlayingTitle = document.getElementById('nowPlayingTitle');
  const nowPlayingArtist = document.getElementById('nowPlayingArtist');
  const audioModeLabel = document.getElementById('audioModeLabel');
  const connectionStatus = document.getElementById('connectionStatus');
  const standbyScreen = document.getElementById('standbyScreen');
  const transitionOverlay = document.getElementById('transitionOverlay');
  const qrcodeDiv = document.getElementById('qrcode');
  const qrUrlDiv = document.getElementById('qrUrl');
  const unlockOverlay = document.getElementById('unlockOverlay');
  const nowPlayingBarTitle = document.getElementById('nowPlayingBarTitle');
  const nowPlayingBarArtist = document.getElementById('nowPlayingBarArtist');
  const immersiveBtn = document.getElementById('immersiveBtn');
  const immersiveBtnLabel = document.getElementById('immersiveBtnLabel');
  const immersiveIcon = document.getElementById('immersiveIcon');
  const immersiveDialog = document.getElementById('immersiveDialog');
  const immersiveDialogConfirm = document.getElementById('immersiveDialogConfirm');
  const immersiveDialogCancel = document.getElementById('immersiveDialogCancel');
  const audioModeBtn = document.getElementById('audioModeBtn');
  const audioModeBtnLabel = document.getElementById('audioModeBtnLabel');
  const songAddedToast = document.getElementById('songAddedToast');
  const songAddedToastTitle = document.getElementById('songAddedToastTitle');

  // ===== 下一首倒數卡片 =====
  const nextSongCard = document.getElementById('nextSongCard');
  const nextSongCountdownNum = document.getElementById('nextSongCountdownNum');
  const nextSongCardTitle = document.getElementById('nextSongCardTitle');
  const nextSongCardArtist = document.getElementById('nextSongCardArtist');
  const queueEmptyBar = document.getElementById('queueEmptyBar');

  // ===== 下一首倒數狀態 =====
  let nextSong = null;          // playlist_updated 裡的下一首
  let countdownInterval = null;
  const COUNTDOWN_TRIGGERS = [30, 15, 5]; // 秒數閾值

  // ===== 沉浸模式狀態 =====
  let immersive = false;          // 是否進入沉浸模式 (CSS class)
  // Mobile 發請求時,server 會廣播 toggle_immersive 給所有 client (含 tv 自己回報的)。
  // 為了避免 tv 自己的回報被當成「新請求」再彈 dialog,這個 flag 用來辨識「來源是誰」。
  let lastImmersiveBroadcastImmersive = null;

  // ===== 產生 QR Code =====
  // 內容：http://[伺服器IP]:[Port]/mobile.html
  const serverUrl = `${window.location.protocol}//${window.location.host}`;
  const mobileUrl = `${serverUrl}/mobile.html`;
  qrUrlDiv.textContent = mobileUrl;

  // 等 DOM ready 再生成 QR (qrcode.js 需要有尺寸的容器)
  if (typeof QRCode !== 'undefined') {
    qrcodeDiv.innerHTML = '';
    new QRCode(qrcodeDiv, {
      text: mobileUrl,
      width: 140,
      height: 140,
      colorDark: '#000000',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M,
    });
  } else {
    qrcodeDiv.textContent = 'QRCode 載入失敗';
  }

  // ===== Web Audio API (伴奏消除核心) =====
  // 架構：video → MediaElementSource → Splitter (L=伴奏, R=人聲) → 2 個 Gain → destination
  //   'original' (導唱): accGain=1, vocGain=1 → 伴奏＋人聲混音 = 完整原唱
  //   'vocal_off' (伴唱): accGain=1, vocGain=0 → 只有伴奏
  let fadeTimer = null;
  let immersiveMode = false;
  let currentTvSyncOffset = 0; // 用於強制重新整理快取的變數
  let audioCtx = null;
  let sourceNode = null;
  let splitter = null;
  let accGain = null;   // L 聲道 (伴奏)
  let vocGain = null;   // R 聲道 (人聲)
  let destinationGain = null;
  let audioReady = false;

// Autoplay / Audio-Context 解鎖狀態
let audioUnlocked = false;
let pendingFirstPlay = false;
let pendingSongSrc = null; // 解鎖前先把 src 暫存在這邊,等 unlock 後才真正給 video

// 記住目前正在播的 song（保留 srcVocalOff 為診斷用），給 sync 顯示用
let currentSongRef = null;

// 解決 race condition：change_audio_mode 可能比 initAudioGraph() 先到
// 這時 applyAudioMode 會因 audioReady=false 直接 return，mode 變更被丟棄
// → 用 pendingAudioMode 緩存，等 initAudioGraph 完成後再 apply
let pendingAudioMode = null;

function initAudioGraph() {
    if (audioReady) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      // 請求最低延遲，減少 Web Audio API 造成的音訊落後 (A/V sync issue)
      audioCtx = new AudioCtx({ latencyHint: 0 });

      // 把 video 音源接入 Web Audio
      sourceNode = audioCtx.createMediaElementSource(video);

      // 立體聲分離：port 0 = L (伴奏), port 1 = R (人聲)
      splitter = audioCtx.createChannelSplitter(2);

      // 兩個 Gain：伴奏軌 & 人聲軌
      accGain = audioCtx.createGain(); // L 聲道 (伴奏)
      vocGain = audioCtx.createGain(); // R 聲道 (人聲)

      destinationGain = audioCtx.createGain();
      destinationGain.gain.value = 1.0;

      // 接線
      sourceNode.connect(splitter);
      splitter.connect(accGain, 0); // port 0 = L (伴奏) → accGain
      splitter.connect(vocGain, 1); // port 1 = R (人聲) → vocGain ← 這是關鍵！

      // 兩個 gain 都流入同一個 destination → 混音
      accGain.connect(destinationGain);
      vocGain.connect(destinationGain);
      destinationGain.connect(audioCtx.destination);

      // 初始模式：原唱
      applyAudioMode('original');

      audioReady = true;
      console.log('[音訊] Web Audio 圖初始化完成 (新版：accGain + vocGain)');
      // audioGraph 建好了，之前若有 pending mode，立刻補 apply
      if (pendingAudioMode !== null) {
        const m = pendingAudioMode;
        pendingAudioMode = null;
        console.log('[音訊] 套用 initAudioGraph 前緩存的 mode =', m);
        applyAudioMode(m);
      }
    } catch (err) {
      console.error('[音訊] 初始化失敗：', err);
    }
  }

  function applyAudioMode(mode) {
    if (!audioReady || !audioCtx) {
      // audioGraph 還沒建好 → 緩存起來，等 initAudioGraph() 完成後再 apply
      pendingAudioMode = mode;
      console.warn('[音訊] applyAudioMode 收到但 audioGraph 還沒建好，緩存 mode =', mode);
      return;
    }
    if (mode === 'original') {
      // 導唱：伴奏 + 人聲 同時開 → 完整原唱
      accGain.gain.value = 1.0;
      vocGain.gain.value = 1.0;
    } else if (mode === 'vocal_off') {
      // 伴唱：只開伴奏，人聲關掉
      accGain.gain.value = 1.0;
      vocGain.gain.value = 0.0;
    }
    currentAudioMode = mode; // 記住目前伺服器廣播的 mode (給 audio-mode replay 用)
    // Audio-mode 下,如果 mode 變更,重新挑對應的 .m4a 餵給 bgAudio
    if (audioMode && currentSongRef && (mode === 'original' || mode === 'vocal_off')) {
      const newTrack = mode === 'vocal_off' ? 'vocal_off' : 'original';
      if (newTrack !== audioCurrentTrack) {
        const savedTime = bgAudio.currentTime;
        audioCurrentTrack = newTrack;
        const src = getAudioModeSrc(currentSongRef, newTrack);
        if (src) {
          // 走 playBgAudio 統一 canplay-wait 路徑,避免 iOS PWA 拒絕
          // (直接設 src → play() 在 change_audio_mode 會丟 NotAllowedError)
          if (bgAudio.src && bgAudio.src.endsWith(src.split('/').pop())) {
            // 同 src → 只更新 playbackState
            bgAudio.play().then(() => {
              if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
            }).catch(() => {});
          } else {
            bgAudio.src = src;
            bgAudio.loop = false;
            const restoreTime = savedTime;
            let started = false;
            const tryStart = () => {
              if (started) return;
              started = true;
              bgAudio.currentTime = restoreTime;
              updateMediaSession(currentSongRef);
              bgAudio.play().then(() => {
                if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
              }).catch((err) => console.warn('[bgAudio] play 失敗：', err));
            };
            bgAudio.addEventListener('canplay', tryStart, { once: true });
            bgAudio.addEventListener('loadeddata', tryStart, { once: true });
            setTimeout(tryStart, 1500);
          }
        }
      }
    }
    audioModeLabel.textContent = mode === 'original' ? '原唱' : '伴奏';
    console.log('[音訊] mode =', mode, '(accGain=' + (accGain ? accGain.gain.value : '?') + ', vocGain=' + (vocGain ? vocGain.gain.value : '?') + ')');
  }

  let currentAudioMode = 'original'; // 從 server 廣播過來的最新 audio mode (original/vocal_off)

  // ===== Socket.io 連線 =====
  const socket = io({ reconnection: true });

  socket.on('connect', () => {
    console.log('[Socket] 已連線', socket.id);
    connectionStatus.innerHTML = '<i class="fa-solid fa-circle text-green-500"></i> 已連線';
  });

  socket.on('disconnect', () => {
    connectionStatus.innerHTML = '<i class="fa-solid fa-circle text-red-500"></i> 連線中斷';
  });

  // 第一次 sync (後端建立連線時就會推一次，這只是保險)
  socket.on('sync_state', (state) => {
    console.log('[Socket] 同步狀態：', state);
    if (state.tvSyncOffset !== undefined) {
      currentTvSyncOffset = state.tvSyncOffset;
    }
    if (state.audioMode) {
      applyAudioMode(state.audioMode);
      currentAudioMode = state.audioMode;
    }
    if (state.currentSong) {
      playSong(state.currentSong);
    }
  });

  // 播放指令
  socket.on('play_song', ({ currentSong }) => {
    console.log('[Socket] 播放：', currentSong);
    playSong(currentSong);
  });

  // 歌曲 audio 預抽完成 → 若仍在 audio mode 且播同一首歌,重啟 bgAudio
  socket.on('song_audio_ready', ({ songId, audioOriginal }) => {
    console.log('[Socket] song_audio_ready', { songId, audioOriginal });
    if (currentSongRef && currentSongRef.id === songId && !currentSongRef.audioOriginal) {
      currentSongRef.audioOriginal = audioOriginal;
      if (audioMode) {
        console.log('[bgAudio] song_audio_ready → 重試 playBgAudio');
        playBgAudio(currentSongRef);
      }
    }
  });

  // 停止指令 (切歌時) - 黑幕過場
  socket.on('stop_song', () => {
    console.log('[Socket] 停止');
    try { video.pause(); } catch (e) {}
    video.removeAttribute('src');
    video.load();
    // audio-mode: 只 pause bgAudio,不解綁 src/不 load()
    // → server 緊接著 emit play_song → playBgAudio 會重新設 src,避免破壞
    //   iOS PWA 的 user-activation credit (切下一首 src 立刻 play() 才不會被拒)。
    // 非 audio-mode: bgAudio 沒在用,可以真的 stopBgAudio() 釋放
    if (audioMode) {
      try { bgAudio.pause(); } catch (e) {}
    } else {
      stopBgAudio();
    }
    currentSongRef = null;
    // 重置 ended guard，避免 stop 後殘留的 error 延遲 callback 觸發
    _songEndedEmitted = false;
    // 清除倒數
    clearInterval(countdownInterval);
    clearTimeout(hideCountdownTimer);
    shownThresholds = new Set(); // 防止过渡期间 callback 仍觸發顯示
    lastReportedRemaining = Infinity;
    nextSongCard.style.opacity = '0';
    // 顯示黑幕，隱藏待機畫面
    standbyScreen.style.display = 'none';
    transitionOverlay.style.opacity = '1';
    transitionOverlay.style.pointerEvents = 'auto';
  });

  // 音軌切換
  socket.on('change_audio_mode', ({ audioMode }) => {
    console.log('[Socket] 音軌模式：', audioMode);
    applyAudioMode(audioMode);
  });

  // JIT 陰影檔更新時重新載入
  socket.on('tv_sync_offset_updated', (data) => {
    if (data && data.tvSyncOffset !== undefined) {
      currentTvSyncOffset = data.tvSyncOffset;
    }
    if (currentSongRef && video.src && !video.paused) {
      const currentTime = video.currentTime;
      console.log(`[Socket] 影音同步更新，重新載入歌曲於 ${currentTime}s...`);
      // 修改 pendingSongSrc 並重新呼叫 playSong 來觸發網址變更
      playSong(currentSongRef);
      video.addEventListener('canplay', () => {
        video.currentTime = currentTime;
      }, { once: true });
    }
  });

  // 自動喚醒 B: 有人點歌 → 頂部中央顯示「已點播：xxx」5 秒
  // (來自 server 的 broadcast,server 會在 add_song 成功後發給所有 client)
  socket.on('song_added', ({ title, addedBy } = {}) => {
    console.log('[Socket] 有人點歌：', title, 'by', addedBy);
    const label = addedBy ? `${title}（${addedBy}）` : title;
    showSongAddedToast(label || '新點播');
  });

  // 歌單更新：記住下一首，用於倒數提示
  socket.on('playlist_updated', ({ playlist, currentSong } = {}) => {
    nextSong = (playlist && playlist.length > 0) ? playlist[0] : null;
    // 歌單空了：當 currentSong 播完、queue 也空的時候顯示 bar
    if (!nextSong && !currentSong) {
      queueEmptyBar.style.opacity = '1';
    } else {
      queueEmptyBar.style.opacity = '0';
    }
  });

  // 手動喚醒 (邀請朋友): 手機端按「顯示 QR」→ server 廣播給 tv
  // tv 端 QR Panel 強制顯示 15 秒
  socket.on('show_qr', ({ durationMs } = {}) => {
    console.log('[Socket] 邀請朋友 → 顯示 QR');
    wakeUI('qrCode', durationMs || SMART_FADE.qrCode);
  });

  function playSong(song) {
    if (!song || !song.src) return;
    nowPlayingTitle.textContent = song.title;
    nowPlayingArtist.textContent = `${song.artist || ''} · ${song.duration || ''}`;
    nowPlayingBarTitle.textContent = song.title;
    nowPlayingBarArtist.textContent = `${song.artist || ''} · ${song.duration || ''}`;
    // 自動喚醒 A: 切到新歌 → 立刻顯示 nowPlaying UI 8 秒
    // (沉浸模式時會用 .ui-shown 蓋掉隱藏)
    wakeUI('nowPlaying', SMART_FADE.nowPlaying);
    standbyScreen.style.display = 'none';
    // 淡出黑幕
    transitionOverlay.style.opacity = '0';
    transitionOverlay.style.pointerEvents = 'none';

    // 記住當前 song（含 srcVocalOff），給 change_audio_mode 切換音軌用
    currentSongRef = song;
    // Audio-mode 同步清 bgAudio 上一次狀態,避免殘留
    audioCurrentTrack = audioMode ? (currentAudioMode === 'vocal_off' ? 'vocal_off' : 'original') : 'original';

    // 重置 ended/error guard，避免上一首歌的延迟回调干扰新歌
    _songEndedEmitted = false;

    console.log('[playSong] 收到 song =', song.src, 'audioMode=', audioMode, 'audioUnlocked =', audioUnlocked);

    // ===== Audio Mode (背景播放) 路徑 =====
    // 音樂模式時完全不走 <video> (iOS 背景會被 pa是use)，
    // 改用 <audio> 播 server 預抽的 .m4a,鎖屏才不會被 pause。
    // 注意:不需要 user gesture 解鎖 audioContext,因為 <audio> 用瀏覽器原生解碼。
    if (audioMode) {
      playBgAudio(song);
      return;
    }

    // ===== 關鍵：在 audioContext 解鎖之前，不要碰 video.src =====
    // 原因：MediaElementSource 一旦建立 (initAudioGraph),video 元素的
    //       audio 解碼管線就會掛在 audioCtx 上。若 audioCtx 是 suspended,
    //       視訊 frames 的解碼會被凍結 → currentTime 卡在 0.0,畫面沒出來,
    //       雖然 paused=false / readyState=4 也沒救。
    //
    // 所以：audioUnlocked=true 之前,把 src 暫存,顯示 overlay,等 user 點。
    // 將 /videos/ 抽換為 /tv-videos/ 以便觸發 JIT 陰影快取機制
    let tvSrc = song.src;
    if (tvSrc && tvSrc.startsWith('/videos/')) {
      tvSrc = tvSrc.replace('/videos/', '/tv-videos/');
      // 加上 query param，確保電視瀏覽器不會沿用舊的 Range Request 快取
      tvSrc += `?offset=${currentTvSyncOffset}`;
    }

    if (!audioUnlocked) {
      pendingSongSrc = tvSrc;
      pendingFirstPlay = true;
      unlockOverlay.style.display = 'flex';
      console.log('[playSong] 等 user gesture, src 暫存於 pendingSongSrc');
      return;
    }

    // 已經解鎖了 → 一切照舊
    initAudioGraph(); // build/restore graph (若是首次播放)

    console.log('[playSong] 設定 src =', tvSrc);
    video.src = tvSrc;
    video.loop = false;

    // 不等 canplay — 直接嘗試播。失敗了再說。
    const tryPlay = (reason) => {
      console.log(`[video] tryPlay() 因為: ${reason}, audioCtx.state=${audioCtx ? audioCtx.state : 'null'}`);
      const p = video.play();
      if (p && p.catch) {
        p.then(() => console.log('[video] play() 成功 (' + reason + ')'))
         .catch((err) => {
            console.warn('[video] play() 失敗 (' + reason + ')：', err.name, err.message);
            // 不管哪種失敗都先試著顯示 overlay,user 點一下會 retry
            pendingFirstPlay = true;
            unlockOverlay.style.display = 'flex';
          });
      }
    };

    // canplay 之後再播，這時 video.duration 已可用
    video.addEventListener('canplay', () => tryPlay('canplay'), { once: true });

    // 倒數提示：canplay 時 duration 就緒，這裡啟動倒數計時
    video.addEventListener('canplay', () => {
      startNextSongCountdown();
    }, { once: true });
  }

  // ===== 下一首倒數邏輯 =====
  // 每次播新歌就重設倒數計時器（用 setInterval 檢查剩餘時間）
  let shownThresholds = new Set(); // 避免同一閾值重複觸發
  let hideCountdownTimer = null;
  let lastReportedRemaining = Infinity;

  function startNextSongCountdown() {
    clearInterval(countdownInterval);
    clearTimeout(hideCountdownTimer);
    shownThresholds = new Set();
    lastReportedRemaining = Infinity;
    nextSongCard.style.opacity = '0';

    countdownInterval = setInterval(() => {
      // 需要有效 duration 且影片正在播
      if (!video.duration || video.duration <= 0 || video.paused || !video.src) return;
      const remaining = video.duration - video.currentTime;
      if (remaining <= 0 || remaining > video.duration) {
        clearInterval(countdownInterval);
        nextSongCard.style.opacity = '0';
        return;
      }
      // 每秒（實際剩餘時間變化）才處理，避免過度觸發
      if (Math.abs(remaining - lastReportedRemaining) < 0.9) return;
      lastReportedRemaining = remaining;

      for (const threshold of COUNTDOWN_TRIGGERS) {
        if (remaining <= threshold && !shownThresholds.has(threshold)) {
          shownThresholds.add(threshold);
          triggerCountdownNotification(threshold);
        }
      }
    }, 300); // 每 0.3 秒檢查
  }

  function triggerCountdownNotification(secondsLeft) {
    // 沒有下一首 → 顯示「歌單空了」
    if (!nextSong) {
      nextSongCardTitle.textContent = '歌單空了';
      nextSongCardArtist.textContent = '快去點歌吧 🎤';
    } else {
      nextSongCardTitle.textContent = nextSong.title || '—';
      nextSongCardArtist.textContent = nextSong.artist || '—';
    }
    nextSongCountdownNum.textContent = secondsLeft;
    nextSongCard.style.opacity = '1';

    clearTimeout(hideCountdownTimer);
    hideCountdownTimer = setTimeout(() => {
      nextSongCard.style.opacity = '0';
    }, 4000);
  }

  // 診斷 video 狀態 (協助找出為什麼沒畫面)
  setInterval(() => {
    if (video.src) {
      console.log(
        '[video診斷] src=', video.src.split('/').pop().slice(0, 30),
        'readyState=', video.readyState,
        'paused=', video.paused,
        'currentTime=', video.currentTime.toFixed(1),
        'duration=', video.duration,
        'error=', video.error && video.error.code
      );
    }
  }, 3000);

  // ===== video 事件 =====
  // guard: 防止 ended 和 error (1500ms延迟) 同时触发导致 song_ended 发两次
  let _songEndedEmitted = false;
  function _emitSongEnded() {
    if (_songEndedEmitted) return;
    _songEndedEmitted = true;
    console.log('[video] ended → 通知後端');
    socket.emit('song_ended');
  }

  video.addEventListener('ended', _emitSongEnded);

  video.addEventListener('error', (e) => {
    console.error('[video] error', e);
    // 来源错误时也通知后端，避免卡死；1.5s delay 给缓冲恢复最后机会
    setTimeout(() => {
      if (!_songEndedEmitted) {
        _emitSongEnded();
      }
    }, 1500);
  });

// ===== 音樂模式 (Audio-Only Mode) =====
// 用途: 純聽歌場景 (背景播放、駕車聽歌)。
// 行為: 隱藏 video 元素 (但 audio 繼續由 Web Audio graph 輸出),
//       黑底大字顯示歌名 + 進度條,無 QR/無沉浸/無切換干擾。
// 通訊: 完全沿用現有 socket events — server 不需任何改動。
let audioMode = false;

function setAudioMode(on) {
  audioMode = !!on;
  document.body.classList.toggle('audio-mode', audioMode);
  if (audioModeBtnLabel) {
    audioModeBtnLabel.textContent = audioMode ? 'TV 模式' : '音樂模式';
  }
  console.log('[音樂模式] 切換為', audioMode ? 'ON' : 'OFF');

  // 切到音樂模式:把現在播的歌交給 bgAudio (iOS 才能背景播)
  // 切回 TV 模式:停 bgAudio,讓 <video> 接手
  if (on && currentSongRef) {
    // 等一首具備 .m4a 的歌才切
    audioCurrentTrack = currentAudioMode === 'vocal_off' ? 'vocal_off' : 'original';
    playBgAudio(currentSongRef);
    try { video.pause(); } catch (e) {}
  } else if (!on) {
    stopBgAudio();
    // video 從 currentSongRef 接手 (若 audioUnlocked 已建立 graph)
    if (currentSongRef && audioUnlocked) {
      playSong(currentSongRef);
    }
  }
}

// 從 URL query 自動進入音樂模式 (?mode=audio)
// 讓 user 可以直接分享「音樂模式 URL」給朋友 / 設成 PWA 入口
if (new URLSearchParams(window.location.search).get('mode') === 'audio') {
  // 等 DOM ready 後再切換 (確保 CSS class 生效)
  setTimeout(() => setAudioMode(true), 0);
}

audioModeBtn.addEventListener('click', () => {
  setAudioMode(!audioMode);
});

// ===== Audio Mode (背景播放) =====
// iOS PWA 鎖屏仍會 pause <video>,所以 audio-mode 時改用 <audio> element 播 server 預先抽好的 .m4a,
// .m4a 才能拿到 iOS 的背景音訊 session,並透過 MediaSession API 顯示鎖屏卡片。
//
// 設計:
//   - audio-mode 時: bgAudio 處理一切 (load/play),video 完全不動作 (display:none 也沒用,iOS 仍會清緩衝)
//   - TV mode 時: 維持原本的 <video> + Web Audio graph 流程
//   - 切回 TV mode 時: 同步把 bgAudio 暫停,讓 video 接手
//   - audioMode 切換 (原唱/伴奏) 時: 重新給 bgAudio 餵對應的 .m4a URL

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => bgAudio.play().catch(() => {}));
  navigator.mediaSession.setActionHandler('pause', () => bgAudio.pause().catch(() => {}));
  navigator.mediaSession.setActionHandler('seekbackward', () => { bgAudio.currentTime = Math.max(0, bgAudio.currentTime - 10); });
  navigator.mediaSession.setActionHandler('seekforward', () => { bgAudio.currentTime = Math.min(bgAudio.duration || 0, bgAudio.currentTime + 10); });
}

bgAudio.addEventListener('ended', () => {
  // 通知後端切下一首 (只在 audio-mode 才有作用)
  if (audioMode) {
    socket.emit('song_ended');
  }
});

function updateMediaSession(song) {
  if (!('mediaSession' in navigator) || !song) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.title || '—',
      artist: song.artist || '',
      album: 'CouchMic · ' + (audioMode && audioCurrentTrack === 'vocal_off' ? '伴奏' : '原唱'),
    });
  } catch (e) {
    console.warn('[bgAudio] MediaSession metadata 失敗:', e);
  }
}

// audio-mode 專用:挑對應的 .m4a URL
// - track='vocal_off' → src = audioVocalOff (伴奏 mono)
// - track='original'  → src = audioOriginal (原唱 L+R mixed mono)
function getAudioModeSrc(song, track) {
  if (!song) return null;
  if (track === 'vocal_off') return song.audioVocalOff || song.audioOriginal || null;
  return song.audioOriginal || null;
}

let audioCurrentTrack = 'original'; // 記住 audio-mode 目前播原唱還是伴奏

function playBgAudio(song) {
  if (!song) return;
  const src = getAudioModeSrc(song, audioCurrentTrack);
  console.log('[bgAudio] playBgAudio 收到:', { title: song.title, src, audioCurrentTrack, audioMode });
  if (!src) {
    // 沒有預抽 m4a → 退而求其次,讓 <video> 繼續播 (但 iOS 鎖屏會停)。
    // 顯示一條非阻擋 toast,告訴 user 此歌暫不支援背景播放。
    // 同時通知 server 用 ffmpeg 即時補抽 audioOriginal (給未來這首歌或下一輪用)
    console.warn('[bgAudio] 此歌沒有預抽的 .m4a (audioOriginal/audioVocalOff),改用 video 繼續播 (鎖屏會停)');
    showAudioModeFallbackToast(song);
    if (socket && song.id && song.source === 'local') {
      socket.emit('request_audio_extract', { songId: song.id });
    }
    return;
  }
  // iOS PWA 切歌根因: 設定 src → play() 太快,iOS 還在 fetch 新資源時丟
  // NotAllowedError (非 user gesture)。解法: 等 canplay/loadedmetadata 後再 play,
  // 並設 1.5s timeout 主動 retry (cached 資源不會觸發 canplay)。
  const srcFile = src.split('/').pop();
  if (bgAudio.src && bgAudio.src.endsWith(srcFile)) {
    // src 沒變 (change_audio_mode 同首歌切軌) — resume
    console.log('[bgAudio] 同 src,只 resume');
    if (bgAudio.paused) bgAudio.play().then(() => {
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    }).catch((e) => console.warn('[bgAudio] resume 失敗:', e));
    return;
  }
  bgAudio.src = src;
  bgAudio.loop = false;
  // 不要先設 currentTime=0 — 設了會干擾 iOS 的 internal buffering
  let started = false;
  const tryStart = (why) => {
    if (started) return;
    started = true;
    console.log('[bgAudio] tryStart 因為', why);
    bgAudio.currentTime = 0;
    updateMediaSession(song);
    bgAudio.play().then(() => {
      console.log('[bgAudio] play() 成功, paused=', bgAudio.paused, 'currentTime=', bgAudio.currentTime);
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    }).catch((err) => console.warn('[bgAudio] play 失敗：', err.name, err.message));
  };
  bgAudio.addEventListener('canplay', () => tryStart('canplay'), { once: true });
  bgAudio.addEventListener('loadeddata', () => tryStart('loadeddata'), { once: true });
  // cached m4a 不會觸發 canplay → 1.5s 後主動試
  setTimeout(() => tryStart('1500ms-timeout'), 1500);
}

function stopBgAudio() {
  // 切回 TV mode 或 user 主動暫停時呼叫 — 真的要釋放 bgAudio
  try {
    bgAudio.pause();
    bgAudio.removeAttribute('src');
    bgAudio.load();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';
  } catch (e) {}
}

// audio-mode 沒有預抽 m4a 時,顯示 toast 提醒 user
// (video 元素會繼續播,但 iOS PWA 鎖屏會停 — 後續可以排 pipeline 補抽)
let _audioModeFallbackToastTimer = null;
function showAudioModeFallbackToast(song) {
  let toast = document.getElementById('audioModeFallbackToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'audioModeFallbackToast';
    toast.className = 'fixed top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 ' +
      'bg-black/80 text-white px-5 py-3 rounded-xl text-base font-medium ' +
      'shadow-2xl backdrop-blur-sm pointer-events-none transition-opacity duration-300';
    toast.style.opacity = '0';
    document.body.appendChild(toast);
  }
  toast.textContent = `「${song.title || '此歌'}」尚未預抽背景音訊，鎖屏後會停止播放`;
  toast.style.opacity = '1';
  clearTimeout(_audioModeFallbackToastTimer);
  _audioModeFallbackToastTimer = setTimeout(() => {
    toast.style.opacity = '0';
  }, 4000);
}


// ===== 第一次 user gesture 解鎖 (autoplay + AudioContext 政策) =====
async function unlockAudioPlayback() {
    if (audioUnlocked) return;
    try {
      // 1. 先把 AudioContext 建好並 resume (這段必須在 gesture callback 內同步執行)
      initAudioGraph();
      if (audioCtx) {
        if (audioCtx.state === 'suspended') {
          await audioCtx.resume().catch(e => console.warn('[音訊] resume 失敗：', e));
        }
        // 播一個靜音 sample buffer (consumes the user-activation credit)
        try {
          const buf = audioCtx.createBuffer(1, 1, 22050);
          const src = audioCtx.createBufferSource();
          src.buffer = buf;
          src.connect(audioCtx.destination);
          src.start(0);
        } catch (e) { console.warn('[音訊] 靜音 buffer 播放失敗：', e); }
      }
      audioUnlocked = true;
      unlockOverlay.style.display = 'none';
      console.log('[播放] 已解鎖 audio playback, audioCtx.state=', audioCtx ? audioCtx.state : 'null');

      // 2. 解鎖後,如果有暫存的歌曲,把它真正播下去
      if (pendingSongSrc) {
        const src = pendingSongSrc;
        pendingSongSrc = null;
        pendingFirstPlay = false;
        console.log('[播放] 設定暫存的 src =', src);
        video.src = src;
        video.loop = false;
        video.addEventListener('canplay', () => {
          console.log('[video] canplay (解鎖後), audioCtx.state=', audioCtx ? audioCtx.state : 'null');
          const p = video.play();
          if (p && p.catch) {
            p.then(() => console.log('[video] play() 成功 (解鎖後)'))
             .catch((err) => console.warn('[video] play() 失敗 (解鎖後)：', err.name, err.message));
          }
        }, { once: true });
      }
    } catch (err) {
      console.error('[播放] 解鎖失敗：', err);
      unlockOverlay.style.display = 'flex';
    }
  }

  // 點 overlay 或整個 document 都算 gesture (但只第一次有用)
  unlockOverlay.addEventListener('click', () => {
    try {
      unlockAudioPlayback();
    } catch (e) {
      console.error('[播放] unlockOverlay 點擊失敗：', e);
      unlockOverlay.addEventListener('click', () => {
        try { unlockAudioPlayback(); } catch (err) { console.error('[播放] 重試失敗：', err); }
      });
    }
  });
  // 額外保險：點文件任何地方也能解鎖
  document.addEventListener(
    'click',
    () => {
      try {
        if (!audioUnlocked) unlockAudioPlayback();
        if (audioCtx && audioCtx.state === 'suspended') {
          audioCtx.resume().catch(() => {});
        }
      } catch (e) {
        console.error('[播放] document click 解鎖失敗：', e);
      }
    },
    { once: false }
  );

  // ===== 智慧淡入淡出 (The Smart Fade) =====
  // 設計理念: 不該讓 UI「永遠消失」或「永遠常駐」,而是「需要時才出現」。
  // 預設狀態: 全部淡入 (首次載入 / 待機時)
  // 7-10 秒後: 自動淡出右上的「現在播放」和右下的 QR Code
  // 喚醒時機:
  //   - 新歌開播 (play_song) → 顯示 nowPlaying 8 秒
  //   - 有人點歌 (add_song) → 顯示頂部 toast 5 秒
  //   - 邀請朋友 (mobile 按鈕) → 顯示 QR 15 秒
  //   - 滑鼠動 (mousemove) → 喚醒 5 秒
  const SMART_FADE = {
    nowPlaying: 8000,  // ms — 顯示「現在播放」(右上+底部) 多久
    qrCode: 15000,     // ms — 顯示 QR 多久
    toast: 5000,       // ms — 「已點播：xxx」toast 多久
    mouse: 5000,       // ms — 滑鼠喚醒後,所有 UI 留多久
  };

  // 給每個區塊獨立的 fadeTimer,以確保「叫醒 A 不會打斷 B 的計時」
  const fadeTimers = {
    nowPlaying: null,
    qrCode: null,
    toast: null,
    mouse: null,
  };

  // 「某區塊是否應該可見」 — 這是商業邏輯層,UI 狀態由 CSS 來表達。
  // 我們用「shouldShowXxx」變數追蹤「誰希望它可見」,而非「CSS 屬於什麼狀態」。
  // 然後 renderUI() 會把所有 shouldShow 與 immersive 結合,決定 CSS class。
  const shouldShow = {
    nowPlaying: true,    // 預設可見
    qrCode: true,        // 預設可見
  };

  /**
   * 叫醒某區塊 N 毫秒, 然後自動淡出。
   * 重複呼叫會重設計時 (不會把 UI 關掉重開)。
   */
  function wakeUI(zone, ms) {
    // 1. 設定該區塊「應該可見」
    if (zone === 'nowPlaying') shouldShow.nowPlaying = true;
    if (zone === 'qrCode') shouldShow.qrCode = true;
    renderUI();

    // 2. 重設 / 啟動 fade timer
    if (fadeTimers[zone]) clearTimeout(fadeTimers[zone]);
    fadeTimers[zone] = setTimeout(() => {
      if (zone === 'nowPlaying') shouldShow.nowPlaying = false;
      if (zone === 'qrCode') shouldShow.qrCode = false;
      renderUI();
      fadeTimers[zone] = null;
    }, ms);
  }

  /**
   * 顯示「已點播：xxx」toast (頂部中央) — 獨立於其他 fade 邏輯。
   * 重複呼叫會 reset 計時。
   */
  function showSongAddedToast(title) {
    songAddedToastTitle.textContent = title || '—';
    songAddedToast.classList.add('show');
    if (fadeTimers.toast) clearTimeout(fadeTimers.toast);
    fadeTimers.toast = setTimeout(() => {
      songAddedToast.classList.remove('show');
      fadeTimers.toast = null;
    }, SMART_FADE.toast);
  }

  /**
   * 渲染 UI 狀態 — 把 shouldShow + immersive 轉成 CSS class。
   * 「非沉浸模式」: shouldShow=true → 顯示, false → .ui-faded
   * 「沉浸模式」:   .ui-shown 表示「強迫在沉浸模式內顯示」
   *                沒 .ui-shown 就會被 body.immersive 規則隱藏
   */
  function renderUI() {
    // (a) nowPlaying — 右上 panel + 底部 bar
    if (immersive) {
      // 沉浸模式中,只在「主動叫醒」時顯示 (例如 play_song)
      setZoneClass('nowPlaying', shouldShow.nowPlaying, /*showInImmersive=*/true);
    } else {
      setZoneClass('nowPlaying', shouldShow.nowPlaying, /*showInImmersive=*/false);
    }

    // (b) qrCode — 右下 QR 面板
    if (immersive) {
      // 沉浸模式中,只在「主動叫醒」時顯示 (例如 「邀請朋友」)
      setZoneClass('qrCode', shouldShow.qrCode, /*showInImmersive=*/true);
    } else {
      setZoneClass('qrCode', shouldShow.qrCode, /*showInImmersive=*/false);
    }
  }

  /**
   * 設置某區塊的 CSS class。
   * - isVisible + 非沉浸: 移除 ui-faded
   * - !isVisible + 非沉浸: 加上 ui-faded (預設顯示,被淡出)
   * - isVisible + 沉浸: 加上 ui-shown (覆寫 immersive 規則)
   * - !isVisible + 沉浸: 移除 ui-shown (讓 immersive 預設隱藏發揮作用)
   */
  function setZoneClass(zone, isVisible, showInImmersive) {
    const panelIds = {
      nowPlaying: ['nowPlayingPanel', 'nowPlayingBar'],
      qrCode: ['qrPanel'],
    };
    const ids = panelIds[zone] || [];
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (showInImmersive) {
        // 沉浸模式
        if (isVisible) {
          el.classList.remove('ui-faded');
          el.classList.add('ui-shown');
        } else {
          el.classList.remove('ui-shown');
        }
      } else {
        // 非沉浸模式
        if (isVisible) {
          el.classList.remove('ui-faded');
        } else {
          el.classList.add('ui-faded');
        }
      }
    });
  }

  // 滑鼠動一下 → 叫醒 UI 5 秒
  // (任何狀態都會觸發,連待機時也會)
  document.addEventListener('mousemove', () => {
    wakeUI('nowPlaying', SMART_FADE.mouse);
    wakeUI('qrCode', SMART_FADE.mouse);
  });

  // 啟動時: 預設 8 秒後淡出 nowPlaying,讓畫面進入「純淨 MV」狀態
  // (這個 timer 會在首次 play_song 時被重設,所以不會跟實際播放時間衝突)
  setTimeout(() => {
    if (!currentSongRef) {
      // 還沒在播 → 全部淡出 (待機也要乾淨)
      shouldShow.nowPlaying = false;
      shouldShow.qrCode = false;
      renderUI();
    }
  }, SMART_FADE.nowPlaying);



  function enterImmersive() {
    if (immersive) return;
    immersive = true;
    document.body.classList.add('immersive');
    // 進入沉浸模式: 立刻把所有可浮動的 UI 縮到「不主動顯示」狀態。
    // SmartFade 會用 .ui-shown 來在沉浸模式內臨時叫醒。
    shouldShow.nowPlaying = false;
    shouldShow.qrCode = false;
    renderUI();
    requestFullscreenCompat();
    // 廣播給 server/mobile (server 會再 io.emit 回來給 tv,但因為值 == immersive
    // 會被 toggle_immersive handler 忽略)
    socket.emit('toggle_immersive', { immersive: true });
    console.log('[immersive] 進入沉浸模式');
  }

  function exitImmersive() {
    if (!immersive) return;
    immersive = false;
    document.body.classList.remove('immersive');
    // 退出時主動讓 UI 重新可見一段時間,讓 user 確認現在在播什麼
    wakeUI('nowPlaying', SMART_FADE.nowPlaying);
    // 若還在瀏覽器原生 fullscreen,主動退出 (mobile 觸發退出時)
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) exit.call(document).catch(() => {});
    }
    // 廣播給 server/mobile
    socket.emit('toggle_immersive', { immersive: false });
    console.log('[immersive] 退出沉浸模式');
  }

  function requestFullscreenCompat() {
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (req) {
      req.call(el).catch((err) => {
        // user 拒絕 / 沒 gesture → 不影響沉浸模式本身 (CSS 已生效)
        console.warn('[immersive] 瀏覽器 fullscreen 請求被拒:', err.name);
      });
    }
  }

  // 瀏覽器原生 fullscreen 變動時 → 同步 CSS 沉浸狀態
  // ESC 退出 / 其他視窗搶走焦點時也會觸發
  const onFsChange = () => {
    const inFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
    if (!inFs && immersive) {
      immersive = false;
      document.body.classList.remove('immersive');
      wakeUI('nowPlaying', SMART_FADE.nowPlaying);
      // 廣播給 server / mobile,讓手機按鈕狀態同步
      socket.emit('toggle_immersive', { immersive: false });
      console.log('[immersive] 瀏覽器退出 fullscreen → 同步退出沉浸模式');
    }
  };
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);

  function updateImmersiveBtnUI() {
    // 按鈕固定顯示「全螢幕」一個狀態 — immersive 模式時按鈕整個被 CSS 隱藏,
    // 所以永遠不會出現「退出」狀態。user 用手機遙控即可退出。
    immersiveBtnLabel.textContent = '全螢幕';
    immersiveIcon.className = 'fa-solid fa-expand text-pink-400';
  }

  function showImmersiveDialog() {
    immersiveDialog.classList.remove('hidden');
  }
  function hideImmersiveDialog() {
    immersiveDialog.classList.add('hidden');
  }

  // TV 端主動按鈕:直接進/出(有 user gesture)
  immersiveBtn.addEventListener('click', () => {
    if (immersive) {
      exitImmersive();
    } else {
      enterImmersive();
    }
    updateImmersiveBtnUI();
  });

  // dialog 確認 → 進入全螢幕 (有 user gesture,瀏覽器才會接受)
  immersiveDialogConfirm.addEventListener('click', () => {
    hideImmersiveDialog();
    enterImmersive();
    updateImmersiveBtnUI();
  });
  immersiveDialogCancel.addEventListener('click', () => {
    hideImmersiveDialog();
    // 取消時廣播 false,讓 mobile 按鈕狀態回到「TV 全螢幕」
    socket.emit('toggle_immersive', { immersive: false });
  });

  // 接收 mobile 端的切換請求
  // 重要:server 廣播會「也回送給 tv 自己」(io.emit),所以 tv 自己的 emit 後
  // 會再收到一次。這裡用「廣播回來的值 == tv 自己目前狀態」這個跡象忽略它,
  // 避免 tv 自己的回報變成自我觸發彈 dialog。
  socket.on('toggle_immersive', ({ immersive: wantImmersive } = {}) => {
    if (typeof wantImmersive !== 'boolean') {
      // 沒指定 → 切換(保留舊行為,相容舊版)
      if (immersive) exitImmersive();
      else enterImmersive();
      updateImmersiveBtnUI();
      return;
    }

    // 若 server 回報的狀態 == 我目前狀態,代表這是「我自己剛剛 emit 出去又彈回來」
    //   → 視為同步訊號,不要再彈 dialog。
    if (wantImmersive === immersive) {
      console.log('[immersive] toggle_immersive 廣播 = 自己目前狀態,當作同步訊號忽略');
      return;
    }

    // wantImmersive === true 且目前為 false → 代表「有人想進入全螢幕」
    //  - 若 tv 自己按鈕時,上面已直接處理(廣播回來會被上面 if 擋掉)
    //  - 從 mobile 進來時 → 廣播回來時 wantImmersive=true 且 tv 還是 false → 一定是 mobile 觸發
    if (wantImmersive === true) {
      // 已在 fullscreen?就直接進入 (ESC 之類的狀態)
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        enterImmersive();
        updateImmersiveBtnUI();
      } else {
        // 沒有 user gesture,不能直接 requestFullscreen → 請 tv user 按確認
        console.log('[immersive] Mobile 請求進入全螢幕 → 顯示 dialog');
        showImmersiveDialog();
      }
    } else {
      // wantImmersive === false → 有人要退出 → 直接執行
      exitImmersive();
      updateImmersiveBtnUI();
    }
  });

  // 滑鼠喚醒在 SmartFade 模組內已統一處理 (覆蓋沉浸 + 非沉浸)。
  // 舊的沉浸專屬邏輯已刪除,因為 SmartFade 模組會自動處理兩種狀態。

  // ===== PWA Service Worker 註冊 =====
  // iOS Safari 加入主畫面後背景播放音訊;Android Chrome 同樣支援。
  // 失敗不影響主功能 (背景音樂仍可在 user 停留在頁面時運作)。
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch((err) => {
        console.warn('[PWA] SW 註冊失敗:', err);
      });
    });
  }
})();
