'use client';

import { useEffect } from 'react';

/**
 * The page-view beacon (D-075): one JS POST after the page loads, so a GET
 * never records anything (and link scanners that only fetch never count).
 * Sends where the visitor came from (a UTM source, a ?via= partner code or
 * the referring site's host) — never a full URL — and the personal token
 * when on a personal link.
 */
export function ViewBeacon({ endpoint, token }: { endpoint: string; token: string | null }) {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    let source = params.get('utm_source') || params.get('via');
    if (!source && document.referrer) {
      try {
        const host = new URL(document.referrer).host;
        if (host && host !== window.location.host) source = host;
      } catch {
        // ignore
      }
    }
    const body = JSON.stringify({ token, source: source ? source.slice(0, 120) : null });
    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
      credentials: 'same-origin',
    }).catch(() => undefined);
  }, [endpoint, token]);
  return null;
}
