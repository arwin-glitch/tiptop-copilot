'use client';

import * as React from 'react';
import Link from 'next/link';
import { BellRing, HeartHandshake, Inbox, X } from 'lucide-react';

/**
 * One-time "new while you were out" card for Nick's first visit after his
 * leave. Dismissed per device; gone for everyone after SHOW_UNTIL.
 */
const DISMISS_KEY = 'welcome-back-oct-2026';
const SHOW_UNTIL = Date.parse('2026-11-01T00:00:00Z');

const STEPS = [
  {
    icon: Inbox,
    title: 'Email session',
    body: 'Follow-ups › Start. One email at a time with the reply already drafted. Send goes out from your inbox, signed as you or as Arwin. It starts with the 10 most urgent minutes.',
    href: '/follow-ups/session',
    cta: 'Start',
  },
  {
    icon: BellRing,
    title: 'Phone alerts',
    body: 'Settings › Preferences › Phone alerts. A ping only when something needs you, 8am to 8pm, once per thing.',
    href: '/settings',
    cta: 'Set up',
  },
  {
    icon: HeartHandshake,
    title: 'Waiting on you',
    body: 'Follow-ups lists the LPs, founders and co-investors who asked you something and haven’t heard back.',
    href: '/follow-ups',
    cta: 'Look',
  },
] as const;

function readShouldShow(): boolean {
  if (Date.now() > SHOW_UNTIL) return false;
  try {
    return !window.localStorage.getItem(DISMISS_KEY);
  } catch {
    // Storage blocked: show it; "Got it" still hides it for this visit.
    return true;
  }
}

const noSubscribe = () => () => {};

export function WelcomeBack() {
  // Server render says "hidden", so it never flashes on a device that dismissed it.
  const stored = React.useSyncExternalStore(noSubscribe, readShouldShow, () => false);
  const [dismissed, setDismissed] = React.useState(false);

  if (!stored || dismissed) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISS_KEY, new Date().toISOString());
    } catch {
      // Private window: it comes back next visit, which is harmless.
    }
  };

  return (
    <section
      aria-labelledby="welcome-back-heading"
      className="mb-6 rounded-[var(--radius-card)] border border-[var(--border-strong)] bg-[var(--bg-raised)] p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="welcome-back-heading" className="text-base font-semibold">
            Welcome back. Three things are new.
          </h2>
          <p className="text-sm text-[var(--fg-muted)]">
            Everything refreshes on its own every day. Nothing sends unless you tap Send.
          </p>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          className="rounded-md p-1 text-[var(--fg-muted)] hover:bg-[var(--bg-hover)]"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
      <ol className="mt-4 grid gap-3 sm:grid-cols-3">
        {STEPS.map((step, i) => (
          <li
            key={step.title}
            className="flex min-w-0 flex-col gap-2 rounded-md border border-[var(--border)] p-3"
          >
            <div className="flex items-center gap-2">
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-[var(--accent)] text-xs font-semibold text-[var(--accent-fg)]">
                {i + 1}
              </span>
              <step.icon className="size-4 text-[var(--fg-muted)]" aria-hidden />
              <span className="font-medium">{step.title}</span>
            </div>
            <p className="flex-1 text-sm text-[var(--fg-muted)]">{step.body}</p>
            <Link
              href={step.href}
              className="self-start text-sm font-medium text-[var(--accent)] underline-offset-2 hover:underline"
            >
              {step.cta} →
            </Link>
          </li>
        ))}
      </ol>
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          onClick={dismiss}
          className="inline-flex h-8 items-center rounded-md bg-[var(--accent)] px-3 text-sm font-medium text-[var(--accent-fg)] hover:opacity-90"
        >
          Got it
        </button>
      </div>
    </section>
  );
}
