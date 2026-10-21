import 'server-only';
import type { z } from 'zod';
import { env, type AppEnv } from '@/lib/config/env';
import type { DataStore } from '@/lib/db/store';
import type { RelayEnvelope } from '@/lib/portfolio/relay-fields';
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
 * A routine's snapshot in the private #deal-relay channel, read live: the
 * shape Jobs (`JOBS_V1`) and Students (`STUDENTS_V1`) share. Nothing is
 * stored; the newest complete run wins.
 *
 * A post is two lines: the marker, then the JSON in single backticks. A run
 * too long for one Slack message is split into numbered parts, each repeating
 * the run's `run_at` and saying how many parts there are; a run whose parts
 * are not all in yet is passed over for the last complete one. Each item is
 * validated on its own: one bad row is dropped and counted, the rest still
 * show. The item ids are the app's own hashes, whatever the routine sent.
 */

/** How one routine's posts are read. */
export interface RelaySnapshotSpec<Item, Post extends RelayEnvelope> {
  marker: string;
  /** For log lines only ("Jobs"); never content. */
  name: string;
  post: z.ZodType<Post>;
  /** The post's raw rows, each checked on its own by `item`. */
  rows: (post: Post) => readonly unknown[];
  /** One row -> an item with the app's own id, or null when it does not validate. */
  item: (row: unknown) => Item | null;
  /** A whole run's items as shown: one per id, in order. */
  finish: (items: Item[]) => Item[];
}

export interface ParsedRelayPost<Item, Post> {
  post: Post;
  items: Item[];
  /** Rows that did not validate. */
  dropped: number;
}

export interface RelaySnapshot<Item> {
  runAt: string;
  /** When the newest part of that run reached Slack. */
  postedAt: string;
  scannedSince: string | null;
  emailsScanned: number | null;
  items: Item[];
  /** The run's parts are not all there (still posting, or one went missing). */
  partial: boolean;
  /** Rows in the posts that did not validate and were left out. */
  dropped: number;
}

const MAX_MESSAGE_CHARS = 40_000;

/**
 * One relay message -> a parsed post, or null when it is not one of this
 * routine's or its envelope does not validate. Slack's link markup is undone
 * first, so a link or an address arrives as the text the routine wrote.
 */
export function parseRelayPost<Item, Post extends RelayEnvelope>(
  raw: unknown,
  spec: RelaySnapshotSpec<Item, Post>,
): ParsedRelayPost<Item, Post> | null {
  if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_CHARS) return null;
  const clean = unwrapSlackText(raw, { preferLabel: true }).trim();
  if (!clean.startsWith(`${spec.marker}\n`) && !clean.startsWith(`${spec.marker} `)) return null;
  const json = /`([^`]+)`/.exec(clean)?.[1];
  if (!json) return null;
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    log.warn(`${spec.name} relay post is not valid JSON`);
    return null;
  }
  const parsed = spec.post.safeParse(data);
  if (!parsed.success) {
    log.warn(`${spec.name} relay post did not validate`, {
      issue: parsed.error.issues[0]?.path.join('.') ?? 'unknown',
    });
    return null;
  }
  const items: Item[] = [];
  let dropped = 0;
  for (const row of spec.rows(parsed.data)) {
    const item = spec.item(row);
    if (item === null) dropped++;
    else items.push(item);
  }
  if (dropped > 0) log.warn(`${spec.name} relay post had rows that did not validate`, { dropped });
  return { post: parsed.data, items, dropped };
}

interface Run<Item, Post> {
  runAt: string;
  postedAt: string;
  byPart: Map<number, ParsedRelayPost<Item, Post>>;
  /** When each part was posted, so a part posted twice (a retry) keeps the later post. */
  partAt: Map<number, string>;
  /** The part count any part declared. */
  parts: number | null;
}

function isComplete(run: Run<unknown, unknown>): boolean {
  const numbers = [...run.byPart.keys()];
  const expected = run.parts ?? Math.max(...numbers);
  if (numbers.length !== expected) return false;
  for (let n = 1; n <= expected; n++) if (!run.byPart.has(n)) return false;
  return true;
}

/**
 * Slack pages (newest first) -> the snapshot to show: the newest run whose
 * parts are all there, else the newest run as it stands (marked partial).
 * Null when no post of this routine is in the window. Pure, for tests.
 */
export function collectRelaySnapshot<Item, Post extends RelayEnvelope>(
  messages: readonly SlackMessage[],
  posterIds: readonly string[],
  spec: RelaySnapshotSpec<Item, Post>,
): RelaySnapshot<Item> | null {
  const runs = new Map<string, Run<Item, Post>>();
  for (const m of messages) {
    if (m.subtype !== undefined && m.subtype !== null) continue;
    if (posterIds.length > 0 && !(typeof m.user === 'string' && posterIds.includes(m.user))) {
      continue;
    }
    const iso = slackTsToIso(m.ts);
    if (!iso) continue;
    const parsed = parseRelayPost(m.text, spec);
    if (!parsed) continue;
    const runAt = parsed.post.run_at;
    const run: Run<Item, Post> = runs.get(runAt) ?? {
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
    items: spec.finish(ordered.flatMap((p) => p.items)),
    partial: !isComplete(chosen),
    dropped: ordered.reduce((sum, p) => sum + p.dropped, 0),
  };
}

/* -------------------------------------------------------------- the read */

export type RelaySnapshotState = FollowUpsState;

export interface RelaySnapshotResult<S> {
  state: RelaySnapshotState;
  /** Null until the routine has posted (or when the read failed). */
  snapshot: S | null;
  readAt: string;
}

export interface RelayReadOptions {
  fetchImpl?: typeof fetch;
  now?: Date;
  force?: boolean;
  e?: AppEnv;
}

const WINDOW_DAYS = 30;
const MAX_PAGES = 5;
const PAGE_SIZE = 200;
/** A snapshot posted at most a few times a week: a good read is kept five minutes. */
const CACHE_MS = 5 * 60_000;
/** After a refusal or fault, try again after a minute. */
const RETRY_MS = 60_000;
/** The last good read, served while Slack fails to answer (never once access is withdrawn). */
const LAST_GOOD_MS = 14 * 24 * 60 * 60_000;
/** Faults that may clear on their own; anything else means access was withdrawn. */
const TRANSIENT: readonly RelayReadState[] = ['error', 'rate_limited'];

export interface RelaySnapshotReader<S> {
  /**
   * The current snapshot for this organization. Cached for five minutes and
   * shared between concurrent callers; the last good read stands in while
   * Slack is down or rate-limiting. Never throws.
   *
   * Closed until sign-in is limited to TipTop accounts, like Follow-ups: the
   * posts quote people's emails.
   */
  read(
    store: DataStore,
    organizationId: string,
    options?: RelayReadOptions,
  ): Promise<RelaySnapshotResult<S>>;
  /**
   * `read` for a page that only shows a count or a short list: past `ms` the
   * answer is null, read as "nothing to show", and the read carries on to
   * fill the cache for the next view.
   */
  readWithin(
    store: DataStore,
    organizationId: string,
    ms: number,
    options?: RelayReadOptions,
  ): Promise<RelaySnapshotResult<S> | null>;
  /**
   * The snapshot only if it is already in memory (or the demo's), with no
   * read: for the count on a tab's label, which must never slow the page.
   */
  peek(organizationId: string, options?: { now?: Date; e?: AppEnv }): S | null;
  /** Test hook. */
  reset(): void;
}

/**
 * The cached, never-throwing reader for one routine's snapshot. `key` names
 * its process-wide cache; `collect` turns the channel's messages into the
 * snapshot (null when the routine has not posted in the window).
 */
export function relaySnapshotReader<S extends { partial: boolean }>(config: {
  key: string;
  /** For log lines only ("jobs"). */
  name: string;
  collect: (messages: readonly SlackMessage[], posterIds: readonly string[]) => S | null;
  demo: (now: Date) => S;
}): RelaySnapshotReader<S> {
  interface CacheEntry {
    at: number;
    ttl: number;
    result: RelaySnapshotResult<S>;
  }
  const cache = processWide(config.key, () => ({
    entries: new Map<string, CacheEntry>(),
    lastGood: new Map<string, { at: number; result: RelaySnapshotResult<S> }>(),
    inFlight: new Map<string, Promise<RelaySnapshotResult<S>>>(),
  }));

  const read: RelaySnapshotReader<S>['read'] = async (store, organizationId, options = {}) => {
    const { fetchImpl = fetch, now = new Date(), force = false, e = env() } = options;
    const result = (
      state: RelaySnapshotState,
      snapshot: S | null = null,
    ): RelaySnapshotResult<S> => ({ state, snapshot, readAt: now.toISOString() });

    if (e.demoMode) return result('ok', config.demo(now));
    if (!e.askRelaySlackToken) return result('not_configured');
    if (e.authAllowedDomains.length === 0) return result('restricted');

    const cached = cache.entries.get(organizationId);
    if (!force && cached && now.getTime() - cached.at < cached.ttl) return cached.result;
    const pending = cache.inFlight.get(organizationId);
    if (pending) return pending;

    const remember = (value: RelaySnapshotResult<S>, ttl: number) => {
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
          if (window.fault !== undefined)
            log.warn(`Reading ${config.name} from #deal-relay failed`);
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
        const value = result('ok', config.collect(window.messages, e.dealRelayPosterIds));
        // A read that worked and found no scan (every post aged out) has nothing to stand in.
        if (value.snapshot) {
          cache.lastGood.set(organizationId, { at: now.getTime(), result: value });
        } else {
          cache.lastGood.delete(organizationId);
        }
        // A run still posting its parts is read again after a minute.
        return remember(value, value.snapshot?.partial ? RETRY_MS : CACHE_MS);
      } catch {
        log.warn(`Reading ${config.name} failed unexpectedly`);
        return result('error');
      } finally {
        cache.inFlight.delete(organizationId);
      }
    })();
    cache.inFlight.set(organizationId, run);
    return run;
  };

  return {
    read,
    async readWithin(store, organizationId, ms, options = {}) {
      const pending = read(store, organizationId, options).catch(() => null);
      return (await settlesWithin(pending, ms)) ? pending : null;
    },
    peek(organizationId, { now = new Date(), e = env() } = {}) {
      if (e.demoMode) return config.demo(now);
      if (!e.askRelaySlackToken || e.authAllowedDomains.length === 0) return null;
      const entry = cache.entries.get(organizationId);
      if (entry?.result.state === 'ok') return entry.result.snapshot;
      return cache.lastGood.get(organizationId)?.result.snapshot ?? null;
    },
    reset() {
      cache.entries.clear();
      cache.lastGood.clear();
      cache.inFlight.clear();
    },
  };
}
