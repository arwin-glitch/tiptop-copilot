'use client';

import * as React from 'react';
import { X } from 'lucide-react';
import {
  REPLY_NOTICE_MS,
  newestArrival,
  replyHeadline,
  replyKey,
  type ReplyNotice,
} from '@/lib/chat/reply-notice';
import { cn } from '@/lib/util/cn';

/**
 * "Arwin replied": the pop-up for an answer that landed out of sight.
 *
 * Arwin's mark, the headline, the answer's first line and the question it
 * answers. It stays about three and a half seconds, then sinks away; a hover
 * or keyboard focus holds it, and leaving lets the clock run on. So does being
 * out of sight (its corner steps aside while another dialog, such as the inbox
 * composer, is open): the clock only runs while it can be read. Clicking it
 * opens the conversation; the X (or Esc on it) dismisses it. It never takes
 * focus: the launcher's dot and a polite announcement do the rest.
 *
 * - `launcher`: above the Ask Arwin launcher, its tail pointing at it.
 * - `panel`: over the top of the open panel, which is modal and covers the launcher.
 * - `page`: on the full Ask page, which has no launcher.
 */

/** How long the way out takes; matches `animate-sink`. */
const LEAVE_MS = 200;
/** Once released by a hover, enough time to see it go. */
const RESUME_MIN_MS = 1_000;

export type ReplyNoticePlacement = 'launcher' | 'panel' | 'page';

export function ReplyNoticeCard({
  notice,
  placement,
  onOpen,
  onDismiss,
  onFocusOut,
  className,
}: {
  notice: ReplyNotice;
  placement: ReplyNoticePlacement;
  onOpen: (threadId: string) => void;
  onDismiss: () => void;
  /** Somewhere for focus to go when the pop-up goes from under it. */
  onFocusOut?: () => void;
  className?: string;
}) {
  const key = replyKey(notice);
  const newest = newestArrival(notice);
  const headline = replyHeadline(notice);
  const preview = newest.preview;

  const [hovered, setHovered] = React.useState(false);
  const [focused, setFocused] = React.useState(false);
  const [leaving, setLeaving] = React.useState(false);
  /** Laid out on screen; false while its corner is hidden. */
  const [inView, setInView] = React.useState(true);
  const paused = hovered || focused || !inView;

  // A new answer joining, or a hover catching it on the way out, brings it back.
  const [shownKey, setShownKey] = React.useState(key);
  if (key !== shownKey) {
    setShownKey(key);
    setLeaving(false);
  }
  if (paused && leaving) setLeaving(false);

  const rootRef = React.useRef<HTMLDivElement>(null);
  const remaining = React.useRef(REPLY_NOTICE_MS);
  const dismissRef = React.useRef(onDismiss);
  React.useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  // Hidden (display: none) it has no box, so it stops intersecting the
  // viewport; shown again, it does. No polling, and no say in what hides it.
  React.useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      if (last) setInView(last.isIntersecting);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Each new answer gets the full time.
  React.useEffect(() => {
    remaining.current = REPLY_NOTICE_MS;
  }, [key]);

  React.useEffect(() => {
    if (paused || leaving) return;
    const started = Date.now();
    const wait =
      remaining.current < REPLY_NOTICE_MS
        ? Math.max(remaining.current, RESUME_MIN_MS)
        : remaining.current;
    const timer = window.setTimeout(() => {
      remaining.current = 0;
      if (prefersReducedMotion()) dismissRef.current();
      else setLeaving(true);
    }, wait);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - started));
    };
  }, [paused, leaving, key]);

  React.useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => dismissRef.current(), LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);

  const close = React.useCallback(() => {
    const hadFocus = rootRef.current?.contains(document.activeElement) ?? false;
    onDismiss();
    if (hadFocus) onFocusOut?.();
  }, [onDismiss, onFocusOut]);

  return (
    <div
      ref={rootRef}
      data-ask-reply=""
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        // Esc here dismisses the pop-up; it is not passed on to a page shortcut.
        event.stopPropagation();
        event.preventDefault();
        close();
      }}
      className={cn(
        'shadow-lifted pointer-events-auto relative rounded-2xl border border-[var(--border-strong)] bg-[var(--bg-overlay)] text-[var(--fg)]',
        leaving ? 'motion-safe:animate-sink' : 'motion-safe:animate-rise',
        placement === 'panel' ? 'w-full' : 'w-[min(22rem,calc(100vw-2rem))]',
        className,
      )}
    >
      <button
        type="button"
        onClick={() => onOpen(newest.threadId)}
        aria-label={`${headline}: ${preview || 'the answer is ready'}. Open the conversation.`}
        className="flex w-full items-start gap-3 rounded-2xl p-3 pr-12 text-left transition-colors duration-[var(--motion-instant)] hover:bg-[var(--bg-hover)] focus-visible:-outline-offset-2 lg:pr-10"
      >
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--jewel)] font-serif text-base font-semibold text-[var(--jewel-fg)] ring-1 ring-[var(--gold)]"
        >
          A
        </span>
        <span className="min-w-0 flex-1 pt-px">
          <span className="block text-sm leading-snug font-semibold">{headline}</span>
          <span
            data-ask-reply-preview=""
            className="text-note mt-0.5 line-clamp-2 block text-[var(--fg-muted)]"
          >
            {preview || 'The answer is ready to read.'}
          </span>
          {newest.question ? (
            <span className="text-micro mt-1 block truncate text-[var(--fg-subtle)]">
              You asked: {newest.question}
            </span>
          ) : null}
        </span>
      </button>
      <button
        type="button"
        onClick={close}
        aria-label="Dismiss"
        title="Dismiss"
        className="absolute top-0.5 right-0.5 flex size-11 items-center justify-center rounded-full text-[var(--fg-muted)] transition-colors duration-[var(--motion-instant)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)] lg:top-1.5 lg:right-1.5 lg:size-8"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
      {placement === 'launcher' ? (
        // The tail, pointing down at the middle of the launcher.
        <span
          aria-hidden="true"
          className="absolute right-[1.375rem] -bottom-[7px] size-3 rotate-45 border-r border-b border-[var(--border-strong)] bg-[var(--bg-overlay)]"
        />
      ) : null}
      {/* The time left, as a gold line that empties; it stops while held. */}
      <span
        key={key}
        aria-hidden="true"
        className="motion-safe:animate-drain pointer-events-none absolute inset-x-4 bottom-1 h-0.5 origin-left rounded-full bg-[var(--gold)] opacity-70 motion-reduce:hidden"
        style={{
          animationDuration: `${REPLY_NOTICE_MS}ms`,
          animationPlayState: paused ? 'paused' : 'running',
        }}
      />
    </div>
  );
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
