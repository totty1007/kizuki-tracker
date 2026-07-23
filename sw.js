const CACHE_NAME = 'kizuki-tracker-v3';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './vendor/xlsx.full.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// Rarely-changing static assets: safe to serve cache-first.
const CACHE_FIRST_PATTERNS = [/\/vendor\//, /\/icons\//];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(ASSETS.map((url) =>
        // { cache: 'reload' } bypasses the browser's HTTP cache so precaching
        // always reflects the true latest deployed files, not a stale disk hit.
        fetch(url, { cache: 'reload' }).then((response) => cache.put(url, response))
      ))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (new URL(event.request.url).origin !== self.location.origin) return;

  const isCacheFirst = CACHE_FIRST_PATTERNS.some((re) => re.test(event.request.url));

  if (isCacheFirst) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      }))
    );
    return;
  }

  // App shell files (html/css/js): network-first, bypassing the browser's
  // HTTP cache, so updates are picked up immediately when online. Falls
  // back to the cached copy when offline.
  event.respondWith(
    fetch(event.request, { cache: 'no-store' }).then((response) => {
      const clone = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
      return response;
    }).catch(() => caches.match(event.request))
  );
});
