'use client';

import * as React from 'react';

/**
 * Registers the service worker so the app is installable to a home screen on
 * iOS and Android. Registration is skipped in development so a stale worker
 * never shadows a code change.
 *
 * It also checks for a newer worker on every load and when the tab comes back
 * to the foreground. A previous version of this worker cached the app's own
 * JavaScript indefinitely, so a deployed change could keep not appearing and
 * the only remedy was a hard refresh — which is not something a user should
 * have to know to do. The worker no longer caches code, and this makes sure a
 * replacement is picked up promptly rather than whenever the browser happens
 * to look.
 */
export function ServiceWorkerRegistrar() {
  React.useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (!('serviceWorker' in navigator)) return;

    let registration: ServiceWorkerRegistration | undefined;

    const checkForUpdate = () => {
      // `update()` rejects if the worker has gone away or the network is down;
      // neither is worth surfacing, and neither should break the page.
      registration?.update().catch(() => undefined);
    };

    const onVisible = () => {
      if (document.visibilityState === 'visible') checkForUpdate();
    };

    const register = () => {
      navigator.serviceWorker
        .register('/sw.js', { scope: '/' })
        .then((reg) => {
          registration = reg;
          checkForUpdate();
          document.addEventListener('visibilitychange', onVisible);
        })
        .catch(() => {
          // Installability is a progressive enhancement; a failure here must
          // not surface to the user or break the page.
        });
    };

    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });

    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  return null;
}
