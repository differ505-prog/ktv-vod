/** CouchMic TV PWA service worker. Keep media/API/socket requests network-only. */
const CACHE = 'couchmic-v10';
const APP_SHELL = [
  '/tv.html', '/tv.js',
  '/mobile.html', '/mobile.js',
  '/manifest.json', '/icon-192.png', '/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))
  )).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin ||
      url.pathname.includes('/audio/') || url.pathname.includes('/videos/') ||
      url.pathname.includes('/tv-videos/') || url.pathname.includes('/tv-videos-no-range/') ||
      url.pathname.includes('/api/') || url.pathname.includes('/socket.io/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then((response) => {
      caches.open(CACHE).then((cache) => cache.put(request, response.clone())).catch(() => {});
      return response;
    }).catch(() => caches.match('/tv.html')));
    return;
  }

  event.respondWith(caches.match(request).then((cached) => {
    const fresh = fetch(request).then((response) => {
      if (response.ok) caches.open(CACHE).then((cache) => cache.put(request, response.clone())).catch(() => {});
      return response;
    }).catch(() => cached);
    return cached || fresh;
  }));
});
