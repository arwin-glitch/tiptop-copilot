import 'server-only';
import { z } from 'zod';
import { env } from '@/lib/config/env';
import type { DataStore } from '@/lib/db/store';
import { log } from '@/lib/security/redact';
import type { AuditEvent, Organization, OrganizationMember, UserProfile } from '@/lib/types/domain';
import { newId, sha256 } from '@/lib/util/hash';
import { localClock } from '@/lib/util/time';
import { buildReaders, readDocSendViews, type DocSendReader } from './docsend';
import { readFollowUps, type FollowUpsSnapshot } from './follow-ups';

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
 * (readFollowUps), each item alerts once, and nothing is sent outside 8am-8pm
 * in the owner's timezone.
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

export interface StoredSubscription extends PushSubscriptionInput {
  userId: string | null;
}

const endpointKey = (endpoint: string) => sha256(endpoint).slice(0, 40);

export async function saveSubscription(
  store: DataStore,
  organizationId: string,
  userId: string,
  subscription: PushSubscriptionInput,
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
    metadata: { endpoint: subscription.endpoint, keys: subscription.keys },
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
    if (parsed.success) out.push({ ...parsed.data, userId: row.user_id });
  }
  return out;
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
  const clock = localClock(now, timeZone);
  if (clock.hour < QUIET_BEFORE_HOUR || clock.hour >= QUIET_FROM_HOUR) return [];
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

async function ownerTimeZone(store: DataStore, organizationId: string): Promise<string> {
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

export interface OutboxEntry {
  organizationId: string;
  subscriptions: PushSubscriptionInput[];
  alerts: PushAlert[];
}

/** What the sender job should push now, per organization with a subscribed phone. */
export async function buildOutbox(
  store: DataStore,
  now: Date = new Date(),
): Promise<OutboxEntry[]> {
  const organizations = (await store.list('organizations', '', {})) as Organization[];
  const out: OutboxEntry[] = [];
  for (const org of organizations) {
    try {
      const subscriptions = await listSubscriptions(store, org.id);
      if (!subscriptions.length) continue;
      const followUps = await readFollowUps(store, org.id, { now, force: true });
      if (followUps.state !== 'ok') continue;
      const [sent, tz] = await Promise.all([
        alertedKeys(store, org.id, now),
        ownerTimeZone(store, org.id),
      ]);
      const docsend = await readDocSendViews(store, org.id, { now }).catch(() => null);
      const readers =
        docsend?.state === 'ok'
          ? buildReaders(docsend.views, {
              ownDomain: docsend.ownDomain,
              lps: followUps.snapshot.lpPipeline?.lps ?? [],
              now,
            })
          : [];
      const alerts = computeDueAlerts(followUps.snapshot, sent, now, tz, readers);
      out.push({
        organizationId: org.id,
        subscriptions: subscriptions.map(({ endpoint, keys }) => ({ endpoint, keys })),
        alerts,
      });
    } catch (error) {
      log.warn('Push outbox failed for an organization', {
        reason: (error as Error)?.message,
      });
    }
  }
  return out;
}

/** The sender job's report: ledger the delivered keys, drop endpoints the push service says are gone. */
export async function recordDelivery(
  store: DataStore,
  organizationId: string,
  sentKeys: readonly string[],
  goneEndpoints: readonly string[],
): Promise<{ recorded: number; removed: number }> {
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
  return { recorded: keys.length, removed };
}
