// hivedesk service worker: makes the desktop installable as an app and shows a friendly page
// when the local server is not running. It never caches data from the engine.
const SHELL = 'hivedesk-shell-v1';
const FILES = ['/offline.html', '/favicon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    // The engine is the source of truth: always go to the network, fall back to the "start hivedesk" page.
    e.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
    return;
  }
  if (FILES.includes(url.pathname)) e.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});
