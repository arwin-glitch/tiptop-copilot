import 'server-only';
import { z } from 'zod';
import { env } from '@/lib/config/env';
import type { DataStore } from '@/lib/db/store';
import { log } from '@/lib/security/redact';
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
  date_key: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date_key must be YYYY-MM-DD'),
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(20_000),
  source_url: z.string().url().max(2000).nullish(),
});

export type RoutineBriefingPayload = z.infer<typeof ROUTINE_BRIEFING_SCHEMA>;

/**
 * Replace one slot of the organization's briefing.
 *
 * Upserted on `(organization_id, kind)`, so there is at most one row per
 * organization per kind: a morning post and an afternoon post the same day
 * are two independent rows, and posting the afternoon one does not touch the
 * dossier row at all. The existing row's id is preserved explicitly — passing
 * a fresh id on every call would still upsert correctly, but would churn the
 * primary key for no reason.
 */
export async function ingestRoutineBriefing(
  store: DataStore,
  organizationId: string,
  payload: RoutineBriefingPayload,
  now: Date = new Date(),
): Promise<RoutineBriefing> {
  const existing = await store.findOne('routine_briefings', organizationId, {
    eq: { kind: payload.kind },
  });
  const nowIso = now.toISOString();
  const row: RoutineBriefing = {
    id: existing?.id ?? crypto.randomUUID(),
    organization_id: organizationId,
    kind: payload.kind,
    date_key: payload.date_key,
    title: payload.title,
    summary: payload.summary,
    source_url: payload.source_url ?? null,
    posted_at: nowIso,
    updated_at: nowIso,
  };
  const result = await store.upsert('routine_briefings', row, ['organization_id', 'kind']);
  return result.row;
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

/* ---------------------------------------------------------- Slack relay */

const BRIEFING_MARKER = 'BRIEFING_PAYLOAD_V1';
const PULL_INTERVAL_MS = 60_000;
let lastBriefingPull = 0;
let briefingPullInFlight: Promise<number> | null = null;

/** One relay-channel message -> a validated briefing payload, or null. */
export function parseBriefingRelayMessage(text: unknown): RoutineBriefingPayload | null {
  if (typeof text !== 'string') return null;
  const clean = text.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').trim();
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
  const clean = text.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').trim();
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
    : `schema: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ').slice(0, 160)}`;
}

/**
 * Pull the routines' briefing payloads straight from the Slack relay channel,
 * so the Today page reflects a routine's post the moment someone looks at it
 * instead of whenever a scheduled GitHub job next runs. The cloud routines
 * cannot reach this app directly, so the channel is the hand-off.
 *
 * Read on demand and throttled to once a minute per instance, because the
 * Today page calls it on every render. Messages are applied oldest first so
 * the newest post of each kind wins, and a payload that is already stored
 * unchanged is skipped rather than rewritten. Returns how many briefing rows
 * were created or changed. Never throws: a Slack fault must not take down the
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
  if (Date.now() - lastBriefingPull < PULL_INTERVAL_MS) return 0;

  briefingPullInFlight = (async () => {
    try {
      const url = `https://slack.com/api/conversations.history?channel=${encodeURIComponent(
        e.askRelayChannelId,
      )}&limit=50`;
      const response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${e.askRelaySlackToken}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(5_000),
      });
      const body = (await response.json()) as {
        ok?: boolean;
        error?: string;
        messages?: Array<{ text?: unknown }>;
      };
      if (!body.ok) {
        log.warn('Slack relay channel could not be read for briefings', {
          error: body.error ?? 'unknown',
        });
        return 0;
      }
      let changed = 0;
      let parsedCount = 0;
      const scanned = body.messages?.length ?? 0;
      for (const message of [...(body.messages ?? [])].reverse()) {
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
        const existing = await store.findOne('routine_briefings', organizationId, {
          eq: { kind: payload.kind },
        });
        if (
          existing &&
          existing.date_key === payload.date_key &&
          existing.title === payload.title &&
          existing.summary === payload.summary
        ) {
          continue;
        }
        await ingestRoutineBriefing(store, organizationId, payload);
        changed++;
      }
      log.info('Briefing pull finished', {
        scanned,
        parsed: parsedCount,
        changed,
        channel: e.askRelayChannelId,
        // Diagnostic: shape of what Slack returned, no message content.
        sample: (body.messages ?? []).slice(0, 6).map((m) => {
          const raw = m as { text?: unknown; ts?: unknown; subtype?: unknown };
          return {
            ts: raw.ts,
            subtype: raw.subtype ?? null,
            head: typeof raw.text === 'string' ? raw.text.slice(0, 22) : typeof raw.text,
          };
        }),
      });
      return changed;
    } catch (error) {
      log.warn('Pulling briefings from Slack failed', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      return 0;
    } finally {
      lastBriefingPull = Date.now();
      briefingPullInFlight = null;
    }
  })();
  return briefingPullInFlight;
}

/** Test seam: forget the throttle so a second pull in the same process runs. */
export function resetBriefingPullThrottle(): void {
  lastBriefingPull = 0;
  briefingPullInFlight = null;
}
