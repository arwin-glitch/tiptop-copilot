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

const CACHE = 'tiptop-shell-v4';
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

  // Serve the shell from cache, and nothing else.
  //
  // This used to cache-first every `.js` and `/_next/static/` request, which
  // is how a deployed fix could keep not appearing: the cache name only
  // changes when a person edits it by hand, so nothing evicted the app's own
  // code, and the only way out was a hard refresh. A user should never have to
  // know what a service worker is to see the version you just shipped.
  //
  // Nothing is lost by dropping it. Next.js content-hashes these filenames and
  // serves them `immutable`, so the browser's own HTTP cache already does this
  // job correctly — and unlike this worker, it invalidates when the hash
  // changes. The worker's remaining job is what its header claims: be
  // installable, and have something to show when the network is gone.
  if (SHELL.includes(url.pathname)) {
    event.respondWith(
      caches.match(request).then((cached) => cached ?? fetch(request)),
    );
  }
});
