'use client';

import * as React from 'react';

/**
 * Registers the service worker so the app is installable to a home screen on
 * iOS and Android. Registration is skipped in development so a stale worker
 * never shadows a code change.
 */
export function ServiceWorkerRegistrar() {
  React.useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (!('serviceWorker' in navigator)) return;

    const register = () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
        // Installability is a progressive enhancement; a failure here must not
        // surface to the user or break the page.
      });
    };

    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  }, []);

  return null;
}
