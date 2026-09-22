import 'server-only';
import { z } from 'zod';
import { env } from '@/lib/config/env';
import type { DataStore } from '@/lib/db/store';
import { log } from '@/lib/security/redact';
import { unwrapSlackText } from '@/lib/util/slack-text';
import type { RoutineBriefing } from '@/lib/types/domain';

/**
 * The Today-page briefing card(s), posted by the Daily Overview and Daily
 * Recap cloud routines rather than generated in-app.
 *
 * `summary` is stored and rendered as plain text, never HTML. The routines
 * are Claude sessions reading Nick's live mailbox and calendar — trusted in
 * the sense that their output is Claude's own prose, but the underlying
 * emails they summarise are third-party content the routines are instructed
 * to treat as data, not always successfully. Rendering their output as text
 * only closes the one class of failure that would matter here: a summary
 * that echoes something injection-shaped from a message can never become
 * markup on this page.
 */
export const ROUTINE_BRIEFING_SCHEMA = z.object({
  kind: z.enum(['morning', 'afternoon', 'dossier']),
  /** Local calendar date the routine ran for, in the user's timezone. */
  date_key: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date_key must be YYYY-MM-DD')
    .refine(isPlausibleDateKey, 'date_key must be a real date, no later than today'),
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(20_000),
  source_url: z.string().url().max(2000).nullish(),
});

export type RoutineBriefingPayload = z.infer<typeof ROUTINE_BRIEFING_SCHEMA>;

/**
 * A real calendar day, and no later than today anywhere on Earth (UTC+14).
 * A slot never moves back to an earlier date_key, so without the upper bound
 * one far-future date — a mistyped year from a routine, or a forged post —
 * would pin its slot until the row was fixed by hand.
 */
function isPlausibleDateKey(value: string): boolean {
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value) return false;
  const latest = new Date(Date.now() + 14 * 3_600_000).toISOString().slice(0, 10);
  return value <= latest;
}

/**
 * Replace one slot of the organization's briefing, unless the stored one is
 * newer.
 *
 * Upserted on `(organization_id, kind)`, so there is at most one row per
 * organization per kind: a morning post and an afternoon post the same day
 * are two independent rows, and posting the afternoon one does not touch the
 * dossier row at all. The existing row's id is preserved explicitly — passing
 * a fresh id on every call would still upsert correctly, but would churn the
 * primary key for no reason.
 *
 * Never moves back to an earlier date_key, and a payload identical to what is
 * stored is a no-op that leaves posted_at alone. Replays of old relay
 * messages are routine (every pull re-reads the channel's recent history),
 * and without this guard each replay put an older card back on the page.
 *
 * Which of several same-day posts is newest is the Slack pull's call, made
 * from Slack's own order, not this function's: a stored posted_at may be an
 * ingest time (a direct webhook post, or any row written before the pull
 * stamped Slack times), which cannot be compared with a Slack message time.
 *
 * `postedAt` is when the routine posted (the Slack message time, for a relay
 * pull); it defaults to now for a direct webhook post.
 */
export async function ingestRoutineBriefing(
  store: DataStore,
  organizationId: string,
  payload: RoutineBriefingPayload,
  opts: { postedAt?: Date; now?: Date } = {},
): Promise<{ row: RoutineBriefing; written: boolean }> {
  const now = opts.now ?? new Date();
  const postedAt = opts.postedAt ?? now;
  const existing = await store.findOne('routine_briefings', organizationId, {
    eq: { kind: payload.kind },
  });
  const sourceUrl = payload.source_url ?? null;
  if (existing) {
    const older = payload.date_key < existing.date_key;
    const unchanged =
      payload.date_key === existing.date_key &&
      existing.title === payload.title &&
      existing.summary === payload.summary &&
      existing.source_url === sourceUrl;
    if (older || unchanged) return { row: existing, written: false };
  }
  const row: RoutineBriefing = {
    id: existing?.id ?? crypto.randomUUID(),
    organization_id: organizationId,
    kind: payload.kind,
    date_key: payload.date_key,
    title: payload.title,
    summary: payload.summary,
    source_url: sourceUrl,
    posted_at: postedAt.toISOString(),
    updated_at: now.toISOString(),
  };
  const result = await store.upsert('routine_briefings', row, ['organization_id', 'kind']);
  return { row: result.row, written: true };
}

/**
 * The organization's current brief — whichever of the morning overview or
 * the afternoon recap is current for *today* — or null if neither has
 * posted yet.
 *
 * "Current" is decided by date_key first, not just posted_at: without that,
 * yesterday's 3pm afternoon post would outrank this morning's fresh brief
 * (posted_at 6am today is earlier in the day than 3pm yesterday was, but the
 * calendar date is what actually matters here). Within the same date_key the
 * afternoon post always wins — that is the entire point of the Recap.
 */
export async function getCurrentBrief(
  store: DataStore,
  organizationId: string,
): Promise<RoutineBriefing | null> {
  const [morning, afternoon] = await Promise.all([
    store.findOne('routine_briefings', organizationId, { eq: { kind: 'morning' } }),
    store.findOne('routine_briefings', organizationId, { eq: { kind: 'afternoon' } }),
  ]);
  if (!morning) return afternoon;
  if (!afternoon) return morning;
  if (afternoon.date_key !== morning.date_key) {
    return afternoon.date_key > morning.date_key ? afternoon : morning;
  }
  return afternoon;
}

/**
 * The organization's current meeting dossier, or null if the Daily Overview
 * has never posted one. Independent of `getCurrentBrief` — an afternoon
 * Recap has no dossier of its own, so this is untouched by the brief swap
 * and only changes when the next Overview posts a fresh one.
 */
export async function getCurrentDossier(
  store: DataStore,
  organizationId: string,
): Promise<RoutineBriefing | null> {
  return store.findOne('routine_briefings', organizationId, { eq: { kind: 'dossier' } });
}

/**
 * A fingerprint of what the Today page's briefing cards show, so an open tab
 * can tell whether it is stale. Built from posted_at rather than updated_at:
 * every accepted post moves posted_at, and nothing else should count as news.
 * Timestamps are normalized because Postgres and JS spell the same instant
 * differently.
 */
export function briefingVersion(
  brief: RoutineBriefing | null,
  dossier: RoutineBriefing | null,
): string {
  const iso = (value: string | undefined) => {
    if (!value) return '';
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? value : new Date(ms).toISOString();
  };
  return [
    brief?.kind,
    brief?.date_key,
    iso(brief?.posted_at),
    dossier?.date_key,
    iso(dossier?.posted_at),
  ].join('|');
}

/** Pull anything waiting in the relay, then fingerprint the current cards. */
export async function readBriefingVersion(
  store: DataStore,
  organizationId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  await pullBriefingsFromSlack(store, organizationId, fetchImpl);
  const [brief, dossier] = await Promise.all([
    getCurrentBrief(store, organizationId),
    getCurrentDossier(store, organizationId),
  ]);
  return briefingVersion(brief, dossier);
}

/* ---------------------------------------------------------- Slack relay */

const BRIEFING_MARKER = 'BRIEFING_PAYLOAD_V1';
const PULL_INTERVAL_MS = 60_000;
const RETRY_AFTER_FAILURE_MS = 10_000;
let nextBriefingPullAt = 0;
let briefingPullInFlight: Promise<number> | null = null;

/** One relay-channel message -> a validated briefing payload, or null. */
export function parseBriefingRelayMessage(text: unknown): RoutineBriefingPayload | null {
  if (typeof text !== 'string') return null;
  const clean = unwrapSlackText(text).trim();
  if (!clean.startsWith(BRIEFING_MARKER)) return null;
  const match = /`([^`]+)`/.exec(clean);
  if (!match?.[1]) return null;
  let json: unknown;
  try {
    json = JSON.parse(match[1]);
  } catch {
    return null;
  }
  const parsed = ROUTINE_BRIEFING_SCHEMA.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** Why a marked relay message failed to parse, for the log. No content. */
function explainRelayFailure(text: unknown): string {
  if (typeof text !== 'string') return 'text is not a string';
  const clean = unwrapSlackText(text).trim();
  const match = /`([^`]+)`/.exec(clean);
  if (!match?.[1]) return 'no backticked body';
  let json: unknown;
  try {
    json = JSON.parse(match[1]);
  } catch (error) {
    return `json: ${error instanceof Error ? error.message.slice(0, 80) : 'error'}`;
  }
  const parsed = ROUTINE_BRIEFING_SCHEMA.safeParse(json);
  return parsed.success
    ? 'ok'
    : `schema: ${parsed.error.issues
        .map((i) => `${i.path.join('.')} ${i.message}`)
        .join('; ')
        .slice(0, 160)}`;
}

/**
 * Pull the routines' briefing payloads straight from the Slack relay channel,
 * so the Today page reflects a routine's post the moment someone looks at it.
 * The cloud routines cannot reach this app directly, so the channel is the
 * hand-off, and this is the only thing that reads it.
 *
 * Per kind, only the payload with the latest date_key is ingested — the
 * newest post of that day — stamped with its Slack message time as
 * posted_at; the rest of the window is history, not candidates, and
 * ingestRoutineBriefing refuses anything older than what is stored. Returns
 * how many briefing rows were created or changed.
 *
 * Read on demand and throttled to once a minute per instance, because the
 * Today page and its open-tab watcher both call it. A network fault or Slack
 * 5xx is retried after 10 seconds instead, so one blip does not hide a fresh
 * post for a full minute. Never throws: a Slack fault must not take down the
 * page that asked.
 */
export async function pullBriefingsFromSlack(
  store: DataStore,
  organizationId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const e = env();
  if (!e.askRelaySlackToken) return 0;
  if (briefingPullInFlight) return briefingPullInFlight;
  if (Date.now() < nextBriefingPullAt) return 0;

  briefingPullInFlight = (async () => {
    let retryIn = RETRY_AFTER_FAILURE_MS;
    try {
      const url = `https://slack.com/api/conversations.history?channel=${encodeURIComponent(
        e.askRelayChannelId,
      )}&limit=50`;
      const response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${e.askRelaySlackToken}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(5_000),
      });
      if (response.status >= 500) throw new Error(`Slack answered ${response.status}`);
      // From here on Slack has answered. A refusal (missing_scope,
      // not_in_channel) will not clear in ten seconds, and a rate limit says
      // when to come back.
      const retryAfterSeconds = Number(response.headers.get('retry-after'));
      retryIn = Math.max(PULL_INTERVAL_MS, retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 0);
      const body = (await response.json()) as {
        ok?: boolean;
        error?: string;
        messages?: Array<{ text?: unknown; ts?: unknown }>;
      };
      if (!body.ok) {
        log.warn('Slack relay channel could not be read for briefings', {
          error: body.error ?? 'unknown',
        });
        return 0;
      }
      let parsedCount = 0;
      const scanned = body.messages?.length ?? 0;
      const newest = new Map<
        RoutineBriefingPayload['kind'],
        { payload: RoutineBriefingPayload; postedAt?: Date }
      >();
      for (const message of body.messages ?? []) {
        const payload = parseBriefingRelayMessage(message.text);
        if (!payload) {
          if (typeof message.text === 'string' && message.text.startsWith(BRIEFING_MARKER)) {
            log.warn('Relay message carries the briefing marker but did not parse', {
              reason: explainRelayFailure(message.text),
              length: message.text.length,
            });
          }
          continue;
        }
        parsedCount++;
        // Slack returns newest first, so within a day the first payload seen
        // wins. A later date_key wins even if it was posted earlier: a re-run
        // for yesterday posted after today's card must not hide it.
        const current = newest.get(payload.kind);
        if (current && payload.date_key <= current.payload.date_key) continue;
        newest.set(payload.kind, { payload, postedAt: slackTsToDate(message.ts) });
      }
      let changed = 0;
      for (const { payload, postedAt } of newest.values()) {
        const result = await ingestRoutineBriefing(store, organizationId, payload, { postedAt });
        if (result.written) changed++;
      }
      log.info('Briefing pull finished', {
        scanned,
        parsed: parsedCount,
        changed,
        channel: e.askRelayChannelId,
      });
      return changed;
    } catch (error) {
      log.warn('Pulling briefings from Slack failed', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      return 0;
    } finally {
      nextBriefingPullAt = Date.now() + retryIn;
      briefingPullInFlight = null;
    }
  })();
  return briefingPullInFlight;
}

/** A Slack message ts ("1785200000.000100", seconds) as a Date, if it is one. */
function slackTsToDate(ts: unknown): Date | undefined {
  if (typeof ts !== 'string' || !/^\d+(\.\d+)?$/.test(ts)) return undefined;
  return new Date(Number(ts) * 1000);
}

/** Test seam: forget the throttle so a second pull in the same process runs. */
export function resetBriefingPullThrottle(): void {
  nextBriefingPullAt = 0;
  briefingPullInFlight = null;
}
