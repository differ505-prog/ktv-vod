/**
 * KTV 手機端 (The Controller)
 * 職責：
 *  - 取得並快取歌曲庫
 *  - 發送控制指令 (add_song / skip_song / toggle_vocal) 給後端
 *  - 渲染當前播放、待播佇列，提供即時狀態
 *  - 加歌 UI：貼 YouTube URL → 追蹤 pipeline job 進度
 */

(() => {
  'use strict';

  // ===== 元素 =====
  const connLabel = document.getElementById('connLabel');
  const npTitle = document.getElementById('npTitle');
  const npArtist = document.getElementById('npArtist');
  const npCover = document.getElementById('npCover');
  const npMode = document.getElementById('npMode');
  const npQueue = document.getElementById('npQueue');
  const btnSkip = document.getElementById('btnSkip');
  const btnVocal = document.getElementById('btnVocal');
  const btnImmersive = document.getElementById('btnImmersive');
  const btnShowQr = document.getElementById('btnShowQr');
  const btnHost = document.getElementById('btnHost');
  const hostIcon = document.getElementById('hostIcon');
  const hostLabel = document.getElementById('hostLabel');
  const immersiveLabel = document.getElementById('immersiveLabel');
  const immersiveIcon = document.getElementById('immersiveIcon');
  const vocalLabel = document.getElementById('vocalLabel');
  const vocalIcon = document.getElementById('vocalIcon');
  const songList = document.getElementById('songList');
  const queueList = document.getElementById('queueList');
  const queueEmpty = document.getElementById('queueEmpty');
  const searchInput = document.getElementById('searchInput');
  const toast = document.getElementById('toast');
  const toastText = document.getElementById('toastText');
  const btnAddSong = document.getElementById('btnAddSong');
  const addSongModal = document.getElementById('addSongModal');
  const addSongForm = document.getElementById('addSongForm');
  const inputUrl = document.getElementById('inputUrl');
  const inputTitle = document.getElementById('inputTitle');
  const inputArtist = document.getElementById('inputArtist');
  const btnSubmitSong = document.getElementById('btnSubmitSong');
  const jobsPanel = document.getElementById('jobsPanel');
  const jobsList = document.getElementById('jobsList');
  const jobsCount = document.getElementById('jobsCount');
  const jobsRefresh = document.getElementById('jobsRefresh');
  // 主揪模式 + 刪除相關 modal
  const hostModal = document.getElementById('hostModal');
  const hostPinInput = document.getElementById('hostPinInput');
  const hostConfirm = document.getElementById('hostConfirm');
  const deleteModal = document.getElementById('deleteModal');
  const deleteSongTitle = document.getElementById('deleteSongTitle');
  const deleteConfirm = document.getElementById('deleteConfirm');
  const trashModal = document.getElementById('trashModal');
  const trashList = document.getElementById('trashList');

  // ===== 狀態 =====
  let songs = [];       // 歌曲庫
  let playlist = [];    // 待播佇列
  let currentSong = null;
  let audioMode = 'original';
  let immersiveMode = false;

  // 主揪模式 (Host Mode):
  //   - 解鎖後,手機端可以顯示「永久刪除」「垃圾桶入口」等危險操作。
  //   - PIN 不存 localStorage,只存「已登入的 session」boolean (每次打開頁面都要重打)。
  //   - 真正的 PIN 由伺服器驗證,前端只是 UX。
  let hostModeUnlocked = false;
  let pendingDeleteSongId = null; // 正在 confirm 的 song id

  // 加歌任務追蹤: jobId → { url, title, artist, status, percent, detail, error }
  const jobs = new Map();

  // ===== 抓取歌曲庫 =====
  async function fetchSongs() {
    try {
      const res = await fetch('/api/songs');
      const data = await res.json();
      if (data.success) {
        songs = data.songs;
        renderSongs();
      }
    } catch (e) {
      console.error('抓取歌曲庫失敗：', e);
    }
  }

  // ===== Toast =====
  function showToast(msg, kind = 'success') {
    toastText.textContent = msg;
    toast.classList.remove('hidden');
    toast.innerHTML = '';
    const iconClass = kind === 'success' ? 'fa-circle-check text-green-400'
      : kind === 'error' ? 'fa-circle-exclamation text-red-400'
      : 'fa-circle-info text-cyan-400';
    toast.innerHTML = `<i class="fa-solid ${iconClass}"></i> <span>${msg}</span>`;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.add('hidden'), 1800);
  }

  // ===== Socket.io =====
  const socket = io({ reconnection: true });

  socket.on('connect', () => {
    connLabel.innerHTML = '<i class="fa-solid fa-circle text-green-500 text-[8px]"></i> 已連線';
    // 重新連線時向後端要一次最新狀態
    socket.emit('request_playlist');
  });

  socket.on('disconnect', () => {
    connLabel.innerHTML = '<i class="fa-solid fa-circle text-red-500 text-[8px]"></i> 連線中斷';
  });

  socket.on('sync_state', (state) => {
    currentSong = state.currentSong;
    playlist = state.playlist || [];
    audioMode = state.audioMode || 'original';
    renderAll();
  });

  socket.on('playlist_updated', (data) => {
    playlist = data.playlist || [];
    if (data.currentSong !== undefined) currentSong = data.currentSong;
    renderQueue();
    renderNowPlaying();
  });

  socket.on('play_song', ({ currentSong: cs }) => {
    if (cs) {
      currentSong = cs;
      renderNowPlaying();
    }
  });

  socket.on('change_audio_mode', ({ audioMode: m }) => {
    audioMode = m;
    renderVocalButton();
    renderNowPlaying();
  });

  // TV 沉浸模式狀態回報 (由 tv 端在 fullscreenchange 時同步發出)
  // 用途：tv user 按 ESC 退出瀏覽器 fullscreen 時,手機按鈕狀態也要更新
  socket.on('immersive_state', ({ immersive }) => {
    immersiveMode = !!immersive;
    renderImmersiveButton();
  });

  socket.on('error_message', ({ message }) => {
    showToast(message || '發生錯誤', 'error');
  });

  socket.on('library_updated', ({ songs: newSongs }) => {
    if (Array.isArray(newSongs)) {
      songs = newSongs;
      renderSongs();
      showToast('🎵 歌庫已更新', 'success');
    }
  });

  // ===== 控制指令 =====
  function pickSong(songId) {
    socket.emit('add_song', songId);
    showToast('已加入點歌列隊！');
  }

  btnSkip.addEventListener('click', () => {
    if (!currentSong && playlist.length === 0) {
      showToast('目前沒有歌曲可切', 'info');
      return;
    }
    socket.emit('skip_song');
    showToast('已送出切歌指令');
  });

  btnVocal.addEventListener('click', () => {
    socket.emit('toggle_vocal');
  });

  // ===== 沉浸模式切換 =====
  // 注意：server.js 用 io.emit(...) 廣播,tv 端會自己收 'toggle_immersive'。
  // 此處只發指令 + 自己同步狀態 (避免 tv 端回報延遲,本地按鈕立刻反映)
  btnImmersive.addEventListener('click', () => {
    immersiveMode = !immersiveMode;
    socket.emit('toggle_immersive', { immersive: immersiveMode });
    renderImmersiveButton();
  });

  // ===== 邀請朋友 (顯示 QR 15 秒) =====
  // 新朋友剛進包廂時,主揪按一下 → 電視上的 QR 浮現 15 秒,讓朋友掃
  btnShowQr.addEventListener('click', () => {
    socket.emit('show_qr', { durationMs: 15000 });
    showToast('📺 TV 已顯示 QR Code 15 秒', 'info');
  });

  // ===== 主揪模式 (Host Mode) — 三層防護的第 2 層 =====
  // - 按鈕常駐顯示 (低調)
  // - 解鎖後,UI 進入「已登入」狀態 (icon 變綠勾),垃圾桶入口浮現,佇列卡長按 → 永久刪除入口
  // - lock 后,UI 回到「未登入」狀態
  function renderHostUI() {
    if (hostModeUnlocked) {
      hostIcon.className = 'fa-solid fa-lock-open text-green-400 text-[10px]';
      hostLabel.textContent = '主揪模式已啟用 · 點擊鎖回';
      btnHost.classList.add('border', 'border-green-500/30');
      // 把垃圾桶入口塞進待播佇列 tab 旁 (用 footer button 的方式)
      ensureTrashButton();
    } else {
      hostIcon.className = 'fa-solid fa-lock text-[10px]';
      hostLabel.textContent = '主揪模式 (點擊解鎖)';
      btnHost.classList.remove('border', 'border-green-500/30');
      removeTrashButton();
    }
  }

  let trashButtonEl = null;
  function ensureTrashButton() {
    if (trashButtonEl) return;
    trashButtonEl = document.createElement('button');
    trashButtonEl.id = 'btnTrash';
    trashButtonEl.className = 'mt-2 w-full glass rounded-xl px-4 py-2 text-xs text-amber-300 hover:text-amber-100 hover:bg-amber-500/10 transition flex items-center justify-center gap-2';
    trashButtonEl.innerHTML = '<i class="fa-solid fa-trash-can"></i> <span>查看垃圾桶</span>';
    trashButtonEl.addEventListener('click', openTrashModal);
    btnHost.parentElement.appendChild(trashButtonEl);
  }
  function removeTrashButton() {
    if (trashButtonEl) {
      trashButtonEl.remove();
      trashButtonEl = null;
    }
  }

  btnHost.addEventListener('click', () => {
    if (hostModeUnlocked) {
      // 已解鎖 → 點擊 = 鎖回去
      hostModeUnlocked = false;
      renderHostUI();
      showToast('🔒 主揪模式已鎖回', 'info');
    } else {
      // 未解鎖 → 顯示 PIN 輸入
      hostModal.classList.remove('hidden');
      setTimeout(() => hostPinInput.focus(), 150);
      hostPinInput.value = '';
    }
  });
  document.querySelectorAll('[data-close-host]').forEach((el) => {
    el.addEventListener('click', () => hostModal.classList.add('hidden'));
  });
  hostPinInput.addEventListener('input', () => {
    // 自動 submit on 4 digits
    if (hostPinInput.value.length === 4) hostConfirm.click();
  });
  hostConfirm.addEventListener('click', () => {
    const pin = hostPinInput.value.trim();
    if (!/^\d{4}$/.test(pin)) {
      showToast('請輸入 4 位數字', 'error');
      return;
    }
    // 把 PIN 送 server 驗證 (不用先做完所有事才驗)
    fetch('/api/songs/host-verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostPin: pin }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.success) {
          hostModeUnlocked = true;
          hostModal.classList.add('hidden');
          renderHostUI();
          showToast('🔓 主揪模式已啟用', 'success');
        } else {
          showToast('密碼錯誤', 'error');
          hostPinInput.value = '';
          hostPinInput.focus();
        }
      })
      .catch((err) => {
        showToast(`驗證失敗：${err.message}`, 'error');
      });
  });

  // ===== 永久刪除確認 (主揪模式限定) =====
  document.querySelectorAll('[data-close-delete]').forEach((el) => {
    el.addEventListener('click', () => {
      deleteModal.classList.add('hidden');
      pendingDeleteSongId = null;
    });
  });
  deleteConfirm.addEventListener('click', async () => {
    if (!pendingDeleteSongId || !hostModeUnlocked) return;
    const songId = pendingDeleteSongId;
    const pin = prompt('再輸入一次主揪密碼確認'); // 二次密碼確認
    // 上面 prompt 對 mobile UX 不友善,但在二次確認 modal 裡是合理的
    // 實務上更佳是用第二顆輸入 — 為簡化沿用瀏覽器內建 prompt,
    // 若被 user 取消 → do nothing
    if (pin === null) return;
    deleteConfirm.disabled = true;
    deleteConfirm.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 搬移中...';
    try {
      const res = await fetch('/api/songs/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ songId, hostPin: pin }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || '刪除失敗');
      showToast(`🗑️ 已移到垃圾桶: ${data.moved?.join(', ') || ''}`, 'success');
      deleteModal.classList.add('hidden');
      pendingDeleteSongId = null;
      // 廣播 library_updated 由 server 處理,前端會透過 socket 自動收到
    } catch (err) {
      showToast(`❌ ${err.message}`, 'error');
    } finally {
      deleteConfirm.disabled = false;
      deleteConfirm.innerHTML = '<i class="fa-solid fa-trash"></i> 刪除';
    }
  });

  // ===== 垃圾桶檢視 / 復原 =====
  document.querySelectorAll('[data-close-trash]').forEach((el) => {
    el.addEventListener('click', () => trashModal.classList.add('hidden'));
  });
  async function openTrashModal() {
    trashModal.classList.remove('hidden');
    trashList.innerHTML = '<div class="text-center text-gray-500 text-sm py-6">載入中...</div>';
    try {
      const res = await fetch('/api/songs/trash');
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      renderTrash(data.items);
    } catch (err) {
      trashList.innerHTML = `<div class="text-center text-red-400 text-sm py-6">載入失敗：${err.message}</div>`;
    }
  }
  function renderTrash(items) {
    if (!items || items.length === 0) {
      trashList.innerHTML = '<div class="text-center text-gray-500 text-sm py-6"><i class="fa-solid fa-trash text-2xl mb-2 block"></i>垃圾桶是空的 🎉</div>';
      return;
    }
    trashList.innerHTML = '';
    items.forEach((it) => {
      const li = document.createElement('div');
      li.className = 'glass rounded-xl p-3 flex items-center gap-3';
      const sizeStr = it.sizeBytes > 1024 * 1024
        ? `${(it.sizeBytes / 1024 / 1024).toFixed(1)} MB`
        : `${(it.sizeBytes / 1024).toFixed(1)} KB`;
      const dt = new Date(it.mtime);
      const dtStr = `${dt.getMonth() + 1}/${dt.getDate()} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
      li.innerHTML = `
        <div class="flex-1 min-w-0">
          <div class="text-sm font-medium truncate">${escapeHtml(it.fileName)}</div>
          <div class="text-[10px] text-gray-500 mt-0.5">${dtStr} · ${sizeStr}</div>
        </div>
        <button class="restore-btn px-3 py-1.5 rounded-lg bg-emerald-500/20 text-emerald-300 text-xs font-bold flex items-center gap-1 flex-shrink-0">
          <i class="fa-solid fa-rotate-left"></i> 復原
        </button>
      `;
      li.querySelector('.restore-btn').addEventListener('click', async () => {
        const pin = prompt('輸入主揪密碼復原');
        if (pin === null) return;
        li.querySelector('.restore-btn').disabled = true;
        li.querySelector('.restore-btn').innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
        try {
          const res = await fetch('/api/songs/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fileName: it.fileName, hostPin: pin }),
          });
          const data = await res.json();
          if (!data.success) throw new Error(data.error || '復原失敗');
          showToast(`✅ 已復原: ${it.fileName}`, 'success');
          // server 會自動 rebuildLibrary,前端透過 socket 收到 library_updated
          // 我們也手動 close + 重 fetch:
          openTrashModal();
        } catch (err) {
          showToast(`❌ ${err.message}`, 'error');
          li.querySelector('.restore-btn').disabled = false;
          li.querySelector('.restore-btn').innerHTML = '<i class="fa-solid fa-rotate-left"></i> 復原';
        }
      });
      trashList.appendChild(li);
    });
  }

  function renderImmersiveButton() {
    if (immersiveMode) {
      immersiveLabel.textContent = 'TV 退出全螢幕';
      immersiveIcon.className = 'fa-solid fa-compress text-xl';
    } else {
      immersiveLabel.textContent = 'TV 全螢幕';
      immersiveIcon.className = 'fa-solid fa-expand text-xl';
    }
  }

  // ===== 渲染 =====
  function renderAll() {
    renderNowPlaying();
    renderQueue();
    renderVocalButton();
  }

  function renderVocalButton() {
    if (audioMode === 'vocal_off') {
      vocalLabel.textContent = '伴奏中';
      vocalIcon.className = 'fa-solid fa-guitar text-xl';
    } else {
      vocalLabel.textContent = '原唱';
      vocalIcon.className = 'fa-solid fa-microphone-lines text-xl';
    }
  }

function renderNowPlaying() {
  if (!currentSong) {
    npTitle.textContent = '等待點歌...';
    npArtist.textContent = '掃描電視 QR 或點下方歌曲加入點歌列隊';
    npCover.classList.add('opacity-0');
    npQueue.innerHTML = '<i class="fa-solid fa-list-ol"></i> 佇列 0 首';
    return;
  }

  // 主標題 (歌名)
  npTitle.textContent = currentSong.title || '—';

  // 副標題: 歌手 + 專輯 + 時長
  const parts = [];
  if (currentSong.artist) parts.push(currentSong.artist);
  if (currentSong.album) parts.push(currentSong.album);
  if (currentSong.duration) parts.push(currentSong.duration);
  npArtist.textContent = parts.length > 0 ? parts.join(' · ') : '—';

  // 封面 (oEmbed thumbnail)
  if (currentSong.cover) {
    npCover.src = currentSong.cover;
    npCover.onload = () => npCover.classList.remove('opacity-0');
    npCover.onerror = () => npCover.classList.add('opacity-0');
  } else {
    npCover.removeAttribute('src');
    npCover.classList.add('opacity-0');
  }

  npQueue.innerHTML = `<i class="fa-solid fa-list-ol"></i> 佇列 ${playlist.length} 首`;

  if (audioMode === 'vocal_off') {
    npMode.innerHTML = '<i class="fa-solid fa-guitar"></i> 伴奏';
    npMode.className = 'px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300';
  } else {
    npMode.innerHTML = '<i class="fa-solid fa-microphone"></i> 原唱';
    npMode.className = 'px-2 py-0.5 rounded-full bg-pink-500/20 text-pink-300';
  }
}

/**
 * 兩行卡片 (方案 B — 9.5/10):
 *   ┌─────────────────────────────────────┐
 *   │ 🎵  夜曲                  [+ 點歌]  │
 *   │     周杰倫 · 十一月的蕭邦 · 4:32    │
 *   └─────────────────────────────────────┘
 */
function renderSongCard(song, opts = {}) {
  const { action = 'pick', index = null } = opts;
  const li = document.createElement('button');
  li.className = 'w-full glass rounded-xl p-3 flex items-center gap-3 song-card text-left';
  li.dataset.songId = song.id;

  const durationStr = song.duration ? ` · ${escapeHtml(song.duration)}` : '';
  const albumStr = song.album ? ` · ${escapeHtml(song.album)}` : '';
  const artistLine = `${escapeHtml(song.artist || '未知歌手')}${albumStr}${durationStr}`;
  const titleLine = escapeHtml(song.title || '未知歌曲');

  // 封面 (oEmbed thumbnail, 失敗會 fallback 為音符 icon)
  const coverHtml = song.cover
    ? `<img src="${escapeHtml(song.cover)}" class="w-full h-full object-cover" loading="lazy" onerror="this.style.display='none';this.parentElement.innerHTML='<i class=\\'fa-solid fa-music\\'></i>'" />`
    : '<i class="fa-solid fa-music"></i>';

  const indexHtml = index !== null
    ? `<div class="w-8 text-center text-pink-400 font-bold text-sm flex-shrink-0">${index + 1}</div>`
    : '';

  const actionHtml = action === 'queue'
    ? `<div class="text-[10px] text-gray-500"><i class="fa-solid fa-user"></i> ${escapeHtml(song.addedBy || '匿名')}</div>`
    : `<div class="cyan-btn rounded-lg px-3 py-1.5 text-xs font-bold flex items-center gap-1 flex-shrink-0">
         <i class="fa-solid fa-plus"></i> 點歌
       </div>`;

  li.innerHTML = `
    ${indexHtml}
    <div class="w-12 h-12 rounded-lg overflow-hidden bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center flex-shrink-0">
      ${coverHtml}
    </div>
    <div class="flex-1 min-w-0 overflow-hidden">
      <div class="font-medium text-sm leading-tight line-clamp-2 break-words" title="${titleLine}">${titleLine}</div>
      <div class="text-xs text-gray-400 truncate mt-0.5" title="${artistLine}">${artistLine}</div>
    </div>
    ${actionHtml}
  `;

  if (action === 'queue') {
    // 佇列卡不能點
    li.disabled = false;
    li.classList.remove('cursor-pointer');
  }

  return li;
}

/**
 * 三層防護的 UI 端實作 — 第 1 層動作分離:
 *
 * renderQueue 渲染每張佇列卡時,綁定兩種互動:
 *   (a) 左滑超過 80px (touch/pointer move) → 滑出刪除「從佇列移除」按鈕
 *       → release 後按 DELETE 觸發 /api/songs/remove-from-queue
 *   (b) 長按 600ms → (主揪模式已啟用) 彈「永久刪除」confirm modal
 *
 * 兩個動作是分離的:
 *   左滑  → 只是把這首「不唱了」,檔案還在 NAS / Song Library
 *   長按  → 主揪決定要把檔案從 NAS 永久踢出去 (其實也只是移到 _Trash)
 *
 * 沒解鎖主揪模式時,長按不做事 (只震動一下提示「需主揪模式」)。
 */
function renderQueue() {
  queueList.innerHTML = '';
  if (playlist.length === 0) {
    queueEmpty.classList.remove('hidden');
    return;
  }
  queueEmpty.classList.add('hidden');
  playlist.forEach((song, idx) => {
    const li = renderSongCard(song, { action: 'queue', index: idx });
    attachQueueCardGestures(li, song, idx);
    queueList.appendChild(li);
  });
}

/**
 * 給佇列卡綁定兩種互動:
 * - 左滑 → 顯示「移除佇列」按鈕 (release 觸發)
 * - 長按 → 永久刪除入口 (主揪模式限定)
 */
function attachQueueCardGestures(li, song, idx) {
  // ---- 左滑 (touch/pointer) ----
  let startX = 0;
  let dx = 0;
  let sliding = false;
  const SLIDE_REVEAL_PX = 80;
  const SLIDE_DELETE_PX = 140;

  const onDown = (e) => {
    if (e.target.closest('button')) return; // 放過按鈕
    const t = e.touches ? e.touches[0] : e;
    startX = t.clientX;
    dx = 0;
    sliding = true;
    li.style.transition = 'none';
  };
  const onMove = (e) => {
    if (!sliding) return;
    const t = e.touches ? e.touches[0] : e;
    dx = t.clientX - startX;
    // 只接受左滑 (dx < 0),且不超過 -160
    const clamped = Math.max(-160, Math.min(0, dx));
    li.style.transform = `translateX(${clamped}px)`;
  };
  const onUp = () => {
    if (!sliding) return;
    sliding = false;
    li.style.transition = 'transform 0.2s ease';
    if (dx <= -SLIDE_DELETE_PX) {
      // 滑到底 → 直接刪
      li.style.transform = 'translateX(-100%)';
      setTimeout(() => removeFromQueue(idx, song), 180);
    } else if (dx <= -SLIDE_REVEAL_PX) {
      // 露出刪除按鈕
      li.style.transform = 'translateX(-80px)';
    } else {
      // 沒過門檻,彈回
      li.style.transform = 'translateX(0)';
      dx = 0;
    }
  };

  li.addEventListener('touchstart', onDown, { passive: true });
  li.addEventListener('touchmove', onMove, { passive: true });
  li.addEventListener('touchend', onUp);
  li.addEventListener('mousedown', onDown);
  li.addEventListener('mousemove', onMove);
  li.addEventListener('mouseup', onUp);
  li.addEventListener('mouseleave', onUp);

  // ---- 長按 (永久刪除入口) ----
  let pressTimer = null;
  let longPressed = false;
  const startPress = () => {
    longPressed = false;
    pressTimer = setTimeout(() => {
      longPressed = true;
      // 視覺提示
      if ('vibrate' in navigator) navigator.vibrate(40);
      // 主揪模式沒解鎖 → 提示但不彈 modal (防誤觸 + UX 友善)
      if (!hostModeUnlocked) {
        showToast('🔒 需主揪模式解鎖才能永久刪除', 'info');
        return;
      }
      // 主揪模式已解鎖 → 永久刪除 confirm
      openDeleteConfirmModal(song);
    }, 600);
  };
  const cancelPress = () => {
    if (pressTimer) clearTimeout(pressTimer);
    pressTimer = null;
    // 若已經觸發 long press → 阻擋 click 事件
    if (longPressed) {
      li.addEventListener('click', (e) => e.stopPropagation(), { once: true });
    }
  };
  li.addEventListener('touchstart', startPress);
  li.addEventListener('touchend', cancelPress);
  li.addEventListener('touchcancel', cancelPress);
  li.addEventListener('mousedown', startPress);
  li.addEventListener('mouseup', cancelPress);
  li.addEventListener('mouseleave', cancelPress);
}

async function removeFromQueue(position, song) {
  try {
    const res = await fetch('/api/songs/remove-from-queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || '移除失敗');
    showToast(`已從佇列移除: ${data.removed?.title || song.title}`, 'success');
    // playlist_updated 由 server 廣播,前端會自己收到 → renderQueue
  } catch (err) {
    showToast(`❌ ${err.message}`, 'error');
    // 失敗 → 不動 UI,等 server 重發同步
  }
}

function openDeleteConfirmModal(song) {
  pendingDeleteSongId = song.id;
  deleteSongTitle.textContent = song.title || song.id;
  deleteModal.classList.remove('hidden');
}

/**
 * 搜尋邏輯 (方案 B — 9.0/10):
 *   同時比對: 中文標題 / 中文歌手 / 拼音標題 / 拼音歌手
 *   例：輸入 "yeqv" 找不到 "夜曲", 但輸入 "ye qu" 可以命中
 *   例：輸入 "jay" 可命中 "Jay Chou" 系列
 */
function matchSong(song, q) {
  if (!q) return true;
  const fields = [
    song.title,
    song.artist,
    song.album || '',
    song.pinyinTitle || '',
    song.pinyinArtist || '',
  ];
  return fields.some((f) => String(f || '').toLowerCase().includes(q));
}

function renderSongs() {
  const q = (searchInput.value || '').trim().toLowerCase();
  songList.innerHTML = '';
  const filtered = songs.filter((s) => matchSong(s, q));
  if (filtered.length === 0) {
    songList.innerHTML = '<div class="text-center text-gray-500 py-8 text-sm">找不到符合的歌曲</div>';
    return;
  }
  filtered.forEach((song) => {
    const li = renderSongCard(song, { action: 'pick' });
    li.addEventListener('click', () => pickSong(song.id));
    attachLibraryCardSwipe(li, song);
    songList.appendChild(li);
  });
}

/**
 * 歌曲庫卡片的 swipe-to-permanent-delete
 * - 只在主揪模式解鎖時生效 (hostModeUnlocked)
 * - 沒解鎖時左滑到底直接被擋掉 (不會誤刪)
 * - 滑到底 (≤-140px) → 直接彈永久刪除 confirm modal
 *   (走的是與長按同一條路徑,UX 一致)
 */
function attachLibraryCardSwipe(li, song) {
  let startX = 0;
  let dx = 0;
  let sliding = false;
  const SLIDE_DELETE_PX = 140;

  const onDown = (e) => {
    if (e.target.closest('button')) return;
    const t = e.touches ? e.touches[0] : e;
    startX = t.clientX;
    dx = 0;
    sliding = true;
    li.style.transition = 'none';
  };
  const onMove = (e) => {
    if (!sliding) return;
    const t = e.touches ? e.touches[0] : e;
    dx = t.clientX - startX;
    // 紅色預覽: dx 越負,背景越紅
    if (dx < 0) {
      const intensity = Math.min(1, Math.abs(dx) / 160);
      li.style.background = `rgba(239, 68, 68, ${intensity * 0.25})`;
    }
    const clamped = Math.max(-160, Math.min(0, dx));
    li.style.transform = `translateX(${clamped}px)`;
  };
  const onUp = () => {
    if (!sliding) return;
    sliding = false;
    li.style.transition = 'transform 0.2s ease, background 0.2s ease';
    if (dx <= -SLIDE_DELETE_PX) {
      // 滑到底 → 觸發永久刪 modal (主揪模式限定)
      if (!hostModeUnlocked) {
        // 沒解鎖: 拒絕 + 提示 (UX 友善,不解鎖到主揪按鈕)
        li.style.transform = 'translateX(0)';
        li.style.background = '';
        if ('vibrate' in navigator) navigator.vibrate(60);
        showToast('🔒 滑動刪除需要主揪模式,點下方「主揪模式」解鎖', 'error');
        return;
      }
      li.style.transform = 'translateX(-100%)';
      setTimeout(() => {
        pendingDeleteSongId = song.id;
        deleteSongTitle.textContent = song.title;
        deleteModal.classList.remove('hidden');
        // 不要把 li 移走,使用者可能按取消,卡片位置不對會很怪
        // 反正刪除確認後 server 會 broadcast library_updated,前端會重 render
        li.style.transform = 'translateX(0)';
        li.style.background = '';
      }, 180);
    } else {
      // 沒過門檻,彈回
      li.style.transform = 'translateX(0)';
      li.style.background = '';
    }
    dx = 0;
  };

  li.addEventListener('touchstart', onDown, { passive: true });
  li.addEventListener('touchmove', onMove, { passive: true });
  li.addEventListener('touchend', onUp);
  li.addEventListener('mousedown', onDown);
  li.addEventListener('mousemove', onMove);
  li.addEventListener('mouseup', onUp);
  li.addEventListener('mouseleave', onUp);
}

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[m]));
  }

  searchInput.addEventListener('input', () => renderSongs());

  // ===== 加歌 Modal =====
  function openAddSongModal() {
    addSongModal.classList.remove('hidden');
    setTimeout(() => inputUrl.focus(), 200);
  }

  function closeAddSongModal() {
    addSongModal.classList.add('hidden');
    addSongForm.reset();
    btnSubmitSong.disabled = false;
    btnSubmitSong.innerHTML = '<i class="fa-solid fa-rocket"></i> 開始處理';
  }

  btnAddSong.addEventListener('click', openAddSongModal);
  document.querySelectorAll('[data-close-modal]').forEach((el) => {
    el.addEventListener('click', closeAddSongModal);
  });

  addSongForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = inputUrl.value.trim();
    const title = inputTitle.value.trim();
    const artist = inputArtist.value.trim();

    if (!url) {
      showToast('請輸入 YouTube 網址', 'error');
      return;
    }
    if (!/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(url)) {
      showToast('網址格式不正確', 'error');
      return;
    }

    btnSubmitSong.disabled = true;
    btnSubmitSong.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 送出中...';

    try {
      const res = await fetch('/api/process-youtube', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          title: title || undefined,
          artist: artist || undefined,
        }),
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      const jobId = data.job_id;
      if (!jobId) {
        throw new Error('Pipeline 沒回 job_id');
      }

      jobs.set(jobId, {
        url,
        title: title || '(處理中將自動取名)',
        artist: artist || '',
        status: 'queued',
        percent: 5,
        detail: '排隊中...',
        error: null,
      });
      renderJobs();
      startJobsPolling();
      closeAddSongModal();
      showToast('✅ 已加入處理列隊');
    } catch (err) {
      showToast(`送出失敗：${err.message}`, 'error');
      btnSubmitSong.disabled = false;
      btnSubmitSong.innerHTML = '<i class="fa-solid fa-rocket"></i> 開始處理';
    }
  });

  // ===== Jobs 輪詢 =====
  let jobsPollTimer = null;

  function startJobsPolling() {
    if (jobsPollTimer) return;
    pollJobs();
    jobsPollTimer = setInterval(pollJobs, 1500);
  }

  function stopJobsPolling() {
    if (jobsPollTimer) {
      clearInterval(jobsPollTimer);
      jobsPollTimer = null;
    }
  }

  async function pollJobs() {
    if (jobs.size === 0) {
      stopJobsPolling();
      renderJobs();
      return;
    }

    // 1) 問 pipeline 各 job 真實狀態
    await Promise.all(
      [...jobs.entries()].map(async ([jobId, job]) => {
        if (job.status === 'done' || job.status === 'error') return;
        try {
          const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`);
          const data = await res.json();
          if (data && data.status) {
            job.status = data.status;
            if (data.error) job.error = data.error;
            if (data.status === 'done') {
              job.percent = 100;
              job.detail = `✅ 完成：${data.filename || ''}`;
              if (data.filename) {
                setTimeout(() => {
                  const song = songs.find(s => s.src && s.src.includes(data.filename));
                  if (song) socket.emit('add_song', song.id);
                }, 1000);
              }
            } else if (data.status === 'error') {
              job.percent = 100;
              job.detail = `❌ ${data.error || '處理失敗'}`;
            }
          }
        } catch (e) {
          /* ignore transient errors */
        }
      })
    );

    // 2) 問 brain 磁碟階段 (給「下載中 / AI 分離中 / 混音中」文字反饋)
    try {
      const res = await fetch('/api/work-progress');
      const data = await res.json();
      if (data && data.stage && data.stage !== 'idle' && data.stage !== 'unknown') {
        // 把進度套到仍在跑的第一個 job (單執行緒 pipeline, 同時只一個)
        for (const [, job] of jobs) {
          if (job.status === 'done' || job.status === 'error') continue;
          job.percent = Math.max(job.percent || 0, data.percent || 0);
          job.detail = data.detail || job.detail;
          break;
        }
      }
    } catch (e) {
      /* ignore */
    }

    renderJobs();

    // 清理 30 秒前就完成的 job
    for (const [jobId, job] of jobs) {
      if (job.status === 'done' || job.status === 'error') {
        if (!job._cleanupAt) job._cleanupAt = Date.now() + 30000;
        if (Date.now() > job._cleanupAt) jobs.delete(jobId);
      }
    }
  }

  function retryJob(jobId) {
    const job = jobs.get(jobId);
    if (!job) return;
    // 重設狀態, 重新送出
    job.status = 'queued';
    job.percent = 5;
    job.detail = '重新送出...';
    job.error = null;
    delete job._cleanupAt;
    (async () => {
      try {
        const res = await fetch('/api/process-youtube', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: job.url,
            title: job.title === '(處理中將自動取名)' ? undefined : job.title,
            artist: job.artist || undefined,
          }),
        });
        const data = await res.json();
        if (data.success && data.job_id && data.job_id !== jobId) {
          jobs.delete(jobId);
          jobs.set(data.job_id, {
            ...job,
            status: 'queued',
            percent: 5,
            detail: '排隊中...',
          });
        }
      } catch (e) {
        job.status = 'error';
        job.detail = `重試失敗：${e.message}`;
      }
      renderJobs();
    })();
  }

  function removeJob(jobId) {
    jobs.delete(jobId);
    renderJobs();
  }

  function renderJobs() {
    const arr = [...jobs.entries()];
    if (arr.length === 0) {
      jobsPanel.classList.add('hidden');
      jobsList.innerHTML = '';
      jobsCount.textContent = '0';
      return;
    }
    jobsPanel.classList.remove('hidden');
    jobsCount.textContent = String(arr.length);
    jobsList.innerHTML = '';

    arr.forEach(([jobId, job]) => {
      const li = document.createElement('div');
      li.className = 'glass rounded-xl p-3 border border-white/10';

      const stages = ['queued', 'downloading', 'separating', 'mixing'];
      const stageIdx = stages.indexOf(job.status >= 0 ? job.status : '');

      const stageDots = ['queued', 'downloading', 'separating', 'mixing']
        .map((s, i) => {
          let cls = 'stage-dot';
          if (job.status === 'done') cls += ' done';
          else if (job.status === 'error') cls += '';
          else if (i < stageIdx) cls += ' done';
          else if (i === stageIdx) cls += ' active';
          return `<span class="${cls}" title="${s}"></span>`;
        })
        .join('<span class="flex-1 h-px bg-white/10"></span>');

      const isFail = job.status === 'error';
      const isDone = job.status === 'done';
      const percent = Math.min(100, Math.max(0, job.percent || 0));

      li.innerHTML = `
        <div class="flex items-start gap-2 mb-2">
          <div class="flex-1 min-w-0">
            <div class="text-sm font-medium truncate">${escapeHtml(job.title)}</div>
            <div class="text-xs text-gray-400 truncate">${escapeHtml(job.artist || '')}</div>
          </div>
          ${isFail ? `
            <button data-retry="${jobId}" class="px-2 py-1 rounded-lg bg-amber-500/20 text-amber-300 text-xs font-bold">
              <i class="fa-solid fa-rotate"></i> 重試
            </button>` : ''}
          <button data-remove="${jobId}" class="w-7 h-7 rounded-lg bg-white/5 hover:bg-white/10 text-gray-400 text-xs flex items-center justify-center flex-shrink-0">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>
        <div class="flex items-center gap-1.5 mb-2">${stageDots}</div>
        <div class="progress-track h-1.5 rounded-full">
          <div class="progress-fill h-full rounded-full"
               style="width:${percent}%; ${isFail ? 'background:#ef4444;animation:none;' : ''} ${isDone ? 'background:#10b981;animation:none;' : ''}"></div>
        </div>
        <div class="flex items-center justify-between mt-1.5 text-[10px]">
          <span class="${isFail ? 'text-red-400' : isDone ? 'text-emerald-400' : 'text-gray-400'}">
            ${escapeHtml(job.detail || '')}
          </span>
          <span class="text-gray-500">${percent}%</span>
        </div>
      `;

      const retryBtn = li.querySelector('[data-retry]');
      if (retryBtn) retryBtn.addEventListener('click', () => retryJob(jobId));
      const removeBtn = li.querySelector('[data-remove]');
      if (removeBtn) removeBtn.addEventListener('click', () => removeJob(jobId));

      jobsList.appendChild(li);
    });
  }

  jobsRefresh.addEventListener('click', () => pollJobs());

  // ===== Tabs =====
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('tab-active'));
      btn.classList.add('tab-active');
      const target = btn.dataset.tab;
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
      document.getElementById(`tab-${target}`).classList.remove('hidden');
    });
  });

  // ===== 啟動 =====
  fetchSongs();
  renderAll();
})();
