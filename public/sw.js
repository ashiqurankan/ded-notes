/* ded - notes service worker
 * - App shell is cached per build (version comes from ?v=<build id> on registration).
 * - Hashed /_next/static files are immutable: cache-first in a shared, size-capped cache,
 *   so a page from the previous build can still lazy-load its chunks.
 * - Pages: network first, falling back to the cached shell, then offline.html.
 */
const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const SHELL = `ded-shell-${VERSION}`;
const STATIC = 'ded-static';
const STATIC_LIMIT = 250;
const PRECACHE = ['/', '/offline.html', '/manifest.json', '/icon.svg', '/icons/icon-192.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL);
    await Promise.all(PRECACHE.map(url => shell.add(new Request(url, { cache: 'reload' })).catch(() => undefined)));
    // Precache the JS/CSS the shell page needs, so the app opens offline.
    try {
      const response = await shell.match('/');
      const html = response ? await response.text() : '';
      const assets = Array.from(new Set(html.match(/\/_next\/static\/[^"'\s)\\]+/g) || []));
      const cache = await caches.open(STATIC);
      await Promise.all(assets.map(url => cache.match(url).then(hit => hit || cache.add(url)).catch(() => undefined)));
    } catch (_) { /* best effort */ }
  })());
  // Activate immediately only on first install; updates wait for the user to tap "Reload".
  if (!self.registration.active) self.skipWaiting();
});

self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith('ded-shell-') && key !== SHELL).map(key => caches.delete(key)));
    await Promise.all(keys.filter(key => key.startsWith('dednotes-')).map(key => caches.delete(key))); // old v1 cache
    await self.clients.claim();
  })());
});

async function trimStatic() {
  const cache = await caches.open(STATIC);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - STATIC_LIMIT; i++) await cache.delete(keys[i]);
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/__/')) return; // Firebase Auth helper pages

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok && url.pathname === '/' ) {
          const copy = response.clone();
          caches.open(SHELL).then(cache => cache.put('/', copy)).catch(() => undefined);
        }
        return response;
      } catch (_) {
        return (await caches.match('/', { cacheName: SHELL }))
          || (await caches.match('/'))
          || (await caches.match('/offline.html'))
          || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      }
    })());
    return;
  }

  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith((async () => {
      const cache = await caches.open(STATIC);
      const hit = await cache.match(request);
      if (hit) return hit;
      const response = await fetch(request);
      if (response.ok) {
        cache.put(request, response.clone()).then(trimStatic).catch(() => undefined);
      }
      return response;
    })());
    return;
  }

  if (/\.(png|svg|ico|json|woff2?)$/.test(url.pathname)) {
    event.respondWith((async () => {
      const cached = await caches.match(request);
      const network = fetch(request).then(response => {
        if (response.ok) caches.open(SHELL).then(cache => cache.put(request, response.clone())).catch(() => undefined);
        return response;
      }).catch(() => cached);
      return cached || network;
    })());
  }
});
