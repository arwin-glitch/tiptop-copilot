'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { syncAffinityNowAction } from '@/app/actions/affinity-sync';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Notice } from '@/components/ui/feedback';
import { relativeTime } from '@/lib/util/time';

/**
 * Knowledge → Affinity import: the daily sync, in three lines.
 *
 * Connected, it says when Affinity was last copied in and how much, with a
 * "Sync now" for the owner. Not connected, it says the three steps that
 * connect it. Nothing else: Nick reads one line, not a paragraph.
 *
 * "Sync now" runs the sync one bounded step at a time (the server action),
 * calling again until the run is done and showing how far it has got, the
 * same way the daily job loops the cron endpoint.
 */

/** The parts of AffinitySyncStatus this panel shows; serializable from the server. */
export interface AffinitySyncPanelStatus {
  configured: boolean;
  demo: boolean;
  running: boolean;
  phase: 'lists' | 'notes' | null;
  listsDone: number;
  listsTotal: number;
  lastRun: {
    finishedAt: string;
    lists: number;
    rows: number;
    records: number;
    notes: number;
    changed: number;
    /** Pages the last run could not save; the next run reads them again. */
    skipped?: number;
  } | null;
  lastError: { at: string; message: string } | null;
}

interface Progress {
  phase: 'lists' | 'notes' | 'done';
  listsDone: number;
  listsTotal: number;
}

/** Calls of the action one "Sync now" may make before it stops and says so. */
const MAX_STEPS = 400;

const NUMBER = new Intl.NumberFormat('en-US');

function progressLabel(p: Progress): string {
  if (p.phase === 'notes') return 'Syncing notes…';
  if (p.phase === 'done') return 'Finishing…';
  return p.listsTotal
    ? `Syncing list ${Math.min(p.listsDone + 1, p.listsTotal)} of ${p.listsTotal}…`
    : 'Starting…';
}

function percent(p: Progress): number {
  if (p.phase === 'notes' || p.phase === 'done') return 95;
  return p.listsTotal ? Math.round((p.listsDone / p.listsTotal) * 90) : 2;
}

export function AffinitySyncPanel({
  status,
  canSync,
}: {
  status: AffinitySyncPanelStatus;
  canSync: boolean;
}) {
  const router = useRouter();
  const [progress, setProgress] = React.useState<Progress | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [finished, setFinished] = React.useState<string | null>(null);
  const running = progress !== null;

  async function syncNow() {
    setError(null);
    setFinished(null);
    setProgress({ phase: 'lists', listsDone: 0, listsTotal: 0 });
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        const result = await syncAffinityNowAction();
        if (!result.ok || !result.data) {
          setError(result.error?.message ?? 'The sync stopped. Try again.');
          return;
        }
        const data = result.data;
        if (data.done) {
          const c = data.counts;
          const changed =
            c.entries.inserted +
            c.entries.updated +
            c.records.inserted +
            c.records.updated +
            c.notes.inserted +
            c.notes.updated;
          setFinished(
            changed ? `Done: ${NUMBER.format(changed)} added or changed.` : 'Done: nothing new.',
          );
          router.refresh();
          return;
        }
        setProgress({ phase: data.phase, listsDone: data.listsDone, listsTotal: data.listsTotal });
        // Another sync holds the lease (the daily job): wait for it.
        if (data.busy || data.rateLimited) await new Promise((r) => setTimeout(r, 5000));
      }
      setError('Still going: the daily sync will finish the rest.');
    } catch {
      setError('The sync stopped. Try again.');
    } finally {
      setProgress(null);
    }
  }

  const last = status.lastRun;
  const shown: Progress | null =
    progress ??
    (status.running && status.phase
      ? { phase: status.phase, listsDone: status.listsDone, listsTotal: status.listsTotal }
      : null);

  return (
    <Card className="mb-6" aria-labelledby="affinity-sync-heading">
      <CardContent className="pt-4">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex min-w-0 items-center gap-2">
            <h3 id="affinity-sync-heading" className="text-sm font-semibold">
              Daily sync from Affinity
            </h3>
            {status.demo ? (
              <Badge tone="outline">Demo</Badge>
            ) : status.configured ? (
              <Badge tone="ok">Connected</Badge>
            ) : (
              <Badge tone="neutral">Not connected</Badge>
            )}
          </div>
          {status.configured && canSync ? (
            <Button
              size="sm"
              variant="primary"
              onClick={syncNow}
              loading={running}
              disabled={running}
            >
              {running ? (
                'Syncing'
              ) : (
                <>
                  <RefreshCw aria-hidden="true" />
                  Sync now
                </>
              )}
            </Button>
          ) : null}
        </div>

        {status.configured ? (
          <p
            className="mt-1.5 text-sm text-[var(--fg-muted)]"
            aria-live="polite"
            suppressHydrationWarning
          >
            {shown
              ? progressLabel(shown)
              : finished
                ? finished
                : last
                  ? [
                      `Synced ${relativeTime(last.finishedAt)}`,
                      `${NUMBER.format(last.lists)} lists`,
                      `${NUMBER.format(last.rows)} rows`,
                      `${NUMBER.format(last.notes)} notes`,
                      last.skipped
                        ? `${NUMBER.format(last.skipped)} ${last.skipped === 1 ? 'page' : 'pages'} skipped, read again next run`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  : 'Not synced yet. It runs every morning; Sync now starts it.'}
          </p>
        ) : (
          <ol className="mt-2 list-decimal space-y-0.5 pl-5 text-sm text-[var(--fg-muted)]">
            <li>
              Affinity: <span className="text-[var(--fg)]">Settings › Manage Apps (API)</span> ›
              generate a key.
            </li>
            <li>
              Render: <span className="text-[var(--fg)]">tiptop-copilot › Environment</span> › add{' '}
              <code className="rounded bg-[var(--bg-sunken)] px-1 text-[13px]">
                AFFINITY_API_KEY
              </code>
              .
            </li>
            <li>Then it copies Affinity in every morning by itself.</li>
          </ol>
        )}

        {shown ? (
          <div
            className="mt-2 h-1 overflow-hidden rounded-full bg-[var(--bg-sunken)]"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent(shown)}
            aria-label="Affinity sync progress"
          >
            <div
              className="h-full rounded-full bg-[var(--primary)] transition-[width]"
              style={{ width: `${percent(shown)}%` }}
            />
          </div>
        ) : null}

        {status.configured && !canSync ? (
          <p className="mt-1 text-xs text-[var(--fg-subtle)]">
            Only the workspace owner can start a sync by hand.
          </p>
        ) : null}

        {error ? (
          <Notice tone="warn" className="mt-3">
            {error}
          </Notice>
        ) : status.lastError && !running && !finished ? (
          <Notice tone="warn" className="mt-3">
            Last attempt {relativeTime(status.lastError.at)}: {status.lastError.message}
          </Notice>
        ) : null}
      </CardContent>
    </Card>
  );
}
