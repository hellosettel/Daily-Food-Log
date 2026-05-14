/* ============================================================
   service-worker.js
   ============================================================
   Strategy:
   - Static app shell: cache-first, with version-based busting.
   - HTML / config / scripts: network-first, fall back to cache.
   - Supabase API requests: never cached (always live).

   To force update: bump CACHE_VERSION below and redeploy.
   ============================================================ */

const CACHE_VERSION = 'v2.0.0';
const STATIC_CACHE = `daily-log-static-${CACHE_VERSION}`;

const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/styles.css',
  '/js/config.js',
  '/js/db.js',
  '/js/seed.js',
  '/js/sync.js',
  '/js/parser.js',
  '/js/ui.js',
  '/js/app.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(cache => cache.addAll(APP_SHELL).catch(err => {
      console.warn('SW pre-cache partial failure:', err);
    }))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== STATIC_CACHE).map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache Supabase requests
  if (url.hostname.includes('supabase.co') || url.hostname.includes('supabase.in')) {
    return;
  }

  // Never cache fonts.googleapis (let browser handle)
  if (url.hostname.includes('fonts.googleapis.com') || url.hostname.includes('fonts.gstatic.com')) {
    return;
  }

  // Network-first for our HTML/JS/CSS so updates land fast
  if (url.origin === location.origin) {
    event.respondWith(
      fetch(event.request).then(res => {
        // Update cache with fresh copy
        const copy = res.clone();
        caches.open(STATIC_CACHE).then(c => c.put(event.request, copy));
        return res;
      }).catch(() => caches.match(event.request))
    );
    return;
  }
});
