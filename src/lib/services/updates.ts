import 'server-only';
import { log } from '@/lib/security/redact';
import {
  classifyTopLevel,
  firstLine,
  isSystemMessage,
  isSystemReply,
} from '@/lib/updates/classify';
import { parseDealflowReport } from '@/lib/updates/dealflow';
import { parseDigestRun, parseRoster } from '@/lib/updates/digest';
import { plainText, stripFooters, toBlocks } from '@/lib/updates/mrkdwn';
import type {
  SetupProblem,
  SlackMessage,
  UpdateAccess,
  UpdatePost,
  UpdateSource,
  UpdateSourceView,
  UpdatesSnapshot,
} from '@/lib/updates/types';
import { processWide } from '@/lib/util/process-state';

/**
 * The Updates tab's Slack reader: the dealflow and digest channels, read live
 * with the relay bot token and never written to.
 *
 * Nothing is stored outside this process. Each instance keeps what it parsed
 * in memory — five minutes for a good read, less while a thread may still be
 * posting or after a refusal — plus the last good copy of each channel for up
 * to a day, served only while Slack fails to answer. When access is withdrawn
 * (bot removed, token revoked, scope dropped) everything kept from that
 * channel is dropped at once. A forced refresh re-reads a channel at most once
 * every 20 seconds and never overrides Slack's Retry-After.
 */

export interface UpdatesFeed {
  sources: readonly UpdateSource[];
  token: string | undefined;
  fetchImpl: typeof fetch;
}

const SLACK_API = 'https://slack.com/api/';

const FRESH_MS = 300_000;
const SETTLING_MS = 60_000;
const REFUSED_MS = 60_000;
const UNREACHABLE_RETRY_MS = 10_000;
const AUTH_TTL_MS = 3_600_000;
const AUTH_RETRY_MS = 60_000;
const LAST_GOOD_MAX_MS = 86_400_000;
const FORCE_FLOOR_MS = 20_000;
const SETTLING_WINDOW_MS = 600_000;

const HISTORY_LIMIT = 100;
const REPLIES_LIMIT = 200;
const MAX_PAGES = 3;
const REPLIES_CONCURRENCY = 4;
const MAX_REPLIES_CALLS = 16;
const REPLIES_DEADLINE_MS = 8_000;
const REPLIES_CACHE_MAX = 200;
/** An edit changes neither reply_count nor latest_reply, so threads are re-read anyway. */
const REPLIES_MAX_AGE_MS = 1_800_000;

const DEALFLOW_KEEP = 4;
const OTHER_KEEP = 2;
const DIGEST_KEEP = 6;

const TOKEN_CODES = new Set([
  'invalid_auth',
  'not_authed',
  'token_revoked',
  'token_expired',
  'account_inactive',
]);

/* ------------------------------------------------------------------ cache */

interface SourceEntry {
  access: UpdateAccess;
  posts: UpdatePost[];
  fetchedAt: number;
  expiresAt: number;
  /** Retry-After: not even a forced read goes before this. */
  blockedUntil: number;
}

interface AuthInfo {
  workspaceUrl: string | null;
  botHandle: string | null;
  /** A token or scope problem that stops every history read. */
  problem: SetupProblem | null;
}

interface AuthEntry {
  info: AuthInfo;
  fetchedAt: number;
  expiresAt: number;
}

interface ReplyMessage {
  ts: string;
  text: string;
  subtype?: string;
}

const { sourceCache, lastGood, sourceInFlight, repliesCache } = processWide(
  'updates-caches',
  () => ({
    sourceCache: new Map<string, SourceEntry>(),
    lastGood: new Map<string, { posts: UpdatePost[]; at: number }>(),
    sourceInFlight: new Map<string, Promise<SourceEntry>>(),
    repliesCache: new Map<
      string,
      { fingerprint: string; messages: ReplyMessage[]; fetchedAt: number }
    >(),
  }),
);
/** Retry-After from conversations.replies, which Slack limits per method. */
const updatesState = processWide('updates', () => ({
  repliesBlockedUntil: 0,
  authCache: null as AuthEntry | null,
  authInFlight: null as Promise<AuthEntry> | null,
}));

/** Test seam: forget everything this process has read. */
export function resetUpdatesCache(): void {
  sourceCache.clear();
  lastGood.clear();
  sourceInFlight.clear();
  repliesCache.clear();
  updatesState.repliesBlockedUntil = 0;
  updatesState.authCache = null;
  updatesState.authInFlight = null;
}

/** Slack failed to answer; the channel may still be readable, so the last good copy may show. */
function isTransient(access: UpdateAccess): boolean {
  return (
    access.state === 'unreachable' || access.state === 'rate_limited' || access.state === 'error'
  );
}

/** Access was withdrawn: drop everything this process kept from the channel. */
function forgetChannel(channel: string): void {
  sourceCache.delete(channel);
  lastGood.delete(channel);
  for (const key of repliesCache.keys()) {
    if (key.startsWith(`${channel}:`)) repliesCache.delete(key);
  }
}

/* ------------------------------------------------------------------ slack */

type SlackBody = Record<string, unknown> & {
  ok?: boolean;
  error?: string;
  needed?: string;
  response_metadata?: { next_cursor?: string };
};

type SlackResult =
  { ok: true; body: SlackBody; headers: Headers } | { ok: false; access: UpdateAccess };

function accessForCode(code: string, body: SlackBody, headers: Headers | null): UpdateAccess {
  if (code === 'missing_scope') {
    return {
      state: 'missing_scope',
      needed: typeof body.needed === 'string' && body.needed ? body.needed : 'groups:history',
    };
  }
  if (code === 'channel_not_found' || code === 'not_in_channel') {
    return { state: 'not_invited', code };
  }
  if (TOKEN_CODES.has(code)) return { state: 'token_rejected', code };
  if (code === 'ratelimited') return { state: 'rate_limited', retryAfterSec: retryAfter(headers) };
  return { state: 'error', code };
}

function retryAfter(headers: Headers | null): number {
  const seconds = Number(headers?.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 60;
}

async function slackGet(
  feed: UpdatesFeed,
  method: string,
  params: Record<string, string>,
  channel: string | null,
): Promise<SlackResult> {
  const query = new URLSearchParams(params).toString();
  const url = `${SLACK_API}${method}${query ? `?${query}` : ''}`;
  let response: Response;
  try {
    response = await feed.fetchImpl(url, {
      headers: { Authorization: `Bearer ${feed.token}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    log.warn('Updates: Slack refused a read', { channel, method, error: 'unreachable' });
    return { ok: false, access: { state: 'unreachable' } };
  }
  if (response.status === 429) {
    log.warn('Updates: Slack refused a read', { channel, method, error: 'http_429' });
    return {
      ok: false,
      access: { state: 'rate_limited', retryAfterSec: retryAfter(response.headers) },
    };
  }
  if (response.status >= 500) {
    log.warn('Updates: Slack refused a read', {
      channel,
      method,
      error: `http_${response.status}`,
    });
    return { ok: false, access: { state: 'unreachable' } };
  }
  let body: SlackBody;
  try {
    body = (await response.json()) as SlackBody;
  } catch {
    const code = `http_${response.status}`;
    log.warn('Updates: Slack refused a read', { channel, method, error: code });
    return { ok: false, access: { state: 'error', code } };
  }
  if (body?.ok === true) return { ok: true, body, headers: response.headers };
  const code = typeof body?.error === 'string' ? body.error : 'unknown_error';
  log.warn('Updates: Slack refused a read', { channel, method, error: code });
  return { ok: false, access: accessForCode(code, body ?? {}, response.headers) };
}

function asMessages(value: unknown): SlackMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (m): m is SlackMessage =>
        typeof m === 'object' && m !== null && typeof (m as { ts?: unknown }).ts === 'string',
    )
    .map((m) => (typeof m.text === 'string' || m.text === undefined ? m : { ...m, text: '' }));
}

function nextCursor(body: SlackBody): string | null {
  const cursor = body.response_metadata?.next_cursor;
  return typeof cursor === 'string' && cursor ? cursor : null;
}

/* ------------------------------------------------------------------- auth */

function workspaceUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.slack.com')) return null;
    return `https://${url.hostname}/`;
  } catch {
    return null;
  }
}

async function fetchAuth(feed: UpdatesFeed, now: number): Promise<AuthEntry> {
  const result = await slackGet(feed, 'auth.test', {}, null);
  if (!result.ok) {
    const problem: SetupProblem | null =
      result.access.state === 'token_rejected'
        ? { kind: 'token_rejected', code: result.access.code }
        : null;
    return {
      info: { workspaceUrl: null, botHandle: null, problem },
      fetchedAt: now,
      expiresAt: now + AUTH_RETRY_MS,
    };
  }
  const scopesHeader = result.headers.get('x-oauth-scopes');
  const scopes = scopesHeader
    ? scopesHeader
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : null;
  const missing = scopes !== null && !scopes.includes('groups:history');
  const info: AuthInfo = {
    workspaceUrl: workspaceUrl(result.body.url),
    botHandle: typeof result.body.user === 'string' && result.body.user ? result.body.user : null,
    problem: missing ? { kind: 'missing_scope', needed: 'groups:history' } : null,
  };
  const healthy = scopes !== null && !missing;
  return { info, fetchedAt: now, expiresAt: now + (healthy ? AUTH_TTL_MS : AUTH_RETRY_MS) };
}

async function getAuth(
  feed: UpdatesFeed,
  now: number,
  force: boolean,
): Promise<{ entry: AuthEntry; fetched: boolean }> {
  const cached = updatesState.authCache;
  if (cached) {
    const fresh = now < cached.expiresAt;
    const forcedPastFloor = force && now - cached.fetchedAt >= FORCE_FLOOR_MS;
    if (fresh && !forcedPastFloor) return { entry: cached, fetched: false };
  }
  if (updatesState.authInFlight) return { entry: await updatesState.authInFlight, fetched: false };
  const pending = fetchAuth(feed, now).finally(() => {
    updatesState.authInFlight = null;
  });
  updatesState.authInFlight = pending;
  const entry = await pending;
  updatesState.authCache = entry;
  return { entry, fetched: true };
}

/* ---------------------------------------------------------------- history */

interface Kept {
  msg: SlackMessage;
  cls: ReturnType<typeof classifyTopLevel>;
}

function enough(group: UpdateSource['group'], kept: Kept[]): boolean {
  if (group === 'dealflow') {
    return kept.filter((k) => k.cls.kind === 'dealflow').length >= DEALFLOW_KEEP;
  }
  const runs = kept.filter((k) => k.cls.kind === 'digest').length;
  return runs >= DIGEST_KEEP && kept.some((k) => k.cls.kind === 'roster');
}

/** Newest first, as Slack returns it; keep what this source's tab shows. */
function select(group: UpdateSource['group'], messages: SlackMessage[]): Kept[] {
  const kept: Kept[] = [];
  let dealflow = 0;
  let other = 0;
  let runs = 0;
  let roster: Kept | null = null;
  for (const msg of messages) {
    if (isSystemMessage(msg)) continue;
    const cls = classifyTopLevel(msg);
    if (group === 'dealflow') {
      if (cls.kind === 'dealflow' && dealflow < DEALFLOW_KEEP) {
        kept.push({ msg, cls });
        dealflow++;
      } else if (cls.kind === 'other' && other < OTHER_KEEP) {
        kept.push({ msg, cls });
        other++;
      }
    } else if (cls.kind === 'digest' && runs < DIGEST_KEEP) {
      kept.push({ msg, cls });
      runs++;
    } else if (cls.kind === 'roster') {
      const best = roster?.cls.kind === 'roster' ? roster.cls.version : -1;
      if (cls.version > best) roster = { msg, cls };
    }
  }
  if (roster) kept.push(roster);
  return kept;
}

type HistoryResult = { ok: true; messages: SlackMessage[] } | { ok: false; access: UpdateAccess };

async function readHistory(feed: UpdatesFeed, source: UpdateSource): Promise<HistoryResult> {
  const messages: SlackMessage[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params: Record<string, string> = {
      channel: source.channelId,
      limit: String(HISTORY_LIMIT),
    };
    if (cursor) params.cursor = cursor;
    const result = await slackGet(feed, 'conversations.history', params, source.channelId);
    if (!result.ok) {
      // A later page failing still leaves a usable newest page.
      if (page === 0) return result;
      break;
    }
    messages.push(...asMessages(result.body.messages));
    const kept = select(source.group, messages);
    cursor = nextCursor(result.body);
    if (enough(source.group, kept) || !cursor) break;
  }
  return { ok: true, messages };
}

/* ---------------------------------------------------------------- replies */

interface ReplyBudget {
  /** The read's clock, for cache ages and Retry-After. */
  now: number;
  callsLeft: number;
  deadline: number;
  stopped: boolean;
  slot: <T>(fn: () => Promise<T>) => Promise<T>;
}

/** At most `limit` of these at once across every source in one read. */
function semaphore(limit: number): ReplyBudget['slot'] {
  let active = 0;
  const queue: (() => void)[] = [];
  return async (fn) => {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    else active++;
    try {
      return await fn();
    } finally {
      // Hand the slot straight to the next waiter, so a newcomer cannot overtake it.
      const next = queue.shift();
      if (next) next();
      else active--;
    }
  };
}

function beforeDeadline<T>(promise: Promise<T>, deadline: number, fallback: T): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.resolve(fallback);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), remaining);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

type RepliesOutcome = { ok: true; messages: ReplyMessage[]; fetched: boolean } | { ok: false };

async function readReplies(
  feed: UpdatesFeed,
  channel: string,
  parent: SlackMessage,
  budget: ReplyBudget,
): Promise<RepliesOutcome> {
  const key = `${channel}:${parent.ts}`;
  const fingerprint = `${parent.reply_count ?? 0}:${parent.latest_reply ?? ''}`;
  const cached = repliesCache.get(key);
  if (
    cached &&
    cached.fingerprint === fingerprint &&
    budget.now - cached.fetchedAt < REPLIES_MAX_AGE_MS
  ) {
    return { ok: true, messages: cached.messages, fetched: false };
  }
  return budget.slot(async (): Promise<RepliesOutcome> => {
    // Wall-clock on purpose: this bounds real network time, not cache age.
    if (
      budget.stopped ||
      budget.callsLeft <= 0 ||
      Date.now() > budget.deadline ||
      budget.now < updatesState.repliesBlockedUntil
    ) {
      return { ok: false };
    }
    budget.callsLeft--;

    const messages: ReplyMessage[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const params: Record<string, string> = {
        channel,
        ts: parent.ts,
        limit: String(REPLIES_LIMIT),
      };
      if (cursor) params.cursor = cursor;
      const result = await slackGet(feed, 'conversations.replies', params, channel);
      if (!result.ok) {
        if (result.access.state === 'rate_limited') {
          budget.stopped = true;
          updatesState.repliesBlockedUntil = Math.max(
            updatesState.repliesBlockedUntil,
            budget.now + result.access.retryAfterSec * 1000,
          );
        }
        if (page === 0) return { ok: false };
        break;
      }
      for (const m of asMessages(result.body.messages)) {
        if (m.ts === parent.ts) continue;
        messages.push({
          ts: m.ts,
          text: typeof m.text === 'string' ? m.text : '',
          subtype: m.subtype,
        });
      }
      cursor = nextCursor(result.body);
      if (!cursor) break;
    }
    repliesCache.delete(key);
    repliesCache.set(key, { fingerprint, messages, fetchedAt: budget.now });
    while (repliesCache.size > REPLIES_CACHE_MAX) {
      const oldest = repliesCache.keys().next().value;
      if (oldest === undefined) break;
      repliesCache.delete(oldest);
    }
    return { ok: true, messages, fetched: true };
  });
}

/* ----------------------------------------------------------------- parse */

function tsToIso(ts: string): string {
  const ms = Number(ts) * 1000;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date(0).toISOString();
}

/** A post the parsers cannot read still shows, as a card that links to Slack. */
function buildPostSafely(
  channel: string,
  kept: Kept,
  replies: ReplyMessage[] | null,
): UpdatePost | null {
  try {
    return buildPost(kept, replies);
  } catch (error) {
    log.warn('Updates: a post could not be parsed', {
      channel,
      kind: kept.cls.kind,
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return {
      ts: kept.msg.ts,
      postedAt: tsToIso(kept.msg.ts),
      permalink: null,
      settling: false,
      threadMissing: false,
      type: 'other',
      firstLine: 'A post that could not be shown here',
      blocks: [{ type: 'para', lines: [[{ text: 'Open it in Slack to read it.' }]] }],
      fileOnly: false,
    };
  }
}

function buildPost(kept: Kept, replies: ReplyMessage[] | null): UpdatePost | null {
  const { msg, cls } = kept;
  const base = {
    ts: msg.ts,
    postedAt: tsToIso(msg.ts),
    permalink: null,
    settling: false,
    threadMissing: replies === null && (msg.reply_count ?? 0) > 0,
  };
  const text = msg.text ?? '';
  const thread = (replies ?? []).filter((r) => !isSystemReply(r.subtype));
  if (cls.kind === 'dealflow') {
    return {
      ...base,
      ...parseDealflowReport(
        cls.format,
        text,
        thread.map((r) => r.text),
      ),
    };
  }
  if (cls.kind === 'digest') return { ...base, ...parseDigestRun(text, thread) };
  if (cls.kind === 'roster') {
    const appendix = thread
      .filter((r) => /^\*ROSTER v\d+ [—–-] appendix\*/.test(r.text.trim()))
      .map((r) => r.text);
    return { ...base, ...parseRoster(text, appendix) };
  }
  if (cls.kind === 'other') {
    const cleaned = stripFooters(text).text;
    return {
      ...base,
      type: 'other',
      firstLine: plainText(firstLine(cleaned)) || 'Post',
      blocks: toBlocks(cleaned),
      fileOnly: cls.fileOnly,
    };
  }
  return null;
}

/* ---------------------------------------------------------------- sources */

async function readSourceFresh(
  feed: UpdatesFeed,
  source: UpdateSource,
  now: number,
  budget: ReplyBudget,
): Promise<SourceEntry> {
  const channel = source.channelId;
  const history = await readHistory(feed, source);
  let entry: SourceEntry;
  let repliesFetched = 0;
  if (!history.ok) {
    const access = history.access;
    if (!isTransient(access)) forgetChannel(channel);
    const blockedUntil = access.state === 'rate_limited' ? now + access.retryAfterSec * 1000 : 0;
    const expiresAt =
      access.state === 'rate_limited'
        ? blockedUntil
        : access.state === 'unreachable'
          ? now + UNREACHABLE_RETRY_MS
          : now + REFUSED_MS;
    entry = { access, posts: [], fetchedAt: now, expiresAt, blockedUntil };
  } else {
    const kept = select(source.group, history.messages);
    const withReplies = kept.filter((k) => (k.msg.reply_count ?? 0) > 0 && k.cls.kind !== 'other');
    const outcomes = await Promise.all(
      withReplies.map((k) =>
        beforeDeadline(readReplies(feed, channel, k.msg, budget), budget.deadline, {
          ok: false,
        } as RepliesOutcome),
      ),
    );
    const replies = new Map<string, ReplyMessage[] | null>();
    withReplies.forEach((k, i) => {
      const outcome = outcomes[i];
      replies.set(k.msg.ts, outcome?.ok ? outcome.messages : null);
      if (outcome?.ok && outcome.fetched) repliesFetched++;
    });
    const posts = kept
      .map((k) =>
        buildPostSafely(channel, k, replies.has(k.msg.ts) ? (replies.get(k.msg.ts) ?? null) : []),
      )
      .filter((p): p is UpdatePost => p !== null)
      .sort((a, b) => Number(b.ts) - Number(a.ts));
    const threadGap = outcomes.some((o) => !o.ok);
    const settling = posts.some((p) => now - Date.parse(p.postedAt) < SETTLING_WINDOW_MS);
    entry = {
      access: { state: 'ok' },
      posts,
      fetchedAt: now,
      expiresAt: now + (threadGap ? REFUSED_MS : settling ? SETTLING_MS : FRESH_MS),
      blockedUntil: 0,
    };
    // A copy with an unread thread never replaces a complete one.
    const previous = lastGood.get(channel);
    if (!threadGap || !previous || now - previous.at > LAST_GOOD_MAX_MS) {
      lastGood.set(channel, { posts, at: now });
    }
  }
  sourceCache.set(channel, entry);
  log.info('Updates read', {
    channel,
    state: entry.access.state,
    posts: entry.posts.length,
    repliesFetched,
  });
  return entry;
}

function needsRead(entry: SourceEntry | undefined, now: number, force: boolean): boolean {
  if (!entry) return true;
  if (now < entry.blockedUntil) return false;
  if (now >= entry.expiresAt) return true;
  return force && now - entry.fetchedAt >= FORCE_FLOOR_MS;
}

async function getSource(
  feed: UpdatesFeed,
  source: UpdateSource,
  now: number,
  force: boolean,
  budget: ReplyBudget,
): Promise<{ entry: SourceEntry; fetched: boolean }> {
  const channel = source.channelId;
  const cached = sourceCache.get(channel);
  if (cached && !needsRead(cached, now, force)) return { entry: cached, fetched: false };
  const pending = sourceInFlight.get(channel);
  if (pending) return { entry: await pending, fetched: false };
  const read = readSourceFresh(feed, source, now, budget).finally(() => {
    sourceInFlight.delete(channel);
  });
  sourceInFlight.set(channel, read);
  return { entry: await read, fetched: true };
}

function view(
  source: UpdateSource,
  access: UpdateAccess,
  entryPosts: UpdatePost[],
  checkedAt: number,
  now: number,
  auth: AuthInfo,
): UpdateSourceView {
  const channel = source.channelId;
  let posts = entryPosts;
  let stale: UpdateSourceView['stale'] = null;
  if (isTransient(access)) {
    const good = lastGood.get(channel);
    if (good && now - good.at <= LAST_GOOD_MAX_MS) {
      posts = good.posts;
      stale = { since: new Date(good.at).toISOString() };
    } else if (good) {
      lastGood.delete(channel);
    }
  }
  const ws = auth.workspaceUrl;
  const shown = posts.map((p) => ({
    ...p,
    permalink: ws ? `${ws}archives/${channel}/p${p.ts.replace('.', '')}` : null,
    settling: now - Date.parse(p.postedAt) < SETTLING_WINDOW_MS,
  })) as UpdatePost[];
  const routine = shown.filter((p) => p.type === 'dealflow' || p.type === 'digest');
  const lastPostAt = routine.reduce<string | null>(
    (latest, p) => (!latest || p.postedAt > latest ? p.postedAt : latest),
    null,
  );
  return {
    source,
    access,
    posts: shown,
    lastPostAt,
    overdue:
      access.state === 'ok' &&
      lastPostAt !== null &&
      now - Date.parse(lastPostAt) > source.staleAfterDays * 86_400_000,
    stale,
    channelUrl: ws ? `${ws}archives/${channel}` : null,
    checkedAt: new Date(checkedAt).toISOString(),
  };
}

/**
 * Read every source, from cache where it is fresh. Never throws: a Slack
 * fault becomes a per-source access state the page can explain.
 */
export async function readUpdates(
  feed: UpdatesFeed,
  opts: { force?: boolean; now?: Date } = {},
): Promise<UpdatesSnapshot> {
  const nowDate = opts.now ?? new Date();
  const now = nowDate.getTime();
  const force = opts.force === true;
  const checkedAt = nowDate.toISOString();
  const empty = { botHandle: null, url: null };

  try {
    if (!feed.token) {
      for (const s of feed.sources) forgetChannel(s.channelId);
      return {
        sources: feed.sources.map((s) => view(s, { state: 'no_token' }, [], now, now, emptyAuth())),
        workspace: empty,
        setup: { kind: 'no_token' },
        throttled: false,
        checkedAt,
      };
    }

    const { entry: auth, fetched: authFetched } = await getAuth(feed, now, force);
    const problem = auth.info.problem;
    if (problem) for (const s of feed.sources) forgetChannel(s.channelId);
    // "Throttled" means no channel was re-read — unless a token or scope
    // problem stops every read, when auth.test is the whole check.
    let reread = problem !== null && authFetched;
    const budget: ReplyBudget = {
      now,
      callsLeft: MAX_REPLIES_CALLS,
      deadline: Date.now() + REPLIES_DEADLINE_MS,
      stopped: false,
      slot: semaphore(REPLIES_CONCURRENCY),
    };

    const views = await Promise.all(
      feed.sources.map(async (source) => {
        if (problem) {
          const access: UpdateAccess =
            problem.kind === 'token_rejected'
              ? { state: 'token_rejected', code: problem.code }
              : problem.kind === 'missing_scope'
                ? { state: 'missing_scope', needed: problem.needed }
                : { state: 'no_token' };
          return view(source, access, [], auth.fetchedAt, now, auth.info);
        }
        const { entry, fetched } = await getSource(feed, source, now, force, budget);
        if (fetched) reread = true;
        return view(source, entry.access, entry.posts, entry.fetchedAt, now, auth.info);
      }),
    );

    const scopeGap = views.find((v) => v.access.state === 'missing_scope')?.access;
    const setup: SetupProblem | null =
      problem ??
      (scopeGap?.state === 'missing_scope'
        ? { kind: 'missing_scope', needed: scopeGap.needed }
        : null);
    const oldest = views.reduce<string | null>(
      (min, v) => (!min || v.checkedAt < min ? v.checkedAt : min),
      null,
    );
    return {
      sources: views,
      workspace: { botHandle: auth.info.botHandle, url: auth.info.workspaceUrl },
      setup,
      throttled: force && !reread,
      checkedAt: oldest ?? checkedAt,
    };
  } catch (error) {
    log.error('Updates: read failed', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return {
      sources: feed.sources.map((s) =>
        view(s, { state: 'error', code: 'internal' }, [], now, now, emptyAuth()),
      ),
      workspace: empty,
      setup: null,
      throttled: false,
      checkedAt,
    };
  }
}

function emptyAuth(): AuthInfo {
  return { workspaceUrl: null, botHandle: null, problem: null };
}
