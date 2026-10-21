import 'server-only';
import { env, type AppEnv } from '@/lib/config/env';
import {
  jobBoardCheck,
  readBoardAnswer,
  type BoardVerdict,
  type JobBoardCheck,
} from '@/lib/portfolio/job-boards';
import type { JobLinkVerdict, JobRole } from '@/lib/portfolio/jobs';
import { log } from '@/lib/security/redact';
import { processWide } from '@/lib/util/process-state';
import { settlesWithin } from '@/lib/util/settle';

/**
 * Whether a role's job posting is still up, for postings on boards with a
 * public postings API (Greenhouse, Lever, Ashby; see `job-boards.ts`). One
 * unauthenticated GET per posting (per board, for Ashby), cached for a day in
 * memory; no secrets, no crawling, nothing stored. A slow board never holds
 * the page: the Jobs tab waits briefly and the rest fill in for the next view.
 *
 * Only roles still open (active or probably filled) are checked, at most
 * MAX_CHECKS a view, a few at a time, each with its own timeout.
 */

const DAY_MS = 24 * 60 * 60_000;
/** A board that did not answer clearly is asked again after an hour, not a day. */
const UNKNOWN_TTL_MS = 60 * 60_000;
const CALL_TIMEOUT_MS = 4_000;
const MAX_CHECKS = 40;
const CONCURRENCY = 4;
/** A board's whole job list (Ashby) is read only up to this size. */
const MAX_BODY_CHARS = 2_000_000;

interface CachedAnswer {
  at: number;
  verdict: BoardVerdict;
}

const cache = processWide('job-liveness', () => ({
  answers: new Map<string, CachedAnswer>(),
  inFlight: new Map<string, Promise<{ status: number; body: unknown }>>(),
}));

/** Test hook. */
export function resetJobLivenessCache(): void {
  cache.answers.clear();
  cache.inFlight.clear();
}

function fresh(entry: CachedAnswer | undefined, now: number): entry is CachedAnswer {
  if (!entry) return false;
  return now - entry.at < (entry.verdict === 'unknown' ? UNKNOWN_TTL_MS : DAY_MS);
}

async function fetchBoard(
  apiUrl: string,
  fetchImpl: typeof fetch,
): Promise<{ status: number; body: unknown }> {
  const pending = cache.inFlight.get(apiUrl);
  if (pending) return pending;
  const run = (async () => {
    try {
      const response = await fetchImpl(apiUrl, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (response.status !== 200) return { status: response.status, body: null };
      const raw = await response.text();
      if (raw.length > MAX_BODY_CHARS) return { status: 0, body: null };
      try {
        return { status: 200, body: JSON.parse(raw) as unknown };
      } catch {
        return { status: 0, body: null };
      }
    } catch {
      return { status: 0, body: null };
    } finally {
      cache.inFlight.delete(apiUrl);
    }
  })();
  cache.inFlight.set(apiUrl, run);
  return run;
}

function cacheKey(apiUrl: string, postingId: string): string {
  return `${apiUrl}#${postingId}`;
}

function verdictsFromCache(roles: readonly JobRole[], now: number): Map<string, JobLinkVerdict> {
  const out = new Map<string, JobLinkVerdict>();
  for (const role of roles) {
    const check = jobBoardCheck(role.link);
    if (!check) continue;
    const entry = cache.answers.get(cacheKey(check.apiUrl, check.postingId));
    if (!fresh(entry, now) || entry.verdict === 'unknown') continue;
    out.set(role.id, {
      gone: entry.verdict === 'gone',
      board: check.board,
      checkedAt: new Date(entry.at).toISOString(),
    });
  }
  return out;
}

/**
 * Board verdicts for these roles, by role id: whatever is cached, plus what
 * the boards answer within `waitMs`. Checks still running after that carry on
 * and fill the cache. Never throws; off in demo mode (no outside calls).
 */
export async function jobLinkVerdicts(
  roles: readonly JobRole[],
  options: { waitMs?: number; now?: Date; fetchImpl?: typeof fetch; e?: AppEnv } = {},
): Promise<Map<string, JobLinkVerdict>> {
  const { waitMs = 1_500, now = new Date(), fetchImpl = fetch, e = env() } = options;
  if (e.demoMode) return new Map();
  const at = now.getTime();

  const todo = new Map<string, JobBoardCheck>();
  for (const role of roles) {
    if (role.status !== 'active' && role.status !== 'probably_filled') continue;
    const check = jobBoardCheck(role.link);
    if (!check) continue;
    const key = cacheKey(check.apiUrl, check.postingId);
    if (fresh(cache.answers.get(key), at) || todo.has(key)) continue;
    todo.set(key, check);
    if (todo.size >= MAX_CHECKS) break;
  }

  if (todo.size > 0) {
    const queue = [...todo.entries()];
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const [key, check] = next;
        const { status, body } = await fetchBoard(check.apiUrl, fetchImpl);
        cache.answers.set(key, { at, verdict: readBoardAnswer(check, status, body) });
      }
    };
    const all = Promise.all(Array.from({ length: CONCURRENCY }, worker)).catch(() => {
      log.warn('Checking job postings failed unexpectedly');
    });
    await settlesWithin(all, waitMs);
  }
  return verdictsFromCache(roles, at);
}

/** Only what is cached already, with no call out: for pages that only count roles. */
export function cachedJobLinkVerdicts(
  roles: readonly JobRole[],
  { now = new Date(), e = env() }: { now?: Date; e?: AppEnv } = {},
): Map<string, JobLinkVerdict> {
  if (e.demoMode) return new Map();
  return verdictsFromCache(roles, now.getTime());
}
