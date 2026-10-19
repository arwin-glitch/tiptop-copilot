import 'server-only';
import type { DataStore } from '@/lib/db/store';
import { getAccessToken } from '@/lib/google/oauth';
import type { Integration } from '@/lib/types/domain';
import { processWide } from '@/lib/util/process-state';
import { err, ok, type AppError, type Result } from '@/lib/util/result';

/**
 * One read-only GET against the Gmail API, for the read modules
 * (gmail-inbox.ts, gmail-metadata.ts). Read scope only; gmail-send.ts is the
 * only module that writes.
 *
 * Interactive reads (a page, the Inbox, Ask) fail fast: one try, and any
 * non-2xx is an error. A background read that nobody waits on (the asks
 * reader, the numbers refresh) opts in to `retry`: Gmail's per-user rate
 * limit (429, or 403 with the reason rateLimitExceeded or
 * userRateLimitExceeded) and its 500, 502, 503 and 504 are tried again, up to
 * four tries in all, after Retry-After when Gmail sends one, or else after a
 * backoff that starts near a second and doubles, with jitter. A single wait
 * is capped at 20 s, no wait starts that would end after the caller's
 * deadline, and 400, 401, 404 and every other 4xx are never tried again. A
 * background request gives up after 30 s, or when the caller's deadline
 * comes if that is sooner; the 30 s timeout, or Gmail being unreachable, is
 * tried again the same way.
 *
 * One read a person waits on opts in too: the full email on Follow-ups and in
 * the email session (follow-up-email.ts), with an 8 s deadline. It is fetched
 * only when asked for, after the page has drawn, so it waits its turn behind
 * the mailbox's background reads instead of adding to a burst, and with
 * `retry.front` it takes the first free place rather than the last.
 *
 * Gmail's rate limit is per mailbox, not per reader, so the background reads
 * of one mailbox share one gate in this process, whichever reader asks: at
 * most BACKGROUND_CONCURRENCY at once, the rest queued in turn, and after a
 * rate limit none starts until the wait it called for is over. Two readers
 * running together (the numbers refresh and the asks read, from the daily job
 * or one Portfolio view) then pace each other rather than doubling the burst.
 * Other interactive reads never queue here.
 *
 * Every failure carries Gmail's status in `error.details` (and `reason:
 * 'rate_limited'` for a rate limit, `reason: 'deadline'` when the caller's
 * time ran out), so a background read can say why a read failed with a safe
 * code (`gmailFailCode`), never Gmail's own words.
 */

export const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

/** Tries in all for a background read, the first included. */
const MAX_ATTEMPTS = 4;
/** The first backoff; each one after doubles. */
const BACKOFF_MS = 1_000;
/** No single wait is longer, Retry-After included. */
const MAX_WAIT_MS = 20_000;
/** A background request Gmail has not answered by then is given up (and may be tried again). */
const REQUEST_TIMEOUT_MS = 30_000;
/**
 * Background reads of one mailbox in flight at once, every reader together. A
 * full thread costs Gmail 10 units of the mailbox's 250 a second and a header
 * read 5, so four at once stays inside the limit at Gmail's usual latency.
 */
const BACKGROUND_CONCURRENCY = 4;
/** Gmail's own transient failures. A 403 is one only with a rate-limit reason. */
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);
/** The reasons Gmail gives a 403 rate limit, lower-cased: the classic `errors[]` and the newer `details[]`. */
const RATE_LIMIT_REASONS = new Set([
  'ratelimitexceeded',
  'userratelimitexceeded',
  'rate_limit_exceeded',
]);

export interface GmailRetry {
  /**
   * The caller's deadline (epoch ms): no wait starts that would end after it,
   * no request runs past it, and a read still queued then is given up.
   */
  deadline?: number;
  /**
   * A read a person is waiting on (the follow-up full email): it queues ahead
   * of the background reads already waiting, still within
   * BACKGROUND_CONCURRENCY and any rate-limit pause.
   */
  front?: boolean;
}

export interface GmailReadOptions {
  /**
   * Background reads, and the follow-up full email with a short deadline: try
   * a rate limit, a Gmail 5xx, a timeout or an unreachable Gmail again, paced
   * with the mailbox's other background reads. Other interactive reads leave
   * it out and fail fast.
   */
  retry?: GmailRetry;
}

/** Why a Gmail read failed, as a code safe for an audit row. */
export const GMAIL_FAIL_CODES = [
  'rate_limited',
  'gmail_5xx',
  'gmail_4xx',
  'not_found',
  'timeout',
  'deadline',
  'provider_unavailable',
] as const;

export type GmailFailCode = (typeof GMAIL_FAIL_CODES)[number];

/**
 * The safe code for a failed read: `rate_limited` (429, or 403 with a
 * rate-limit reason, or a mailbox still waiting out one), `not_found` (404,
 * or nothing there), `gmail_5xx`, `gmail_4xx`, `timeout` (Gmail did not
 * answer in 30 s), `deadline` (the caller's time ran out first, queued or
 * mid-request), or `provider_unavailable` (Gmail unreachable, or no access
 * token).
 */
export function gmailFailCode(error: AppError): GmailFailCode {
  const status = typeof error.details?.status === 'number' ? error.details.status : null;
  if (error.details?.reason === 'deadline') return 'deadline';
  if (error.details?.reason === 'rate_limited' || status === 429) return 'rate_limited';
  if (error.code === 'timeout') return 'timeout';
  if (status === 404 || (status === null && error.code === 'not_found')) return 'not_found';
  if (status !== null && status >= 500) return 'gmail_5xx';
  if (status !== null && status >= 400) return 'gmail_4xx';
  return 'provider_unavailable';
}

/* ------------------------------------------------------------- waiting */

const pacing = processWide('gmail-get-pacing', () => ({
  wait: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}));
const realWait = pacing.wait;

/** Wait `ms` between background reads (a backoff, or a reader's own pacing). */
export function gmailPause(ms: number): Promise<void> {
  return ms > 0 ? pacing.wait(ms) : Promise.resolve();
}

interface MailboxGate {
  /** Background reads of the mailbox in flight now. */
  active: number;
  /** Background reads waiting for a place, first come first served (a `front` read first). */
  queue: (() => void)[];
  /** After a rate limit, no background read of the mailbox starts before this (epoch ms). */
  pausedUntil: number;
}

const gates = processWide('gmail-get-gates', () => new Map<string, MailboxGate>());

function gateFor(integration: Integration): MailboxGate {
  const key = integration.id || integration.account_email || '';
  let gate = gates.get(key);
  if (!gate) {
    gate = { active: 0, queue: [], pausedUntil: 0 };
    gates.set(key, gate);
  }
  return gate;
}

/** A place among the mailbox's background reads: true once it is this read's turn, false if the deadline comes first. */
function enter(gate: MailboxGate, deadline: number, front: boolean): Promise<boolean> {
  if (gate.active < BACKGROUND_CONCURRENCY) {
    gate.active += 1;
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const start = () => {
      if (timer !== undefined) clearTimeout(timer);
      gate.active += 1;
      resolve(true);
    };
    if (front) gate.queue.unshift(start);
    else gate.queue.push(start);
    if (Number.isFinite(deadline)) {
      timer = setTimeout(
        () => {
          const at = gate.queue.indexOf(start);
          if (at !== -1) gate.queue.splice(at, 1);
          resolve(false);
        },
        Math.max(0, deadline - Date.now()),
      );
    }
  });
}

function leave(gate: MailboxGate): void {
  gate.active = Math.max(0, gate.active - 1);
  gate.queue.shift()?.();
}

/**
 * Test hook: how backoffs and pacing wait; null puts the real timer back.
 * Either way every mailbox's gate starts afresh: nothing queued, no pause.
 */
export function setGmailWaitForTests(wait: ((ms: number) => Promise<void>) | null): void {
  pacing.wait = wait ?? realWait;
  gates.clear();
}

/** Retry-After as a wait: seconds, or an HTTP date; capped at 20 s, null when absent or unreadable. */
export function retryAfterMs(value: string | null, now = Date.now()): number | null {
  const v = value?.trim();
  if (!v) return null;
  if (/^\d+(?:\.\d+)?$/.test(v)) return Math.min(MAX_WAIT_MS, Math.round(Number(v) * 1_000));
  const at = Date.parse(v);
  if (Number.isNaN(at)) return null;
  return Math.min(MAX_WAIT_MS, Math.max(0, at - now));
}

/** The wait before try `retry + 2`: about 1 s, 2 s, 4 s, each within ±25 %, capped. */
function backoffMs(retry: number): number {
  return Math.min(MAX_WAIT_MS, Math.round(BACKOFF_MS * 2 ** retry * (0.75 + Math.random() * 0.5)));
}

/* --------------------------------------------------------------- reads */

type Attempt<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: AppError;
      transient: boolean;
      rateLimited: boolean;
      waitMs: number | null;
    };

/** The caller's deadline came before Gmail answered (or before the read's turn). */
const outOfTime = (): AppError =>
  err('timeout', 'The read ran out of time.', { details: { reason: 'deadline' } }).error;

/** Whether a 403's JSON body names a rate limit. Reads only the reason codes, never the message. */
async function rateLimitReason(res: Response): Promise<boolean> {
  try {
    const body = (await res.json()) as {
      error?: { errors?: { reason?: unknown }[]; details?: { reason?: unknown }[] };
    };
    const reasons = [...(body.error?.errors ?? []), ...(body.error?.details ?? [])].map((e) =>
      typeof e?.reason === 'string' ? e.reason.toLowerCase() : '',
    );
    return reasons.some((r) => RATE_LIMIT_REASONS.has(r));
  } catch {
    return false;
  }
}

async function failed<T>(res: Response): Promise<Attempt<T>> {
  const status = res.status;
  const rateLimited = status === 429 || (status === 403 && (await rateLimitReason(res)));
  const transient = rateLimited || TRANSIENT_STATUSES.has(status);
  return {
    ok: false,
    error: err('provider_unavailable', `Gmail returned ${status}.`, {
      details: rateLimited ? { status, reason: 'rate_limited' } : { status },
    }).error,
    transient,
    rateLimited,
    waitMs: transient ? retryAfterMs(res.headers.get('retry-after')) : null,
  };
}

/**
 * One request. `limit` is a background read's timeout: the 30 s one, or the
 * time left before the caller's deadline when that is sooner (`byDeadline`).
 * An interactive read (null) has none.
 */
async function attempt<T>(
  path: string,
  token: string,
  limit: { timeoutMs: number; byDeadline: boolean } | null,
): Promise<Attempt<T>> {
  const signal = limit ? AbortSignal.timeout(limit.timeoutMs) : undefined;
  try {
    const res = await fetch(`${GMAIL_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) return await failed<T>(res);
    return { ok: true, value: (await res.json()) as T };
  } catch {
    // The timeout fired, however the runtime names what it throws.
    if (limit && signal?.aborted) {
      if (limit.byDeadline) {
        return {
          ok: false,
          error: outOfTime(),
          transient: false,
          rateLimited: false,
          waitMs: null,
        };
      }
      return {
        ok: false,
        error: err('timeout', 'Gmail did not answer in time.').error,
        transient: true,
        rateLimited: false,
        waitMs: null,
      };
    }
    return {
      ok: false,
      error: err('provider_unavailable', 'Could not reach Gmail.').error,
      transient: limit !== null,
      rateLimited: false,
      waitMs: null,
    };
  }
}

/** A background read: through the mailbox's gate, tried again on a transient failure, within `deadline`. */
async function backgroundGet<T>(
  gate: MailboxGate,
  path: string,
  token: string,
  deadline: number,
  front: boolean,
): Promise<Result<T>> {
  if (!(await enter(gate, deadline, front))) return { ok: false, error: outOfTime() };
  try {
    // Another read of this mailbox just met the rate limit: wait it out, when there is time to.
    const paused = gate.pausedUntil - Date.now();
    if (paused > 0) {
      if (Date.now() + paused > deadline) {
        return {
          ok: false,
          error: err('provider_unavailable', 'Gmail is rate limiting this mailbox.', {
            details: { reason: 'rate_limited' },
          }).error,
        };
      }
      await gmailPause(paused);
    }
    let last = outOfTime();
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      const res = await attempt<T>(path, token, {
        timeoutMs: Math.min(REQUEST_TIMEOUT_MS, left),
        byDeadline: left < REQUEST_TIMEOUT_MS,
      });
      if (res.ok) return ok(res.value);
      last = res.error;
      if (!res.transient || i === MAX_ATTEMPTS - 1) break;
      const wait = res.waitMs ?? backoffMs(i);
      // The whole mailbox waits, not only this read.
      if (res.rateLimited) gate.pausedUntil = Math.max(gate.pausedUntil, Date.now() + wait);
      if (Date.now() + wait > deadline) break;
      await gmailPause(wait);
    }
    return { ok: false, error: last };
  } finally {
    leave(gate);
  }
}

/** GET `path` (under users/me) with the mailbox's access token. Fails fast unless `retry` is given. */
export async function gmailGet<T>(
  store: DataStore,
  integration: Integration,
  path: string,
  options: GmailReadOptions = {},
): Promise<Result<T>> {
  const token = await getAccessToken(store, integration);
  if (!token.ok) return token;
  const retry = options.retry;
  if (retry) {
    return backgroundGet<T>(
      gateFor(integration),
      path,
      token.value,
      retry.deadline ?? Number.POSITIVE_INFINITY,
      retry.front === true,
    );
  }
  const res = await attempt<T>(path, token.value, null);
  return res.ok ? ok(res.value) : { ok: false, error: res.error };
}
