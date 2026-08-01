/**
 * CouchMic TV PWA - Service Worker
 *
 * 範圍：app shell 快取 + 離線時 fallback 顯示 tv.html。
 * 影片 / API / socket.io 絕不快取 (那會吃到舊的播放狀態)。
 *
 * 策略：
 *   - GET 導航 (HTML): network-first, fallback to cache
 *   - 靜態資源 (JS/CSS/PNG): stale-while-revalidate
 *   - 其他 (影片/API/socket): 不介入,交給瀏覽器原生
 */
const CACHE = 'couchmic-tv-v1';
const APP_SHELL = ['/', '/tv.html', '/tv.js', '/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 不處理影片、API、socket.io、跨網域
  if (req.method !== 'GET') return;
  if (url.pathname.startsWith('/videos/') ||
      url.pathname.startsWith('/tv-videos/') ||
      url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/socket.io/') ||
      url.origin !== self.location.origin) {
    return;
  }

  // 導航請求：network-first, fallback cache
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match('/tv.html'))
    );
    return;
  }

  // 靜態資源：stale-while-revalidate
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req).then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
