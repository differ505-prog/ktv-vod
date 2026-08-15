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

  // ===== 統一 Toast API (所有 TV 通知收口) =====
  // 支援 success / error / warning / info
  // 內部管理計時器，重複呼叫自動 reset
  (function () {
    let _timer = null;
    let _el = null;
    function ensureEl() {
      if (!_el) {
        _el = document.createElement('div');
        _el.id = 'ktvToast';
        _el.className = 'ktv-toast rounded-xl px-5 py-2.5 text-sm font-medium';
        document.body.appendChild(_el);
      }
      return _el;
    }
    window.showToast = function (msg, kind = 'success') {
      const icons = {
        success: 'fa-circle-check text-green-400',
        error: 'fa-circle-exclamation text-red-400',
        warning: 'fa-triangle-exclamation text-amber-400',
        info: 'fa-circle-info text-cyan-400',
      };
      const cls = `ktv-toast-${kind}`;
      const el = ensureEl();
      el.className = `ktv-toast rounded-xl px-5 py-2.5 text-sm font-medium ${cls}`;
      el.innerHTML = `<i class="fa-solid ${icons[kind] || icons.info} mr-2"></i>${msg}`;
      el.classList.add('show');
      if (_timer) clearTimeout(_timer);
      const durations = { success: 2000, error: 3500, warning: 3500, info: 2500 };
      _timer = setTimeout(() => {
        el.classList.remove('show');
        _timer = null;
      }, durations[kind] || 2500);
    };
  })();

  // ===== 雙 Audio 池 (9 分修法) =====
  // 兩個 <audio> 永遠保持 warm:iOS 對 load() 過的 element 不會凍結 session
  // - activeAudio: 當前正在播的 (handle 一切 src swap / play)
  // - inactiveAudio: 保險絲,只 load() 不 play(),當 active 死掉時用它接手
  // 切歌時**不**切換 activeAudio (避免 new Audio 失去 user gesture credit),
  // 改在 active 上 swap src (iOS 對同 element src 變更最友善)。
  const audioA = new Audio();
  const audioB = new Audio();
  [audioA, audioB].forEach((a, i) => {
    a.id = 'bgAudio' + (i === 0 ? 'A' : 'B');
    a.preload = 'auto';
    a.loop = false;
    // audioSessionType='playback' 是 iOS 13+ WebKit 私有 API,
    // 必須在第一次 user gesture 內設定,iOS 才視為媒體類別允許背景播放
    document.body.appendChild(a);
  });
  let activeAudio = audioA;
  let inactiveAudio = audioB;
  // Web Audio 圖重綁定用:記住綁在哪個 element
  let activeAudioElement = null; // 綁在 splitter 上的 real <audio> (可能 != activeAudio,因為保險絲接手時會切)

  // [9 分修法] 此變數已棄用,只保留給舊 log 識別用;
  // 真正的「當前播放 element」走 activeAudio。當 activeAudio 損壞需切到 audioB 時,
  // 只要重新賦值 activeAudio = audioB,後續所有 activeAudio.xxx 都會自動走到新的 element。
  // 我們不放棄 audioA element — 它仍在 inactiveAudio 角色中預載下一首。

  // 專門用來維持 iOS 背景權限的虛擬音軌。不斷迴圈播放極短的 Base64 靜音檔，
  // 確保 iOS 的 Audio Session 永遠不會被清空。這樣 bgAudio 就可以任意更換 src 或 pause。
  const keepAliveAudio = new Audio();
  keepAliveAudio.loop = true;

  // 背景播放診斷：記錄 iOS 是否真的以主畫面 Web App 執行,以及 audio 是否被系統暫停。
  // [9 分版] 改用 activeAudio 取代 bgAudio 直接讀
  const audioRuntime = () => ({
    mode: audioMode,
    visibility: document.visibilityState,
    standalone: Boolean(navigator.standalone || window.matchMedia?.('(display-mode: standalone)').matches),
    audioSrc: activeAudio?.currentSrc || activeAudio?.src || '',
    paused: activeAudio?.paused,
    readyState: activeAudio?.readyState,
    networkState: activeAudio?.networkState,
    error: activeAudio?.error?.code || null,
  });
  const logAudioRuntime = (event, extra = {}) => console.log('[bgAudio:lifecycle]', event, { ...audioRuntime(), ...extra });

  // ============================================================
  // [V4 修法] on-screen debug logger — 完全不污染 unlock 流程
  //   預設狀態:
  //     - 沒有 🌟 圖示 (之前放右下角的 🐞 會被 iOS 視為蓋住 user gesture 區)
  //     - 沒有 console.log override
  //     - 沒有 setInterval
  //   啟用方式: tv.html?debug=1  →  右下角才出現 🐞 圖示 (層級極低,不擋點擊)
  // ============================================================
  const __debugEnabled = new URLSearchParams(window.location.search).get('debug') === '1';
  if (false && __debugEnabled) { // 暫時整個關閉,避免再次打壞 user gesture 流程
  }
  // TODO: 等音樂模式切歌根因抓出來後,改用 Safari Web Inspector remote debug,不靠 DOM overlay
  document.addEventListener('visibilitychange', () => logAudioRuntime('visibilitychange'));
// [V2 9 分修法] 修正 audio-mode 在背景被 iOS pause 後的「盲目復活舊歌」bug
//   - 舊邏輯 (ad9db55): 前景 visibility 進場時,只要 bgAudio paused → 直接 bgAudio.play()
//     這是錯的:iOS 自動 pause ≠ user 想停,直接 play 會從中斷的 currentTime 殘留播舊歌
//   - 新邏輯: 進前景時,不要盲目 play。改成:
//     (a) 有 pending 新歌 → 真的走切歌路徑 (A+ 修法 (c))
//     (b) 沒 pending 但 bgAudio paused → 用 server 廣播時附的 updatedAt 對齊 currentTime
//         (server emit play_song 已附 updatedAt,SyncState 也會帶) 再 play
let _currentSongStartedAt = 0; // server 端 play_song 時的 timestamp (ms)
// [B' 修法] visibilitychange handler:
//   1. 回前景時先 unbypassAudioGraph (重接 accGain/vocGain 鏈)
//   2. 如果有 pending (前景 sync play 失敗留下來的 fallback) → 補做 play
//   3. 如果 audio 該在播卻 paused → 對齊 server 時間軸再 resume
document.addEventListener('visibilitychange', () => {
  // [E 方案] 進背景瞬間:確保 active audio 100% buffered + 重啟 audioCtx
  //   iOS bg 後只允許已 buffered 部分播完,streaming 會被切
  //   JS 在 bg 仍可執行 5-10s grace window,趁這時把 active 拉到 canplaythrough
  //   另外:audioCtx 在 bg 會被 iOS suspend,bypass + resume() 可強制重新 audible
  if (document.hidden && audioMode && activeAudio && activeAudio.src) {
    const src = activeAudio.src;
    console.log('[bgAudio] 進背景,主動確保 100% buffered:', src.split('/').pop());
    // (1) bypass Web Audio graph (iOS bg 期間 accGain/vocGain 鏈可能 silent 掉)
    try { bypassAudioGraph(); } catch (e) { console.warn('[bgAudio] bg bypass 失敗:', e); }
    // (2) resume audioCtx (iOS bg 會 suspend → 無聲;resume() 把它叫醒)
    if (audioCtx && audioCtx.state !== 'running') {
      audioCtx.resume().then(() => {
        console.log('[bgAudio] bg audioCtx resume OK,state=', audioCtx.state);
      }).catch((e) => console.warn('[bgAudio] bg audioCtx resume 失敗:', e));
    }
    // (3) 預載 active + inactive (grace window 內搶 100% buffered)
    preloadFullTrack(activeAudio, src, 8000).then((ok) => {
      console.log('[bgAudio] bg preload 結果:', ok ? 'OK 100%' : 'PARTIAL (grace window 不夠)');
    });
    if (typeof nextSong !== 'undefined' && nextSong) {
      const nextSrc = getAudioModeSrc(nextSong, audioCurrentTrack);
      if (nextSrc) {
        bindAudioToGraph(inactiveAudio);
        preloadFullTrack(inactiveAudio, nextSrc, 8000).catch(() => {});
      }
    }
    // (4) bg 瞬間保險:active 該在播卻 paused → 強制 play() + 對齊 currentTime
    //   iOS 進 bg 時偶爾會主動 pause,即使 src 還沒播完
    if (activeAudio && activeAudio.paused && activeAudio.src) {
      console.log('[bgAudio] bg 瞬間 active paused,強制 play()');
      activeAudio.play().then(() => {
        console.log('[bgAudio] bg 強制 play() 成功, currentTime=', activeAudio.currentTime);
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
      }).catch((e) => console.warn('[bgAudio] bg 強制 play() 失敗:', e.name, e.message));
    }
  }
  if (document.hidden) return;
  // [B' 修法] 回前台 → 重接 graph + 重設 gain
  unbypassAudioGraph();

  // (a) fallback 補做:只在 sync play 真的失敗時才有 pending
  if (_pendingBgAudioPlay) {
    console.log('[bgAudio] visibilitychange → 補做 pending play()');
    const pending = _pendingBgAudioPlay;
    _pendingBgAudioPlay = null;
    try { activeAudio.pause(); } catch (e) {}
    try {
      activeAudio.removeAttribute('src');
      try { activeAudio.load(); } catch (_) {}
    } catch (e) {}
    activeAudio.src = pending.src;
    activeAudio.loop = false;
    try { activeAudio.load(); } catch (e) {}
    try { activeAudio.currentTime = 0; } catch (e) {}
    updateMediaSession(pending.song);
    activeAudio.play().then(() => {
      console.log('[bgAudio] 延遲 play() 成功, currentTime=', activeAudio.currentTime);
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
      logAudioRuntime('playback-started', { currentTime: activeAudio.currentTime });
    }).catch((e) => console.warn('[bgAudio] 延遲 play() 失敗：', e.name, e.message));
    return;
  }
  // (b) audio 該在播卻 paused → 對齊 server 時間軸再 resume (iOS PWA 進背景會主動 pause)
  if (audioMode && activeAudio.paused && activeAudio.src) {
    const elapsedMs = _currentSongStartedAt ? (Date.now() - _currentSongStartedAt) : 0;
    const expectedTime = elapsedMs / 1000;
    if (activeAudio.duration && expectedTime >= activeAudio.duration) {
      console.log('[bgAudio] visibilitychange → 對齊點已過 duration, 跳下一首');
      socket.emit('song_ended');
      return;
    }
    console.log('[bgAudio] visibilitychange → 對齊 currentTime=', expectedTime.toFixed(1), 's');
    try {
      activeAudio.currentTime = expectedTime;
    } catch (e) {
      console.warn('[bgAudio] 對齊 currentTime 失敗:', e);
    }
    activeAudio.play().then(() => {
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    }).catch((e) => console.warn('[bgAudio] visibility-resume 失敗:', e));
  }
});
  window.addEventListener('pagehide', (event) => logAudioRuntime('pagehide', { persisted: event.persisted }));
  window.addEventListener('pageshow', (event) => logAudioRuntime('pageshow', { persisted: event.persisted }));
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

  // SONG_LIBRARY 本地快取:從 /api/songs 載入完整列表(含 audioOriginal/audioVocalOff),
  // 當 socket play_song 推的 currentSong 漏欄位時可以補上
  let SONG_LIBRARY_CACHE = [];
  fetch('/api/songs').then(r => r.json()).then(d => {
    SONG_LIBRARY_CACHE = d.songs || [];
    console.log('[tv] 載入歌曲庫快取:', SONG_LIBRARY_CACHE.length, '首');
  }).catch(e => console.warn('[tv] 載入歌曲庫失敗:', e));

  // ===== 下一首倒數卡片 =====
  const nextSongCard = document.getElementById('nextSongCard');
  const nextSongCountdownNum = document.getElementById('nextSongCountdownNum');
  const nextSongCardTitle = document.getElementById('nextSongCardTitle');
  const nextSongCardArtist = document.getElementById('nextSongCardArtist');
  const queueEmptyBar = document.getElementById('queueEmptyBar');

  // ===== 下一首倒數狀態 =====
  let nextSong = null;          // playlist_updated 裡的下一首
  let countdownInterval = null;
  const COUNTDOWN_TRIGGERS = [5]; // 只在剩 5 秒時預告一次

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

  // 共用:把 QR Code 渲染到指定容器 (沉浸模式 modal 跟主 panel 共用同一份 URL)
  function renderQrInto(container, size = 140) {
    if (typeof QRCode === 'undefined') {
      container.textContent = 'QRCode 載入失敗';
      return;
    }
    container.innerHTML = '';
    new QRCode(container, {
      text: mobileUrl,
      width: size,
      height: size,
      colorDark: '#000000',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M,
    });
  }

  // 等 DOM ready 再生成 QR (qrcode.js 需要有尺寸的容器)
  renderQrInto(qrcodeDiv, 140);

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

      // [終極保活] 使用 10 秒的無聲 mp3 檔案來維持 iOS 背景播放權限
      // 用相對路徑，避免 nginx /ktv/ 前綴導致 404
      keepAliveAudio.src = 'silence.mp3';
      keepAliveAudio.play().then(() => {
        console.log('[keepAliveAudio] 啟動成功，背景音訊保活中');
      }).catch(e => console.warn('[keepAliveAudio] 啟動失敗:', e));

      // [9 分修法] video 也用「第一次 create 後 cache」模式
      // (MediaElementSource 一個 element 只能 create 一次)
      sourceNode = ensureMediaElementSource(video);

      // 立體聲分離：port 0 = L (伴奏), port 1 = R (人聲)
      splitter = audioCtx.createChannelSplitter(2);

      // 兩個 Gain：伴奏軌 & 人聲軌
      accGain = audioCtx.createGain(); // L 聲道 (伴奏)
      vocGain = audioCtx.createGain(); // R 聲道 (人聲)

      destinationGain = audioCtx.createGain();
      destinationGain.gain.value = 1.0;

      // 接線:sourceNode → splitter (sourceNode 是 video 的,切歌時不會動)
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

  // [9 分修法] 為 element 取得 MediaElementSource (每個 element 只能 create 一次)
  // 用 WeakMap cache，第二次呼叫直接拿舊的;
  // 這樣切歌時 disconnect 舊 source、把新 source connect 進 splitter 就好
  const _mediaSourceCache = new WeakMap();
  function ensureMediaElementSource(el) {
    if (!el || !audioCtx) return null;
    let src = _mediaSourceCache.get(el);
    if (!src) {
      src = audioCtx.createMediaElementSource(el);
      _mediaSourceCache.set(el, src);
    }
    return src;
  }

  // [9 分修法] 把指定的 <audio> 元素接到 graph (接到 splitter)
  // 同時 disconnect 舊的、把它從 graph 移除
  // 注意:每個 element 的 MediaElementSource 在 ensureMediaElementSource 內 cache,
  //       切換時只是「哪個 source 連到 splitter」不同,acGain/vocGain 鏈不動
  //       → applyAudioMode 完全不用改
  function bindAudioToGraph(audioEl) {
    if (!audioReady || !splitter || !audioEl) return;
    // [B' 修法] bypass 模式:source 已接 destination,不要再接 splitter (會雙路輸出)
    if (graphBypassed) return;
    // 1. disconnect 舊的 (拔 source 從 splitter)
    if (activeAudioElement && activeAudioElement !== audioEl) {
      const oldSrc = _mediaSourceCache.get(activeAudioElement);
      if (oldSrc) {
        try { oldSrc.disconnect(splitter); } catch (e) {}
        // [B' 修法] 舊 element 也要拔掉 bypass 連線 (避免雙 source 連 destination)
        try { oldSrc.disconnect(destinationGain); } catch (e) {}
      }
    }
    // 2. 確保新 element 有自己的 MediaElementSource
    const newSrc = ensureMediaElementSource(audioEl);
    if (!newSrc) return;
    // 3. 連到 splitter (冪等:如果已連,connect 是 no-op)
    try { newSrc.connect(splitter); } catch (e) {}
    activeAudioElement = audioEl;
  }

  // [B' 修法] 圖節點:
  //   - destinationGain 是 graph → 耳機的總音量,前景背景都用這個
  //   - 背景時不接 splitter,改接 source → destinationGain (繞過 accGain/vocGain)
  //   - 如此 iOS 背景時仍可聽到聲音 (只是沒人聲/伴奏分離)
  let graphBypassed = false;

  // [B' 修法] 背景降級:把 source 從 splitter 拔掉,直接接 destinationGain
  // iOS PWA 進背景時,Web Audio graph 對 splitted gain 的計算極不穩,
  // 聲音會突然沒掉。bypass 期間圖縮到最短,確保有聲音。
  function bypassAudioGraph() {
    if (!audioReady || !destinationGain) return;
    if (graphBypassed) return;
    graphBypassed = true;
    console.log('[audioGraph] Bypass 模式啟動 (background)');
    // 拔掉所有 active source 從 splitter
    for (const el of [audioA, audioB]) {
      const src = _mediaSourceCache.get(el);
      if (!src) continue;
      try { src.disconnect(splitter); } catch (e) {}
      try { src.disconnect(destinationGain); } catch (e) {} // 先清舊的(若有)
      try { src.connect(destinationGain); } catch (e) {}
    }
  }

  // [B' 修法] 前台恢復:把 source 從 destinationGain 拔掉,接回 splitter
  // 然後重跑 applyAudioMode (重設 accGain/vocGain 對應目前 mode)
  function unbypassAudioGraph() {
    if (!audioReady || !splitter) return;
    if (!graphBypassed) return;
    graphBypassed = false;
    console.log('[audioGraph] Bypass 解除 (foreground)');
    // 拔所有 source 從 destinationGain
    for (const el of [audioA, audioB]) {
      const src = _mediaSourceCache.get(el);
      if (!src) continue;
      try { src.disconnect(destinationGain); } catch (e) {}
    }
    // 接 active 到 splitter
    if (activeAudio) {
      const src = _mediaSourceCache.get(activeAudio);
      if (src) {
        try { src.connect(splitter); } catch (e) {}
      }
      activeAudioElement = activeAudio;
    }
    // 重設 gain 對應目前 mode
    applyAudioMode(currentAudioMode || 'original');
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
    // Audio-mode 下,如果 mode 變更,重新挑對應的 .m4a 餵給 activeAudio
    if (audioMode && currentSongRef && (mode === 'original' || mode === 'vocal_off')) {
      const newTrack = mode === 'vocal_off' ? 'vocal_off' : 'original';
      if (newTrack !== audioCurrentTrack) {
        const savedTime = activeAudio.currentTime;
        audioCurrentTrack = newTrack;
        const src = getAudioModeSrc(currentSongRef, newTrack);
        if (src) {
          // 走 playBgAudio 統一 canplay-wait 路徑,避免 iOS PWA 拒絕
          // (直接設 src → play() 在 change_audio_mode 會丟 NotAllowedError)
          if (activeAudio.src && activeAudio.src.endsWith(src.split('/').pop())) {
            // 同 src → 只更新 playbackState
            activeAudio.play().then(() => {
              if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
            }).catch(() => {});
          } else {
            activeAudio.src = src;
            activeAudio.loop = false;
            const restoreTime = savedTime;
            let started = false;
            const tryStart = () => {
              if (started) return;
              started = true;
              activeAudio.currentTime = restoreTime;
              updateMediaSession(currentSongRef);
              activeAudio.play().then(() => {
                if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
              }).catch((err) => console.warn('[bgAudio] play 失敗：', err));
            };
            activeAudio.addEventListener('canplay', tryStart, { once: true });
            activeAudio.addEventListener('loadeddata', tryStart, { once: true });
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
  // 2026-08-09: Funnel 統一入口走 nginx /ktv/* 路徑分流,socket.io 必須配 path 前綴
  //   否則會被 proxy 轉去 FlowSight (port 8888) → 卡拉ok server 收不到 play_song / library_updated
  // 2026-08-10: Cloudflare Quick Tunnel 透過 nginx 8089 proxy 仍帶 /ktv/, 跟 Funnel 一致
  // [DEBUG] 添加詳細連線日誌，協助診斷 net::ERR_FAILED 問題
  const _tvSocketStart = Date.now();
  console.log('[Socket] 初始化中, URL 自動推斷, path=/ktv/socket.io');
  const socket = io({
    path: '/ktv/socket.io',
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 20000,
  });

  // [DEBUG] socket.io 內部事件日誌（合併 UI 邏輯）
  socket.on('connect', () => {
    console.log(`[Socket] ✅ connect, id=${socket.id}, elapsed=${Date.now()-_tvSocketStart}ms`);
    connectionStatus.innerHTML = '<i class="fa-solid fa-circle text-green-500"></i> 已連線';
  });
  socket.on('connect_error', (err) => {
    console.error(`[Socket] ❌ connect_error: ${err.message}, type=${err.type}, code=${err.code}`);
  });
  socket.on('disconnect', (reason) => {
    console.warn(`[Socket] ⚠️ disconnect: ${reason} — 等 visibilitychange 回前台 reconnect`);
    connectionStatus.innerHTML = '<i class="fa-solid fa-circle text-red-500"></i> 連線中斷';
  });
  socket.on('error', (err) => {
    console.error(`[Socket] ❌ error:`, err);
  });
  socket.io.on('error', (err) => {
    console.error(`[Socket] ❌ engine.io error:`, err);
  });

  // 切回前景時若 socket 還是斷的 → 強制重連一次 (避免 502 cycle 拖太久)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (socket && !socket.connected) {
      console.log('[Socket] 回前景且未連線, 強制 socket.connect()');
      socket.connect();
    }
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
      // [V2] sync_state 在 connect 時也會帶,用 serverTime 對齊時間軸
      _currentSongStartedAt = state.serverTime || Date.now();
      playSong(enrichSong(state.currentSong));
    }
  });

  // 從本地 SONG_LIBRARY_CACHE 補上 audioOriginal/audioVocalOff 欄位
  // (socket play_song 推的 currentSong 偶爾會漏,例如 server 重啟前的殘留 playlist)
  function enrichSong(song) {
    if (!song || !song.id) return song;
    const full = SONG_LIBRARY_CACHE.find((s) => s.id === song.id);
    if (!full) return song;
    if (!song.audioOriginal && full.audioOriginal) song.audioOriginal = full.audioOriginal;
    if (!song.audioVocalOff && full.audioVocalOff) song.audioVocalOff = full.audioVocalOff;
    return song;
  }

  // 播放指令
  socket.on('play_song', ({ currentSong, updatedAt }) => {
    console.log('[Socket] 播放：', currentSong);
    // [V2] server emit play_song 時附 updatedAt,記下來供 visibility 對齊用
    if (updatedAt) _currentSongStartedAt = updatedAt;
    playSong(enrichSong(currentSong));
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
    if (audioMode) {
      try { activeAudio.pause(); } catch (e) {}
      _pendingBgAudioPlay = null; // 切歌就把 pending 洗掉,避免 race
    } else {
      stopBgAudio();
    }
    currentSongRef = null;
    // 重置 ended guard，避免 stop 後殘留的 error 延遲 callback 觸發
    _songEndedEmitted = false;
    _videoFallbackTried = false;
    // 清除倒數
    clearInterval(countdownInterval);
    clearTimeout(hideCountdownTimer);
    shownThresholds = new Set(); // 防止过渡期间 callback 仍觸發顯示
    lastReportedRemaining = Infinity;
    nextSongCard.classList.remove('show');
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
    _videoFallbackTried = false;

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
      // 2026-08-01: Funnel 環境改用 no-range route,避免 Funnel proxy 對 Range request 的處理
      // 造成 <video> element 內建 audio decoder buffer underrun → 機械音
      const isFunnel = typeof location !== 'undefined'
        && location.hostname.endsWith('.ts.net');
      if (isFunnel) {
        tvSrc = tvSrc.replace('/videos/', '/tv-videos-no-range/');
        console.log('[playSong] Funnel 環境: 走 no-range 路徑 (避免機械音)');
      } else {
        tvSrc = tvSrc.replace('/videos/', '/tv-videos/');
      }
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
    nextSongCard.classList.remove('show');

    countdownInterval = setInterval(() => {
      // 需要有效 duration 且影片正在播
      if (!video.duration || video.duration <= 0 || video.paused || !video.src) return;
      const remaining = video.duration - video.currentTime;
      if (remaining <= 0 || remaining > video.duration) {
        clearInterval(countdownInterval);
        nextSongCard.classList.remove('show');
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
    nextSongCard.classList.add('show');

    clearTimeout(hideCountdownTimer);
    hideCountdownTimer = setTimeout(() => {
      nextSongCard.classList.remove('show');
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
    const err = video.error;
    console.error('[video] error code=', err?.code, 'msg=', err?.message, 'src=', video.currentSrc);
    // Fallback: 只在解碼錯誤 (code=3) 才認定是 codec 不支援，其他 error 可能是網路/暫時性的，不該觸發 fallback
    if (err && err.code !== 3) {
      console.warn('[video] error code', err.code, '不是解碼錯誤，不觸發 audio-mode fallback');
      return;
    }
    // Fallback: AV1 mp4 在 iOS Safari 會直接 error → 試改用 m4a 音訊播 (audio-mode)。
    // 條件: 還沒 fallback 過、且 currentSong 有 audioOriginal/audioVocalOff、且沒發過 ended
    if (!_videoFallbackTried && currentSongRef && !_songEndedEmitted) {
      const fallbackSrc = currentSongRef.audioOriginal || currentSongRef.audioVocalOff;
      if (fallbackSrc) {
        _videoFallbackTried = true;
        console.warn('[video] mp4 codec 不支援, fallback 到 m4a 音訊播完這首');
        // 切到音樂模式,讓 bgAudio 用 m4a 接手這首
        try { video.pause(); video.removeAttribute('src'); video.load(); } catch (_) {}
        if (!audioMode) setAudioMode(true);
        if (currentSongRef) playBgAudio(currentSongRef);
        // 顯示一次性提示給 user
        showVideoFallbackToast(currentSongRef);
        return; // 不走 1.5s 強制 ended
      }
    }
    // 1.5s 延遲防呆：給緩衝最後一次恢復機會,沒成功就 forced ended
    setTimeout(() => {
      if (!_songEndedEmitted) {
        _emitSongEnded();
      }
    }, 1500);
  });

  let _videoFallbackTried = false;
  function showVideoFallbackToast(song) {
    showToast(`影片 codec 不支援，改用音訊播放：${song.title || song.id}`, 'warning');
  }

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
  _bgAudioErrorEmitted = false; // 重置錯誤旗標 (mode 切換 = 全新輪播)

  // 切到音樂模式:把現在播的歌交給 bgAudio (iOS 才能背景播)
  // 切回 TV 模式:停 bgAudio,讓 <video> 接手
  if (on && currentSongRef) {
    logAudioRuntime('mode-on', { songId: currentSongRef.id });
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
  setTimeout(() => setAudioMode(true), 0);
}

audioModeBtn.addEventListener('click', () => {
  setAudioMode(!audioMode);
});

// ===== 沉浸模式 QR (常駐顯示,可隨時掃碼) =====
// 沉浸模式時,右下角自動顯示 QR Code — 點歌網址必須隨時可見
const immersiveQrCode = document.getElementById('immersiveQrModal');

// 監聽 body.immersive 變動,首次進入時渲染 QR (避免重複)
const immersiveObserver = new MutationObserver(() => {
  if (document.body.classList.contains('immersive') && immersiveQrCode && !immersiveQrCode.dataset.rendered) {
    renderQrInto(immersiveQrCode, 48);  // 更小的頂部小卡,不干擾觀影,hover可放大
    immersiveQrCode.dataset.rendered = '1';
  }
});
immersiveObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
// 初始也跑一次(若 user 用 ?immersive=1 直接進入)
if (document.body.classList.contains('immersive') && immersiveQrCode && !immersiveQrCode.dataset.rendered) {
  renderQrInto(immersiveQrCode, 48);
  immersiveQrCode.dataset.rendered = '1';
}

// ===== Audio Mode (背景播放) =====
// iOS PWA 鎖屏仍會 pause <video>,所以 audio-mode 時改用 <audio> element 播 server 預先抽好的 .m4a,
// .m4a 才能拿到 iOS 的背景音訊 session,並透過 MediaSession API 顯示鎖屏卡片。
//
// 設計:
//   - audio-mode 時: bgAudio 處理一切 (load/play),video 完全不動作 (display:none 也沒用,iOS 仍會清緩衝)
//   - TV mode 時: 維持原本的 <video> + Web Audio graph 流程
//   - 切回 TV mode 時: 同步把 bgAudio 暫停,讓 video 接手
//   - audioMode 切換 (原唱/伴奏) 時: 重新給 bgAudio 餵對應的 .m4a URL
//
// [A+ 9.5 分修法] iOS PWA 背景切歌根因:
//   1. src swap 在 document.hidden 時,iOS WebKit 會拒絕 play() (NotAllowedError,沒 user gesture)
//   2. 多次連續 src swap → 多個 play promise race,iOS 視為「背景濫用」殺掉 session
// 解法三件套:
//   (a) 同一個 <audio> element instance,只 swap src (不要 removeAttribute + load)
//   (b) 用 AbortController 取消上一輪的 canplay/loadeddata 監聽,避免 race
//   (c) document.hidden 時不直接 src swap,延遲到 visibilitychange 進 foreground
//       → 那時 user 已經「回到」app,iOS 給的 grace period 內可正常 play()
//
// [V2 9 分修法] iOS PWA 進背景時 <audio> 會被 auto-pause 的根因:
//   預設 HTMLAudioElement 拿到的 audio session category 是「ambient」,iOS 視為非必要背景音訊
//   修法: 在 user gesture 內把 audioSessionType 設為 'playback',iOS 就會把它當媒體類別,允許背景繼續播
//       注意: 'audioSessionType' 是非標準但 iOS 13+ Safari 支援的屬性,WebKit 私有 API
let _audioSessionLocked = false;
function lockAudioSessionForBackground() {
  if (_audioSessionLocked) return;
  if (!audioA) return; // 雙 Audio 池尚未建立
  try {
    // iOS WebKit: 把 (兩個) audio element 標記為媒體類別,iOS 才會在背景繼續播
    // audioSessionType 必須在 gesture 內設定,兩個都要設
    [audioA, audioB].forEach((a) => {
      try { if ('audioSessionType' in a) a.audioSessionType = 'playback'; } catch (e) {}
    });
    // 確保 MediaSession metadata 是非空,告訴 iOS 這是合法媒體
    if ('mediaSession' in navigator && !navigator.mediaSession.metadata) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: 'KTV 音樂模式',
        artist: '背景播放中',
        album: 'CouchMic'
      });
    }
    _audioSessionLocked = true;
    console.log('[bgAudio] audio session 已鎖為 playback (iOS 背景播放關鍵)');
  } catch (e) {
    console.warn('[bgAudio] 鎖 audio session 失敗:', e);
  }
}
// 第一次 user gesture (click / touchstart / keydown) 內鎖
['click', 'touchstart', 'keydown'].forEach((evt) => {
  window.addEventListener(evt, lockAudioSessionForBackground, { once: true, capture: true });
});

// [9 分修法] mediaSession action handler 走 activeAudio 變數 (保險絲切換自動生效)
if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => activeAudio.play().catch(() => {}));
  navigator.mediaSession.setActionHandler('pause', () => activeAudio.pause().catch(() => {}));
  navigator.mediaSession.setActionHandler('seekbackward', () => { activeAudio.currentTime = Math.max(0, activeAudio.currentTime - 10); });
  navigator.mediaSession.setActionHandler('seekforward', () => { activeAudio.currentTime = Math.min(activeAudio.duration || 0, activeAudio.currentTime + 10); });
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => console.log('[pwa] service worker 註冊成功 scope=', reg.scope)).catch((err) => console.warn('[pwa] service worker 註冊失敗:', err));
  });
}

window.addEventListener('DOMContentLoaded', () => {
  if (audioMode) {
    logAudioRuntime('audio-mode-startup', { reason: 'query-mode=audio' });
  } else {
    console.log('[bgAudio:lifecycle] startup (audio-mode 關閉)', audioRuntime());
  }
});

// [9 分修法] ended/error 必須綁在兩個 Audio 上,因為 active 可能切換
// handler 內判斷「事件源是不是當前 active」才處理
function _isCurrentActive(audioEl) { return audioEl === activeAudio; }

audioA.addEventListener('ended', () => {
  if (audioMode && _isCurrentActive(audioA)) {
    socket.emit('song_ended');
  }
});
audioB.addEventListener('ended', () => {
  if (audioMode && _isCurrentActive(audioB)) {
    socket.emit('song_ended');
  }
});

// 音樂模式「背景連續播放」防破壞:
//   - m4a 缺檔 / 404 / 不支援 codec → bgAudio error 但不會 fire ended
//   - 原本 user 卡在無聲狀態 (開車聽音樂最煩)
//   - 修法: error → 視為播完, 走下一首 + 顯示 toast 告知
let _bgAudioErrorEmitted = false;
function _showAudioErrorToast(msg) {
  let t = document.getElementById('bgAudioErrorToast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'bgAudioErrorToast';
    t.className = 'fixed top-20 left-1/2 -translate-x-1/2 z-50 panel rounded-xl px-4 py-2 text-sm text-yellow-200';
    t.style.pointerEvents = 'none';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(window.___bgAudioErrT);
  window.___bgAudioErrT = setTimeout(() => { t.style.display = 'none'; }, 3000);
}
// [9 分修法] error listener 綁兩個,helper 內判斷
function _handleAudioError(audioEl) {
  if (!audioMode) return;
  if (!_isCurrentActive(audioEl)) return; // 不是 active,忽略
  const src = audioEl.currentSrc || audioEl.src;
  console.error('[bgAudio] error → 自動跳下一首', { src, code: audioEl.error?.code });
  if (_bgAudioErrorEmitted) return;
  _bgAudioErrorEmitted = true;
  _showAudioErrorToast('音訊載入失敗 (缺檔或不支援),自動跳下一首');
  // 0.8s 後通知後端切歌 (給 user 一點時間看到 toast)
  setTimeout(() => {
    if (!_songEndedEmitted) {
      _songEndedEmitted = true;
      socket.emit('song_ended');
    }
  }, 800);
}
audioA.addEventListener('error', () => _handleAudioError(audioA));
audioB.addEventListener('error', () => _handleAudioError(audioB));

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

// [A+ 9.5 分修法] 延遲切歌用 state:
//   - _pendingBgAudioPlay:document.hidden 時存進去,等 visibilitychange 進 foreground 再執行
//   - _bgAudioLoadAbort:上一輪的 canplay/loadeddata 監聽,避免 race 雙觸發
let _pendingBgAudioPlay = null;
let _bgAudioLoadAbort = null;

// [9 分修法] playBgAudio v3 — 雙 Audio 池主流程
//   設計:
//     1. 切歌只在 active 上 swap src (iOS 對同 element src 變更最友善,保留 user gesture credit)
//     2. inactive 只 load() 不 play(),充當「保險絲」:當 active 真的壞掉時可立即接手
//     3. document.hidden 時:不 swap active (iOS 會拒絕),改設 inactive 預載,等回前台 swap
//     4. Web Audio 圖透過 bindAudioToGraph 切換 source (disconnect 舊 → connect 新)
//     5. 同 src 切換 (audioMode 原唱/伴奏) 走短路 resume,不重建 player
function playBgAudio(song) {
  if (!song) return;
  _bgAudioErrorEmitted = false; // 切歌 → 重置錯誤旗標
  const src = getAudioModeSrc(song, audioCurrentTrack);
  console.log('[bgAudio] playBgAudio 收到:', { title: song.title, src, audioCurrentTrack, audioMode, hidden: document.hidden });
  if (!src) {
    logAudioRuntime('fallback-video', { reason: 'missing-audio-src', songId: song.id, title: song.title });
    console.warn('[bgAudio] 此歌沒有預抽的 .m4a (audioOriginal/audioVocalOff),改用 video 繼續播 (鎖屏會停)');
    showAudioModeFallbackToast(song);
    if (socket && song.id && song.source === 'local') {
      socket.emit('request_audio_extract', { songId: song.id });
    }
    return;
  }
  const srcFile = src.split('/').pop();

  // === A) 同 src 短路 (audioMode 切原唱/伴奏時) ===
  if (activeAudio.src && activeAudio.src.endsWith(srcFile) && !activeAudio.paused) {
    console.log('[bgAudio] 同 src 已播,不動作');
    return;
  }

  // [B' 修法] 隱藏時:在 active 同一個 element 上 swap src + 同步 play()
  // 設計理由:
  //   - iOS 對「同一個 audio element 在 background 做 src swap + play()」是放行的 (session 已被首次 gesture 鎖)
  //   - iOS 對「在 background 對第二個 audio element 呼叫 play()」會丟 NotAllowedError (MediaSession 只能被一個 element 擁有)
  //   - 因此用 inactive 預載 + 接力 = 錯誤方向。正解是 active 一個元素走到底
  //   - inactiveAudio 改當「下一首 cache」:在前景 play 下一首前就 load() 進 inactive buffer
  //     (這在 foreground load,不受 background 限制);背景切歌時如果剛好 inactive 已 cache 目標,
  //     用 switchToInactiveIfReady() 加速 src swap (省一個 502 cycle)
  if (document.hidden) {
    console.log('[bgAudio] PWA 隱藏中,在 active 立即 swap src + play (iOS 對同 element bg swap 放行)');
    _pendingBgAudioPlay = null; // 不再延遲,立即執行

    // [B' 修法] 背景 → Web Audio graph bypass (聲音不再走 accGain/vocGain,確保有聲)
    bypassAudioGraph();

    // [E 方案] bg 進入瞬間:確保 active 100% buffered
    //   iOS bg 期間只允許「已 buffered」播完,因此進 bg 前若還在 streaming 必斷
    //   這裡呼叫 preloadFullTrack 同步等到 canplaythrough 才走下一步 play()
    //   注:JS 在 bg 後不會凍結,但 setTimeout/Promise 都還會跑 (直到 system suspend)
    //   所以同步等 canplaythrough 在 bg 仍可執行幾秒,iOS 給的 grace window 約 5-10s

    // 取消上一輪 listener
    if (_bgAudioLoadAbort) _bgAudioLoadAbort.abort();
    _bgAudioLoadAbort = new AbortController();
    const signal = _bgAudioLoadAbort.signal;

    // 確保 active 仍在 graph 上
    bindAudioToGraph(activeAudio);

    // 同一 element 上:pause → 清 src → 設新 src → load → play
    // iOS 的「src 從空變有」保證執行
    try { activeAudio.pause(); } catch (e) {}
    try {
      activeAudio.removeAttribute('src');
      try { activeAudio.load(); } catch (_) {}
    } catch (e) {}
    activeAudio.src = src;
    activeAudio.loop = false;
    updateMediaSession(song);

    // 同步 play() — 必須跟設 src 在同一 tick (iOS 對 background 的 play 還在已鎖 session 範圍內)
    activeAudio.play().then(() => {
      console.log('[bgAudio] 背景 swap 同步 play() 成功, currentTime=', activeAudio.currentTime);
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
      logAudioRuntime('playback-started-bg', { currentTime: activeAudio.currentTime });
    }).catch((err) => {
      console.warn('[bgAudio] 背景同步 play 失敗:', err.name, err.message);
      // fallback: 等 visibilitychange 回前台再 play
      _pendingBgAudioPlay = { song, src, srcFile };
    });

    // 預載 inactive 為下一首 (silent,不會被 iOS 拒絕,因為 inactive 不 play())
    try {
      inactiveAudio.removeAttribute('src');
      try { inactiveAudio.load(); } catch (_) {}
    } catch (e) {}
    logAudioRuntime('playBgAudio-bg-swap', { src, audioCurrentTrack, audioMode });
    return;
  }

  // === C) 前景切歌:在 active 上 swap src + 同步 play() ===
  // [A+ 修法 (b)] 取消上一輪的 listener,避免 race
  if (_bgAudioLoadAbort) _bgAudioLoadAbort.abort();
  _bgAudioLoadAbort = new AbortController();
  const signal = _bgAudioLoadAbort.signal;

  // 確保 active 仍在 graph 上 (保險絲切換後需重新綁)
  bindAudioToGraph(activeAudio);

  // 同 src 但 paused → resume
  if (activeAudio.src && activeAudio.src.endsWith(srcFile)) {
    console.log('[bgAudio] 同 src,只 resume');
    if (activeAudio.paused) {
      activeAudio.play().then(() => {
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
      }).catch((e) => console.warn('[bgAudio] resume 失敗:', e));
    }
    updateMediaSession(song);
    logAudioRuntime('playBgAudio-resumed', { src, audioCurrentTrack, audioMode });
    return;
  }

  // 真正 swap src + play (B 方案:同 element 直接 swap,不走 inactive 接力)
  // iOS 對「同 element 設 src + 立即 play」放行,且不會 NotAllowedError
  // pause → 清空 src → 設新 src → load → play() 全部同 tick
  try { activeAudio.pause(); } catch (e) {}
  try {
    activeAudio.removeAttribute('src');
    try { activeAudio.load(); } catch (_) {}
  } catch (e) {}
  activeAudio.src = src;
  activeAudio.loop = false;

  // 預載 inactive 為下一首 cache (load() 不用 user gesture,前景時 iOS 一定會跑)
  try {
    inactiveAudio.removeAttribute('src');
    try { inactiveAudio.load(); } catch (_) {}
  } catch (e) {}
  inactiveAudio.preload = 'auto';

  // [E 方案] 預緩衝 active + 下一首:
  //   - active:等 canplaythrough 確保 100% buffered (背景不會被切)
  //   - inactive:同時預載下一首 (若有 playlist 知道下一首)
  //   - 不 await 整個,避免首播延遲:丟背景跑,console 可觀察
  preloadFullTrack(activeAudio, src, 30000).then((ok) => {
    if (ok) console.log('[bgAudio] active 100% buffered 完成,bg 期間可完整播完');
    else console.warn('[bgAudio] active 未達 100% buffered,bg 期間可能在末端中斷');
  });

  // 預載下一首進 inactive (使用 socket 推播的 nextSong 全域變數)
  if (typeof nextSong !== 'undefined' && nextSong) {
    const nextSrc = getAudioModeSrc(nextSong, audioCurrentTrack);
    if (nextSrc) {
      bindAudioToGraph(inactiveAudio); // 確保 inactive 也在 graph 上 (Safari lazy load 條件)
      preloadFullTrack(inactiveAudio, nextSrc, 30000).then((ok) => {
        console.log('[bgAudio] 下一首預載:', ok ? 'OK' : 'PARTIAL', nextSong.title);
      });
    }
  }

  // [重點修法] 必須在設 src 的同一個 tick 內同步呼叫 play()
  // 否則 iOS 會因為 src 改變導致 paused = true,背景會失去 session lock
  let started = true;
  updateMediaSession(song);
  activeAudio.play().then(() => {
    console.log('[bgAudio] 同步 play() 成功');
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    logAudioRuntime('playback-started', { currentTime: activeAudio.currentTime });
  }).catch((err) => {
    console.warn('[bgAudio] 同步 play 失敗,交由事件觸發:', err);
    started = false;
  });

  const tryStart = (why) => {
    if (signal.aborted) return;
    if (started) return;
    started = true;
    console.log('[bgAudio] tryStart 因為', why);
    activeAudio.currentTime = 0;
    updateMediaSession(song);
    activeAudio.play().then(() => {
      console.log('[bgAudio] 事件 play() 成功, paused=', activeAudio.paused, 'currentTime=', activeAudio.currentTime);
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
      logAudioRuntime('playback-started', { currentTime: activeAudio.currentTime });
    }).catch((err) => {
      console.warn('[bgAudio] play 失敗:', err.name, err.message, '— 若是 NotAllowedError 等下次 visibilitychange');
      _pendingBgAudioPlay = { song, src, srcFile };
    });
  };
  activeAudio.addEventListener('canplay', () => tryStart('canplay'), { once: true, signal });
  activeAudio.addEventListener('loadeddata', () => tryStart('loadeddata'), { once: true, signal });
  // cached m4a 不會觸發 canplay → 1.5s 後主動試
  setTimeout(() => tryStart('1500ms-timeout'), 1500);
  logAudioRuntime('playBgAudio-queued', { src, audioCurrentTrack, audioMode });
}

// [9 分修法] 保險絲切換:把 active 換到 inactive (inactive 需已預載好 src)
// 前提:inactiveAudio.src 已經是目標 .m4a 且 readyState >= 2
function switchToInactiveIfReady() {
  if (inactiveAudio === activeAudio) return false;
  if (!inactiveAudio.src || inactiveAudio.readyState < 2) return false;
  // 1. 中止舊 active 的播放
  try { activeAudio.pause(); } catch (e) {}
  // 2. 重新綁 Web Audio graph 到 inactive
  bindAudioToGraph(inactiveAudio);
  // 3. 對調兩個變數的角色
  const old = activeAudio;
  activeAudio = inactiveAudio;
  inactiveAudio = old;
  return true;
}

function stopBgAudio() {
  // 切回 TV mode 或 user 主動暫停時呼叫 — 真的要釋放雙 Audio
  try {
    try { audioA.pause(); } catch (e) {}
    try { audioB.pause(); } catch (e) {}
    try { audioA.removeAttribute('src'); audioA.load(); } catch (e) {}
    try { audioB.removeAttribute('src'); audioB.load(); } catch (e) {}
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';
  } catch (e) {}
}

// [E 方案 9.5/10] 預緩衝整首歌到 audio element
// 設計理由:
//   - iOS 進 background 後只允許「已經 buffered 的部分」播完,然後暫停
//   - .m4a 若只 buffer 30 秒,3 分鐘的歌會在 bg 30 秒處斷 → "網路連線中斷" 報錯
//   - 解法:前景時主動把整首拉到 100% buffered (canplaythrough),
//     bg 期間 iOS 就不會主動斷 streaming (因為沒有「還沒拉到的部分」要繼續抓)
//   - 切歌前預載下一首同理,避免切歌空窗期被 iOS 凍結
//   - 注:active element 必須已經被 bound 到 Web Audio graph 才能正常 preload,
//     不然 preload 不會跑 (Safari 對 unbound <audio> 會 lazy load)
async function preloadFullTrack(audioEl, src, timeoutMs = 30000) {
  if (!audioEl || !src) return false;
  // 已經 100% buffered → noop
  try {
    const dur = audioEl.duration;
    if (dur > 0 && audioEl.buffered.length > 0) {
      const end = audioEl.buffered.end(audioEl.buffered.length - 1);
      if (end >= dur - 0.5) {
        console.log('[preload] 已經 100% buffered:', src.split('/').pop());
        return true;
      }
    }
  } catch (e) { /* duration 還 NaN,繼續 */ }

  return new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      audioEl.removeEventListener('canplaythrough', onCanPlayThrough);
      audioEl.removeEventListener('error', onError);
      audioEl.removeEventListener('stalled', onStalled);
      clearTimeout(timeoutId);
    };
    const onCanPlayThrough = () => {
      if (settled) return;
      settled = true;
      cleanup();
      console.log('[preload] canplaythrough 達到 100%:', src.split('/').pop());
      resolve(true);
    };
    const onError = (e) => {
      if (settled) return;
      settled = true;
      cleanup();
      console.warn('[preload] error:', audioEl.error?.code, src.split('/').pop());
      resolve(false);
    };
    const onStalled = () => {
      // Safari 在 partial buffered 時會 stall,主動 reload 一次
      console.log('[preload] stalled,重新 load()');
      try { audioEl.load(); } catch (_) {}
    };
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      console.warn('[preload] timeout (', timeoutMs, 'ms),可能 partial buffered:', src.split('/').pop());
      resolve(false);
    }, timeoutMs);

    audioEl.addEventListener('canplaythrough', onCanPlayThrough, { once: true });
    audioEl.addEventListener('error', onError, { once: true });
    audioEl.addEventListener('stalled', onStalled);

    // 確保 src 已設 + load
    if (!audioEl.src || !audioEl.src.endsWith(src.split('/').pop())) {
      try { audioEl.pause(); } catch (_) {}
      audioEl.src = src;
      audioEl.preload = 'auto';
      audioEl.loop = false;
      try { audioEl.load(); } catch (_) {}
    }
  });
}

// audio-mode 沒有預抽 m4a 時,顯示 toast 提醒 user
// (video 元素會繼續播,但 iOS PWA 鎖屏會停 — 後續可以排 pipeline 補抽)
let _audioModeFallbackToastTimer = null;
function showAudioModeFallbackToast(song) {
  showToast(`「${song.title || '此歌'}」尚未預抽背景音訊，鎖屏後會停止播放`, 'warning');
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

  // 右上角「退出」常駐按鈕:同時退出 immersive + audio-mode (任一模式下皆可見)
  const exitImmersiveBtn = document.getElementById('exitImmersiveBtn');
  if (exitImmersiveBtn) {
    exitImmersiveBtn.addEventListener('click', () => {
      let anyExit = false;
      if (typeof immersive !== 'undefined' && immersive) {
        exitImmersive();
        updateImmersiveBtnUI();
        anyExit = true;
      }
      if (typeof audioMode !== 'undefined' && audioMode) {
        setAudioMode(false);
        anyExit = true;
      }
      // 同步退出瀏覽器原生 fullscreen (若還在)
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        if (document.exitFullscreen) document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      }
      console.log('[exitImmersiveBtn] 點擊 (已退:', anyExit, ')');
    });
  }

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
  // ===== 待機畫面浮動音符粒子 =====
  (function initAmbientParticles() {
    const container = document.getElementById('ambientParticles');
    if (!container) return;
    const notes = ['♪', '♫', '♬', '🎵', '🎶'];
    const COUNT = 14;
    for (let i = 0; i < COUNT; i++) {
      const el = document.createElement('div');
      el.className = 'ambient-note';
      el.textContent = notes[Math.floor(Math.random() * notes.length)];
      el.style.left = `${Math.random() * 100}%`;
      el.style.fontSize = `${0.8 + Math.random() * 0.8}rem`;
      el.style.color = Math.random() > 0.5
        ? 'rgba(236, 72, 153, 0.12)'
        : 'rgba(139, 92, 246, 0.10)';
      el.style.animationDuration = `${8 + Math.random() * 10}s`;
      el.style.animationDelay = `${-Math.random() * 18}s`;
      container.appendChild(el);
    }
  })();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch((err) => {
        console.warn('[PWA] SW 註冊失敗:', err);
      });
    });
  }
})();
