'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useReportRefresh } from '@/components/shell/refresh-status';

const POLL_MS = 15_000;
/** Longest back-off after repeated failed checks: 20 ticks, five minutes. */
const MAX_BACKOFF_TICKS = 20;

/**
 * Keeps an open tab current. It asks `endpoint` only for a cheap fingerprint
 * (`{ version }`) and refreshes the page when that differs from the one it
 * was rendered with — never on a timer alone, because a render can be
 * expensive (Today syncs the calendar and may generate an outlook; Deals
 * pulls the relay). Hidden tabs do not poll; coming back to one (including
 * from the back/forward cache) checks at once. Failed checks back off, and a
 * signed-out tab stops checking.
 */
export function VersionWatcher({ version, endpoint }: { version: string; endpoint: string }) {
  const router = useRouter();
  const [isPending, startTransition] = React.useTransition();
  const reportRefresh = useReportRefresh(isPending);

  React.useEffect(() => {
    let inFlight = false;
    let disposed = false;
    let signedOut = false;
    let failures = 0;
    let skipTicks = 0;
    // `version` only changes once the refreshed page commits, which can take
    // a while (the day's first render generates the outlook), and a second
    // router.refresh() starts another full server render instead of joining
    // the first. So each new version is refreshed for once.
    let requested: string | null = null;

    async function check() {
      if (inFlight || signedOut || document.visibilityState !== 'visible') return;
      inFlight = true;
      try {
        const response = await fetch(endpoint, {
          cache: 'no-store',
          signal: AbortSignal.timeout(10_000),
        });
        if (disposed) return;
        if (response.status === 401) {
          // The session is gone, and polling cannot bring it back; the next
          // navigation lands on the sign-in page.
          signedOut = true;
          return;
        }
        if (!response.ok) throw new Error(`version check answered ${response.status}`);
        const body = (await response.json()) as { version?: unknown };
        failures = 0;
        if (disposed || typeof body.version !== 'string') return;
        if (body.version !== version && body.version !== requested) {
          requested = body.version;
          reportRefresh();
          startTransition(() => router.refresh());
        }
      } catch {
        // Offline, mid-deploy or a server fault: wait 2, 4, 8… ticks.
        failures++;
        skipTicks = Math.min(2 ** failures, MAX_BACKOFF_TICKS) - 1;
      } finally {
        inFlight = false;
      }
    }

    void check();
    const timer = window.setInterval(() => {
      if (skipTicks > 0) skipTicks--;
      else void check();
    }, POLL_MS);
    const onVisible = () => {
      skipTicks = 0;
      void check();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onVisible);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onVisible);
    };
  }, [endpoint, reportRefresh, router, version]);

  return null;
}
