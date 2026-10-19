import 'server-only';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { env, isDemoMode } from '@/lib/config/env';
import { isMissingColumnError, isMissingTableError } from '@/lib/db/missing-table';
import type { DataStore } from '@/lib/db/store';
import {
  MATCH_ALPHABET,
  MATCH_CODE_RE,
  MAX_CODE_ATTEMPTS,
  type DesktopFlowStatus,
  type DesktopVerifyStatus,
} from '@/lib/desktop/shared';
import { getStore } from '@/lib/runtime';
import { openToken, sealToken } from '@/lib/security/crypto';
import { log } from '@/lib/security/redact';
import type {
  DesktopHandoff,
  DesktopHandoffFailure,
  DesktopHandoffStatus,
  DesktopPlatform,
} from '@/lib/types/domain';
import { newId, sha256 } from '@/lib/util/hash';
import { err, ok, type Result } from '@/lib/util/result';

/**
 * Signing in to the desktop app through the system browser.
 *
 * Google refuses sign-in inside an app's own window, so the app cannot use the
 * login page's flow as it is. Instead:
 *
 *   1. The app asks /api/auth/desktop/start for a Google sign-in URL. The
 *      server starts Supabase's PKCE flow there, so the verifier lands in the
 *      app's own cookie jar, and binds the hand-off to the app with an
 *      httpOnly poll cookie.
 *   2. The app's shell hands that URL to the system browser, where the person
 *      signs in with Google and lands on /desktop/callback?h=…&code=….
 *   3. That page seals Google's code and only then mints a short code, which
 *      it shows. The person types it into the app (/api/auth/desktop/verify).
 *   4. A right code claims the hand-off once, and the app exchanges Google's
 *      code with its own verifier: the session is set in the app's window.
 *
 * The code starts in the browser and travels to the app in the person's
 * hands, never the other way round. Anything the app is shown is known to
 * whoever started the hand-off, and anyone can start one, so a code shown by
 * the app and confirmed in the browser would let a phisher who mailed out the
 * sign-in link collect the victim's session. This way the starter never sees
 * the code unless the victim reads it out to them.
 *
 * Stored: hashes of the hand-off id and the poll secret, the short code, and
 * Google's code sealed with APP_ENCRYPTION_KEY (cleared when claimed). A
 * hand-off lives 10 minutes; Supabase's own flow gives the browser leg about
 * 5. Rows are swept a day after they expire, by the start route itself.
 *
 * The table, desktop_handoffs (20261017000000_desktop_handoffs.sql), is
 * applied by hand; until it is, every function here returns `not_configured`
 * and desktop sign-in says it is not available. The rest of the app is
 * untouched by it.
 */

export const DESKTOP_HANDOFFS_MIGRATION_FILE =
  'supabase/migrations/20261017000000_desktop_handoffs.sql';
export const HANDOFF_TTL_MS = 600_000;
export const POLL_COOKIE = 'tiptop_desktop_handoff';
/** The poll cookie is sent to the hand-off routes and nowhere else. */
export const POLL_COOKIE_PATH = '/api/auth/desktop';

/**
 * The poll cookie's attributes. httpOnly and SameSite=Strict, scoped to the
 * hand-off routes, gone with the hand-off: it is the one thing that lets a
 * caller claim a sign-in, so it is never in a URL, a page or a log.
 */
export function pollCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: env().nodeEnv === 'production',
    sameSite: 'strict' as const,
    path: POLL_COOKIE_PATH,
    maxAge,
  };
}

/** 32 random bytes as base64url, the shape of both secrets. */
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
/** What Supabase puts in `code`: a uuid today; anything URL-safe and short is accepted. */
export const AUTH_CODE_RE = /^[A-Za-z0-9._~-]{1,512}$/;
/** Expired rows are deleted this long after they expire. */
const SWEEP_AFTER_MS = 86_400_000;

const TABLE = 'desktop_handoffs';
const NOT_SET_UP = `Desktop sign-in is not set up yet: the desktop_handoffs table does not exist. Run ${DESKTOP_HANDOFFS_MIGRATION_FILE} in the Supabase SQL editor, then try again.`;

/* --------------------------------------------------------------- helpers */

async function guard<T>(operation: string, run: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await run();
  } catch (error) {
    if (isMissingTableError(error) || isMissingColumnError(error)) {
      return err('not_configured', NOT_SET_UP, {
        stillUsable: 'Sign in from a web browser; everything else works as before.',
        details: { operation },
      });
    }
    log.error('Desktop sign-in operation failed', {
      operation,
      reason: error instanceof Error ? error.message : String(error),
    });
    return err('internal', 'Desktop sign-in is not available just now.', {
      retryable: true,
      details: { operation },
    });
  }
}

/** Ids and status changes only: never h, the poll secret, either code or a URL. */
function trace(row: Pick<DesktopHandoff, 'id'>, status: string): void {
  log.info('Desktop sign-in', { handoff: row.id.slice(0, 8), status });
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function isLive(row: DesktopHandoff, now: Date): boolean {
  return Date.parse(row.expires_at) > now.getTime();
}

/**
 * The demo shortcut: no Google, no exchange, a demo session at the end. It
 * needs both DEMO_MODE and the file-backed demo store, and production has
 * neither.
 */
export function demoHandoffs(): boolean {
  return isDemoMode() && getStore().kind === 'demo';
}

/* ------------------------------------------------------------- secrets */

export function mintHandoffSecrets(): { handoffId: string; pollSecret: string } {
  return {
    handoffId: randomBytes(32).toString('base64url'),
    pollSecret: randomBytes(32).toString('base64url'),
  };
}

/** Four characters from MATCH_ALPHABET: about 920,000 codes, three tries each. */
export function mintMatchCode(): string {
  let code = '';
  for (let i = 0; i < 4; i++) code += MATCH_ALPHABET[randomInt(MATCH_ALPHABET.length)];
  return code;
}

/**
 * The column allows mac, windows and other only (no migration for iPhones,
 * which sign in the same way from the iPhone app): an iPhone, iPad or iPod
 * says "like Mac OS X", so it is checked first and stored as other. The
 * sign-in audit names the iPhone app from its own request instead
 * (/api/auth/desktop/verify).
 */
export function platformFromUserAgent(userAgent: string | null | undefined): DesktopPlatform {
  if (!userAgent) return 'other';
  if (/\b(iPhone|iPad|iPod)\b/.test(userAgent)) return 'other';
  if (/Macintosh|Mac OS X/.test(userAgent)) return 'mac';
  if (/Windows/.test(userAgent)) return 'windows';
  return 'other';
}

/**
 * Whether a POST came from a page on this site. Mirrors Next's own Server
 * Action check: the Origin's host against the first X-Forwarded-Host value or
 * the Host header. With no Origin, only a browser's own `same-origin` fetch
 * metadata passes. A cross-site page cannot get past this; a script calling
 * the endpoint directly can, which is why nothing here relies on it alone.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return request.headers.get('sec-fetch-site') === 'same-origin';
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false; // "null", from a sandboxed or privacy-stripped page
  }
  const forwarded = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  const host = request.headers.get('host')?.trim() || new URL(request.url).host;
  return originHost === forwarded || originHost === host;
}

/* ---------------------------------------------------------------- rows */

export async function findByHandoffId(
  store: DataStore,
  handoffId: string | null | undefined,
): Promise<DesktopHandoff | null> {
  if (!handoffId || !SECRET_RE.test(handoffId)) return null;
  return store.findOne(TABLE, '', { eq: { handoff_hash: sha256(handoffId) } });
}

export async function findByPollSecret(
  store: DataStore,
  pollSecret: string | null | undefined,
): Promise<DesktopHandoff | null> {
  if (!pollSecret || !SECRET_RE.test(pollSecret)) return null;
  return store.findOne(TABLE, '', { eq: { poll_secret_hash: sha256(pollSecret) } });
}

export function isWellFormedSecret(value: string | null | undefined): value is string {
  return typeof value === 'string' && SECRET_RE.test(value);
}

/** Start a hand-off. Only hashes of the two secrets are stored. */
export async function createHandoff(
  store: DataStore,
  args: {
    secrets: { handoffId: string; pollSecret: string };
    flowId: string | null;
    platform: DesktopPlatform;
    now?: Date;
  },
): Promise<Result<DesktopHandoff>> {
  return guard('start a desktop sign-in', async () => {
    const now = args.now ?? new Date();
    const row: DesktopHandoff = {
      id: newId(),
      handoff_hash: sha256(args.secrets.handoffId),
      poll_secret_hash: sha256(args.secrets.pollSecret),
      match_code: null,
      attempts: 0,
      flow_id: args.flowId && args.flowId.length <= 128 ? args.flowId : null,
      platform: args.platform,
      status: 'pending',
      failure_reason: null,
      auth_code_sealed: null,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + HANDOFF_TTL_MS).toISOString(),
      code_received_at: null,
      consumed_at: null,
    };
    await store.insert(TABLE, row);
    trace(row, 'pending');
    return ok(row);
  });
}

/**
 * End an unfinished hand-off for a reason, if it is still in one of `from`.
 * Returns whether this call changed it.
 */
async function failIf(
  store: DataStore,
  row: DesktopHandoff,
  reason: DesktopHandoffFailure,
  from: DesktopHandoffStatus[],
): Promise<boolean> {
  const changed = await store.updateWhere(
    TABLE,
    '',
    { eq: { id: row.id }, in: { status: from } },
    {
      status: 'failed',
      failure_reason: reason,
      match_code: null,
      auth_code_sealed: null,
    },
  );
  if (changed.length) trace(row, `failed:${reason}`);
  return changed.length > 0;
}

/**
 * A newer Sign in from the same app replaces the one it was waiting on, so
 * an old browser tab cannot finish into it. Best effort.
 */
export async function supersede(
  store: DataStore,
  oldPollSecret: string | undefined,
): Promise<void> {
  if (!isWellFormedSecret(oldPollSecret)) return;
  try {
    const row = await findByPollSecret(store, oldPollSecret);
    if (row) await failIf(store, row, 'superseded', ['pending', 'code_received']);
  } catch (error) {
    log.warn('Could not supersede a desktop sign-in', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Delete hand-offs that expired over a day ago. Best effort. */
export async function sweep(store: DataStore, now: Date = new Date()): Promise<void> {
  try {
    await store.removeWhere(TABLE, '', {
      lt: { expires_at: new Date(now.getTime() - SWEEP_AFTER_MS).toISOString() },
    });
  } catch (error) {
    log.warn('Could not sweep expired desktop sign-ins', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/* ----------------------------------------------------------- the app */

/** What the app's poll answers for a row. Pure. */
export function pollView(row: DesktopHandoff | null, now: Date = new Date()): DesktopFlowStatus {
  if (!row) return { status: 'expired' };
  switch (row.status) {
    case 'signed_in':
      return { status: 'signed_in' };
    case 'failed':
      return { status: 'failed', reason: row.failure_reason ?? 'exchange' };
    case 'code_received':
      return isLive(row, now)
        ? { status: 'enter_code', attemptsLeft: Math.max(0, MAX_CODE_ATTEMPTS - row.attempts) }
        : { status: 'expired' };
    case 'pending':
    case 'claimed':
    default:
      return isLive(row, now) ? { status: 'waiting' } : { status: 'expired' };
  }
}

export async function readPollStatus(
  store: DataStore,
  pollSecret: string,
  now: Date = new Date(),
): Promise<Result<DesktopFlowStatus>> {
  return guard('check a desktop sign-in', async () =>
    ok(pollView(await findByPollSecret(store, pollSecret), now)),
  );
}

/**
 * The single-use consume: from code_received to claimed, once. Of two callers
 * racing with the right code, one gets the row and the other null.
 */
export async function claimHandoff(
  store: DataStore,
  row: DesktopHandoff,
  now: Date = new Date(),
): Promise<DesktopHandoff | null> {
  const nowIso = now.toISOString();
  const [claimed] = await store.updateWhere(
    TABLE,
    '',
    {
      eq: { id: row.id, status: 'code_received' },
      isNull: ['consumed_at'],
      gt: { expires_at: nowIso },
    },
    { status: 'claimed', consumed_at: nowIso, auth_code_sealed: null, match_code: null },
  );
  if (claimed) trace(claimed, 'claimed');
  return claimed ?? null;
}

export type VerifyOutcome =
  | { kind: 'status'; status: DesktopVerifyStatus }
  /** This caller holds the claim and must finish it (finishHandoff), exactly once. */
  | { kind: 'claimed'; row: DesktopHandoff; authCode: string | null };

/** End a hand-off whose last try went on a wrong code, and say where it stands. */
async function burn(
  store: DataStore,
  row: DesktopHandoff,
  pollSecret: string,
  now: Date,
): Promise<DesktopVerifyStatus> {
  if (await failIf(store, row, 'wrong_code', ['code_received'])) {
    return { status: 'failed', reason: 'wrong_code' };
  }
  // A right code taken earlier claimed it meanwhile.
  return pollView(await findByPollSecret(store, pollSecret), now);
}

/**
 * The person typed `code` into the app. Each code typed uses one of the
 * hand-off's three tries; a wrong third one ends it, and the right one claims
 * it for this caller. `code` is already normalized (normalizeMatchCode) and
 * well-formed.
 *
 * A try is taken (a compare-and-set on the count this request read) before
 * the code is even looked at, so a code that could not take one is never
 * compared. However many guesses arrive at once, from however many
 * addresses, at most three are ever compared with the real code; the rest are
 * told to slow down, and learn nothing.
 */
export async function verifyHandoffCode(
  store: DataStore,
  args: { pollSecret: string; code: string; now?: Date },
): Promise<Result<VerifyOutcome>> {
  return guard<VerifyOutcome>('check a desktop sign-in code', async () => {
    const now = args.now ?? new Date();
    for (let round = 0; round < 5; round++) {
      const row = await findByPollSecret(store, args.pollSecret);
      if (!row) return ok({ kind: 'status', status: { status: 'expired' } });
      if (row.status !== 'code_received' || !isLive(row, now)) {
        return ok({ kind: 'status', status: pollView(row, now) });
      }
      // Every try is taken, and the request holding the last one has not yet
      // claimed or ended the hand-off: read again, it is about to.
      if (row.attempts >= MAX_CODE_ATTEMPTS) continue;

      const attempt = row.attempts + 1;
      const taken = await store.updateWhere(
        TABLE,
        '',
        { eq: { id: row.id, status: 'code_received', attempts: row.attempts } },
        { attempts: attempt },
      );
      if (!taken.length) continue; // another code took this try first: read again

      // From here on this request has its try: it answers once, whatever happens.
      const right =
        Boolean(row.match_code) &&
        MATCH_CODE_RE.test(args.code) &&
        sameText(row.match_code as string, args.code);
      if (!right) {
        if (attempt >= MAX_CODE_ATTEMPTS) {
          return ok({ kind: 'status', status: await burn(store, row, args.pollSecret, now) });
        }
        trace(row, `wrong_code:${attempt}`);
        return ok({
          kind: 'status',
          status: { status: 'wrong_code', attemptsLeft: MAX_CODE_ATTEMPTS - attempt },
        });
      }

      // Opened before the claim, which clears it from the row.
      const opened = row.auth_code_sealed ? openToken(row.auth_code_sealed, row.id) : null;
      const claimed = await claimHandoff(store, row, now);
      if (claimed) {
        return ok({ kind: 'claimed', row: claimed, authCode: opened?.ok ? opened.value : null });
      }
      // A parallel right code claimed it, or it ended meanwhile: say where it stands.
      return ok({
        kind: 'status',
        status: pollView(await findByPollSecret(store, args.pollSecret), now),
      });
    }
    return err('rate_limited', 'Too many codes at once. Wait a moment, then try again.', {
      retryable: true,
    });
  });
}

/** Record how a claimed hand-off ended. */
export async function finishHandoff(
  store: DataStore,
  id: string,
  outcome: 'signed_in' | 'exchange' | 'domain',
): Promise<void> {
  try {
    const changed = await store.updateWhere(
      TABLE,
      '',
      { eq: { id, status: 'claimed' } },
      outcome === 'signed_in'
        ? { status: 'signed_in' }
        : { status: 'failed', failure_reason: outcome },
    );
    if (changed.length) trace({ id }, outcome === 'signed_in' ? 'signed_in' : `failed:${outcome}`);
  } catch (error) {
    log.warn('Could not record how a desktop sign-in ended', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/* ------------------------------------------------------- the browser */

export type CallbackView =
  /** Google's code arrived: show the person the code to type into the app. */
  | { kind: 'show'; matchCode: string; handoffId: string }
  /** The code was shown already, to whoever loaded this with Google's code. */
  | { kind: 'shown' }
  | { kind: 'finished' }
  | { kind: 'cancelled' }
  | { kind: 'superseded' }
  | { kind: 'stopped' }
  | { kind: 'expired' }
  | { kind: 'unavailable' };

function failureView(reason: DesktopHandoffFailure | null): CallbackView {
  if (reason === 'cancelled' || reason === 'rejected') return { kind: 'cancelled' };
  if (reason === 'superseded') return { kind: 'superseded' };
  return { kind: 'stopped' };
}

/**
 * Whether `code` is the one sealed on the row: a reload of the very URL that
 * received it may see the short code again. Someone with only the hand-off id
 * (it is in the sign-in URL) cannot.
 */
function sameAuthCode(row: DesktopHandoff, code: string | null | undefined): boolean {
  if (!code || !row.auth_code_sealed) return false;
  const opened = openToken(row.auth_code_sealed, row.id);
  return opened.ok && sameText(sha256(opened.value), sha256(code));
}

/**
 * The browser landed on /desktop/callback. Unknown and expired look the same,
 * so the page cannot be used to test hand-off ids.
 */
export async function receiveCode(
  store: DataStore,
  args: {
    handoffId: string | null | undefined;
    code: string | null | undefined;
    providerError: boolean;
    now?: Date;
    demo?: boolean;
  },
): Promise<Result<CallbackView>> {
  return guard<CallbackView>('receive a desktop sign-in code', async () => {
    const now = args.now ?? new Date();
    const nowIso = now.toISOString();
    for (let round = 0; round < 3; round++) {
      const row = await findByHandoffId(store, args.handoffId);
      if (!row) return ok({ kind: 'expired' });

      switch (row.status) {
        case 'claimed':
        case 'signed_in':
          return ok({ kind: 'finished' });
        case 'failed':
          return ok(failureView(row.failure_reason));
        case 'code_received':
          if (!isLive(row, now)) return ok({ kind: 'expired' });
          return ok(
            row.match_code && sameAuthCode(row, args.code)
              ? { kind: 'show', matchCode: row.match_code, handoffId: args.handoffId as string }
              : { kind: 'shown' },
          );
        case 'pending':
          break;
      }

      if (!isLive(row, now)) return ok({ kind: 'expired' });
      if (args.providerError) {
        if (await failIf(store, row, 'cancelled', ['pending'])) return ok({ kind: 'cancelled' });
        continue;
      }
      if (!args.code || !AUTH_CODE_RE.test(args.code)) {
        if (await failIf(store, row, 'no_code', ['pending'])) return ok({ kind: 'stopped' });
        continue;
      }

      const sealed = sealToken(args.code, row.id);
      if (!sealed.ok && !args.demo) return ok({ kind: 'unavailable' });
      const matchCode = mintMatchCode();
      const changed = await store.updateWhere(
        TABLE,
        '',
        { eq: { id: row.id, status: 'pending' }, gt: { expires_at: nowIso } },
        {
          status: 'code_received',
          match_code: matchCode,
          auth_code_sealed: sealed.ok ? sealed.value : null,
          code_received_at: nowIso,
        },
      );
      if (changed.length) {
        trace(row, 'code_received');
        return ok({ kind: 'show', matchCode, handoffId: args.handoffId as string });
      }
    }
    return ok({ kind: 'expired' });
  });
}

/**
 * "I didn't start this", from the browser. Says honestly when it is too late:
 * a hand-off already claimed has signed someone in.
 */
export async function rejectHandoff(
  store: DataStore,
  handoffId: string | null | undefined,
): Promise<Result<'rejected' | 'finished' | 'expired'>> {
  return guard('stop a desktop sign-in', async () => {
    const row = await findByHandoffId(store, handoffId);
    if (!row) return ok('expired');
    if (row.status === 'claimed' || row.status === 'signed_in') return ok('finished');
    if (row.status === 'failed') return ok('rejected');
    if (await failIf(store, row, 'rejected', ['pending', 'code_received'])) return ok('rejected');
    const again = await findByHandoffId(store, handoffId);
    return ok(
      again && (again.status === 'claimed' || again.status === 'signed_in')
        ? 'finished'
        : 'rejected',
    );
  });
}
