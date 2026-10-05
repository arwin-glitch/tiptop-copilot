import 'server-only';
import { z } from 'zod';
import { env, type AppEnv } from '@/lib/config/env';
import type { DataStore } from '@/lib/db/store';
import { log } from '@/lib/security/redact';
import {
  readRelayWindow,
  slackTsToIso,
  type RelayReadState,
  type SlackMessage,
} from '@/lib/slack/relay-history';
import { processWide } from '@/lib/util/process-state';
import { unwrapSlackText } from '@/lib/util/slack-text';
import { demoFollowUps } from '@/lib/demo/follow-ups-fixtures';
import { isRelayOrganization } from './deal-relay';

/**
 * The Follow-ups page and the Today "Top priorities" card: four cloud routines
 * post to the private #deal-relay channel, and this reads them back live.
 * Nothing is stored; every view is the latest posts in the window.
 *
 * - `FOLLOWUPS_V1`: a full snapshot of threads where Nick wrote last and is
 *   still waiting. The newest snapshot wins.
 * - `MEETING_FOLLOWUP_V1`: one post per meeting a recap draft was written for.
 *   Accumulated across the window, newest post per meeting wins.
 * - `SCHEDULING_V1`: one post per run listing the threads it drafted times on.
 *   Accumulated across the window, newest post per thread wins.
 * - `PRIORITIES_V1`: the morning brief's and checkpoint's ranked list. The
 *   newest wins.
 * - `RELATIONSHIPS_V1`: the relationship radar's snapshot of who is waiting
 *   on Nick and which key relationships are going cold. The newest wins.
 *
 * Every value is rendered as plain text. Links are rebuilt from validated
 * Gmail thread ids, never taken from a post.
 */

export const FOLLOWUPS_MARKER = 'FOLLOWUPS_V1';
export const MEETING_FOLLOWUP_MARKER = 'MEETING_FOLLOWUP_V1';
export const SCHEDULING_MARKER = 'SCHEDULING_V1';
export const PRIORITIES_MARKER = 'PRIORITIES_V1';
export const RELATIONSHIPS_MARKER = 'RELATIONSHIPS_V1';

const MARKERS = [
  FOLLOWUPS_MARKER,
  MEETING_FOLLOWUP_MARKER,
  SCHEDULING_MARKER,
  PRIORITIES_MARKER,
  RELATIONSHIPS_MARKER,
] as const;
type Marker = (typeof MARKERS)[number];

const THREAD_ID = z.string().regex(/^[0-9a-f]{10,24}$/i);
const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).nullish();

export const FOLLOWUPS_SCHEMA = z.object({
  run_at: z.string().datetime(),
  items: z
    .array(
      z.object({
        thread_id: THREAD_ID,
        who: text(120),
        company: optionalText(120),
        subject: text(300),
        last_sent_at: z.string().datetime(),
        days_waiting: z.number().int().min(0).max(365),
        draft: z.boolean(),
        note: optionalText(400),
      }),
    )
    .max(60),
});

export const MEETING_FOLLOWUP_SCHEMA = z.object({
  meeting_id: text(80),
  title: text(200),
  met_at: z.string().datetime(),
  attendees: z.array(text(120)).max(20),
  thread_id: THREAD_ID.nullish(),
  draft: z.boolean(),
  promises: z.array(text(300)).max(10).default([]),
  note: optionalText(400),
});

export const SCHEDULING_SCHEMA = z.object({
  run_at: z.string().datetime(),
  items: z
    .array(
      z.object({
        thread_id: THREAD_ID,
        who: text(120),
        subject: text(300),
        slots: z.array(z.string().datetime()).max(5),
        draft: z.boolean(),
        note: optionalText(400),
      }),
    )
    .max(30),
});

export const PRIORITY_KINDS = ['money', 'reply', 'meeting', 'deal', 'portfolio', 'other'] as const;

export const PRIORITIES_SCHEMA = z.object({
  run_at: z.string().datetime(),
  source: z.enum(['morning', 'afternoon']),
  items: z
    .array(
      z.object({
        title: text(160),
        why: text(300),
        kind: z.enum(PRIORITY_KINDS),
        thread_id: THREAD_ID.nullish(),
      }),
    )
    .max(7),
});

export const RELATIONSHIP_KINDS = [
  'lp',
  'prospective_lp',
  'portfolio',
  'founder',
  'coinvestor',
  'other',
] as const;

const RELATIONSHIP_ITEM = z.object({
  who: text(120),
  company: optionalText(120),
  kind: z.enum(RELATIONSHIP_KINDS),
  thread_id: THREAD_ID.nullish(),
  since: z.string().datetime(),
  days: z.number().int().min(0).max(3650),
  note: optionalText(300),
});

export const RELATIONSHIPS_SCHEMA = z.object({
  run_at: z.string().datetime(),
  waiting: z.array(RELATIONSHIP_ITEM).max(40),
  cold: z.array(RELATIONSHIP_ITEM).max(40),
});

export type Relationships = z.infer<typeof RELATIONSHIPS_SCHEMA>;
export type RelationshipItem = z.infer<typeof RELATIONSHIP_ITEM>;
export type FollowUpItem = z.infer<typeof FOLLOWUPS_SCHEMA>['items'][number];
export type MeetingFollowUp = z.infer<typeof MEETING_FOLLOWUP_SCHEMA> & { posted_at: string };
export type SchedulingItem = z.infer<typeof SCHEDULING_SCHEMA>['items'][number] & {
  posted_at: string;
};
export type Priorities = z.infer<typeof PRIORITIES_SCHEMA>;

export type ParsedFollowUpMessage =
  | { marker: typeof FOLLOWUPS_MARKER; value: z.infer<typeof FOLLOWUPS_SCHEMA> }
  | { marker: typeof MEETING_FOLLOWUP_MARKER; value: z.infer<typeof MEETING_FOLLOWUP_SCHEMA> }
  | { marker: typeof SCHEDULING_MARKER; value: z.infer<typeof SCHEDULING_SCHEMA> }
  | { marker: typeof PRIORITIES_MARKER; value: Priorities }
  | { marker: typeof RELATIONSHIPS_MARKER; value: Relationships };

const SCHEMAS: Record<Marker, z.ZodTypeAny> = {
  [FOLLOWUPS_MARKER]: FOLLOWUPS_SCHEMA,
  [MEETING_FOLLOWUP_MARKER]: MEETING_FOLLOWUP_SCHEMA,
  [SCHEDULING_MARKER]: SCHEDULING_SCHEMA,
  [PRIORITIES_MARKER]: PRIORITIES_SCHEMA,
  [RELATIONSHIPS_MARKER]: RELATIONSHIPS_SCHEMA,
};

const MAX_MESSAGE_CHARS = 40_000;

/**
 * One relay message -> a parsed follow-up post, or null when it is not one or
 * does not validate. Slack's link markup is undone before parsing: a bare URL
 * at the end of a value would otherwise swallow the closing `"}`.
 */
export function parseFollowUpMessage(raw: unknown): ParsedFollowUpMessage | null {
  if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_CHARS) return null;
  const clean = unwrapSlackText(raw, { preferLabel: true }).trim();
  const marker = MARKERS.find((m) => clean.startsWith(`${m}\n`) || clean.startsWith(`${m} `));
  if (!marker) return null;
  const json = /`([^`]+)`/.exec(clean)?.[1];
  if (!json) return null;
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    log.warn('Follow-up relay post is not valid JSON', { marker });
    return null;
  }
  const parsed = SCHEMAS[marker].safeParse(data);
  if (!parsed.success) {
    log.warn('Follow-up relay post did not validate', {
      marker,
      issue: parsed.error.issues[0]?.path.join('.') ?? 'unknown',
    });
    return null;
  }
  return { marker, value: parsed.data } as ParsedFollowUpMessage;
}

export interface FollowUpsSnapshot {
  waiting: { runAt: string; items: FollowUpItem[] } | null;
  meetings: MeetingFollowUp[];
  scheduling: SchedulingItem[];
  priorities: Priorities | null;
  relationships: Relationships | null;
}

/** Slack pages (newest first) -> the current view. Pure, for tests. */
export function collectFollowUps(
  messages: readonly SlackMessage[],
  posterIds: readonly string[] = [],
): FollowUpsSnapshot {
  const usable = messages
    .filter((m) => m.subtype === undefined || m.subtype === null)
    .filter(
      (m) => posterIds.length === 0 || (typeof m.user === 'string' && posterIds.includes(m.user)),
    )
    .map((m) => ({ m, iso: slackTsToIso(m.ts) }))
    .filter((x): x is { m: SlackMessage; iso: string } => x.iso !== null)
    .sort((a, b) => b.iso.localeCompare(a.iso));

  const out: FollowUpsSnapshot = {
    waiting: null,
    meetings: [],
    scheduling: [],
    priorities: null,
    relationships: null,
  };
  const seenMeetings = new Set<string>();
  const seenThreads = new Set<string>();

  for (const { m, iso } of usable) {
    const parsed = parseFollowUpMessage(m.text);
    if (!parsed) continue;
    switch (parsed.marker) {
      case FOLLOWUPS_MARKER:
        if (!out.waiting) {
          out.waiting = {
            runAt: parsed.value.run_at,
            items: [...parsed.value.items].sort((a, b) => b.days_waiting - a.days_waiting),
          };
        }
        break;
      case MEETING_FOLLOWUP_MARKER:
        if (!seenMeetings.has(parsed.value.meeting_id)) {
          seenMeetings.add(parsed.value.meeting_id);
          out.meetings.push({ ...parsed.value, posted_at: iso });
        }
        break;
      case SCHEDULING_MARKER:
        for (const item of parsed.value.items) {
          if (seenThreads.has(item.thread_id)) continue;
          seenThreads.add(item.thread_id);
          out.scheduling.push({ ...item, posted_at: iso });
        }
        break;
      case PRIORITIES_MARKER:
        if (!out.priorities) out.priorities = parsed.value;
        break;
      case RELATIONSHIPS_MARKER:
        if (!out.relationships) out.relationships = parsed.value;
        break;
    }
  }
  out.meetings.sort((a, b) => b.met_at.localeCompare(a.met_at));
  return out;
}

export type FollowUpsState =
  'ok' | 'not_configured' | 'restricted' | 'other_workspace' | Exclude<RelayReadState, 'ok'>;

export interface FollowUpsResult {
  state: FollowUpsState;
  snapshot: FollowUpsSnapshot;
  readAt: string;
}

const EMPTY: FollowUpsSnapshot = {
  waiting: null,
  meetings: [],
  scheduling: [],
  priorities: null,
  relationships: null,
};
const WINDOW_DAYS = 14;
const MAX_PAGES = 5;
const PAGE_SIZE = 200;
const CACHE_MS = 60_000;

const cache = processWide('follow-ups', () => ({
  entries: new Map<string, { at: number; result: FollowUpsResult }>(),
  inFlight: new Map<string, Promise<FollowUpsResult>>(),
}));

/** Test hook. */
export function resetFollowUpsCache(): void {
  cache.entries.clear();
  cache.inFlight.clear();
}

/**
 * The current follow-ups view for this organization. Cached for a minute and
 * shared between concurrent callers. Never throws.
 *
 * Closed until sign-in is limited to TipTop accounts, like Updates: the posts
 * name the people Nick is waiting on and the subjects of those threads.
 */
export async function readFollowUps(
  store: DataStore,
  organizationId: string,
  options: { fetchImpl?: typeof fetch; now?: Date; force?: boolean; e?: AppEnv } = {},
): Promise<FollowUpsResult> {
  const { fetchImpl = fetch, now = new Date(), force = false, e = env() } = options;
  const result = (state: FollowUpsState, snapshot = EMPTY): FollowUpsResult => ({
    state,
    snapshot,
    readAt: now.toISOString(),
  });

  if (e.demoMode) return result('ok', demoFollowUps(now));
  if (!e.askRelaySlackToken) return result('not_configured');
  if (e.authAllowedDomains.length === 0) return result('restricted');

  const cached = cache.entries.get(organizationId);
  if (!force && cached && now.getTime() - cached.at < CACHE_MS) return cached.result;
  const pending = cache.inFlight.get(organizationId);
  if (pending) return pending;

  const run = (async () => {
    try {
      if (!(await isRelayOrganization(store, organizationId))) return result('other_workspace');
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
        if (window.fault !== undefined) log.warn('Reading follow-ups from #deal-relay failed');
        return result(window.state);
      }
      const value = result('ok', collectFollowUps(window.messages, e.dealRelayPosterIds));
      cache.entries.set(organizationId, { at: now.getTime(), result: value });
      return value;
    } catch {
      log.warn('Reading follow-ups failed unexpectedly');
      return result('error');
    } finally {
      cache.inFlight.delete(organizationId);
    }
  })();
  cache.inFlight.set(organizationId, run);
  return run;
}
