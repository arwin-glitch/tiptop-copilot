import 'server-only';
import { z } from 'zod';
import { env, isDemoMode } from '@/lib/config/env';
import type { DataStore } from '@/lib/db/store';
import { log } from '@/lib/security/redact';
import type {
  AuditEvent,
  CalendarEvent,
  Integration,
  Organization,
  OrganizationMember,
  UserProfile,
} from '@/lib/types/domain';
import { newId, sha256 } from '@/lib/util/hash';
import { processWide } from '@/lib/util/process-state';
import { ok, type Result } from '@/lib/util/result';
import { localClock } from '@/lib/util/time';
import {
  dueMeetingAlerts,
  listMeetingEvents,
  meetingFromStoredEvent,
  type MeetingEvent,
} from '@/lib/calendar/meetings';
import { receiptLine } from '@/lib/campaigns/receipt';
import { finishedCampaignsSince, type FinishedCampaign } from './campaigns';
import { buildReaders, readDocSendViews, type DocSendReader } from './docsend';
import { getPrimaryIntegration } from './inbox';
import { readFollowUps, type FollowUpsSnapshot } from './follow-ups';
import type { IosAlertsStatus } from '@/lib/ios/shared';
import {
  alertsPreferences,
  apnsSenderReady,
  iosAlertsStatusFor,
  listIosDevices,
  noteApnsSender,
  pendingTestAlerts,
  removeGoneIosDevices,
  routeChannels,
  sweepIosDevices,
  type GoneIosDevice,
  type IosDevice,
} from './ios-push';

/**
 * Phone alerts (Web Push) for Nick.
 *
 * The app decides WHAT to alert; a GitHub Actions job does the sending. The
 * signing key (VAPID private key) lives only in GitHub, so nothing has to be
 * set on Render, and the app never holds a key that can push to a phone.
 *
 *   phone ── subscribe ──> /api/push/subscription      (stored per user)
 *   GitHub job ── GET  /api/cron/push ──> due alerts + subscriptions
 *   GitHub job ── web-push ──> Apple / Google push service ──> phone
 *   GitHub job ── POST /api/cron/push ──> "sent these" (ledger) + dead endpoints
 *
 * No schema change: subscriptions and the "already alerted" ledger are rows
 * in `audit_events` (actions `push.subscription` and `push.alerted`), written
 * directly rather than through recordAudit, whose redaction would mangle the
 * subscription keys.
 *
 * Alerts come only from the relay snapshots the app already reads
 * (readFollowUps), DocSend views, and campaigns that just finished sending;
 * each item alerts once, and nothing is sent outside 8am-8pm in the owner's
 * timezone.
 *
 * The desktop app gets the same alerts by asking for them itself
 * (desktop-alerts.ts), with readAlertInputs, alertsFromInputs and
 * meetingAlerts below and a ledger of its own per computer. The iPhone app
 * gets them through this same job and ledger, by Apple's push service
 * (ios-push.ts): the outbox lists its tokens next to the subscriptions.
 */

/** Public half of the VAPID pair; not a secret. The private half is a GitHub secret. */
export const DEFAULT_VAPID_PUBLIC_KEY =
  'BGpsfOnjp1nZGU8Bo2IkuHesv3PhEHh1ZpDTUTe8bA-57xX0u3xcZvjyUieAF3HlVTwBQIs9XzQHTMxwFdBRQno';

export function vapidPublicKey(): string {
  return env().vapidPublicKey ?? DEFAULT_VAPID_PUBLIC_KEY;
}

const SUBSCRIPTION_ACTION = 'push.subscription';
const ALERTED_ACTION = 'push.alerted';
const QUIET_BEFORE_HOUR = 8;
const QUIET_FROM_HOUR = 20;
const LEDGER_DAYS = 60;
const BODY_MAX = 180;
/** A campaign alerts only this soon after it finished, so turning alerts on never pings old ones. */
export const CAMPAIGN_ALERT_WINDOW_MS = 2 * 60 * 60 * 1000;
/** 8pm to 8am: the hours that do not count toward a campaign's two. */
const QUIET_NIGHT_MS = (24 - QUIET_FROM_HOUR + QUIET_BEFORE_HOUR) * 60 * 60 * 1000;

/** Push services a subscription may point at. Anything else is refused. */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/,
  /\.notify\.windows\.com$/,
];

export const SUBSCRIPTION_SCHEMA = z.object({
  endpoint: z
    .string()
    .url()
    .max(1000)
    .refine((value) => {
      try {
        const url = new URL(value);
        return url.protocol === 'https:' && PUSH_HOSTS.some((re) => re.test(url.hostname));
      } catch {
        return false;
      }
    }, 'Not a known push service'),
  keys: z.object({
    p256dh: z.string().regex(/^[A-Za-z0-9_-]{40,120}={0,2}$/),
    auth: z.string().regex(/^[A-Za-z0-9_-]{16,40}={0,2}$/),
  }),
});
export type PushSubscriptionInput = z.infer<typeof SUBSCRIPTION_SCHEMA>;

/** What a subscribing browser was: kept from now on, so an iPhone's can be told apart. */
export type SubscriptionPlatform = 'ios' | 'mac' | 'other';

export function subscriptionPlatform(userAgent: string | null | undefined): SubscriptionPlatform {
  if (!userAgent) return 'other';
  if (/\b(iPhone|iPod)\b/.test(userAgent)) return 'ios';
  if (/Macintosh|Mac OS X/.test(userAgent)) return 'mac';
  return 'other';
}

export interface StoredSubscription extends PushSubscriptionInput {
  userId: string | null;
  /** Null for a row from before platforms were kept. */
  platform: SubscriptionPlatform | null;
}

const endpointKey = (endpoint: string) => sha256(endpoint).slice(0, 40);

export async function saveSubscription(
  store: DataStore,
  organizationId: string,
  userId: string,
  subscription: PushSubscriptionInput,
  platform: SubscriptionPlatform = 'other',
): Promise<void> {
  const entityId = endpointKey(subscription.endpoint);
  await store.removeWhere('audit_events', organizationId, {
    eq: { action: SUBSCRIPTION_ACTION, entity_id: entityId },
  });
  const row: AuditEvent = {
    id: newId(),
    organization_id: organizationId,
    user_id: userId,
    action: SUBSCRIPTION_ACTION,
    entity_type: 'push',
    entity_id: entityId,
    metadata: { endpoint: subscription.endpoint, keys: subscription.keys, platform },
    ip_hash: null,
    created_at: new Date().toISOString(),
  };
  await store.insert('audit_events', row);
}

export async function removeSubscription(
  store: DataStore,
  organizationId: string,
  endpoint: string,
): Promise<number> {
  return store.removeWhere('audit_events', organizationId, {
    eq: { action: SUBSCRIPTION_ACTION, entity_id: endpointKey(endpoint) },
  });
}

export async function listSubscriptions(
  store: DataStore,
  organizationId: string,
): Promise<StoredSubscription[]> {
  const rows = (await store.list(
    'audit_events',
    organizationId,
    { eq: { action: SUBSCRIPTION_ACTION } },
    { limit: 50 },
  )) as AuditEvent[];
  const out: StoredSubscription[] = [];
  for (const row of rows) {
    const parsed = SUBSCRIPTION_SCHEMA.safeParse(row.metadata);
    const platform = (row.metadata as Record<string, unknown>).platform;
    if (parsed.success) {
      out.push({
        ...parsed.data,
        userId: row.user_id,
        platform:
          platform === 'ios' || platform === 'mac' || platform === 'other' ? platform : null,
      });
    }
  }
  return out;
}

/** The signed-in person's iPhone app alerts, for Settings (ios-push.ts). */
export async function iosAlertsStatus(
  store: DataStore,
  organizationId: string,
  userId: string,
  now: Date = new Date(),
): Promise<IosAlertsStatus> {
  const [subscriptions, devices, preferences, senderReady] = await Promise.all([
    listSubscriptions(store, organizationId),
    listIosDevices(store, organizationId),
    alertsPreferences(store, organizationId),
    apnsSenderReady(store, organizationId, now),
  ]);
  return iosAlertsStatusFor(userId, subscriptions, devices, preferences, now, senderReady);
}

export async function hasSubscription(
  store: DataStore,
  organizationId: string,
  userId: string,
): Promise<boolean> {
  const count = await store.count('audit_events', organizationId, {
    eq: { action: SUBSCRIPTION_ACTION, user_id: userId },
  });
  return count > 0;
}

export interface PushAlert {
  /** Ledger keys this notification covers; recorded once it is delivered. */
  keys: string[];
  title: string;
  body: string;
  /** In-app path opened when the notification is tapped. */
  url: string;
  tag: string;
}

const WAITING_KINDS = new Set(['lp', 'prospective_lp', 'portfolio', 'founder']);
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 60);

function clip(text: string): string {
  return text.length <= BODY_MAX ? text : `${text.slice(0, BODY_MAX - 1).trimEnd()}…`;
}

function listBody(lines: string[]): string {
  const [first, ...rest] = lines;
  if (!first) return '';
  return clip(rest.length ? `${first} (+${rest.length} more)` : first);
}

/** Outside 8am-8pm in the owner's timezone, when only meeting alerts go out. */
function quietHours(now: Date, timeZone: string): boolean {
  const { hour } = localClock(now, timeZone);
  return hour < QUIET_BEFORE_HOUR || hour >= QUIET_FROM_HOUR;
}

/**
 * How far back a finished campaign still alerts at `now`: two hours of
 * daytime. Quiet hours do not count, so one that finished at 7:40pm or 2am,
 * when nothing but meetings goes out, alerts on the first pass after 8am
 * instead of never; one that finished at 5pm alerted that evening. In the
 * morning's first two hours the window reaches back over the night (to 6pm);
 * the rest of the day it is the plain two hours.
 */
export function campaignAlertWindowMs(now: Date, timeZone: string): number {
  const { hour } = localClock(now, timeZone);
  const morning =
    hour >= QUIET_BEFORE_HOUR && hour < QUIET_BEFORE_HOUR + CAMPAIGN_ALERT_WINDOW_MS / 3_600_000;
  return morning ? CAMPAIGN_ALERT_WINDOW_MS + QUIET_NIGHT_MS : CAMPAIGN_ALERT_WINDOW_MS;
}

/**
 * The alerts due now, from the relay snapshot and the ledger of keys already
 * sent. Pure, for tests. One notification per kind, so a first run with many
 * open items is still five pings at most.
 */
export function computeDueAlerts(
  snapshot: FollowUpsSnapshot,
  alreadySent: ReadonlySet<string>,
  now: Date,
  timeZone: string,
  docsend: readonly DocSendReader[] = [],
): PushAlert[] {
  if (quietHours(now, timeZone)) return [];
  const clock = localClock(now, timeZone);
  const alerts: PushAlert[] = [];

  // Someone outside TipTop opened fundraising material in the last day.
  const opened = docsend
    .filter((r) => r.kind === 'prospect' && now.getTime() - Date.parse(r.lastAt) <= 86_400_000)
    .map((r) => ({ key: `docsend:${r.latestMessageId}`, r }))
    .filter(({ key }) => !alreadySent.has(key));
  if (opened.length) {
    const who = (r: DocSendReader) => `${r.name ?? r.email}${r.domain ? ` (${r.domain})` : ''}`;
    alerts.push({
      keys: opened.map((o) => o.key),
      title:
        opened.length === 1
          ? `${who(opened[0]!.r)} opened your fund materials`
          : `${opened.length} people opened your fund materials`,
      body: listBody(opened.map(({ r }) => `${who(r)}: ${r.documents[0]}`)),
      url: '/fund-ii',
      tag: 'docsend',
    });
  }

  const priorities = snapshot.priorities;
  if (priorities) {
    const money = priorities.items
      .filter((item) => item.kind === 'money')
      .map((item) => ({ key: `money:${item.thread_id ?? slug(item.title)}`, item }))
      .filter(({ key }) => !alreadySent.has(key));
    if (money.length) {
      alerts.push({
        keys: money.map((m) => m.key),
        title: 'Money or legal going stale',
        body: listBody(money.map((m) => m.item.title)),
        url: '/today',
        tag: 'money',
      });
    }

    const top3Key = `top3:${clock.dateKey}`;
    const ranToday = localClock(new Date(priorities.run_at), timeZone).dateKey === clock.dateKey;
    if (
      priorities.source === 'morning' &&
      ranToday &&
      priorities.items.length &&
      !alreadySent.has(top3Key)
    ) {
      alerts.push({
        keys: [top3Key],
        title: "Today's top 3",
        body: clip(
          priorities.items
            .slice(0, 3)
            .map((item, i) => `${i + 1}. ${item.title}`)
            .join('  '),
        ),
        url: '/today',
        tag: 'top3',
      });
    }
  }

  const waiting = (snapshot.relationships?.waiting ?? [])
    .filter((item) => WAITING_KINDS.has(item.kind) && item.days >= 3)
    .map((item) => ({ key: `wait:${item.thread_id ?? slug(item.who)}`, item }))
    .filter(({ key }) => !alreadySent.has(key));
  if (waiting.length) {
    alerts.push({
      keys: waiting.map((w) => w.key),
      title: 'Waiting on you',
      body: listBody(
        waiting.map(
          ({ item }) => `${item.who}${item.company ? ` (${item.company})` : ''}, ${item.days} days`,
        ),
      ),
      url: '/follow-ups',
      tag: 'waiting',
    });
  }

  const risk = (snapshot.portfolioHealth?.companies ?? [])
    .filter((c) => c.flag === 'risk')
    .map((c) => ({ key: `risk:${slug(c.name)}`, c }))
    .filter(({ key }) => !alreadySent.has(key));
  if (risk.length) {
    alerts.push({
      keys: risk.map((r) => r.key),
      title:
        risk.length === 1
          ? 'Portfolio company at risk'
          : `${risk.length} portfolio companies at risk`,
      body: listBody(risk.map(({ c }) => (c.headline ? `${c.name}: ${c.headline}` : c.name))),
      url: '/portfolio',
      tag: 'risk',
    });
  }

  return alerts;
}

/**
 * A campaign finished sending: "Q3 update · 106/106 · no issues". Pure, for
 * tests. Each campaign alerts once (ledger key `campaign:<id>`), only within
 * two daytime hours of finishing (campaignAlertWindowMs: one that finished
 * at night alerts the next morning) and inside 8am-8pm, and the alert carries the
 * campaign's name and counts only, never a recipient. One notification for
 * the kind, like the others; a tap opens the campaign (or, for several, the
 * Campaigns tab).
 */
export function computeCampaignAlerts(
  campaigns: readonly FinishedCampaign[],
  alreadySent: ReadonlySet<string>,
  now: Date,
  timeZone: string,
): PushAlert[] {
  if (quietHours(now, timeZone)) return [];
  const windowMs = campaignAlertWindowMs(now, timeZone);
  const due = campaigns
    .filter((c) => {
      if (c.status !== 'sent' || !c.sentAt) return false;
      const age = now.getTime() - Date.parse(c.sentAt);
      // A minute of clock skew either way still counts as just now.
      return age >= -60_000 && age <= windowMs;
    })
    .map((c) => ({ key: `campaign:${c.id}`, c }))
    .filter(({ key }) => !alreadySent.has(key));
  if (!due.length) return [];
  const [only] = due;
  return [
    {
      keys: due.map((d) => d.key),
      title: due.length === 1 ? 'Campaign sent' : `${due.length} campaigns sent`,
      body: listBody(due.map(({ c }) => receiptLine(c.name, c.counts))),
      url:
        due.length === 1 && only
          ? `/fund-ii/campaigns/${encodeURIComponent(only.c.id)}`
          : '/fund-ii?tab=campaigns',
      tag: 'campaign',
    },
  ];
}

async function alertedKeys(
  store: DataStore,
  organizationId: string,
  now: Date,
): Promise<Set<string>> {
  const since = new Date(now.getTime() - LEDGER_DAYS * 86_400_000).toISOString();
  const rows = (await store.list(
    'audit_events',
    organizationId,
    { eq: { action: ALERTED_ACTION }, gte: { created_at: since } },
    { limit: 2000 },
  )) as AuditEvent[];
  return new Set(rows.map((r) => r.entity_id).filter((k): k is string => Boolean(k)));
}

export async function ownerTimeZone(store: DataStore, organizationId: string): Promise<string> {
  try {
    const members = (await store.list(
      'organization_members',
      organizationId,
      {},
    )) as OrganizationMember[];
    const owner = members.find((m) => m.role === 'owner') ?? members[0];
    const profile = owner
      ? ((await store.userProfileById(owner.user_id)) as UserProfile | null)
      : null;
    return profile?.timezone || 'America/Chicago';
  } catch {
    return 'America/Chicago';
  }
}

/** One iPhone app to send to: its id (to report it gone), token and owner. */
export interface OutboxApns {
  key: string;
  token: string;
  userId: string | null;
}

/**
 * One batch for the sender: these alerts, to these phones. `apns` is listed
 * only to a sender that says it can send to Apple, and an older sender
 * ignores it, so the app and the job can be deployed in either order.
 */
export interface OutboxEntry {
  organizationId: string;
  subscriptions: PushSubscriptionInput[];
  apns: OutboxApns[];
  alerts: PushAlert[];
}

/** How long one Calendar read serves every caller for an organization. */
const MEETING_EVENTS_TTL_MS = 50_000;

const meetingEventsCache = processWide(
  'push-meeting-events',
  () => new Map<string, { at: number; events: MeetingEvent[] }>(),
);

/**
 * Events starting in the next quarter hour, for meetingAlerts. A read that
 * worked serves every caller for 50 seconds (the phone job and each desktop
 * all ask every minute, and Calendar has no cache of its own); the window
 * reaches far enough ahead that a read that old still covers the next 6.5
 * minutes. In demo mode the synced rows stand in, as on the Calendar tab, so
 * asking never reaches Google or marks the demo connection as needing a
 * reconnect.
 */
async function upcomingMeetingEvents(
  store: DataStore,
  organizationId: string,
  integration: Integration,
  now: Date,
): Promise<Result<MeetingEvent[]>> {
  const from = new Date(now.getTime() - 60_000);
  const to = new Date(now.getTime() + 15 * 60_000);
  if (isDemoMode()) {
    const rows = (await store.list('calendar_events', organizationId, {})) as CalendarEvent[];
    return ok(
      rows
        .filter((r) => r.starts_at >= from.toISOString() && r.starts_at < to.toISOString())
        .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
        .map(meetingFromStoredEvent),
    );
  }
  const cached = meetingEventsCache.get(organizationId);
  if (cached && Math.abs(now.getTime() - cached.at) < MEETING_EVENTS_TTL_MS) {
    return ok(cached.events);
  }
  const events = await listMeetingEvents(store, integration, from, to);
  if (events.ok) {
    meetingEventsCache.set(organizationId, { at: now.getTime(), events: events.value });
  }
  return events;
}

/**
 * Meeting alerts: real meetings (see classifyMeeting) starting in about five
 * minutes. These ignore the 8am-8pm quiet window, because an early meeting
 * still needs the heads-up; calendar blocks never alert. A tap joins the
 * video call, except for a face-to-face meeting, which opens the Calendar tab
 * (its card still has the Join link).
 */
export async function meetingAlerts(
  store: DataStore,
  organizationId: string,
  sent: ReadonlySet<string>,
  now: Date,
  timeZone: string,
): Promise<PushAlert[]> {
  const integration = await getPrimaryIntegration(store, organizationId).catch(() => null);
  if (!integration || integration.status === 'disconnected') return [];
  const events = await upcomingMeetingEvents(store, organizationId, integration, now);
  if (!events.ok) return [];
  const own = [integration.account_email ?? ''].filter(Boolean);
  return dueMeetingAlerts(events.value, own, sent, now, timeZone).map((m) => {
    const event = events.value.find((e) => e.id === m.eventId);
    return {
      keys: [m.key],
      title: m.title,
      body: clip(m.body),
      url:
        event?.joinUrl && !m.inPerson
          ? `/go/meeting?id=${encodeURIComponent(m.eventId)}`
          : '/calendar',
      tag: `meeting-${m.eventId.slice(0, 40)}`,
    };
  });
}

export type OutboxScope = 'all' | 'meetings';

/** What every alert but the meeting ones is worked out from, for one organization. */
export interface AlertInputs {
  /** The relay snapshot, or null when it could not be read. */
  followUps: FollowUpsSnapshot | null;
  readers: DocSendReader[];
  finished: FinishedCampaign[];
}

/**
 * Read the inputs: campaigns finished within the alert window, the relay
 * snapshot (`force` skips its one-minute cache) and, when that worked, who
 * opened DocSend links. A failed campaign or DocSend read leaves that part
 * empty; a throw from the snapshot read is the caller's to handle.
 */
export async function readAlertInputs(
  store: DataStore,
  organizationId: string,
  now: Date,
  timeZone: string,
  { force }: { force: boolean },
): Promise<AlertInputs> {
  const finished = await finishedCampaignsSince(
    store,
    organizationId,
    new Date(now.getTime() - campaignAlertWindowMs(now, timeZone)),
  ).catch(() => null);
  const inputs: AlertInputs = {
    followUps: null,
    readers: [],
    finished: finished?.ok ? finished.value : [],
  };
  const followUps = await readFollowUps(store, organizationId, { now, force });
  if (followUps.state === 'ok') {
    inputs.followUps = followUps.snapshot;
    const docsend = await readDocSendViews(store, organizationId, { now }).catch(() => null);
    inputs.readers =
      docsend?.state === 'ok'
        ? buildReaders(docsend.views, {
            ownDomain: docsend.ownDomain,
            lps: followUps.snapshot.lpPipeline?.lps ?? [],
            now,
          })
        : [];
  }
  return inputs;
}

/** Every alert but the meeting ones that is due now: campaigns first, then the rest. Pure. */
export function alertsFromInputs(
  inputs: AlertInputs,
  sent: ReadonlySet<string>,
  now: Date,
  timeZone: string,
): PushAlert[] {
  return [
    ...computeCampaignAlerts(inputs.finished, sent, now, timeZone),
    ...(inputs.followUps
      ? computeDueAlerts(inputs.followUps, sent, now, timeZone, inputs.readers)
      : []),
  ];
}

/** Test hook. */
export function resetPushAlertCaches(): void {
  meetingEventsCache.clear();
}

/** The fixed test alert ("Send a test alert"), for one person's phones. */
export function testAlert(key: string): PushAlert {
  return {
    keys: [key],
    title: 'Test alert',
    body: 'Alerts reach this phone. Tap to open Settings.',
    url: '/settings',
    tag: 'test',
  };
}

/**
 * What the sender job should push now, per organization with a phone that
 * has alerts on (a web subscription or the iPhone app). The sender asks
 * every minute for meetings only, and for everything every half hour.
 *
 * `apnsReady` is the sender saying it holds a working APNs key. Only then
 * are iPhone app tokens listed and anyone's web push held back for their app
 * (ios-push.ts routeChannels), so a missing or failing key never leaves a
 * phone with nothing. `holdBack` false is the sender saying its APNs sends
 * are failing right now (no answer, or Apple's side failing): the tokens are
 * still listed, but nobody's web push is held back until Apple answers
 * again. A test alert someone asked for is an entry of its own
 * with only their phones, so not even an older sender shows it to anyone
 * else; like meeting alerts, it ignores the 8am-8pm window.
 */
export async function buildOutbox(
  store: DataStore,
  now: Date = new Date(),
  scope: OutboxScope = 'all',
  { apnsReady = false, holdBack = true }: { apnsReady?: boolean; holdBack?: boolean } = {},
): Promise<OutboxEntry[]> {
  const organizations = (await store.list('organizations', '', {})) as Organization[];
  const out: OutboxEntry[] = [];
  for (const org of organizations) {
    try {
      if (scope === 'all') await sweepIosDevices(store, org.id, now);
      const [subscriptions, devices] = await Promise.all([
        listSubscriptions(store, org.id),
        listIosDevices(store, org.id),
      ]);
      if (apnsReady) await noteApnsSender(store, org.id, now);
      if (!subscriptions.length && !devices.length) continue;
      const [sent, tz, preferences] = await Promise.all([
        alertedKeys(store, org.id, now),
        ownerTimeZone(store, org.id),
        alertsPreferences(store, org.id),
      ]);
      const toEntry = (
        alerts: PushAlert[],
        subs: readonly StoredSubscription[],
        apps: readonly IosDevice[],
      ): OutboxEntry => {
        const routed = routeChannels(subs, apps, preferences, now, apnsReady, holdBack);
        return {
          organizationId: org.id,
          subscriptions: routed.subscriptions.map(({ endpoint, keys }) => ({ endpoint, keys })),
          apns: routed.devices.map(({ key, token, userId }) => ({ key, token, userId })),
          alerts,
        };
      };

      const alerts: PushAlert[] = await meetingAlerts(store, org.id, sent, now, tz).catch(() => []);
      if (scope === 'all') {
        const inputs = await readAlertInputs(store, org.id, now, tz, { force: true });
        alerts.push(...alertsFromInputs(inputs, sent, now, tz));
      }
      out.push(toEntry(alerts, subscriptions, devices));

      for (const test of await pendingTestAlerts(store, org.id, sent, now)) {
        const entry = toEntry(
          [testAlert(test.key)],
          subscriptions.filter((s) => s.userId === test.userId),
          devices.filter((d) => d.userId === test.userId),
        );
        if (entry.subscriptions.length || entry.apns.length) out.push(entry);
      }
    } catch (error) {
      log.warn('Push outbox failed for an organization', {
        reason: (error as Error)?.message,
      });
    }
  }
  return out;
}

/**
 * The sender job's report: ledger the delivered keys, drop endpoints the push
 * service says are gone, and the iPhones Apple says are (ios-push.ts).
 */
export async function recordDelivery(
  store: DataStore,
  organizationId: string,
  sentKeys: readonly string[],
  goneEndpoints: readonly string[],
  goneIphones: readonly GoneIosDevice[] = [],
): Promise<{ recorded: number; removed: number; removedIphones: number }> {
  const created_at = new Date().toISOString();
  const keys = [...new Set(sentKeys)].slice(0, 200);
  if (keys.length) {
    await store.insertMany(
      'audit_events',
      keys.map((key): AuditEvent => ({
        id: newId(),
        organization_id: organizationId,
        user_id: null,
        action: ALERTED_ACTION,
        entity_type: 'push',
        entity_id: key.slice(0, 200),
        metadata: {},
        ip_hash: null,
        created_at,
      })),
    );
  }
  let removed = 0;
  for (const endpoint of goneEndpoints.slice(0, 50)) {
    removed += await removeSubscription(store, organizationId, endpoint);
  }
  const removedIphones = await removeGoneIosDevices(store, organizationId, goneIphones);
  return { recorded: keys.length, removed, removedIphones };
}
