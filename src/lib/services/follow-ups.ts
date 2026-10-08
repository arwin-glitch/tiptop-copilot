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
 * - `LP_PIPELINE_V1`: the Fund II LP pipeline, every prospective LP and the
 *   stage they are at. The newest snapshot wins. Stages only, never amounts.
 * - `PORTFOLIO_HEALTH_V1`: per portfolio company, when it last sent an update,
 *   a qualitative runway flag and its open asks. Newest wins. No figures.
 * - `INTROS_V1`: intros Nick was asked for, owes, made, and how they went.
 *   Newest wins.
 * - `WEEK_AHEAD_V1`: the next seven days of Nick's calendar with prep context.
 *   Newest wins.
 * - `LP_UPDATE_DRAFT_V1`: the quarterly LP update drafted into Gmail (to Nick
 *   only). Newest wins.
 *
 * - `EMAIL_QUEUE_V1`: Nick's open emails for the email session, in working
 *   order, from the For Nick refresh. Newest run wins (parts joined).
 *
 * The four list snapshots (LP pipeline, portfolio health, intros, week ahead)
 * may arrive in numbered parts sharing one run_at; the parts are joined.
 *
 * Every value is rendered as plain text. Links are rebuilt from validated
 * Gmail thread ids, never taken from a post.
 */

export const FOLLOWUPS_MARKER = 'FOLLOWUPS_V1';
export const MEETING_FOLLOWUP_MARKER = 'MEETING_FOLLOWUP_V1';
export const SCHEDULING_MARKER = 'SCHEDULING_V1';
export const PRIORITIES_MARKER = 'PRIORITIES_V1';
export const RELATIONSHIPS_MARKER = 'RELATIONSHIPS_V1';
export const LP_PIPELINE_MARKER = 'LP_PIPELINE_V1';
export const PORTFOLIO_HEALTH_MARKER = 'PORTFOLIO_HEALTH_V1';
export const INTROS_MARKER = 'INTROS_V1';
export const WEEK_AHEAD_MARKER = 'WEEK_AHEAD_V1';
export const LP_UPDATE_DRAFT_MARKER = 'LP_UPDATE_DRAFT_V1';
export const EMAIL_QUEUE_MARKER = 'EMAIL_QUEUE_V1';

const MARKERS = [
  FOLLOWUPS_MARKER,
  MEETING_FOLLOWUP_MARKER,
  SCHEDULING_MARKER,
  PRIORITIES_MARKER,
  RELATIONSHIPS_MARKER,
  LP_PIPELINE_MARKER,
  PORTFOLIO_HEALTH_MARKER,
  INTROS_MARKER,
  WEEK_AHEAD_MARKER,
  LP_UPDATE_DRAFT_MARKER,
  EMAIL_QUEUE_MARKER,
] as const;
type Marker = (typeof MARKERS)[number];

const THREAD_ID = z.string().regex(/^[0-9a-f]{10,24}$/i);
const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).nullish();
/**
 * A long list may be split across several posts from one run (Slack caps a
 * message's length): each part repeats the run's run_at and numbers itself.
 */
const PART = z.number().int().min(1).max(20).optional();

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

export const LP_STAGES = [
  'target',
  'contacted',
  'meeting',
  'materials',
  'soft_commit',
  'committed',
  'passed',
] as const;
export type LpStage = (typeof LP_STAGES)[number];

export const LP_KINDS = [
  'individual',
  'family_office',
  'institution',
  'fund_of_funds',
  'existing_lp',
  'other',
] as const;

const LP_ITEM = z.object({
  who: text(120),
  firm: optionalText(120),
  kind: z.enum(LP_KINDS),
  stage: z.enum(LP_STAGES),
  last_touch_at: z.string().datetime().nullish(),
  next_step: optionalText(200),
  thread_id: THREAD_ID.nullish(),
  note: optionalText(300),
});

export const LP_PIPELINE_SCHEMA = z.object({
  run_at: z.string().datetime(),
  part: PART,
  fund: text(40),
  lps: z.array(LP_ITEM).max(300),
});

export type LpPipeline = z.infer<typeof LP_PIPELINE_SCHEMA>;

export const HEALTH_FLAGS = ['ok', 'watch', 'risk', 'unknown'] as const;

export const PORTFOLIO_HEALTH_SCHEMA = z.object({
  run_at: z.string().datetime(),
  part: PART,
  companies: z
    .array(
      z.object({
        name: text(120),
        last_update_at: z.string().datetime().nullish(),
        thread_id: THREAD_ID.nullish(),
        flag: z.enum(HEALTH_FLAGS),
        headline: optionalText(200),
        asks: z.array(text(200)).max(5).default([]),
      }),
    )
    .max(80),
});
export type PortfolioHealth = z.infer<typeof PORTFOLIO_HEALTH_SCHEMA>;
export type PortfolioHealthItem = PortfolioHealth['companies'][number];

export const INTRO_STATUSES = ['owed', 'made', 'connected', 'stalled', 'declined'] as const;

export const INTROS_SCHEMA = z.object({
  run_at: z.string().datetime(),
  part: PART,
  intros: z
    .array(
      z.object({
        for_who: text(120),
        to_who: text(120),
        status: z.enum(INTRO_STATUSES),
        asked_at: z.string().datetime().nullish(),
        made_at: z.string().datetime().nullish(),
        thread_id: THREAD_ID.nullish(),
        note: optionalText(200),
      }),
    )
    .max(100),
});
export type Intros = z.infer<typeof INTROS_SCHEMA>;
export type IntroItem = Intros['intros'][number];

export const WEEK_AHEAD_SCHEMA = z.object({
  run_at: z.string().datetime(),
  part: PART,
  events: z
    .array(
      z.object({
        title: text(200),
        starts_at: z.string().datetime(),
        ends_at: z.string().datetime().nullish(),
        with_who: z.array(text(120)).max(10).default([]),
        kind: z.enum(['founder', 'lp', 'portfolio', 'investor', 'internal', 'personal', 'other']),
        prep: optionalText(240),
        thread_id: THREAD_ID.nullish(),
      }),
    )
    .max(80),
});
export type WeekAhead = z.infer<typeof WEEK_AHEAD_SCHEMA>;
export type WeekEvent = WeekAhead['events'][number];

export const LP_UPDATE_DRAFT_SCHEMA = z.object({
  run_at: z.string().datetime(),
  period: text(60),
  status: z.enum(['drafted', 'skipped']),
  draft_thread_id: THREAD_ID.nullish(),
  sections: z.array(text(80)).max(12).default([]),
  note: optionalText(300),
});
export type LpUpdateDraft = z.infer<typeof LP_UPDATE_DRAFT_SCHEMA>;

/** Order the email session works in; replies and archive are Arwin's pile. */
export const EMAIL_GROUPS = [
  'today',
  'money',
  'deals',
  'owed',
  'intros',
  'replies',
  'archive',
] as const;
export type EmailGroup = (typeof EMAIL_GROUPS)[number];

export const EMAIL_QUEUE_SCHEMA = z.object({
  run_at: z.string().datetime(),
  part: PART,
  items: z
    .array(
      z.object({
        /** Gmail thread or message id (hex); links and sending resolve either. */
        id: THREAD_ID,
        who: text(120),
        about: text(200),
        group: z.enum(EMAIL_GROUPS),
        call: z.enum(['reply', 'send', 'archive']),
        flags: z.array(text(30)).max(6).default([]),
        draft: z.enum(['on_thread', 'yours', 'none']),
        why: optionalText(500),
        waiting_since: z.string().datetime().nullish(),
      }),
    )
    .max(150),
});
export type EmailQueue = z.infer<typeof EMAIL_QUEUE_SCHEMA>;
export type EmailQueueItem = EmailQueue['items'][number];
export type LpItem = z.infer<typeof LP_ITEM>;
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
  | { marker: typeof RELATIONSHIPS_MARKER; value: Relationships }
  | { marker: typeof LP_PIPELINE_MARKER; value: LpPipeline }
  | { marker: typeof PORTFOLIO_HEALTH_MARKER; value: PortfolioHealth }
  | { marker: typeof INTROS_MARKER; value: Intros }
  | { marker: typeof WEEK_AHEAD_MARKER; value: WeekAhead }
  | { marker: typeof LP_UPDATE_DRAFT_MARKER; value: LpUpdateDraft }
  | { marker: typeof EMAIL_QUEUE_MARKER; value: EmailQueue };

const SCHEMAS: Record<Marker, z.ZodTypeAny> = {
  [FOLLOWUPS_MARKER]: FOLLOWUPS_SCHEMA,
  [MEETING_FOLLOWUP_MARKER]: MEETING_FOLLOWUP_SCHEMA,
  [SCHEDULING_MARKER]: SCHEDULING_SCHEMA,
  [PRIORITIES_MARKER]: PRIORITIES_SCHEMA,
  [RELATIONSHIPS_MARKER]: RELATIONSHIPS_SCHEMA,
  [LP_PIPELINE_MARKER]: LP_PIPELINE_SCHEMA,
  [PORTFOLIO_HEALTH_MARKER]: PORTFOLIO_HEALTH_SCHEMA,
  [INTROS_MARKER]: INTROS_SCHEMA,
  [WEEK_AHEAD_MARKER]: WEEK_AHEAD_SCHEMA,
  [LP_UPDATE_DRAFT_MARKER]: LP_UPDATE_DRAFT_SCHEMA,
  [EMAIL_QUEUE_MARKER]: EMAIL_QUEUE_SCHEMA,
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
  lpPipeline: LpPipeline | null;
  portfolioHealth: PortfolioHealth | null;
  intros: Intros | null;
  weekAhead: WeekAhead | null;
  lpUpdateDraft: LpUpdateDraft | null;
  emailQueue: EmailQueue | null;
  /** When each queued email was last judged (its post time), by email id. */
  emailJudgedAt: Record<string, string>;
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
    lpPipeline: null,
    portfolioHealth: null,
    intros: null,
    weekAhead: null,
    lpUpdateDraft: null,
    emailQueue: null,
    emailJudgedAt: {},
  };
  const seenMeetings = new Set<string>();
  // Email judgments accumulate: each post covers only new or changed emails,
  // and the newest judgment per email wins.
  const judged: EmailQueueItem[] = [];
  let judgedRunAt: string | null = null;
  const seenThreads = new Set<string>();
  // Split snapshots: every part of the newest run, keyed by part number.
  const parts = new Map<Marker, { runAt: string; byPart: Map<number, unknown> }>();
  const addPart = (marker: Marker, value: { run_at: string; part?: number }) => {
    const entry = parts.get(marker);
    if (!entry) {
      parts.set(marker, { runAt: value.run_at, byPart: new Map([[value.part ?? 1, value]]) });
    } else if (entry.runAt === value.run_at && !entry.byPart.has(value.part ?? 1)) {
      entry.byPart.set(value.part ?? 1, value);
    }
  };
  const merged = <T extends { run_at: string }, K extends keyof T>(
    marker: Marker,
    key: K,
  ): T | null => {
    const entry = parts.get(marker);
    if (!entry) return null;
    const ordered = [...entry.byPart.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v as T);
    const first = ordered[0]!;
    return { ...first, [key]: ordered.flatMap((v) => v[key] as unknown[]) };
  };

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
      case LP_PIPELINE_MARKER:
      case PORTFOLIO_HEALTH_MARKER:
      case INTROS_MARKER:
      case WEEK_AHEAD_MARKER:
        addPart(parsed.marker, parsed.value);
        break;
      case EMAIL_QUEUE_MARKER:
        judgedRunAt ??= parsed.value.run_at;
        for (const item of parsed.value.items) {
          if (out.emailJudgedAt[item.id]) continue;
          out.emailJudgedAt[item.id] = iso;
          judged.push(item);
        }
        break;
      case LP_UPDATE_DRAFT_MARKER:
        if (!out.lpUpdateDraft) out.lpUpdateDraft = parsed.value;
        break;
    }
  }
  out.meetings.sort((a, b) => b.met_at.localeCompare(a.met_at));
  out.lpPipeline = merged<LpPipeline, 'lps'>(LP_PIPELINE_MARKER, 'lps');
  out.portfolioHealth = merged<PortfolioHealth, 'companies'>(PORTFOLIO_HEALTH_MARKER, 'companies');
  out.intros = merged<Intros, 'intros'>(INTROS_MARKER, 'intros');
  out.emailQueue = judgedRunAt ? { run_at: judgedRunAt, items: judged } : null;
  const week = merged<WeekAhead, 'events'>(WEEK_AHEAD_MARKER, 'events');
  out.weekAhead = week
    ? { ...week, events: [...week.events].sort((a, b) => a.starts_at.localeCompare(b.starts_at)) }
    : null;
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
  lpPipeline: null,
  portfolioHealth: null,
  intros: null,
  weekAhead: null,
  lpUpdateDraft: null,
  emailQueue: null,
  emailJudgedAt: {},
};
const WINDOW_DAYS = 30;
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
