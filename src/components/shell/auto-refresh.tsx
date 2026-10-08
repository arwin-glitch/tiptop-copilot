'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';

/**
 * Re-renders the current page's server data every `minutes` while it is open,
 * and when the tab comes back into view after that long. What the person is
 * typing stays: client state survives a router refresh.
 */
export function AutoRefresh({ minutes }: { minutes: number }) {
  const router = useRouter();
  React.useEffect(() => {
    const every = minutes * 60_000;
    let last = Date.now();
    const refresh = () => {
      last = Date.now();
      router.refresh();
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, every);
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - last >= every) refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [minutes, router]);
  return null;
}
