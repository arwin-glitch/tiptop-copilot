import 'server-only';
import { env, type AppEnv } from '@/lib/config/env';
import type { DataStore } from '@/lib/db/store';
import { demoJobs } from '@/lib/demo/jobs-fixtures';
import { jobId } from '@/lib/portfolio/job-id';
import {
  JOBS_MARKER,
  JOBS_POST_SCHEMA,
  JOB_ROLE_SCHEMA,
  dedupeJobRoles,
  sortJobRoles,
  type JobRole,
  type JobsPost,
  type JobsSnapshot,
} from '@/lib/portfolio/jobs';
import { log } from '@/lib/security/redact';
import {
  readRelayWindow,
  slackTsToIso,
  type RelayReadState,
  type SlackMessage,
} from '@/lib/slack/relay-history';
import { processWide } from '@/lib/util/process-state';
import { settlesWithin } from '@/lib/util/settle';
import { unwrapSlackText } from '@/lib/util/slack-text';
import { isRelayOrganization } from './deal-relay';
import type { FollowUpsState } from './follow-ups';

/**
 * The Portfolio page's Jobs tab: open roles at portfolio companies, read
 * live from the jobs routine's `JOBS_V1` snapshot in the private #deal-relay
 * channel, like the other routine snapshots (`follow-ups.ts`). Nothing is
 * stored; the newest complete run wins.
 *
 * The routine runs weekly and posts the whole deduplicated list each time,
 * split into numbered parts (each repeating the run's run_at, and saying how
 * many parts there are) when it is too long for one Slack message. A run
 * whose parts are not all in yet is passed over for the last complete one.
 *
 * Each role is validated on its own: one bad row is dropped and counted, the
 * rest still show. A role's id is the app's own hash of its company and
 * normalized title, whatever id the routine sent.
 */

export type PortfolioJobsState = FollowUpsState;

export interface PortfolioJobsResult {
  state: PortfolioJobsState;
  /** Null until the routine has posted (or when the read failed). */
  snapshot: JobsSnapshot | null;
  readAt: string;
}

const MAX_MESSAGE_CHARS = 40_000;

export interface ParsedJobsPost {
  post: JobsPost;
  roles: JobRole[];
  /** Rows that did not validate. */
  dropped: number;
}

/**
 * One relay message -> a parsed `JOBS_V1` post, or null when it is not one or
 * its envelope does not validate. Slack's link markup is undone first, so a
 * job link or a contact email arrives as the text the routine wrote.
 */
export function parseJobsMessage(raw: unknown): ParsedJobsPost | null {
  if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_CHARS) return null;
  const clean = unwrapSlackText(raw, { preferLabel: true }).trim();
  if (!clean.startsWith(`${JOBS_MARKER}\n`) && !clean.startsWith(`${JOBS_MARKER} `)) return null;
  const json = /`([^`]+)`/.exec(clean)?.[1];
  if (!json) return null;
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    log.warn('Jobs relay post is not valid JSON');
    return null;
  }
  const parsed = JOBS_POST_SCHEMA.safeParse(data);
  if (!parsed.success) {
    log.warn('Jobs relay post did not validate', {
      issue: parsed.error.issues[0]?.path.join('.') ?? 'unknown',
    });
    return null;
  }
  const roles: JobRole[] = [];
  let dropped = 0;
  for (const row of parsed.data.roles) {
    const role = JOB_ROLE_SCHEMA.safeParse(row);
    if (!role.success) {
      dropped++;
      continue;
    }
    const { id: _ignored, ...fields } = role.data;
    roles.push({ ...fields, id: jobId(fields.company, fields.title) });
  }
  if (dropped > 0) log.warn('Jobs relay post had rows that did not validate', { dropped });
  return { post: parsed.data, roles, dropped };
}

interface Run {
  runAt: string;
  postedAt: string;
  byPart: Map<number, ParsedJobsPost>;
  /** When each part was posted, so a part posted twice (a retry) keeps the later post. */
  partAt: Map<number, string>;
  /** The part count any part declared. */
  parts: number | null;
}

function isComplete(run: Run): boolean {
  const numbers = [...run.byPart.keys()];
  const expected = run.parts ?? Math.max(...numbers);
  if (numbers.length !== expected) return false;
  for (let n = 1; n <= expected; n++) if (!run.byPart.has(n)) return false;
  return true;
}

/**
 * Slack pages (newest first) -> the snapshot to show: the newest run whose
 * parts are all there, else the newest run as it stands (marked partial).
 * Null when no `JOBS_V1` post is in the window. Pure, for tests.
 */
export function collectJobs(
  messages: readonly SlackMessage[],
  posterIds: readonly string[] = [],
): JobsSnapshot | null {
  const runs = new Map<string, Run>();
  for (const m of messages) {
    if (m.subtype !== undefined && m.subtype !== null) continue;
    if (posterIds.length > 0 && !(typeof m.user === 'string' && posterIds.includes(m.user))) {
      continue;
    }
    const iso = slackTsToIso(m.ts);
    if (!iso) continue;
    const parsed = parseJobsMessage(m.text);
    if (!parsed) continue;
    const runAt = parsed.post.run_at;
    const run: Run = runs.get(runAt) ?? {
      runAt,
      postedAt: iso,
      byPart: new Map(),
      partAt: new Map(),
      parts: null,
    };
    const part = parsed.post.part ?? 1;
    const seenAt = run.partAt.get(part);
    if (seenAt === undefined || iso > seenAt) {
      run.byPart.set(part, parsed);
      run.partAt.set(part, iso);
    }
    if (iso > run.postedAt) run.postedAt = iso;
    if (parsed.post.parts) run.parts = Math.max(run.parts ?? 0, parsed.post.parts);
    runs.set(runAt, run);
  }
  if (runs.size === 0) return null;

  const newestFirst = [...runs.values()].sort((a, b) => b.runAt.localeCompare(a.runAt));
  const chosen = newestFirst.find(isComplete) ?? newestFirst[0]!;
  const ordered = [...chosen.byPart.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p);
  const first = ordered[0]!.post;
  return {
    runAt: chosen.runAt,
    postedAt: chosen.postedAt,
    scannedSince: first.scanned_since ?? null,
    emailsScanned: first.emails_scanned ?? null,
    roles: sortJobRoles(dedupeJobRoles(ordered.flatMap((p) => p.roles))),
    partial: !isComplete(chosen),
    dropped: ordered.reduce((sum, p) => sum + p.dropped, 0),
  };
}

const WINDOW_DAYS = 30;
const MAX_PAGES = 5;
const PAGE_SIZE = 200;
/** A weekly snapshot: a good read is kept five minutes. */
const CACHE_MS = 5 * 60_000;
/** After a refusal or fault, try again after a minute. */
const RETRY_MS = 60_000;
/** The last good read, served while Slack fails to answer (never once access is withdrawn). */
const LAST_GOOD_MS = 14 * 24 * 60 * 60_000;
/** Faults that may clear on their own; anything else means access was withdrawn. */
const TRANSIENT: readonly RelayReadState[] = ['error', 'rate_limited'];

interface CacheEntry {
  at: number;
  ttl: number;
  result: PortfolioJobsResult;
}

const cache = processWide('portfolio-jobs', () => ({
  entries: new Map<string, CacheEntry>(),
  lastGood: new Map<string, { at: number; result: PortfolioJobsResult }>(),
  inFlight: new Map<string, Promise<PortfolioJobsResult>>(),
}));

/** Test hook. */
export function resetPortfolioJobsCache(): void {
  cache.entries.clear();
  cache.lastGood.clear();
  cache.inFlight.clear();
}

/**
 * The current jobs snapshot for this organization. Cached for five minutes
 * and shared between concurrent callers; the last good read stands in while
 * Slack is down or rate-limiting. Never throws.
 *
 * Closed until sign-in is limited to TipTop accounts, like Follow-ups: the
 * posts quote founders' emails and name who to send candidates to.
 */
export async function readPortfolioJobs(
  store: DataStore,
  organizationId: string,
  options: { fetchImpl?: typeof fetch; now?: Date; force?: boolean; e?: AppEnv } = {},
): Promise<PortfolioJobsResult> {
  const { fetchImpl = fetch, now = new Date(), force = false, e = env() } = options;
  const result = (
    state: PortfolioJobsState,
    snapshot: JobsSnapshot | null = null,
  ): PortfolioJobsResult => ({ state, snapshot, readAt: now.toISOString() });

  if (e.demoMode) return result('ok', demoJobs(now));
  if (!e.askRelaySlackToken) return result('not_configured');
  if (e.authAllowedDomains.length === 0) return result('restricted');

  const cached = cache.entries.get(organizationId);
  if (!force && cached && now.getTime() - cached.at < cached.ttl) return cached.result;
  const pending = cache.inFlight.get(organizationId);
  if (pending) return pending;

  const remember = (value: PortfolioJobsResult, ttl: number) => {
    cache.entries.set(organizationId, { at: now.getTime(), ttl, result: value });
    return value;
  };
  const run = (async () => {
    try {
      if (!(await isRelayOrganization(store, organizationId))) {
        return remember(result('other_workspace'), CACHE_MS);
      }
      const window = await readRelayWindow({
        token: e.askRelaySlackToken ?? '',
        channelId: e.dealRelayChannelId,
        windowDays: WINDOW_DAYS,
        maxPages: MAX_PAGES,
        pageSize: PAGE_SIZE,
        now,
        fetchImpl,
      });
      if (window.state !== 'ok') {
        if (window.fault !== undefined) log.warn('Reading jobs from #deal-relay failed');
        const last = cache.lastGood.get(organizationId);
        if (TRANSIENT.includes(window.state)) {
          if (last && now.getTime() - last.at < LAST_GOOD_MS) {
            return remember(last.result, RETRY_MS);
          }
        } else {
          cache.lastGood.delete(organizationId);
        }
        return remember(result(window.state), RETRY_MS);
      }
      const value = result('ok', collectJobs(window.messages, e.dealRelayPosterIds));
      // A read that worked and found no scan (every post aged out) has nothing to stand in.
      if (value.snapshot) cache.lastGood.set(organizationId, { at: now.getTime(), result: value });
      else cache.lastGood.delete(organizationId);
      // A run still posting its parts is read again after a minute.
      return remember(value, value.snapshot?.partial ? RETRY_MS : CACHE_MS);
    } catch {
      log.warn('Reading jobs failed unexpectedly');
      return result('error');
    } finally {
      cache.inFlight.delete(organizationId);
    }
  })();
  cache.inFlight.set(organizationId, run);
  return run;
}

/**
 * readPortfolioJobs for a page that only shows a count or a short list (a
 * company page): past `ms` the answer is null, read as "nothing to show",
 * and the read carries on to fill the cache for the next view.
 */
export async function readPortfolioJobsWithin(
  store: DataStore,
  organizationId: string,
  ms: number,
  options: Parameters<typeof readPortfolioJobs>[2] = {},
): Promise<PortfolioJobsResult | null> {
  const read = readPortfolioJobs(store, organizationId, options).catch(() => null);
  return (await settlesWithin(read, ms)) ? read : null;
}

/**
 * The snapshot only if it is already in memory (or the demo's), with no read:
 * for the count on the Jobs tab's label, which must never slow the page.
 */
export function peekPortfolioJobs(
  organizationId: string,
  { now = new Date(), e = env() }: { now?: Date; e?: AppEnv } = {},
): JobsSnapshot | null {
  if (e.demoMode) return demoJobs(now);
  if (!e.askRelaySlackToken || e.authAllowedDomains.length === 0) return null;
  const entry = cache.entries.get(organizationId);
  if (entry?.result.state === 'ok') return entry.result.snapshot;
  return cache.lastGood.get(organizationId)?.result.snapshot ?? null;
}
