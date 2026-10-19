import 'server-only';
import { z } from 'zod';
import { getStore } from '@/lib/runtime';
import { clientAddress } from '@/lib/security/client-address';
import { rateLimit } from '@/lib/security/limits';
import { log } from '@/lib/security/redact';
import {
  authenticateDesktopToken,
  desktopAlertsFor,
  parseDesktopToken,
  recordDesktopDelivery,
  removeDesktopDevice,
  shellTakesAskReplies,
} from '@/lib/services/desktop-alerts';
import { processWide } from '@/lib/util/process-state';

/**
 * /api/desktop/alerts: what the desktop app's shell asks with its token, with
 * no session (lib/services/desktop-alerts.ts, D-057).
 *
 *   GET     the alerts due for this computer, and when to ask again (Ask
 *           Arwin answers only to a shell from 0.4.1, by its User-Agent)
 *   POST    { delivered: keys[] }: which ones it showed (its ledger)
 *   DELETE  turn alerts off for this computer (Turn off, signing out)
 *
 * The shell forgets its token on a 401 that carries this realm, and only on
 * one, so every 401 here does, and nothing but a refused token is answered
 * 401: a store that cannot be read is 503 with Retry-After.
 *
 * Brakes, in the order they apply: an address that sent
 * DESKTOP_AUTH_FAILURES_PER_MINUTE bad tokens in a minute has further bad
 * ones answered 429 (a malformed one without a database read), as on
 * /api/mcp; then, only once the token checks out, DESKTOP_RATE_PER_MINUTE
 * requests a minute per computer. Device ids are not secret, so a limit
 * charged before the token is checked would let anyone use up a colleague's
 * computer's minute and make it miss a meeting; and a device id is unique
 * only within one organization, so the limit is keyed on both (anyone can
 * turn on the same id in an organization of their own).
 *
 * Logs carry counts only: never a token, a title or a body.
 */

export const DESKTOP_RATE_PER_MINUTE = 20;
export const DESKTOP_AUTH_FAILURES_PER_MINUTE = 10;
/** Larger bodies are refused unread; a real report is a few hundred bytes. */
export const DESKTOP_MAX_BODY_BYTES = 64 * 1024;
const REALM = 'Bearer realm="tiptop-copilot"';

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
} as const;

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } });
}

function fail(
  status: number,
  code: string,
  message: string,
  extra: Record<string, string> = {},
): Response {
  return json({ ok: false, error: { code, message } }, status, extra);
}

/* --------------------------------------------------------- failed tokens */

interface FailureWindow {
  count: number;
  resetAt: number;
}

const failures = processWide(
  'desktop-alerts-auth-failures',
  () => new Map<string, FailureWindow>(),
);

function lockedOut(address: string, now: number): number | null {
  const window = failures.get(address);
  if (!window || window.resetAt <= now) return null;
  return window.count >= DESKTOP_AUTH_FAILURES_PER_MINUTE
    ? Math.ceil((window.resetAt - now) / 1000)
    : null;
}

function recordFailure(address: string, now: number): void {
  const window = failures.get(address);
  if (!window || window.resetAt <= now) {
    failures.set(address, { count: 1, resetAt: now + 60_000 });
    if (failures.size > 10_000) {
      for (const [key, value] of failures) if (value.resetAt <= now) failures.delete(key);
    }
  } else {
    window.count += 1;
  }
}

/** Test hook. */
export function resetDesktopAlertLimiters(): void {
  failures.clear();
}

/* ---------------------------------------------------------------- request */

const DELIVERED = z.object({
  delivered: z.array(z.string().min(1).max(200)).max(200),
});

async function readBody(request: Request): Promise<{ text: string } | { tooLarge: true }> {
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > DESKTOP_MAX_BODY_BYTES) return { tooLarge: true };
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > DESKTOP_MAX_BODY_BYTES) return { tooLarge: true };
  return { text };
}

export type DesktopAlertsMethod = 'GET' | 'POST' | 'DELETE';

/**
 * Answer one request to /api/desktop/alerts.
 * `now` is injectable for tests; everything else comes from the request.
 */
export async function handleDesktopAlerts(
  request: Request,
  method: DesktopAlertsMethod,
  now: () => Date = () => new Date(),
): Promise<Response> {
  const address = clientAddress(request.headers);
  const startedAt = now().getTime();
  const wait = lockedOut(address, startedAt);
  const tooManyFailures = () =>
    fail(429, 'rate_limited', `Too many invalid tokens from this address. Try again in ${wait}s.`, {
      'Retry-After': String(wait),
    });

  const header = request.headers.get('authorization');
  const token = header ? (/^Bearer\s+(\S+)\s*$/i.exec(header)?.[1] ?? null) : null;
  if (!token) {
    return fail(401, 'unauthenticated', 'Missing token.', { 'WWW-Authenticate': REALM });
  }
  if (wait !== null && !parseDesktopToken(token)) return tooManyFailures();

  const store = getStore();
  const auth = await authenticateDesktopToken(store, token);
  if (!auth.ok) {
    if (auth.error.code === 'unauthenticated') {
      if (auth.error.details?.reason !== 'revoked') {
        if (wait !== null) return tooManyFailures();
        recordFailure(address, startedAt);
      }
      return fail(401, 'unauthenticated', auth.error.message, {
        'WWW-Authenticate': `${REALM}, error="invalid_token"`,
      });
    }
    return fail(503, 'provider_unavailable', auth.error.message, { 'Retry-After': '60' });
  }
  const caller = auth.value;

  const limited = rateLimit(
    `desktop-alerts:${caller.organizationId}:${caller.device}`,
    DESKTOP_RATE_PER_MINUTE,
    60_000,
    startedAt,
  );
  if (!limited.ok) {
    const seconds = Number(limited.error.details?.retry_after_seconds ?? 60);
    return fail(429, 'rate_limited', `Too many requests. Try again in ${seconds}s.`, {
      'Retry-After': String(seconds),
    });
  }

  try {
    if (method === 'GET') {
      const { alerts, pollAfterSeconds } = await desktopAlertsFor(store, caller, now(), {
        askReplies: shellTakesAskReplies(request.headers.get('user-agent')),
      });
      if (alerts.length) log.info('Desktop alerts due', { count: alerts.length });
      return json({ ok: true, alerts, pollAfterSeconds });
    }
    if (method === 'POST') {
      const read = await readBody(request);
      if ('tooLarge' in read) return fail(413, 'too_large', 'The request body is too large.');
      let body: unknown;
      try {
        body = JSON.parse(read.text);
      } catch {
        return fail(400, 'invalid_input', 'The request body is not valid JSON.');
      }
      const parsed = DELIVERED.safeParse(body);
      if (!parsed.success) return fail(400, 'invalid_input', 'Expected { delivered: string[] }.');
      const { recorded } = await recordDesktopDelivery(
        store,
        caller.organizationId,
        caller.device,
        parsed.data.delivered,
        now(),
      );
      if (recorded) log.info('Desktop alerts delivered', { count: recorded });
      return json({ ok: true, recorded });
    }
    await removeDesktopDevice(
      store,
      caller.organizationId,
      caller.device,
      { userId: caller.userId },
      'app',
    );
    return json({ ok: true });
  } catch (error) {
    log.warn('Desktop alerts request failed', {
      method,
      reason: error instanceof Error ? error.message : String(error),
    });
    return fail(503, 'provider_unavailable', 'Desktop alerts could not be read just now.', {
      'Retry-After': '60',
    });
  }
}
