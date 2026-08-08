/** CouchMic TV PWA service worker. Keep media/API/socket requests network-only. */
const CACHE = 'couchmic-tv-v2';
const APP_SHELL = ['/', '/tv.html', '/tv.js', '/manifest.json', '/icon-192.png', '/icon-512.png'];

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
      url.pathname.startsWith('/audio/') || url.pathname.startsWith('/videos/') ||
      url.pathname.startsWith('/tv-videos/') || url.pathname.startsWith('/tv-videos-no-range/') ||
      url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;

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
