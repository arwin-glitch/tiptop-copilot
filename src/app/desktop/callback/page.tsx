import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { rejectDesktopSignInAction } from '@/app/actions/desktop-handoff';
import { AuthShell } from '@/components/desktop/auth-shell';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/feedback';
import { demoHandoffs, receiveCode, type CallbackView } from '@/lib/auth/desktop-handoff';
import { getStore } from '@/lib/runtime';
import { addressKey } from '@/lib/security/client-address';
import { rateLimit } from '@/lib/security/limits';

// No `referrer` here: a POST from a page with a no-referrer policy sends
// `Origin: null`, which Next's Server Action check refuses. The site-wide
// strict-origin-when-cross-origin already keeps the query string to this page.
export const metadata: Metadata = {
  title: 'Desktop sign-in',
  robots: { index: false, follow: false },
};
export const dynamic = 'force-dynamic';

const MESSAGES: Record<
  Exclude<CallbackView['kind'], 'show'> | 'busy',
  { title: string; detail: string }
> = {
  shown: {
    title: 'This code was already shown',
    detail:
      'Use the browser tab that showed it first, or click Sign in with Google again in the app.',
  },
  finished: { title: 'This sign-in is finished', detail: 'You can close this tab.' },
  cancelled: {
    title: 'Sign-in was cancelled',
    detail: 'Nothing changed. Go back to the app to try again. You can close this tab.',
  },
  superseded: {
    title: 'There’s a newer sign-in',
    detail: 'Use the newest browser tab, or click Sign in with Google again in the app.',
  },
  stopped: {
    title: 'This sign-in was stopped',
    detail: 'Go back to the app and click Sign in with Google again.',
  },
  expired: {
    title: 'This sign-in link has expired',
    detail:
      'Go back to the TipTop Copilot app and click Sign in with Google again. You can close this tab.',
  },
  busy: { title: 'Too many tries', detail: 'Wait a minute, then try again from the app.' },
  unavailable: {
    title: 'Sign-in isn’t available right now',
    detail: 'Try again in a few minutes.',
  },
};

function one(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Where Google sends the system browser during a desktop app sign-in
 * (lib/auth/desktop-handoff.ts). It never signs this browser in: it seals
 * Google's code for the app and shows the short code the person types there.
 */
export default async function DesktopCallbackPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  let view: CallbackView | { kind: 'busy' };
  if (!rateLimit(`desktop-callback:${addressKey(await headers())}`, 60, 60_000).ok) {
    view = { kind: 'busy' };
  } else {
    try {
      const result = await receiveCode(getStore(), {
        handoffId: one(params.h),
        code: one(params.code),
        providerError: Boolean(one(params.error)),
        demo: demoHandoffs(),
      });
      view = result.ok ? result.value : { kind: 'unavailable' };
    } catch {
      view = { kind: 'unavailable' };
    }
  }

  if (view.kind !== 'show') {
    const message = MESSAGES[view.kind];
    return (
      <AuthShell title={message.title}>
        <p className="mt-1.5 text-sm text-[var(--fg-muted)]">{message.detail}</p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Your sign-in code"
      footer="This page never signs this browser in. The app signs in once you type the code there."
    >
      <p className="mt-1.5 text-sm text-[var(--fg-muted)]">
        Type this code into the TipTop Copilot app on this computer.
      </p>
      <output
        data-testid="desktop-match-code"
        aria-label="Your sign-in code"
        className="mt-5 block rounded-md border border-[var(--border-strong)] bg-[var(--bg-sunken)] py-4 pl-[0.4em] text-center font-mono text-4xl font-semibold tracking-[0.4em] text-[var(--fg)]"
      >
        {view.matchCode}
      </output>
      <p className="mt-3 text-sm text-[var(--fg-muted)]">
        It works for the next few minutes. Once the app has signed in, you can close this tab.
      </p>
      <Notice tone="warn" className="mt-4">
        <p className="font-medium">
          Only type this code if you just clicked Sign in with Google in the app yourself.
        </p>
        <p className="mt-1 text-[var(--fg-muted)]">
          Never read this code out or send it to anyone, even someone who says they are from TipTop.
        </p>
      </Notice>
      <form action={rejectDesktopSignInAction} className="mt-4">
        <input type="hidden" name="h" value={view.handoffId} />
        <Button type="submit" variant="ghost" size="sm">
          I didn’t start this
        </Button>
      </form>
    </AuthShell>
  );
}
