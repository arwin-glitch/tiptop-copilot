'use client';

import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/feedback';
import {
  MATCH_CODE_RE,
  normalizeMatchCode,
  type DesktopFlowStatus,
  type DesktopVerifyStatus,
} from '@/lib/desktop/shared';
import { onIosEvent } from '@/lib/ios/native';
import { parseIosSignInReturn } from '@/lib/ios/shared';
import { useIosApp } from '@/lib/ios/use-ios-app';
import type { DesktopHandoffFailure } from '@/lib/types/domain';

type StopReason = DesktopHandoffFailure | 'expired' | 'unavailable';

type Phase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'waiting'; url: string; deadline: number }
  | { kind: 'code'; url: string; deadline: number }
  | { kind: 'done' }
  | { kind: 'stopped'; reason: StopReason };

const STOPPED: Record<StopReason, string> = {
  cancelled: 'Sign-in was cancelled in the browser.',
  no_code: 'Sign-in didn’t finish.',
  wrong_code: 'That code didn’t match three times, so sign-in stopped to keep you safe.',
  rejected: 'Sign-in was stopped in the browser.',
  superseded: 'A newer sign-in replaced this one.',
  exchange: 'Sign-in didn’t finish.',
  domain: 'That Google account isn’t a TipTop account. Try again and pick your TipTop account.',
  expired: 'That took too long.',
  unavailable: 'Sign-in isn’t available right now. Try again in a minute.',
};

const POLL_MS = 2_000;
const MAX_BACKOFF_MS = 15_000;
/** How long a sign-in stays open on the server (HANDOFF_TTL_MS). */
const SIGN_IN_MS = 10 * 60_000;

/**
 * Sign in from the desktop app (lib/auth/desktop-handoff.ts).
 *
 * Google will not sign anyone in inside the app's window, so this asks the
 * server for a sign-in URL and navigates to it: the shell sees a host that is
 * not Copilot's, opens the system browser instead and keeps this page where
 * it is. The browser ends on a page showing a 4-character code, which the
 * person types here; a right code signs this window in.
 *
 * Meanwhile it polls (every 2 seconds, at once when the window regains focus,
 * backing off while Copilot cannot be reached) so it notices the code is
 * ready, or that the browser cancelled. Only a real outcome ends an attempt:
 * a failed check just says "Reconnecting…" and tries again.
 *
 * The iPhone app signs in the same way, with Safari as the browser. There
 * the code page also offers "Open TipTop Copilot", a link back to the app
 * carrying the code (lib/ios/shared.ts), which this then types in for the
 * person. Only while this sign-in is open: a code arriving any other time is
 * ignored, and /api/auth/desktop/verify still needs this app's own poll
 * cookie, so a link from anywhere else can at worst use up one try.
 */
export function DesktopSignIn() {
  const ios = Boolean(useIosApp());
  const [phase, setPhase] = React.useState<Phase>({ kind: 'idle' });
  const [reconnecting, setReconnecting] = React.useState(false);
  const [code, setCode] = React.useState('');
  const [codeError, setCodeError] = React.useState<string | null>(null);
  const [verifying, setVerifying] = React.useState(false);
  // A code the browser handed back to the iPhone app, until it can be used.
  const returnedRef = React.useRef<string | null>(null);

  const finish = React.useCallback(() => {
    setPhase({ kind: 'done' });
    window.location.replace('/today');
  }, []);

  const verify = async (typed: string) => {
    setVerifying(true);
    setCodeError(null);
    try {
      const response = await fetch('/api/auth/desktop/verify', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: typed }),
      });
      const body = (await response.json().catch(() => null)) as {
        ok?: boolean;
        value?: DesktopVerifyStatus;
        error?: { message?: string };
      } | null;
      if (!response.ok || !body?.ok || !body.value) {
        setCodeError(
          response.status === 400 && body?.error?.message
            ? body.error.message
            : 'Couldn’t check the code just now. Try again.',
        );
        return;
      }
      const view = body.value;
      switch (view.status) {
        case 'signed_in':
          finish();
          return;
        case 'wrong_code':
          setCode('');
          setCodeError(
            `That code didn’t match. ${view.attemptsLeft} ${view.attemptsLeft === 1 ? 'try' : 'tries'} left.`,
          );
          return;
        case 'waiting':
        case 'enter_code':
          setCodeError('Your browser hasn’t finished yet. Wait a moment, then try again.');
          return;
        case 'expired':
          setPhase({ kind: 'stopped', reason: 'expired' });
          return;
        case 'failed':
          setPhase({ kind: 'stopped', reason: view.reason });
          return;
      }
    } catch {
      setCodeError('Couldn’t reach Copilot. Try again.');
    } finally {
      setVerifying(false);
    }
  };

  const start = async () => {
    setPhase({ kind: 'starting' });
    setReconnecting(false);
    setCode('');
    setCodeError(null);
    returnedRef.current = null;
    try {
      const response = await fetch('/api/auth/desktop/start', {
        method: 'POST',
        cache: 'no-store',
      });
      const body = (await response.json().catch(() => null)) as {
        ok?: boolean;
        value?: { url?: string };
      } | null;
      const url = body?.value?.url;
      if (!response.ok || !body?.ok || typeof url !== 'string') {
        setPhase({ kind: 'stopped', reason: 'unavailable' });
        return;
      }
      setPhase({ kind: 'waiting', url, deadline: Date.now() + SIGN_IN_MS });
      // Never window.open: WKWebView blocks it without a fresh user gesture.
      window.location.assign(url);
    } catch {
      setPhase({ kind: 'stopped', reason: 'unavailable' });
    }
  };

  const active = phase.kind === 'waiting' || phase.kind === 'code';
  const deadline = phase.kind === 'waiting' || phase.kind === 'code' ? phase.deadline : 0;

  // The iPhone app: Safari's "Open TipTop Copilot" brings the code back. The
  // app holds a link until something listens, so this listens from the start
  // and drops a code that arrives with no sign-in open (one left over from
  // before the app restarted would only use up a try of the next sign-in).
  // It is typed in once the poll has seen the browser finish (coming back to
  // the app checks at once), and never while a code is being checked.
  const typeReturnedCode = React.useEffectEvent(() => {
    const value = returnedRef.current;
    if (!value || verifying) return;
    returnedRef.current = null;
    setCode(value);
    void verify(value);
  });
  const takeReturnedCode = React.useEffectEvent((data: unknown) => {
    const value = parseIosSignInReturn((data as { url?: unknown } | null)?.url);
    if (!value || !active) return;
    returnedRef.current = value;
    if (phase.kind === 'code') typeReturnedCode();
  });
  React.useEffect(() => {
    if (!ios) return;
    return onIosEvent('App', 'appUrlOpen', (data) => takeReturnedCode(data)) ?? undefined;
  }, [ios]);

  React.useEffect(() => {
    if (!active) return;
    let disposed = false;
    let inFlight = false;
    let failures = 0;
    let timer = 0;

    const apply = (view: DesktopFlowStatus) => {
      switch (view.status) {
        case 'waiting':
          return;
        case 'enter_code':
          setPhase((current) =>
            current.kind === 'waiting'
              ? { kind: 'code', url: current.url, deadline: current.deadline }
              : current,
          );
          // The iPhone app may already have the code from Safari.
          typeReturnedCode();
          return;
        case 'signed_in':
          disposed = true;
          finish();
          return;
        case 'expired':
          setPhase({ kind: 'stopped', reason: 'expired' });
          return;
        case 'failed':
          setPhase({ kind: 'stopped', reason: view.reason });
          return;
      }
    };

    async function check() {
      if (disposed || inFlight) return;
      if (Date.now() >= deadline) {
        setPhase({ kind: 'stopped', reason: 'expired' });
        return;
      }
      inFlight = true;
      try {
        const response = await fetch('/api/auth/desktop/poll', {
          method: 'POST',
          cache: 'no-store',
          signal: AbortSignal.timeout(10_000),
        });
        // 429 and server faults are "try again", not an outcome.
        if (!response.ok) throw new Error(`poll answered ${response.status}`);
        const body = (await response.json()) as { ok?: boolean; value?: DesktopFlowStatus };
        if (disposed) return;
        if (!body.ok || !body.value) throw new Error('poll answered without a status');
        failures = 0;
        setReconnecting(false);
        apply(body.value);
      } catch {
        if (disposed) return;
        failures++;
        setReconnecting(true);
      } finally {
        inFlight = false;
        if (!disposed) {
          window.clearTimeout(timer);
          timer = window.setTimeout(
            () => void check(),
            failures ? Math.min(POLL_MS * 2 ** failures, MAX_BACKOFF_MS) : POLL_MS,
          );
        }
      }
    }

    // Coming back from the browser: check at once, since a hidden window's
    // timers may have been slowed down.
    const onFocus = () => void check();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    timer = window.setTimeout(() => void check(), POLL_MS);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [active, deadline, finish]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Each code sent uses one of the three tries, so never send one twice.
    if (verifying) return;
    const typed = normalizeMatchCode(code);
    if (!MATCH_CODE_RE.test(typed)) {
      setCodeError('Type the 4 characters your browser shows.');
      return;
    }
    await verify(typed);
  };

  const status =
    phase.kind === 'waiting'
      ? reconnecting
        ? 'Reconnecting…'
        : 'Waiting for your browser…'
      : phase.kind === 'code' && reconnecting
        ? 'Reconnecting…'
        : phase.kind === 'done'
          ? 'Signing you in…'
          : '';

  const again =
    phase.kind === 'waiting' || phase.kind === 'code' ? (
      <p className="text-sm text-[var(--fg-muted)]">
        <a className="underline underline-offset-4" href={phase.url}>
          Browser didn’t open? Open it again
        </a>
        <span aria-hidden="true"> · </span>
        <button type="button" className="underline underline-offset-4" onClick={() => void start()}>
          Start over
        </button>
      </p>
    ) : null;

  return (
    <div className="space-y-3" data-desktop-sign-in={phase.kind}>
      {phase.kind === 'idle' || phase.kind === 'starting' ? (
        <>
          <Button
            variant="primary"
            size="lg"
            className="w-full"
            loading={phase.kind === 'starting'}
            onClick={() => void start()}
          >
            Sign in with Google
          </Button>
          <p className="text-sm text-[var(--fg-muted)]">
            {ios
              ? 'Your browser opens so you can sign in there. Then it brings you back here.'
              : 'Your web browser opens so you can sign in there. Then come back here.'}
          </p>
        </>
      ) : null}

      {phase.kind === 'waiting' ? (
        <>
          <h2 className="text-title font-serif font-semibold">
            Finish signing in using your browser
          </h2>
          <p className="text-sm text-[var(--fg-muted)]">
            {ios
              ? 'Sign in with Google in the browser that just opened. Then tap Open TipTop Copilot there, or type the 4-character code it shows here.'
              : 'Sign in with Google in the browser window that just opened. It then shows a 4-character code for you to type here.'}
          </p>
        </>
      ) : null}

      {phase.kind === 'code' ? (
        <form onSubmit={(event) => void submit(event)} className="space-y-3" noValidate>
          <h2 className="text-title font-serif font-semibold">Type the code from your browser</h2>
          <p className="text-sm text-[var(--fg-muted)]">
            Only type a code your own browser is showing you right now.
          </p>
          <label htmlFor="desktop-sign-in-code" className="block text-sm font-medium">
            Sign-in code
          </label>
          <input
            id="desktop-sign-in-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            // Mounted by the switch to this step, so focus lands here.
            autoFocus
            autoComplete="one-time-code"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            maxLength={9}
            aria-invalid={codeError ? true : undefined}
            aria-describedby={codeError ? 'desktop-sign-in-code-error' : undefined}
            className="block h-14 w-full rounded-md border border-[var(--border-control)] bg-[var(--bg-raised)] pl-[0.4em] text-center font-mono text-3xl font-semibold tracking-[0.4em] text-[var(--fg)] uppercase focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:outline-none"
          />
          {codeError ? (
            <p
              id="desktop-sign-in-code-error"
              role="alert"
              className="text-sm text-[var(--danger)]"
            >
              {codeError}
            </p>
          ) : null}
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={verifying}>
            Sign in
          </Button>
        </form>
      ) : null}

      {phase.kind === 'stopped' ? (
        <Notice tone="warn">
          <p>{STOPPED[phase.reason]}</p>
          <Button variant="secondary" size="sm" className="mt-2" onClick={() => void start()}>
            Try again
          </Button>
        </Notice>
      ) : null}

      <p
        role="status"
        className="flex items-center gap-2 text-sm text-[var(--fg-muted)] empty:hidden"
      >
        {status ? (
          <>
            {phase.kind === 'done' || !reconnecting ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : null}
            {status}
          </>
        ) : null}
      </p>

      {again}
    </div>
  );
}
