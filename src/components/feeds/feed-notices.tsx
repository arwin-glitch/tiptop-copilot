'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { BellRing } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

const COULD_NOT = 'Feed notices could not be changed. Try again.';

/**
 * Feed notices for the signed-in person's own computers: when a feed looks
 * stopped, each of their computers with desktop alerts shows one notice a
 * day for it (lib/services/feed-health.ts). Off unless they turn it on, and
 * nobody else's computer is affected either way.
 */
export function FeedNoticesSetting({
  initialOn,
  computers,
}: {
  /** Null when it could not be read. */
  initialOn: boolean | null;
  /** How many of the person's computers have desktop alerts on; null when unknown. */
  computers: number | null;
}) {
  const [on, setOn] = React.useState(initialOn);
  const [busy, setBusy] = React.useState(false);

  async function change(next: boolean) {
    setBusy(true);
    try {
      const res = await fetch('/api/feeds/notices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ on: next }),
      });
      const body = (await res.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (!res.ok || !body?.ok) {
        toast.error(body?.error?.message ?? COULD_NOT);
        return;
      }
      setOn(next);
      toast.success(next ? 'Turned feed notices on.' : 'Turned feed notices off.');
    } catch {
      toast.error(COULD_NOT);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-3 py-3.5">
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[var(--accent)]"
        >
          <BellRing className="size-4" />
        </span>
        {/* Wide enough that on a phone the button drops below instead of squeezing it. */}
        <div className="min-w-[14rem] flex-1">
          <h2 className="text-sm font-medium">Feed notices on your computers</h2>
          <p className="text-sm text-[var(--fg-muted)]">
            When a feed looks stopped, each of your computers with desktop alerts shows one notice a
            day for it, between 8am and 8pm. Only yours: nobody else is notified.
          </p>
          <p className="mt-1 text-xs text-[var(--fg-subtle)]" role="status">
            {on === null
              ? 'Whether they are on could not be read just now.'
              : on
                ? 'Feed notices are on.'
                : 'Feed notices are off.'}
            {on && computers === 0
              ? ' None of your computers has desktop alerts on yet: turn them on in Settings, Preferences, in the desktop app.'
              : ''}
          </p>
        </div>
        {on === null ? null : (
          <Button
            variant={on ? 'secondary' : 'primary'}
            size="sm"
            disabled={busy}
            onClick={() => void change(!on)}
          >
            {on ? 'Turn off feed notices' : 'Turn on feed notices'}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
