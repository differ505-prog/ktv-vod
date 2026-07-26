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
  const nowPlayingTitle = document.getElementById('nowPlayingTitle');
  const nowPlayingArtist = document.getElementById('nowPlayingArtist');
  const audioModeLabel = document.getElementById('audioModeLabel');
  const connectionStatus = document.getElementById('connectionStatus');
  const standbyScreen = document.getElementById('standbyScreen');
  const qrcodeDiv = document.getElementById('qrcode');
  const qrUrlDiv = document.getElementById('qrUrl');
  const unlockOverlay = document.getElementById('unlockOverlay');
  const nowPlayingBarTitle = document.getElementById('nowPlayingBarTitle');
  const nowPlayingBarArtist = document.getElementById('nowPlayingBarArtist');

  // ===== 沉浸模式狀態 =====
  let immersive = false;          // 是否進入沉浸模式 (CSS class)
  let nowPlayingFadeTimer = null; // 沉浸模式時,「目前播放 bar」的 fade timer
  const NOW_PLAYING_FADE_MS = 3000;

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
  // 架構：video → MediaElementSource → Splitter (LR) → Merger (LR)
  //   'original'      : Splitter L→Merger L, R→Merger R (正常立體聲)
  //   'vocal_off'     : Splitter L→Merger L, Splitter L→Merger R (左聲道複製到左右 → 消除右聲道人聲)
  let audioCtx = null;
  let sourceNode = null;
  let splitter = null;
  let merger = null;
  let leftGainOriginal = null;
  let rightGainOriginal = null;
  let leftGainVocalOff = null;
  let rightGainVocalOff = null;
  let destinationGain = null;
  let audioReady = false;

// Autoplay / Audio-Context 解鎖狀態
let audioUnlocked = false;
let pendingFirstPlay = false;
let pendingSongSrc = null; // 解鎖前先把 src 暫存在這邊,等 unlock 後才真正給 video

// 記住目前正在播的 song（保留 srcVocalOff 為診斷用），給 sync 顯示用
let currentSongRef = null;

function initAudioGraph() {
    if (audioReady) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AudioCtx();

      // 把 video 音源接入 Web Audio
      sourceNode = audioCtx.createMediaElementSource(video);

      // 立體聲分離
      splitter = audioCtx.createChannelSplitter(2);
      // 立體聲合併
      merger = audioCtx.createChannelMerger(2);

      // 4 條 Gain 用於在不同模式下切換
      leftGainOriginal = audioCtx.createGain();
      rightGainOriginal = audioCtx.createGain();
      leftGainVocalOff = audioCtx.createGain();
      rightGainVocalOff = audioCtx.createGain();

      destinationGain = audioCtx.createGain();
      destinationGain.gain.value = 1.0;

      // 接線：source → Splitter → (4 條 Gain) → Merger → destinationGain → output
      sourceNode.connect(splitter);
      splitter.connect(leftGainOriginal);
      splitter.connect(rightGainOriginal);
      splitter.connect(leftGainVocalOff);
      // rightGainVocalOff 不接 splitter 的右聲道，因為伴奏模式不要右聲道
      // 但仍占一個節點以維持固定拓樸

      leftGainOriginal.connect(merger, 0, 0);
      rightGainOriginal.connect(merger, 0, 1);

      leftGainVocalOff.connect(merger, 0, 0);
      leftGainVocalOff.connect(merger, 0, 1);

      merger.connect(destinationGain);
      destinationGain.connect(audioCtx.destination);

      // 初始模式：原唱
      applyAudioMode('original');

      audioReady = true;
      console.log('[音訊] Web Audio 圖初始化完成');
    } catch (err) {
      console.error('[音訊] 初始化失敗：', err);
    }
  }

  function applyAudioMode(mode) {
    if (!audioReady || !audioCtx) {
      console.warn('[音訊] applyAudioMode 收到但 audioGraph 還沒建好');
      return;
    }
    if (mode === 'original') {
      // 原唱：左→左、右→右
      leftGainOriginal.gain.value = 1.0;
      rightGainOriginal.gain.value = 1.0;
      leftGainVocalOff.gain.value = 0.0;
      rightGainVocalOff.gain.value = 0.0;
    } else if (mode === 'vocal_off') {
      // 伴奏：左聲道複製到左右 (等同消除右聲道的人聲)
      leftGainOriginal.gain.value = 0.0;
      rightGainOriginal.gain.value = 0.0;
      leftGainVocalOff.gain.value = 1.0;
      rightGainVocalOff.gain.value = 0.0;
    }
    audioModeLabel.textContent = mode === 'original' ? '原唱' : '伴奏';
    console.log('[音訊] mode =', mode, '(Web Audio gain 切換完成，src 不動 → 無字幕偏移)');
  }

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
    if (state.audioMode) applyAudioMode(state.audioMode);
    if (state.currentSong) {
      playSong(state.currentSong);
    }
  });

  // 播放指令
  socket.on('play_song', ({ currentSong }) => {
    console.log('[Socket] 播放：', currentSong);
    playSong(currentSong);
  });

  // 停止指令 (切歌時)
  socket.on('stop_song', () => {
    console.log('[Socket] 停止');
    try { video.pause(); } catch (e) {}
    video.removeAttribute('src');
    video.load();
    currentSongRef = null;
    standbyScreen.style.display = 'flex';
  });

  // 音軌切換
  socket.on('change_audio_mode', ({ audioMode }) => {
    console.log('[Socket] 音軌模式：', audioMode);
    applyAudioMode(audioMode);
  });

  function playSong(song) {
    if (!song || !song.src) return;
    nowPlayingTitle.textContent = song.title;
    nowPlayingArtist.textContent = `${song.artist || ''} · ${song.duration || ''}`;
    nowPlayingBarTitle.textContent = song.title;
    nowPlayingBarArtist.textContent = `${song.artist || ''} · ${song.duration || ''}`;
    // 切到新歌 → 立刻把 bar 顯示回來,重新計 fade
    document.body.classList.remove('nowPlayingFaded');
    scheduleNowPlayingFade();
    standbyScreen.style.display = 'none';

    // 記住當前 song（含 srcVocalOff），給 change_audio_mode 切換音軌用
    currentSongRef = song;

    console.log('[playSong] 收到 song =', song.src, 'audioUnlocked =', audioUnlocked);

    // ===== 關鍵：在 audioContext 解鎖之前，不要碰 video.src =====
    // 原因：MediaElementSource 一旦建立 (initAudioGraph),video 元素的
    //       audio 解碼管線就會掛在 audioCtx 上。若 audioCtx 是 suspended,
    //       視訊 frames 的解碼會被凍結 → currentTime 卡在 0.0,畫面沒出來,
    //       雖然 paused=false / readyState=4 也沒救。
    //
    // 所以：audioUnlocked=true 之前,把 src 暫存,顯示 overlay,等 user 點。
    if (!audioUnlocked) {
      pendingSongSrc = song.src;
      pendingFirstPlay = true;
      unlockOverlay.style.display = 'flex';
      console.log('[playSong] 等 user gesture, src 暫存於 pendingSongSrc');
      return;
    }

    // 已經解鎖了 → 一切照舊
    initAudioGraph(); // build/restore graph (若是首次播放)

    console.log('[playSong] 設定 src =', song.src);
    video.src = song.src;
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

    // canplay 之後再播,這時 buffer 已經有資料
    video.addEventListener('canplay', () => tryPlay('canplay'), { once: true });
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
  video.addEventListener('ended', () => {
    console.log('[video] ended → 通知後端');
    socket.emit('song_ended');
  });

  video.addEventListener('error', (e) => {
    console.error('[video] error', e);
    // 來源錯誤時也通知後端，避免卡死
    setTimeout(() => socket.emit('song_ended'), 1500);
  });

// ===== 第一次 user gesture 解鎖 (autoplay + AudioContext 政策) =====
async function unlockAudioPlayback() {
    if (audioUnlocked) return;
    try {
      // 1. 先把 AudioContext 建好並 resume (這段必須在 gesture callback 內同步執行)
      initAudioGraph();
      if (audioCtx) {
        if (audioCtx.state === 'suspended') {
          await audioCtx.resume();
        }
        // 播一個靜音 sample buffer (consumes the user-activation credit)
        const buf = audioCtx.createBuffer(1, 1, 22050);
        const src = audioCtx.createBufferSource();
        src.buffer = buf;
        src.connect(audioCtx.destination);
        try { src.start(0); } catch (_) {}
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
    }
  }

  // 點 overlay 或整個 document 都算 gesture (但只第一次有用)
  unlockOverlay.addEventListener('click', unlockAudioPlayback, { once: true });
  // 額外保險：點文件任何地方也能解鎖
  document.addEventListener(
    'click',
    () => {
      if (!audioUnlocked) unlockAudioPlayback();
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }
    },
    { once: false }
  );

  // ===== 沉浸模式 (Immersive Mode) =====
  //
  // 進入：CSS 把浮層、QR、標題全部 fade 掉,只留 video。
  //       底部中央留一條「目前播放」bar,3 秒後再 fade,讓 user 確認
  //       自己在唱哪首。
  // 退出：CSS 全部還原。
  //
  // 「離開後要回到原本的全螢幕」問題的解法：
  //   - 不靠 user 再點一次 — 透過 `fullscreenchange` event
  //     監聽瀏覽器原生狀態 (ESC 退出也會觸發)。
  //   - 若 user 按 ESC 退出瀏覽器 fullscreen,我們就同步退出沉浸模式;
  //     反之進入沉浸模式時,自動請求瀏覽器 fullscreen。
  //   - 這樣不論「誰先動」狀態都會一致。
  //
  // 為了相容舊版瀏覽器/Tizen,同時監聽 webkit 系前綴。

  function enterImmersive() {
    if (immersive) return;
    immersive = true;
    document.body.classList.add('immersive');
    scheduleNowPlayingFade();
    requestFullscreenCompat();
    console.log('[immersive] 進入沉浸模式');
  }

  function exitImmersive() {
    if (!immersive) return;
    immersive = false;
    document.body.classList.remove('immersive');
    document.body.classList.remove('nowPlayingFaded');
    if (nowPlayingFadeTimer) {
      clearTimeout(nowPlayingFadeTimer);
      nowPlayingFadeTimer = null;
    }
    // 若還在瀏覽器原生 fullscreen,主動退出 (mobile 觸發退出時)
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) exit.call(document).catch(() => {});
    }
    console.log('[immersive] 退出沉浸模式');
  }

  function scheduleNowPlayingFade() {
    if (nowPlayingFadeTimer) clearTimeout(nowPlayingFadeTimer);
    if (!immersive) return;
    nowPlayingFadeTimer = setTimeout(() => {
      document.body.classList.add('nowPlayingFaded');
    }, NOW_PLAYING_FADE_MS);
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
      document.body.classList.remove('nowPlayingFaded');
      if (nowPlayingFadeTimer) {
        clearTimeout(nowPlayingFadeTimer);
        nowPlayingFadeTimer = null;
      }
      // 廣播給 server / mobile,讓手機按鈕狀態同步
      socket.emit('toggle_immersive', { immersive: false });
      console.log('[immersive] 瀏覽器退出 fullscreen → 同步退出沉浸模式');
    }
  };
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);

  // 接收 mobile 端的切換指令
  // server.js 用 io.emit(...) 廣播,所有 client 都收得到,這裡只接收自己關心的
  socket.on('toggle_immersive', ({ immersive: wantImmersive } = {}) => {
    if (typeof wantImmersive === 'boolean') {
      wantImmersive ? enterImmersive() : exitImmersive();
    } else {
      immersive ? exitImmersive() : enterImmersive();
    }
  });

  // 滑鼠動一下 → 立刻把 bar 拉回來 (user 想看哪首就別藏)
  // 注意：只有沉浸模式下生效,不影響其他 UI
  document.addEventListener('mousemove', () => {
    if (!immersive) return;
    document.body.classList.remove('nowPlayingFaded');
    scheduleNowPlayingFade();
  });
})();
