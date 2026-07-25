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

      // 接線：Splitter → (4 條 Gain) → Merger → destinationGain → output
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
    if (!audioReady) return;
    if (mode === 'original') {
      // 原唱：左→左、右→右
      leftGainOriginal.gain.value = 1.0;
      rightGainOriginal.gain.value = 1.0;
      leftGainVocalOff.gain.value = 0.0;
      rightGainVocalOff.gain.value = 0.0;
    } else {
      // 伴奏：左聲道複製到左右 (等同消除右聲道的人聲)
      leftGainOriginal.gain.value = 0.0;
      rightGainOriginal.gain.value = 0.0;
      leftGainVocalOff.gain.value = 1.0;
      rightGainVocalOff.gain.value = 0.0;
    }
    audioModeLabel.textContent = mode === 'original' ? '原唱' : '伴奏';
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
    standbyScreen.style.display = 'none';

    initAudioGraph(); // 第一次播放時 (需 user gesture) 才建圖

    // resume AudioContext (瀏覽器政策)
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }

    video.src = song.src;
    video.loop = false;
    // 等 canplay 再 play
    const onCanPlay = () => {
      video.play().catch((err) => console.warn('播放失敗：', err));
      video.removeEventListener('canplay', onCanPlay);
    };
    video.addEventListener('canplay', onCanPlay);
  }

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

  // 點擊空白處恢復音訊 (有些瀏覽器需 user gesture)
  document.addEventListener('click', () => {
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
  }, { once: false });
})();
