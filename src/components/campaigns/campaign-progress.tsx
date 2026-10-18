'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Check, Pause, Play, RotateCcw, Send, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useConfirm } from '@/components/ui/confirm';
import { Notice } from '@/components/ui/feedback';
import { campaignReceipt, finishToast } from '@/lib/campaigns/receipt';
import { PAUSE_REASON_TEXT } from '@/lib/campaigns/status';
import type { CampaignPauseReason, CampaignStatus } from '@/lib/types/domain';

export interface ProgressCounts {
  total: number;
  pending: number;
  sent: number;
  failed: number;
  unconfirmed: number;
  skipped: number;
  /** Read from the inbox after sending; the batch answer carries it, for the finish toast. */
  bounced?: number;
}

interface BatchProgress {
  state: 'sending' | 'done' | 'paused' | 'idle' | 'busy' | 'capped';
  status: CampaignStatus;
  pauseReason: CampaignPauseReason | null;
  counts: ProgressCounts;
  message: string | null;
  capResetsAt: string | null;
  dailyRemaining: number;
}

type Action = 'pause' | 'resume' | 'cancel' | 'retry_failed' | 'mark_sent' | 'resend';

export interface UnconfirmedRecipient {
  id: string;
  name: string | null;
  email: string;
}

const post = async (url: string, body?: unknown) => {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const json = (await res.json().catch(() => null)) as
      ({ progress?: BatchProgress; error?: { message?: string } } & Record<string, unknown>) | null;
    return { ok: res.ok, json };
  } catch {
    return { ok: false, json: null };
  }
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sending a confirmed campaign: this page asks the server for one short batch
 * after another while it stays open, and shows how far it got. Sending runs
 * only while the page is open, so leaving it — closing the tab, or a link
 * elsewhere in Copilot (which asks first) — pauses the campaign, and every
 * view then says "Paused". Coming back, Resume is a tap, never automatic.
 * Pause and Cancel take effect before the next email.
 */
export function CampaignProgress({
  campaignId,
  initialStatus,
  initialCounts,
  initialPauseReason = null,
  initialStalled = false,
  initialCapResetsAt = null,
  unconfirmedRecipients = [],
  autoStart = false,
}: {
  campaignId: string;
  initialStatus: CampaignStatus;
  initialCounts: ProgressCounts;
  initialPauseReason?: CampaignPauseReason | null;
  /** Marked sending, but no page has driven it for a while. */
  initialStalled?: boolean;
  initialCapResetsAt?: string | null;
  /** The "may have gone out" ones, to settle one by one. */
  unconfirmedRecipients?: UnconfirmedRecipient[];
  /** Only straight after the tap on Send (or Resume / Retry) on this page. */
  autoStart?: boolean;
}) {
  const router = useRouter();
  const [confirm, confirmDialog] = useConfirm();
  const [toCheck, setToCheck] = React.useState<UnconfirmedRecipient[]>(unconfirmedRecipients);
  const [status, setStatus] = React.useState<CampaignStatus>(initialStatus);
  const [pauseReason, setPauseReason] = React.useState<CampaignPauseReason | null>(
    initialPauseReason,
  );
  const [counts, setCounts] = React.useState<ProgressCounts>(initialCounts);
  const [running, setRunning] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [capResetsAt, setCapResetsAt] = React.useState<string | null>(initialCapResetsAt);
  const [acting, setActing] = React.useState(false);
  const alive = React.useRef(true);
  /** The loop that may keep going; bumping it stops the one running. */
  const runId = React.useRef(0);
  /** True while this page's loop is the one sending (not waiting on another window). */
  const driving = React.useRef(false);
  const pendingRef = React.useRef(initialCounts.pending);
  React.useEffect(() => {
    pendingRef.current = counts.pending;
  }, [counts.pending]);

  const run = React.useCallback(async () => {
    const mine = runId.current + 1;
    runId.current = mine;
    const current = () => alive.current && runId.current === mine;
    setRunning(true);
    setMessage(null);
    let busyTries = 0;
    /** The last batch's counts once it says done: the finish toast's numbers. */
    let finished: ProgressCounts | null = null;
    while (current()) {
      // This page is the sender from the moment it asks, unless the last
      // answer said another window or campaign holds the mailbox.
      if (busyTries === 0) driving.current = true;
      const { ok, json } = await post(`/api/campaigns/${campaignId}/batch`);
      if (!current()) break;
      if (!ok || !json?.progress) {
        driving.current = false;
        setMessage(
          json?.error?.message ??
            'Sending stopped: Copilot could not be reached. Continue when you are ready.',
        );
        break;
      }
      const p = json.progress;
      setStatus(p.status);
      setPauseReason(p.pauseReason ?? null);
      setCounts(p.counts);
      setCapResetsAt(p.capResetsAt);
      if (p.message) setMessage(p.message);
      if (p.state === 'busy') {
        // Another window, or another campaign, is sending from this mailbox:
        // wait for it.
        driving.current = false;
        busyTries += 1;
        if (busyTries > 20) {
          setMessage(
            'Another window or campaign is sending from this mailbox right now. Continue here when it finishes.',
          );
          break;
        }
        await wait(3_000);
        continue;
      }
      busyTries = 0;
      driving.current = p.state === 'sending';
      if (p.state === 'done') finished = p.counts;
      if (p.state !== 'sending') break;
    }
    if (runId.current === mine) driving.current = false;
    if (alive.current && runId.current === mine) {
      setRunning(false);
      if (finished) {
        const text = finishToast(finished);
        if (campaignReceipt(finished).issues) toast.warning(text);
        else toast.success(text);
        router.refresh();
      }
    }
  }, [campaignId, router]);

  /**
   * The page is going away while this loop sends: pause the campaign so every
   * view says so, rather than leaving it marked "sending" with nobody sending.
   * keepalive lets the request outlive the page.
   */
  const pauseOnLeave = React.useCallback(() => {
    if (!driving.current) return;
    driving.current = false;
    try {
      void fetch(`/api/campaigns/${campaignId}/control`, {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'pause', reason: 'left' }),
      }).catch(() => undefined);
    } catch {
      // The status then reads "Stopped" on its own after a couple of minutes.
    }
  }, [campaignId]);

  React.useEffect(() => {
    alive.current = true;
    // Started from a timer, not in the effect body, so a remount (React's
    // development double-mount) cancels it instead of starting two loops.
    const timer = autoStart ? window.setTimeout(() => void run(), 0) : null;
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      alive.current = false;
      runId.current += 1;
    };
  }, [autoStart, run]);

  // Leaving by any route — a link, the back button, closing the tab — pauses.
  React.useEffect(() => {
    window.addEventListener('pagehide', pauseOnLeave);
    return () => {
      window.removeEventListener('pagehide', pauseOnLeave);
      pauseOnLeave();
    };
  }, [pauseOnLeave]);

  React.useEffect(() => {
    if (!running) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    // In-app links never fire beforeunload, so ask before following one.
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      const to = new URL(anchor.href, window.location.href);
      if (to.origin !== window.location.origin) return; // beforeunload asks
      if (to.pathname === window.location.pathname && to.search === window.location.search) return;
      const left = pendingRef.current;
      // Held first, always: the answer comes from the app's own dialog, after
      // this handler has returned, and the link is followed only on a yes.
      event.preventDefault();
      event.stopPropagation();
      void confirm({
        title: 'Leave while sending?',
        description: `Sending runs only on this page, so the campaign pauses${left ? ` with ${left} not sent yet` : ''}. You can resume it later.`,
        confirmLabel: 'Leave and pause',
        cancelLabel: 'Stay',
      }).then((leave) => {
        if (leave) router.push(`${to.pathname}${to.search}${to.hash}`);
      });
    };
    window.addEventListener('beforeunload', warn);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', warn);
      document.removeEventListener('click', onClick, true);
    };
  }, [running, confirm, router]);

  const control = async (action: Action, recipientIds?: string[]) => {
    setActing(true);
    const { ok, json } = await post(`/api/campaigns/${campaignId}/control`, {
      action,
      ...(recipientIds ? { recipientIds } : {}),
    });
    setActing(false);
    if (!ok) {
      toast.error(json?.error?.message ?? 'That did not work. Try again.');
      return;
    }
    if (action === 'mark_sent' || action === 'resend') {
      // Settled here; the counts follow from the next batch or the refresh.
      const settled = recipientIds ?? toCheck.map((r) => r.id);
      const n = settled.length;
      setToCheck((list) => list.filter((r) => !settled.includes(r.id)));
      setCounts((c) => ({
        ...c,
        unconfirmed: Math.max(0, c.unconfirmed - n),
        ...(action === 'mark_sent' ? { sent: c.sent + n } : { pending: c.pending + n }),
      }));
    }
    const campaign = json?.campaign as
      { status?: CampaignStatus; pause_reason?: CampaignPauseReason | null } | undefined;
    if (campaign?.status) setStatus(campaign.status);
    setPauseReason(campaign?.pause_reason ?? null);
    if (action === 'pause') {
      runId.current += 1;
      driving.current = false;
      setRunning(false);
      toast.success('Paused. Nothing more goes out until you resume.');
    } else if (action === 'cancel') {
      runId.current += 1;
      driving.current = false;
      setRunning(false);
      toast.success('Cancelled. Nobody else will get it.');
      router.refresh();
    } else if (action === 'mark_sent') {
      toast.success('Marked as sent.');
      router.refresh();
    } else {
      setCapResetsAt(null);
      void run();
    }
  };

  const done = counts.sent + counts.failed + counts.unconfirmed + counts.skipped;
  const percent = counts.total ? Math.round((done / counts.total) * 100) : 0;
  const stalled = status === 'sending' && !running;
  const capped = status === 'paused' && pauseReason === 'capped';

  return (
    <Card>
      <CardContent className="space-y-4 pt-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-serif text-lg font-semibold">
            {status === 'sent'
              ? 'Sent'
              : status === 'cancelled'
                ? 'Cancelled'
                : capped
                  ? 'Paused at the daily limit'
                  : status === 'paused'
                    ? 'Paused'
                    : running
                      ? 'Sending…'
                      : initialStalled || stalled
                        ? 'Stopped'
                        : 'Not sending right now'}
          </h2>
          <p className="tabular text-sm text-[var(--fg-muted)]" aria-live="polite">
            {counts.sent} of {counts.total} sent
            {counts.failed ? ` · ${counts.failed} failed` : ''}
            {counts.unconfirmed ? ` · ${counts.unconfirmed} to check` : ''}
            {counts.skipped ? ` · ${counts.skipped} skipped` : ''}
          </p>
        </div>
        <div
          role="progressbar"
          aria-label="Campaign progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="h-2 overflow-hidden rounded-full bg-[var(--neutral-soft)]"
        >
          <div
            className="h-full rounded-full bg-[var(--primary)] transition-[width] duration-500"
            style={{ width: `${percent}%` }}
          />
        </div>

        {message ? <Notice tone="warn">{message}</Notice> : null}
        {!message && status === 'paused' && pauseReason ? (
          <Notice tone={pauseReason === 'manual' ? 'note' : 'warn'}>
            {PAUSE_REASON_TEXT[pauseReason]}
          </Notice>
        ) : null}
        {capResetsAt && (capped || status === 'sending') ? (
          <p className="text-sm text-[var(--fg-muted)]">
            The next slot opens{' '}
            {new Date(capResetsAt).toLocaleString([], {
              weekday: 'short',
              hour: 'numeric',
              minute: '2-digit',
            })}
            .
          </p>
        ) : null}
        {stalled && !message ? (
          <Notice>
            Sending stopped when the page that was sending it was closed. {counts.pending} still to
            go; nothing more is sent until you continue.
          </Notice>
        ) : null}
        {running ? (
          <p className="text-sm text-[var(--fg-muted)]">
            About one email every 2 seconds. Keep this page open: leaving it, here or for another
            part of Copilot, pauses sending.
          </p>
        ) : null}
        {toCheck.length > 0 && !running && status !== 'cancelled' ? (
          <Notice tone="warn">
            <div className="w-full space-y-2">
              <p>
                {toCheck.length} {toCheck.length === 1 ? 'email' : 'emails'} may have gone out: the
                send was interrupted after it started, so Copilot will not send{' '}
                {toCheck.length === 1 ? 'it' : 'them'} again on its own. Look in Sent in Gmail, then
                say what happened. Failed sends are separate: they did not go out.
              </p>
              <ul aria-label="May have gone out" className="space-y-1.5">
                {toCheck.slice(0, 20).map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 text-sm break-all">
                      {r.name ? `${r.name} <${r.email}>` : r.email}
                    </span>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={acting}
                      onClick={async () => {
                        const yes = await confirm({
                          title: `Mark the email to ${r.name ?? r.email} as sent?`,
                          description: 'Only if it is in Sent in Gmail.',
                          confirmLabel: 'Mark sent',
                        });
                        if (yes) void control('mark_sent', [r.id]);
                      }}
                    >
                      It went
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={acting}
                      onClick={async () => {
                        const yes = await confirm({
                          title: `Send it again to ${r.name ?? r.email}?`,
                          description: 'Only if it is not in Sent in Gmail, or they get it twice.',
                          confirmLabel: 'Send again',
                        });
                        if (yes) void control('resend', [r.id]);
                      }}
                    >
                      Send again
                    </Button>
                  </li>
                ))}
              </ul>
              {toCheck.length > 1 ? (
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={acting}
                    onClick={async () => {
                      const yes = await confirm({
                        title: `Mark all ${toCheck.length} as sent?`,
                        description: 'Only if you found every one in Sent in Gmail.',
                        confirmLabel: 'Mark all sent',
                      });
                      if (yes) void control('mark_sent');
                    }}
                  >
                    {acting ? null : <Check aria-hidden="true" />}
                    All went: mark sent
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={acting}
                    onClick={async () => {
                      const yes = await confirm({
                        title: `Send again to all ${toCheck.length}?`,
                        description: 'Only if none is in Sent in Gmail, or they get it twice.',
                        confirmLabel: 'Send again',
                      });
                      if (yes) void control('resend');
                    }}
                  >
                    <Send aria-hidden="true" />
                    None went: send again
                  </Button>
                </div>
              ) : null}
            </div>
          </Notice>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {stalled ? (
            <Button variant="primary" onClick={() => void run()} disabled={acting}>
              <Send aria-hidden="true" />
              Continue sending ({counts.pending} left)
            </Button>
          ) : null}
          {status === 'sending' && running ? (
            <Button variant="secondary" onClick={() => void control('pause')} loading={acting}>
              {acting ? null : <Pause aria-hidden="true" />}
              Pause
            </Button>
          ) : null}
          {status === 'paused' ? (
            <Button variant="primary" onClick={() => void control('resume')} loading={acting}>
              {acting ? null : <Play aria-hidden="true" />}
              Resume ({counts.pending} left)
            </Button>
          ) : null}
          {(status === 'sent' || status === 'paused') && counts.failed > 0 && !running ? (
            <Button
              variant="secondary"
              loading={acting}
              onClick={async () => {
                const yes = await confirm({
                  title: `Send again to the ${counts.failed} that failed?`,
                  description: 'Gmail did not take them, so they did not go out.',
                  confirmLabel: 'Retry',
                });
                if (yes) void control('retry_failed');
              }}
            >
              {acting ? null : <RotateCcw aria-hidden="true" />}
              Retry {counts.failed} failed
            </Button>
          ) : null}
          {status === 'sending' || status === 'paused' ? (
            <Button
              variant="ghost"
              disabled={acting}
              onClick={async () => {
                const yes = await confirm({
                  title: 'Cancel this campaign?',
                  description: `The ${counts.pending} not sent yet will not get it.`,
                  confirmLabel: 'Cancel campaign',
                  cancelLabel: 'Keep it',
                  tone: 'danger',
                });
                if (yes) void control('cancel');
              }}
            >
              <XCircle aria-hidden="true" />
              Cancel
            </Button>
          ) : null}
        </div>
        {confirmDialog}
      </CardContent>
    </Card>
  );
}
