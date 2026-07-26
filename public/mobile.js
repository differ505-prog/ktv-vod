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

  // ===== 狀態 =====
  let songs = [];       // 歌曲庫
  let playlist = [];    // 待播佇列
  let currentSong = null;
  let audioMode = 'original';

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

function renderQueue() {
  queueList.innerHTML = '';
  if (playlist.length === 0) {
    queueEmpty.classList.remove('hidden');
    return;
  }
  queueEmpty.classList.add('hidden');
  playlist.forEach((song, idx) => {
    const li = renderSongCard(song, { action: 'queue', index: idx });
    queueList.appendChild(li);
  });
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
    songList.appendChild(li);
  });
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
