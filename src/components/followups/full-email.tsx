'use client';

import * as React from 'react';
import { ChevronDown, ChevronUp, Loader2, Mail, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/feedback';
import { MessageBody, MessageItem, longTime } from '@/components/inbox/message-view';
import { ThreadLinks } from '@/components/email/thread-links';
import { addressOf } from '@/lib/email/addresses';
import { relativeTime } from '@/lib/util/time';
import type { FollowUpEmail } from '@/lib/services/follow-up-email';

/**
 * The full email behind a follow-up, on the Follow-ups list and beside (or,
 * on a narrower screen, above) the drafted reply in the email session. The
 * context line stays; this is the email itself: the newest message clamped
 * to a few lines behind "Show full email", the earlier ones behind "Show
 * earlier messages". Plain text through the Inbox's renderer, read from
 * Gmail on demand (/api/follow-ups/email), never while the page renders.
 * Anything without a Gmail id (a meeting from Granola) gets no control.
 */

const GMAIL_ID = /^[0-9a-f]{10,24}$/i;
/** A loaded email is reused this long, here and across the session's cards. */
const TTL_MS = 3 * 60_000;
/** The session checks Gmail again for a copy older than this: a reply goes to the newest message. */
const REVALIDATE_MS = 30_000;
/** Hovering this long over "Show email" starts the read before the click. */
const HOVER_MS = 250;

type LoadResult =
  { ok: true; email: FollowUpEmail } | { ok: false; message: string; retryable: boolean };

interface Entry {
  at: number;
  promise: Promise<LoadResult>;
  settled?: LoadResult;
}

// Shared by every panel on the page. Written only from effects and handlers,
// so it is empty when the page hydrates and the first render matches the server's.
const loads = new Map<string, Entry>();
/** The one speculative read allowed at a time (a hover, or the session's next email). */
let speculative = false;

const isEmailId = (id: string | null | undefined): id is string => Boolean(id && GMAIL_ID.test(id));

/** Whether an id leads to an email this can show (a Gmail id); anything else gets no panel. */
export const hasFullEmail = isEmailId;

/**
 * Room for what is stuck to the top of the window (the phone header, the demo
 * banner) when something is scrolled to; the desktop title bar is already in
 * the root's scroll padding.
 */
export const STICKY_CLEARANCE =
  'scroll-mt-[calc(max(var(--app-header-h),var(--app-banner-h))+0.5rem)] lg:scroll-mt-[calc(var(--app-banner-h)+0.5rem)]';

async function request(id: string, fresh: boolean): Promise<LoadResult> {
  try {
    const res = await fetch(
      `/api/follow-ups/email?id=${encodeURIComponent(id)}${fresh ? '&fresh=1' : ''}`,
    );
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      email?: FollowUpEmail;
      error?: { message?: string; retryable?: boolean };
    } | null;
    if (res.ok && body?.ok && body.email) return { ok: true, email: body.email };
    if (body?.ok === false && body.error) {
      // The app's own answer: Try again only where the server says it can help
      // (not for "Gmail isn't connected" or "needs reconnecting").
      return {
        ok: false,
        message: body.error.message ?? "Couldn't open the email.",
        retryable: body.error.retryable === true,
      };
    }
    // Not the app's JSON (a proxy's error page in front of it): a gateway may come back.
    return {
      ok: false,
      message: "Couldn't open the email.",
      retryable: [429, 502, 503, 504].includes(res.status),
    };
  } catch {
    return { ok: false, message: "Couldn't reach the app.", retryable: true };
  }
}

function start(id: string): Promise<LoadResult> {
  const now = Date.now();
  for (const [key, e] of loads) if (e.settled && now - e.at >= TTL_MS) loads.delete(key);
  const entry: Entry = { at: now, promise: request(id, false) };
  loads.set(id, entry);
  void entry.promise.then((r) => {
    if (loads.get(id) !== entry) return;
    // A failure is never kept, so Try again asks again.
    if (r.ok) entry.settled = r;
    else loads.delete(id);
  });
  return entry.promise;
}

/** The email for a follow-up id: the copy already loaded or loading, else a new read. */
export function loadFollowUpEmail(id: string): Promise<LoadResult> {
  const hit = loads.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.promise;
  return start(id);
}

/** A loaded copy and its age, or null. Never starts a read. */
export function peekFollowUpEmail(id: string): { email: FollowUpEmail; age: number } | null {
  const hit = loads.get(id);
  const age = hit ? Date.now() - hit.at : Infinity;
  return hit?.settled?.ok && age < TTL_MS ? { email: hit.settled.email, age } : null;
}

/** Ask Gmail again, past the server's copy. The cached copy stays unless a new one arrives. */
function revalidate(id: string): Promise<LoadResult> {
  return request(id, true).then((r) => {
    if (r.ok) loads.set(id, { at: Date.now(), promise: Promise.resolve(r), settled: r });
    return r;
  });
}

/**
 * Start reading an email nobody has asked for yet, so it is there when they
 * do. One at a time: every read joins the mailbox's queue in Gmail, and a
 * read someone is waiting on must not queue behind guesses.
 */
export function prefetchFollowUpEmail(id: string | null | undefined): void {
  if (!isEmailId(id) || speculative) return;
  const hit = loads.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return;
  speculative = true;
  void start(id).finally(() => {
    speculative = false;
  });
}

const bareSubject = (s: string) =>
  s
    .replace(/^\s*((re|fwd?|aw)\s*:\s*)+/i, '')
    .trim()
    .toLowerCase();

/** The same subject, "Re:" and case aside. */
export function sameSubject(a: string, b: string | null | undefined): boolean {
  return Boolean(b) && bareSubject(a) === bareSubject(b ?? '');
}

/* ------------------------------------------------------------- the panel */

interface PanelProps {
  id: string;
  /** For the Kraken and Gmail links on an error (the session only; a list row has its own). */
  mailbox?: string;
  timeZone: string;
  /** The session: loaded on mount, a stale copy checked again, Kraken and Gmail on an error. */
  auto: boolean;
  clampLines: number;
  /** True, false, or on a phone only (where the row's own subject line is cut short). */
  showSubject: boolean | 'phone';
  /** A subject already on screen (the session's "about"): not repeated. */
  knownSubject?: string;
  /** The next email to read ahead once this one is shown. */
  prefetchNext?: string | null;
  /** Under the email once it is shown (a list row's second Hide email). */
  footer?: React.ReactNode;
}

const BOX = 'rounded-md border border-[var(--border)] bg-[var(--bg)] p-3';

/**
 * The session's placeholder, shaped like the email it waits for (recipients,
 * the clamped lines, the button), so the reply below it barely moves when
 * the email arrives.
 */
function EmailSkeleton({ lines }: { lines: number }) {
  return (
    <div aria-hidden="true">
      <Skeleton className="mt-3 h-3 w-2/5" />
      {/* Lines at the text's own pitch (14 px, leading-relaxed). */}
      <div className="mt-3 space-y-[0.5625rem]">
        {Array.from({ length: lines }).map((_, i) => (
          <Skeleton key={i} className={i === lines - 1 ? 'h-3.5 w-2/3' : 'h-3.5 w-full'} />
        ))}
      </div>
      <Skeleton className="mt-3 h-8 w-32" />
    </div>
  );
}

function EmailPanel({
  id,
  mailbox,
  timeZone,
  auto,
  clampLines,
  showSubject,
  knownSubject,
  prefetchNext,
  footer,
}: PanelProps) {
  const [result, setResult] = React.useState<LoadResult | null>(() => {
    const cached = peekFollowUpEmail(id);
    return cached ? { ok: true, email: cached.email } : null;
  });
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    const cached = peekFollowUpEmail(id);
    if (cached) {
      if (auto && cached.age > REVALIDATE_MS) {
        void revalidate(id).then((r) => {
          // Only a newer message replaces what is shown; a failed check keeps it.
          if (!cancelled && r.ok && r.email.focus.id !== cached.email.focus.id) setResult(r);
        });
      }
    } else {
      void loadFollowUpEmail(id).then((r) => {
        if (!cancelled) setResult(r);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [id, attempt, auto]);

  // Read the session's next email ahead, once this one is on screen. Never
  // after a failure, which may be Gmail asking the mailbox to slow down.
  const shown = result?.ok === true;
  React.useEffect(() => {
    if (shown) prefetchFollowUpEmail(prefetchNext);
  }, [shown, prefetchNext]);

  if (!result) {
    return (
      <div className={BOX}>
        <p role="status" className="flex items-center gap-2 text-sm text-[var(--fg-muted)]">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Opening the email…
        </p>
        {auto ? <EmailSkeleton lines={clampLines} /> : null}
      </div>
    );
  }

  if (!result.ok) {
    // The session offers the thread elsewhere: Kraken's Inbox reads it its own way, or Gmail.
    const elsewhere = auto && isEmailId(id);
    return (
      <div className={BOX} role="status">
        <p className="text-sm text-[var(--danger)]">{result.message}</p>
        {result.retryable || elsewhere ? (
          <div className="mt-2 flex flex-wrap items-center gap-3">
            {result.retryable ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setResult(null);
                  setAttempt((a) => a + 1);
                }}
              >
                <RefreshCw aria-hidden /> Try again
              </Button>
            ) : null}
            {elsewhere ? (
              <ThreadLinks id={id} mailbox={mailbox} label={knownSubject} variant="text" />
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <>
      <EmailView
        email={result.email}
        timeZone={timeZone}
        clampLines={clampLines}
        showSubject={
          showSubject === 'phone'
            ? 'phone'
            : showSubject && !sameSubject(result.email.subject, knownSubject)
        }
      />
      {footer}
    </>
  );
}

function EmailView({
  email,
  timeZone,
  clampLines,
  showSubject,
}: {
  email: FollowUpEmail;
  timeZone: string;
  clampLines: number;
  showSubject: boolean | 'phone';
}) {
  const [showEarlier, setShowEarlier] = React.useState(false);
  const earlierId = React.useId();
  const { subject, focus, earlier, earlierHidden } = email;
  const before = earlier.length + earlierHidden;
  // fromUs matches the mailbox's address exactly (inbox-live.ts), so a
  // lookalike sender keeps its address on show.
  const address = focus.fromUs ? '' : addressOf(focus.from);
  return (
    <section aria-label={`Email: ${subject}`} className={`space-y-2 ${BOX}`}>
      {showSubject ? (
        <h3
          className={`text-sm font-semibold break-words ${showSubject === 'phone' ? 'sm:hidden' : ''}`}
        >
          {subject}
        </h3>
      ) : null}
      {before > 0 ? (
        <div>
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2.5"
            aria-expanded={showEarlier}
            aria-controls={showEarlier ? earlierId : undefined}
            onClick={() => setShowEarlier((v) => !v)}
          >
            {showEarlier ? <ChevronUp aria-hidden /> : <ChevronDown aria-hidden />}
            {showEarlier ? 'Hide earlier messages' : `Show earlier messages (${before})`}
          </Button>
          {showEarlier ? (
            // Oldest first and above the newest, as in Gmail and the Inbox.
            <ol id={earlierId} className="mt-1 space-y-2">
              {earlierHidden > 0 ? (
                <li className="text-xs text-[var(--fg-subtle)]">
                  {earlierHidden} older {earlierHidden === 1 ? 'message is' : 'messages are'} in
                  Gmail.
                </li>
              ) : null}
              {earlier.map((m) => (
                <MessageItem
                  key={m.id}
                  message={m}
                  startOpen={false}
                  timeZone={timeZone}
                  clampLines={4}
                />
              ))}
            </ol>
          ) : null}
        </div>
      ) : null}
      {/* The name keeps to its line and the time drops below it when both do
          not fit; on a phone the address gets a line of its own. */}
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="min-w-0 flex-[1_1_auto] text-sm">
          <span data-sender className="font-medium">
            {focus.fromName}
          </span>
          {focus.fromUs ? (
            <span className="ml-1 text-xs text-[var(--fg-subtle)]">(you)</span>
          ) : address ? (
            <span className="block text-xs break-all text-[var(--fg-subtle)] sm:ml-1 sm:inline sm:break-normal">
              {address}
            </span>
          ) : null}
        </span>
        {focus.at ? (
          <time dateTime={focus.at} className="shrink-0 text-xs text-[var(--fg-muted)]">
            {longTime(focus.at, timeZone)} · {relativeTime(focus.at)}
          </time>
        ) : null}
      </div>
      <MessageBody key={focus.id} message={focus} clampLines={clampLines} />
    </section>
  );
}

/* ---------------------------------------------------------------- places */

/**
 * The session: the email beside the drafted reply (above it on a narrower
 * screen), loaded with the card. A subject the card already shows as its
 * "about" is not repeated.
 */
export function FullEmail({
  id,
  mailbox,
  timeZone,
  knownSubject,
  prefetchNext,
}: {
  id: string | null | undefined;
  mailbox: string;
  timeZone: string;
  knownSubject?: string;
  prefetchNext?: string | null;
}) {
  if (!isEmailId(id)) return null;
  return (
    <EmailPanel
      key={id}
      id={id}
      mailbox={mailbox}
      timeZone={timeZone}
      auto
      // More than the list: Nick reads this one before he answers it.
      clampLines={6}
      showSubject
      knownSubject={knownSubject}
      prefetchNext={prefetchNext}
    />
  );
}

// One open email on the list at a time: opening a row closes the one before,
// so two or three long emails never turn the list back into a long scroll.
let openRow: string | null = null;
const rowListeners = new Set<() => void>();
function setOpenRow(row: string | null): void {
  openRow = row;
  for (const listener of rowListeners) listener();
}
function subscribeRows(listener: () => void): () => void {
  rowListeners.add(listener);
  return () => rowListeners.delete(listener);
}

/**
 * A Follow-ups row with its email behind "Show email", under the row's own
 * links. Closed, the row looks as it did; open, the email spans the card
 * below it, with a second Hide email at its foot. Without a Gmail id the row
 * is exactly as before.
 */
export function FollowUpEmailRow({
  id,
  who,
  timeZone,
  showSubject = true,
  aside,
  children,
}: {
  id: string | null | undefined;
  who: string;
  timeZone: string;
  /** False where the row already shows the subject (cut short on a phone, so shown there). */
  showSubject?: boolean;
  /** The row's own links (Kraken and Gmail), stacked above the toggle. */
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  const rowId = React.useId();
  // Every row closed while hydrating, as on the server.
  const open = React.useSyncExternalStore(
    subscribeRows,
    () => openRow === rowId,
    () => false,
  );
  const panelId = React.useId();
  const toggleRef = React.useRef<HTMLButtonElement>(null);
  const reveal = React.useRef(false);
  const hover = React.useRef<number | null>(null);
  const stopHover = () => {
    if (hover.current !== null) window.clearTimeout(hover.current);
    hover.current = null;
  };
  React.useEffect(() => {
    const timer = hover;
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      // Leaving the page: the next visit starts with every row closed.
      if (openRow === rowId) setOpenRow(null);
    };
  }, [rowId]);

  // Opening this row may have closed a long one above it, and hiding from the
  // foot of a long email leaves the row far above: bring the row back into
  // view (no scroll at all when it already is).
  React.useLayoutEffect(() => {
    if (!reveal.current) return;
    reveal.current = false;
    toggleRef.current?.scrollIntoView({ block: 'nearest' });
  }, [open]);

  if (!isEmailId(id)) {
    return (
      <CardContent className="flex items-start gap-3 pt-4">
        {children}
        {aside}
      </CardContent>
    );
  }

  const label = `${open ? 'Hide' : 'Show'} email, ${who}`;
  const toggle = () => {
    stopHover();
    reveal.current = true;
    setOpenRow(open ? null : rowId);
  };

  return (
    <CardContent className="pt-4">
      <div className="flex items-start gap-3">
        {children}
        <div className="flex shrink-0 flex-col items-end gap-3 sm:gap-1">
          {aside}
          <button
            ref={toggleRef}
            type="button"
            aria-expanded={open}
            aria-controls={open ? panelId : undefined}
            aria-label={label}
            onClick={toggle}
            // A deliberate hover, not a cursor passing over the column on its way.
            onPointerEnter={(e) => {
              if (open || e.pointerType !== 'mouse') return;
              stopHover();
              hover.current = window.setTimeout(() => prefetchFollowUpEmail(id), HOVER_MS);
            }}
            onPointerLeave={stopHover}
            // On a phone the tap target reaches past the text (44 px tall, and
            // wider) without making the row any taller.
            className={`relative inline-flex items-center gap-1 py-1 text-xs text-[var(--accent)] underline-offset-2 hover:underline max-sm:after:absolute max-sm:after:-inset-y-2.5 max-sm:after:-right-2 max-sm:after:-left-4 ${STICKY_CLEARANCE}`}
          >
            {open ? (
              <ChevronUp className="size-3" aria-hidden />
            ) : (
              <Mail className="size-3" aria-hidden />
            )}
            {open ? 'Hide email' : 'Show email'}
          </button>
        </div>
      </div>
      {open ? (
        // Full card width on a phone; under the text column from sm up.
        <div id={panelId} className="mt-3 sm:ml-7">
          <EmailPanel
            id={id}
            timeZone={timeZone}
            auto={false}
            clampLines={4}
            showSubject={showSubject ? true : 'phone'}
            footer={
              <Button
                variant="ghost"
                size="sm"
                className="mt-1 -ml-2.5"
                aria-label={label}
                onClick={toggle}
              >
                <ChevronUp aria-hidden /> Hide email
              </Button>
            }
          />
        </div>
      ) : null}
    </CardContent>
  );
}
