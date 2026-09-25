import { z } from 'zod';
import { env, type AppEnv } from '@/lib/config/env';
import type { DataStore } from '@/lib/db/store';
import type { RelayObservation } from '@/lib/deals/routine-state';
import { log } from '@/lib/security/redact';
import { strictDomain } from '@/lib/deals/links';
import { readRelayWindow, slackTsToIso, type SlackMessage } from '@/lib/slack/relay-history';
import { unwrapSlackText } from '@/lib/util/slack-text';
import { ingestDealRelay, scrubErrorMessage, type DealIngestCounts } from './deal-ingest';

/**
 * The deal-sorter relay.
 *
 * A cloud routine reads Nick's mailbox, calendar and the weekly feed reports,
 * sorts every real startup deal into a pipeline stage, and posts the result to
 * a private Slack channel (#deal-relay) because its sandbox cannot reach this
 * app. This module is the reading half: the message format, the per-deal
 * schema, and the throttled pull that hands validated deals to the ingest.
 *
 * Each message is two lines — a marker, then JSON between single backticks —
 * like every other relay message. Deals are validated one at a time, so one
 * malformed deal never drops the rest of its message; a rejected deal is
 * counted by the path and message of its first problem, and nothing of its
 * content is kept.
 */

export const DEAL_UPSERT_MARKER = 'DEAL_UPSERT_V1';
export const DEAL_HEARTBEAT_MARKER = 'DEAL_SORTER_RUN_V1';

export const RELAY_PHASES = ['a1', 'a2', 'a3', 'b1', 'b2', 'c', 'inc'] as const;
/** The six backfill phases, in the order the routine runs them. */
export const BACKFILL_PHASES = ['a1', 'a2', 'a3', 'b1', 'b2', 'c'] as const;

/** The default thesis stage keys, which are the only stages the routine may name. */
export const RELAY_STAGE_KEYS = [
  'new',
  'reviewing',
  'waiting_for_info',
  'founder_meeting',
  'diligence',
  'ic_review',
  'passed',
  'monitoring',
  'invested',
] as const;

export const FIT_VALUES = ['likely', 'possible', 'unlikely'] as const;

const KEY_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const THREAD_ID_RE = /^[0-9a-f]{10,24}$/i;

function isRealDate(value: string): boolean {
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
  .refine(isRealDate, 'must be a real date');

/** An email address anywhere in a free-text field. */
const EMAIL_IN_TEXT = /[^\s@<>()[\]"',;:]+@[^\s@<>()[\]"',;:]+\.[a-z]{2,}/gi;
/**
 * A money amount: `$150K`, `€2.5M`, `USD 100,000`, `250k USD`. Scrubbed from
 * the fields that describe TipTop's own actions (evidence, next step, pass
 * reason), where an amount is TipTop's check or a term. `raise`, the round
 * size the founder states, is the one field meant to carry an amount.
 */
const AMOUNT_IN_TEXT =
  /[$€£]\s?\d[\d,.]*(?:\s?(?:k|m|mm|bn|b|million|thousand|billion)\b)?|\b(?:usd|eur|gbp)\s?\d[\d,.]*(?:\s?(?:k|m|mm|million|thousand)\b)?|\b\d[\d,.]*\s?(?:k|m|mm|million|thousand)?\s?(?:usd|eur|gbp|dollars)\b/gi;

const scrubEmails = (value: string) => value.replace(EMAIL_IN_TEXT, '[email removed]');
const scrubAmounts = (value: string) => value.replace(AMOUNT_IN_TEXT, '[amount]');

/**
 * Free text, with any email address replaced: the prompt forbids them, and
 * this is the backstop that makes "no slot for an email" true of every field
 * rather than only the ones named after one.
 */
const text = (max: number) => z.string().trim().min(1).max(max).transform(scrubEmails);
/** Free text about TipTop's own actions: no email, and no amount either. */
const actionText = (max: number) => text(max).transform(scrubAmounts);

/**
 * One deal as the routine posts it. Unknown fields are stripped, and there is
 * deliberately no field for an email address, a phone number, TipTop's own
 * check or any deal term: the schema cannot carry what the app must not store.
 */
export const RELAY_DEAL_SCHEMA = z
  .object({
    key: z.string().max(80).regex(KEY_RE, 'must be a lowercase slug'),
    name: text(200),
    aka: z.array(text(200)).max(5).optional(),
    stage: z.enum(RELAY_STAGE_KEYS).optional(),
    evidence: actionText(300).optional(),
    evidence_date: isoDate.optional(),
    evidence_kind: z.literal('wire').optional(),
    fit: z.enum(FIT_VALUES).optional(),
    source: text(100).optional(),
    summary: text(300).optional(),
    sector: text(100).optional(),
    round: text(60).optional(),
    raise: text(60).optional(),
    // A plain hostname only: an address or `good.example@evil.example` is
    // not a website, and would otherwise become a link to the wrong host.
    website: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((value) => strictDomain(value) !== null, 'must be a website domain')
      .optional(),
    founders: z
      .array(z.object({ name: text(200), title: text(100).optional() }))
      .max(6)
      .optional(),
    next_step: actionText(200).optional(),
    pass_reason: actionText(200).optional(),
    first_seen: isoDate.optional(),
    last_activity: isoDate.optional(),
    threads: z
      .array(
        z.object({
          id: z.string().regex(THREAD_ID_RE, 'must be a Gmail thread id'),
          subject: text(200).optional(),
          date: isoDate.optional(),
        }),
      )
      .max(5)
      .optional(),
    retract: text(200).optional(),
  })
  .refine((deal) => deal.stage === undefined || deal.evidence_date !== undefined, {
    message: 'is required with a stage',
    path: ['evidence_date'],
  });

export type RelayDeal = z.infer<typeof RELAY_DEAL_SCHEMA>;

export const DEAL_UPSERT_ENVELOPE = z.object({
  v: z.literal(1),
  source: text(100),
  batch: text(40),
  phase: z.enum(RELAY_PHASES),
  part: z.number().int().min(1).max(500),
  parts: z.number().int().min(1).max(500),
  deals: z.array(z.unknown()).max(12),
});

/**
 * The routine's end-of-run heartbeat. Parsed leniently: it only feeds the
 * status strip, so a missing or odd field falls back to a neutral value
 * rather than hiding the whole run.
 */
export const DEAL_HEARTBEAT_SCHEMA = z.object({
  v: z.number().optional().catch(undefined),
  source: z.string().max(100).optional().catch(undefined),
  run_at: z.string().max(40).optional().catch(undefined),
  phase: z.string().max(10).optional().catch(undefined),
  as_of: z.string().max(20).optional().catch(undefined),
  backfill_done: z.array(z.string().max(10)).max(20).catch([]),
  attempts: z.record(z.string().max(10), z.number()).catch({}),
  posted: z.number().int().min(0).catch(0),
  parts: z.number().int().min(0).catch(0),
  stages: z.record(z.string().max(40), z.number()).catch({}),
  near_misses: z.number().int().min(0).catch(0),
});

export type DealHeartbeat = z.infer<typeof DEAL_HEARTBEAT_SCHEMA>;

export interface RelayReject {
  /** Dotted path of the first problem, e.g. `website`. Never a value. */
  path: string;
  message: string;
}

export type ParsedDealRelayMessage =
  | {
      kind: 'upsert';
      batch: string;
      phase: (typeof RELAY_PHASES)[number];
      part: number;
      parts: number;
      deals: RelayDeal[];
      /** Deals dropped whole: their key or name was unusable. */
      rejects: RelayReject[];
      /** Optional fields (or list items) dropped from deals that were kept. */
      dropped: RelayReject[];
    }
  | { kind: 'heartbeat'; heartbeat: DealHeartbeat }
  | { kind: 'invalid'; reason: string };

/**
 * Slack's own ceiling on a message. Anything longer was not posted by the
 * routine (which caps a part at 8 deals), so it is not worth parsing.
 */
export const MAX_MESSAGE_CHARS = 40_000;
/** Deeper than any deal's shape (deal -> founders -> founder -> name). */
const MAX_DEPTH = 6;

/**
 * Drop null and empty-string properties, so "unknown" is always "absent".
 * Bounded in depth: anything nested deeper than a deal can be is dropped
 * rather than recursed into, so a hostile message cannot blow the stack.
 */
function compact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return undefined;
  if (Array.isArray(value)) {
    return value.filter((v) => v !== null).map((v) => compact(v, depth + 1));
  }
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    const inner = compact(v, depth + 1);
    if (inner !== undefined) out[k] = inner;
  }
  return out;
}

function issueOf(issue: z.ZodError['issues'][number] | undefined): RelayReject {
  const path = issue?.path.filter((p) => typeof p === 'string' || typeof p === 'number') ?? [];
  return {
    path: path.length > 0 ? path.join('.') : '(deal)',
    message: (issue?.message ?? 'invalid').slice(0, 80),
  };
}

function firstIssue(error: z.ZodError): RelayReject {
  return issueOf(error.issues[0]);
}

/** The only fields a deal cannot do without. */
const REQUIRED_FIELDS = new Set(['key', 'name']);

/**
 * One raw deal -> the deal, or the reason it was dropped whole.
 *
 * A problem in an optional field drops that field (or that list item) and
 * keeps the deal: one malformed thread id must not cost the company its key,
 * name and stage. A stage whose evidence date is missing or invalid goes with
 * it, since a stage never stands without its date. Only a bad key or name, or
 * something that is not an object at all, drops the whole deal.
 */
function parseRelayDeal(
  raw: unknown,
): { deal: RelayDeal; dropped: RelayReject[] } | { reject: RelayReject } {
  let value = compact(raw);
  const dropped: RelayReject[] = [];
  // Each round removes at least one field or item, and a deal has fewer than
  // twenty fields, so this always ends; the bound is only a backstop.
  for (let round = 0; round < 20; round++) {
    const parsed = RELAY_DEAL_SCHEMA.safeParse(value);
    if (parsed.success) return { deal: parsed.data, dropped };
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { reject: firstIssue(parsed.error) };
    }
    const fatal = parsed.error.issues.find((issue) => {
      const field = issue.path[0];
      return typeof field !== 'string' || REQUIRED_FIELDS.has(field);
    });
    if (fatal) return { reject: issueOf(fatal) };

    const next: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    const removeItems = new Map<string, Set<number>>();
    for (const issue of parsed.error.issues) {
      dropped.push(issueOf(issue));
      const field = issue.path[0] as string;
      const index = issue.path[1];
      if (field === 'evidence_date' && next.evidence_date === undefined) {
        // "is required with a stage": the stage cannot stand without it.
        delete next.stage;
      } else if (typeof index === 'number' && Array.isArray(next[field])) {
        const set = removeItems.get(field) ?? new Set<number>();
        set.add(index);
        removeItems.set(field, set);
      } else {
        delete next[field];
      }
    }
    for (const [field, indexes] of removeItems) {
      const list = next[field] as unknown[];
      next[field] = list.filter((_, i) => !indexes.has(i));
    }
    value = next;
  }
  return { reject: { path: '(deal)', message: 'could not be repaired' } };
}

/**
 * One #deal-relay message -> its parsed content, or null when it carries
 * neither deal marker (chatter, other relays' markers). `invalid` means the
 * marker was there but the body could not be read, so it is counted rather
 * than silently ignored.
 */
export function parseDealRelayMessage(text: unknown): ParsedDealRelayMessage | null {
  if (typeof text !== 'string') return null;
  // Labels, not URLs: `zeta.ai` in a name or website comes back from Slack as
  // `<http://zeta.ai|zeta.ai>`, and the label is what the routine wrote.
  const clean = unwrapSlackText(text, { preferLabel: true }).trim();
  const isUpsert = clean.startsWith(DEAL_UPSERT_MARKER);
  const isHeartbeat = !isUpsert && clean.startsWith(DEAL_HEARTBEAT_MARKER);
  if (!isUpsert && !isHeartbeat) return null;
  if (clean.length > MAX_MESSAGE_CHARS) return { kind: 'invalid', reason: 'message too long' };

  const match = /`([^`]+)`/.exec(clean);
  if (!match?.[1]) return { kind: 'invalid', reason: 'no backticked body' };
  let json: unknown;
  try {
    json = JSON.parse(match[1]);
  } catch {
    return { kind: 'invalid', reason: 'body is not JSON' };
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return { kind: 'invalid', reason: 'body is not an object' };
  }

  if (isHeartbeat) {
    return { kind: 'heartbeat', heartbeat: DEAL_HEARTBEAT_SCHEMA.parse(json) };
  }

  const envelope = DEAL_UPSERT_ENVELOPE.safeParse(json);
  if (!envelope.success) {
    const issue = firstIssue(envelope.error);
    return { kind: 'invalid', reason: `envelope ${issue.path}: ${issue.message}` };
  }
  const deals: RelayDeal[] = [];
  const rejects: RelayReject[] = [];
  const dropped: RelayReject[] = [];
  for (const raw of envelope.data.deals) {
    const parsed = parseRelayDeal(raw);
    if ('reject' in parsed) {
      rejects.push(parsed.reject);
    } else {
      deals.push(parsed.deal);
      dropped.push(...parsed.dropped);
    }
  }
  return {
    kind: 'upsert',
    batch: envelope.data.batch,
    phase: envelope.data.phase,
    part: envelope.data.part,
    parts: envelope.data.parts,
    deals,
    rejects,
    dropped,
  };
}

/* ------------------------------------------------------------ Slack pull */

export type DealRelayState =
  | 'pending'
  | 'not_configured'
  | 'ok'
  | 'bot_not_in_channel'
  | 'missing_scope'
  | 'bad_token'
  | 'rate_limited'
  | 'error'
  /** Read, but saving what was read failed; retried in seconds. */
  | 'save_failed'
  /**
   * Not this organization's feed: #deal-relay is one fund's mailbox, so it is
   * folded into the deployment's only organization and nowhere else (see
   * `lib/db/tenancy.ts`). The Portfolio mirror still runs.
   */
  | 'other_workspace';

export interface DealRelayStatus {
  state: DealRelayState;
  /** When this status was produced; null until the first pull finishes. */
  pulledAt: string | null;
  /** Variables still to set, for `not_configured`. Names only. */
  missing: string[];
  /** The scope Slack says is missing, for `missing_scope`. */
  needed: string | null;
  /** This pull's counts. Each pull re-reads the window, so these are often all "unchanged". */
  counts: DealIngestCounts | null;
  /** The newest pull that changed anything, carried across quiet pulls. */
  lastChange: { counts: DealIngestCounts; at: string } | null;
  /** The newest valid heartbeat in the window, with its Slack time. */
  lastRun: { heartbeat: DealHeartbeat; ts: string } | null;
  /**
   * Deals dropped whole (`total`), and optional fields dropped from deals that
   * were kept (`dropped`). `byIssue` counts both by path and message; the
   * dropped-field entries are prefixed "dropped ".
   */
  rejected: { total: number; dropped: number; byIssue: Record<string, number> };
  /** Messages read from Slack this pull. */
  scanned: number;
}

const PULL_INTERVAL_MS = 60_000;
const RETRY_AFTER_FAILURE_MS = 10_000;
const WINDOW_DAYS = 30;
const MAX_PAGES = 5;
const PAGE_SIZE = 200;
const CALL_TIMEOUT_MS = 8_000;

const statuses = new Map<string, DealRelayStatus>();
const nextPullAt = new Map<string, number>();
const inFlight = new Map<string, Promise<DealRelayStatus>>();

function emptyStatus(state: DealRelayState): DealRelayStatus {
  return {
    state,
    pulledAt: null,
    missing: [],
    needed: null,
    counts: null,
    lastChange: null,
    lastRun: null,
    rejected: { total: 0, dropped: 0, byIssue: {} },
    scanned: 0,
  };
}

/** Whether a pull's counts show any change worth reporting. */
export function countsChangedAnything(c: DealIngestCounts): boolean {
  return (
    c.created +
      c.updated +
      c.moved +
      c.retracted +
      c.retract_flagged +
      c.failed +
      c.mirrored +
      c.mirror_moved >
    0
  );
}

/** The last pull's outcome for this organization, or `pending` before the first. */
export function getDealRelayStatus(organizationId: string): DealRelayStatus {
  return statuses.get(organizationId) ?? emptyStatus('pending');
}

/** Whether the app can read #deal-relay at all (a token is set). */
export function dealRelayConfigured(e: AppEnv = env()): boolean {
  return Boolean(e.askRelaySlackToken);
}

async function fetchRelayHistory(fetchImpl: typeof fetch, e: AppEnv, now: Date) {
  const outcome = await readRelayWindow({
    token: e.askRelaySlackToken ?? '',
    channelId: e.dealRelayChannelId,
    windowDays: WINDOW_DAYS,
    maxPages: MAX_PAGES,
    pageSize: PAGE_SIZE,
    now,
    fetchImpl,
    timeoutMs: CALL_TIMEOUT_MS,
    refusalRetryMs: PULL_INTERVAL_MS,
    faultRetryMs: RETRY_AFTER_FAILURE_MS,
  });
  if (outcome.fault !== undefined) {
    log.warn('Reading #deal-relay failed', { reason: scrubErrorMessage(outcome.fault) });
  }
  return outcome;
}

export interface CollectedRelay {
  observations: RelayObservation[];
  lastRun: DealRelayStatus['lastRun'];
  rejected: DealRelayStatus['rejected'];
  parsedMessages: number;
}

/**
 * Slack's pages (newest first) -> deal observations, oldest first. A message
 * with a subtype (joins, edits, bot notices) is never a routine post, and when
 * a poster allow-list is configured anything from another user is skipped.
 */
export function collectRelayMessages(
  messages: readonly SlackMessage[],
  posterIds: readonly string[] = [],
): CollectedRelay {
  const usable = messages
    .filter((m) => m.subtype === undefined || m.subtype === null)
    .filter(
      (m) => posterIds.length === 0 || (typeof m.user === 'string' && posterIds.includes(m.user)),
    )
    .map((m) => ({ m, at: typeof m.ts === 'string' ? Number(m.ts) : Number.NaN }))
    .filter(({ at }) => Number.isFinite(at))
    .sort((a, b) => a.at - b.at);

  const observations: RelayObservation[] = [];
  const rejected: DealRelayStatus['rejected'] = { total: 0, dropped: 0, byIssue: {} };
  let lastRun: DealRelayStatus['lastRun'] = null;
  let parsedMessages = 0;
  let seq = 0;
  const reject = (issue: string) => {
    rejected.total++;
    rejected.byIssue[issue] = (rejected.byIssue[issue] ?? 0) + 1;
  };
  const drop = (issue: string) => {
    rejected.dropped++;
    const key = `dropped ${issue}`;
    rejected.byIssue[key] = (rejected.byIssue[key] ?? 0) + 1;
  };

  for (const { m } of usable) {
    // One unreadable message is counted and skipped; it never stops the rest
    // of the window (or the Portfolio mirror after it) from being read.
    let parsed: ParsedDealRelayMessage | null;
    try {
      parsed = parseDealRelayMessage(m.text);
    } catch {
      reject('message: unreadable');
      continue;
    }
    if (!parsed) continue;
    const iso = slackTsToIso(m.ts);
    const ts = iso ?? new Date(0).toISOString();
    if (parsed.kind === 'invalid') {
      reject(`message: ${parsed.reason}`);
      continue;
    }
    parsedMessages++;
    if (parsed.kind === 'heartbeat') {
      // Oldest first, so the last one seen is the newest.
      lastRun = { heartbeat: parsed.heartbeat, ts };
      continue;
    }
    for (const r of parsed.rejects) reject(`${r.path}: ${r.message}`);
    for (const r of parsed.dropped) drop(`${r.path}: ${r.message}`);
    const postDay = iso ? iso.slice(0, 10) : null;
    for (const deal of parsed.deals) {
      observations.push({
        seq: seq++,
        ts,
        batch: parsed.batch,
        part: parsed.part,
        deal: postDay ? clampDates(deal, postDay) : deal,
      });
    }
  }
  return { observations, lastRun, rejected, parsedMessages };
}

/**
 * No date the routine posts can be later than the day it posted it. An
 * upcoming meeting is evidence as of the day it was seen, not the day it is
 * scheduled for: left in the future, its date would outrank every real later
 * signal (a pass the next day, say) until that future day, and pin the
 * stage's evidence date there for good.
 */
export function clampDates(deal: RelayDeal, postDay: string): RelayDeal {
  const clamp = (value: string | undefined) =>
    value !== undefined && value > postDay ? postDay : value;
  const out: RelayDeal = { ...deal };
  for (const field of ['evidence_date', 'first_seen', 'last_activity'] as const) {
    if (out[field] !== undefined) out[field] = clamp(out[field]);
  }
  if (out.threads) {
    out.threads = out.threads.map((t) => (t.date ? { ...t, date: clamp(t.date) } : t));
  }
  return out;
}

/**
 * Whether #deal-relay belongs to this organization: the deployment's only
 * one. The channel carries one fund's mailbox-derived pipeline, and a
 * machine source never guesses between tenants (`lib/db/tenancy.ts`) — with
 * a second organization (the sign-up trigger makes one for any new user who
 * belongs to none) the relay is folded nowhere rather than copied into both.
 */
export async function isRelayOrganization(
  store: DataStore,
  organizationId: string,
): Promise<boolean> {
  const organizations = (await store.list('organizations', '', {})) as { id: string }[];
  return organizations.length === 1 && organizations[0]?.id === organizationId;
}

/**
 * Pull #deal-relay and fold it into the pipeline. Also runs the Portfolio ->
 * Invested mirror, which needs no Slack at all, so it happens even when the
 * relay is unreadable.
 *
 * Re-reads the last 30 days every time (up to 5 pages of 200): ingest is
 * idempotent and content-hashed, so an unchanged window costs zero writes.
 * Throttled to once a minute per organization; a network fault or Slack 5xx
 * retries after 10 seconds, a refusal waits the full minute and a rate limit
 * waits for its Retry-After. Concurrent callers share one pull. Never throws.
 */
export async function pullDealsFromSlack(
  store: DataStore,
  organizationId: string,
  fetchImpl: typeof fetch = fetch,
  opts: { force?: boolean; now?: Date } = {},
): Promise<DealRelayStatus> {
  const running = inFlight.get(organizationId);
  if (running) return running;
  if (!opts.force && Date.now() < (nextPullAt.get(organizationId) ?? 0)) {
    return getDealRelayStatus(organizationId);
  }

  const pull = (async (): Promise<DealRelayStatus> => {
    const e = env();
    const now = opts.now ?? new Date();
    const previous = statuses.get(organizationId);
    let retryIn = RETRY_AFTER_FAILURE_MS;
    let status = emptyStatus('error');
    try {
      let observations: RelayObservation[] = [];
      if (!dealRelayConfigured(e)) {
        status = { ...emptyStatus('not_configured'), missing: ['ASK_RELAY_SLACK_TOKEN'] };
        retryIn = PULL_INTERVAL_MS;
      } else if (!(await isRelayOrganization(store, organizationId))) {
        status = emptyStatus('other_workspace');
        retryIn = PULL_INTERVAL_MS;
      } else {
        const outcome = await fetchRelayHistory(fetchImpl, e, now);
        retryIn = outcome.retryIn;
        status = { ...emptyStatus(outcome.state), needed: outcome.needed };
        if (outcome.state === 'ok') {
          const collected = collectRelayMessages(outcome.messages, e.dealRelayPosterIds);
          observations = collected.observations;
          status.lastRun = collected.lastRun;
          status.rejected = collected.rejected;
          status.scanned = outcome.messages.length;
        } else {
          // Could not read this time; what the last good read saw still stands.
          status.lastRun = previous?.lastRun ?? null;
        }
      }
      try {
        status.counts = await ingestDealRelay(store, organizationId, observations, {
          now,
          rejected: status.rejected.total,
        });
      } catch (error) {
        // Read fine, could not save: say so, rather than "couldn't read".
        if (status.state === 'ok') status.state = 'save_failed';
        retryIn = RETRY_AFTER_FAILURE_MS;
        log.warn('Deal relay ingest failed', { reason: scrubErrorMessage(error) });
      }
      status.pulledAt = new Date().toISOString();
      status.lastChange =
        status.counts && countsChangedAnything(status.counts)
          ? { counts: status.counts, at: status.pulledAt }
          : (previous?.lastChange ?? null);
      log.info('Deal relay pull finished', {
        state: status.state,
        scanned: status.scanned,
        observations: observations.length,
        rejected: status.rejected.total,
        dropped: status.rejected.dropped,
        ...status.counts,
      });
    } catch (error) {
      status = {
        ...emptyStatus('error'),
        lastRun: status.lastRun ?? previous?.lastRun ?? null,
        lastChange: previous?.lastChange ?? null,
        pulledAt: new Date().toISOString(),
      };
      retryIn = RETRY_AFTER_FAILURE_MS;
      log.warn('Deal relay pull failed', { reason: scrubErrorMessage(error) });
    } finally {
      statuses.set(organizationId, status);
      nextPullAt.set(organizationId, Date.now() + retryIn);
      inFlight.delete(organizationId);
    }
    return status;
  })();
  inFlight.set(organizationId, pull);
  return pull;
}

/**
 * Counts only, never a company name: the daily job's response is printed into
 * the public repository's Actions log.
 */
export function formatDealCronStatus(status: DealRelayStatus): string {
  const c = status.counts;
  const mirror =
    c && c.mirrored + c.mirror_moved > 0
      ? `; ${c.mirrored + c.mirror_moved} put under Invested from Portfolio`
      : '';
  if (status.state !== 'ok' || !c) return `skipped: ${status.state}${mirror}`;
  return `ok: ${c.created} created, ${c.moved} moved, ${c.suggested} suggested, ${status.rejected.total} rejected${mirror}`;
}

/**
 * A fingerprint of what /deals shows, for the open-tab watcher: the live deal
 * count, the newest change to any deal, and the newest heartbeat. Timestamps
 * are normalized because Postgres and JS spell the same instant differently.
 */
export async function readDealsVersion(store: DataStore, organizationId: string): Promise<string> {
  const [count, newest] = await Promise.all([
    store.count('deals', organizationId, { eq: { is_archived: false } }),
    store.list(
      'deals',
      organizationId,
      {},
      { orderBy: [{ field: 'updated_at', direction: 'desc' }], limit: 1 },
    ),
  ]);
  const iso = (value: string | undefined) => {
    if (!value) return '';
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? value : new Date(ms).toISOString();
  };
  return [
    count,
    iso((newest[0] as { updated_at?: string } | undefined)?.updated_at),
    getDealRelayStatus(organizationId).lastRun?.ts ?? '',
  ].join('|');
}

/** Test seam: forget throttles, in-flight pulls and statuses. */
export function resetDealPullState(): void {
  statuses.clear();
  nextPullAt.clear();
  inFlight.clear();
}
