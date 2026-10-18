// The offline shell of hivedesk remote: every file of the page is cached at install, so the page
// opens without a network and says what it needs. It caches only this folder's own files (no data:
// the phone talks to its computer over WebRTC, which a service worker never sees).
const VERSION = 'hivedesk-remote-1.0.0-1';
const SHELL = [
  './', 'index.html', 'app.css', 'viewer.css', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable.png',
  'js/app.js', 'js/dom.js', 'js/i18n.js', 'js/store.js', 'js/viewer.js',
  'js/vendor/i18n/index.js',
  'js/vendor/lend/core/bytes.js', 'js/vendor/lend/core/emitter.js', 'js/vendor/lend/core/mqtt.js', 'js/vendor/lend/core/relay.js', 'js/vendor/lend/core/rtc.js',
  'js/vendor/lend/core/rendezvous.js', 'js/vendor/lend/core/pairing.js', 'js/vendor/lend/core/words.js', 'js/vendor/lend/core/wordlist.js',
  'js/vendor/lend/core/sha256.js', 'js/vendor/lend/core/p2p-pipe.js',
  'js/vendor/phone/core/crypto.js', 'js/vendor/phone/core/invite.js', 'js/vendor/phone/core/handshake.js', 'js/vendor/phone/core/messages.js',
  'js/vendor/phone/core/session.js', 'js/vendor/phone/core/client.js', 'js/vendor/phone/core/grants.js', 'js/vendor/phone/core/connect.js',
  'js/vendor/remote/media.js', 'js/vendor/remote/abr.js', 'js/vendor/remote/pointer.js',
  'i18n/en.json', 'i18n/pt-BR.json', 'i18n/es.json', 'i18n/fr.json', 'i18n/de.json', 'i18n/it.json', 'i18n/ja.json', 'i18n/ko.json', 'i18n/ru.json', 'i18n/zh-CN.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // The page itself: the network first (a new version), the cache when offline. Everything else: the cache first.
  const page = e.request.mode === 'navigate';
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    if (page) {
      try {
        const fresh = await fetch(e.request);
        if (fresh.ok) cache.put('index.html', fresh.clone());
        return fresh;
      } catch {
        return (await cache.match('index.html')) || Response.error();
      }
    }
    const hit = await cache.match(e.request, { ignoreSearch: true });
    if (hit) return hit;
    const res = await fetch(e.request);
    if (res.ok && url.pathname.includes('/remote/')) cache.put(e.request, res.clone());
    return res;
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((list) => (list[0] ? list[0].focus() : self.clients.openWindow('./'))));
});
