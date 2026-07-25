/**
 * KTV 手機端 (The Controller)
 * 職責：
 *  - 取得並快取歌曲庫
 *  - 發送控制指令 (add_song / skip_song / toggle_vocal) 給後端
 *  - 渲染當前播放、待播佇列，提供即時狀態
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
  const vocalLabel = document.getElementById('vocalLabel');
  const vocalIcon = document.getElementById('vocalIcon');
  const songList = document.getElementById('songList');
  const queueList = document.getElementById('queueList');
  const queueEmpty = document.getElementById('queueEmpty');
  const searchInput = document.getElementById('searchInput');
  const toast = document.getElementById('toast');
  const toastText = document.getElementById('toastText');

  // ===== 狀態 =====
  let songs = [];       // 歌曲庫
  let playlist = [];    // 待播佇列
  let currentSong = null;
  let audioMode = 'original';

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

  socket.on('error_message', ({ message }) => {
    showToast(message || '發生錯誤', 'error');
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
    } else {
      npTitle.textContent = currentSong.title;
      npArtist.textContent = `${currentSong.artist || ''} · ${currentSong.duration || ''}`;
      if (currentSong.cover) {
        npCover.src = currentSong.cover;
        npCover.onload = () => npCover.classList.remove('opacity-0');
        npCover.onerror = () => npCover.classList.add('opacity-0');
      }
      npQueue.innerHTML = `<i class="fa-solid fa-list-ol"></i> 佇列 ${playlist.length} 首`;
    }
    if (audioMode === 'vocal_off') {
      npMode.innerHTML = '<i class="fa-solid fa-guitar"></i> 伴奏';
      npMode.className = 'px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300';
    } else {
      npMode.innerHTML = '<i class="fa-solid fa-microphone"></i> 原唱';
      npMode.className = 'px-2 py-0.5 rounded-full bg-pink-500/20 text-pink-300';
    }
  }

  function renderQueue() {
    queueList.innerHTML = '';
    if (playlist.length === 0) {
      queueEmpty.classList.remove('hidden');
      return;
    }
    queueEmpty.classList.add('hidden');
    playlist.forEach((song, idx) => {
      const li = document.createElement('div');
      li.className = 'glass rounded-xl p-3 flex items-center gap-3 song-card';
      li.innerHTML = `
        <div class="w-10 h-10 rounded-lg bg-gradient-to-br from-pink-500 to-purple-600 flex items-center justify-center font-bold text-sm flex-shrink-0">
          ${idx + 1}
        </div>
        <div class="flex-1 min-w-0">
          <div class="font-medium text-sm truncate">${escapeHtml(song.title)}</div>
          <div class="text-xs text-gray-400 truncate">${escapeHtml(song.artist || '')} · ${escapeHtml(song.duration || '')}</div>
        </div>
        <div class="text-[10px] text-gray-500">
          <i class="fa-solid fa-user"></i> ${escapeHtml(song.addedBy || '匿名')}
        </div>
      `;
      queueList.appendChild(li);
    });
  }

  function renderSongs() {
    const q = (searchInput.value || '').trim().toLowerCase();
    songList.innerHTML = '';
    const filtered = q
      ? songs.filter((s) => (s.title + ' ' + s.artist).toLowerCase().includes(q))
      : songs;
    if (filtered.length === 0) {
      songList.innerHTML = '<div class="text-center text-gray-500 py-8 text-sm">找不到符合的歌曲</div>';
      return;
    }
    filtered.forEach((song) => {
      const li = document.createElement('button');
      li.className = 'w-full glass rounded-xl p-3 flex items-center gap-3 song-card text-left';
      li.innerHTML = `
        <div class="w-12 h-12 rounded-lg overflow-hidden bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center flex-shrink-0">
          ${song.cover
            ? `<img src="${song.cover}" class="w-full h-full object-cover" onerror="this.style.display='none'" />`
            : '<i class="fa-solid fa-music"></i>'}
        </div>
        <div class="flex-1 min-w-0">
          <div class="font-medium text-sm truncate">${escapeHtml(song.title)}</div>
          <div class="text-xs text-gray-400 truncate">${escapeHtml(song.artist || '')} · ${escapeHtml(song.duration || '')}</div>
        </div>
        <div class="cyan-btn rounded-lg px-3 py-1.5 text-xs font-bold flex items-center gap-1">
          <i class="fa-solid fa-plus"></i> 點歌
        </div>
      `;
      li.addEventListener('click', () => pickSong(song.id));
      songList.appendChild(li);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[m]));
  }

  searchInput.addEventListener('input', () => renderSongs());

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
