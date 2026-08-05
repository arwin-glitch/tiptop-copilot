/* eslint-disable */
/**
 * TipTop Copilot service worker.
 *
 * Deliberately conservative. This app holds confidential deal data, so the
 * worker caches *only* the static shell (icons, manifest, offline page) and
 * never caches an authenticated HTML document or any API response. A stale
 * cached page containing another session's data would be a far worse bug than
 * a page that simply needs the network.
 *
 * Its job is installability and a useful offline message — not offline data.
 */

const CACHE = 'tiptop-shell-v3';
const SHELL = ['/offline', '/icon.svg', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never touch API traffic: no caching, no interception.
  if (url.pathname.startsWith('/api/')) return;

  // Navigations go to the network. On failure, show the offline page rather
  // than a stale authenticated document.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match('/offline').then((cached) => cached ?? Response.error()),
      ),
    );
    return;
  }

  // Static assets only: cache-first, then network.
  if (/\.(css|js|png|svg|ico|webmanifest|woff2?)$/.test(url.pathname) || url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ??
          fetch(request).then((response) => {
            if (response.ok && response.type === 'basic') {
              const copy = response.clone();
              caches.open(CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
  }
});
