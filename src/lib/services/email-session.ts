import 'server-only';
import { z } from 'zod';
import type { DataStore } from '@/lib/db/store';
import type { AuditEvent, Deal, PortfolioCompany } from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';
import {
  listInboxThreadIds,
  readLabelNames,
  readThreadMeta,
  type InboxThreadMeta,
} from '@/lib/google/gmail-inbox';
import { env } from '@/lib/config/env';
import type { Integration } from '@/lib/types/domain';
import { processWide } from '@/lib/util/process-state';
import { getPrimaryIntegration } from './inbox';
import {
  EMAIL_GROUPS,
  readFollowUps,
  type EmailGroup,
  type EmailQueueItem,
  type FollowUpsSnapshot,
} from './follow-ups';

/**
 * The email session: Nick's open emails, one at a time, in working order.
 *
 * Which emails appear comes live from Nick's Gmail inbox on every load: an
 * email answered or archived in Gmail drops out, a new one appears. The
 * email-queue routine adds the judgment for each (group, why, draft) as
 * EMAIL_QUEUE_V1 posts in #deal-relay, re-judging only new or changed
 * threads; an email it has not judged yet is sorted by Nick's triage
 * @-labels until it does. The app adds what only it knows: what each person is
 * in the Copilot (a deal, a portfolio company, a Fund II LP) and what Nick
 * already answered. Without a Gmail connection (demo) the judged list is used
 * as is.
 *
 * Answers are rows in `audit_events` (action `email.session_answer`), so they
 * survive reloads, are shared between Nick and Arwin, and need no migration.
 * The newest answer per email wins.
 */

export const ANSWERS = ['sent', 'pass', 'archive', 'later', 'note', 'stop', 'done'] as const;
export type SessionAnswerKind = (typeof ANSWERS)[number];

export const ANSWER_SCHEMA = z.object({
  id: z.string().regex(/^[0-9a-f]{10,24}$/i),
  answer: z.enum(ANSWERS),
  note: z.string().trim().max(1000).optional(),
  signature: z.enum(['nick', 'arwin']).optional(),
  /** True when the reply went out from the app; false when Nick sent it in Gmail. */
  viaApp: z.boolean().optional(),
});
export type SessionAnswerInput = z.infer<typeof ANSWER_SCHEMA>;

const ANSWER_ACTION = 'email.session_answer';
const ANSWER_WINDOW_DAYS = 21;

/**
 * The only batch that leaves Nick's queue: emails with nothing to answer,
 * cleared with one "Archive all". Anything in the inbox that needs a reply is
 * Nick's: Arwin handles what he can before it ever reaches the session.
 */
export const ARWIN_GROUPS: readonly EmailGroup[] = ['archive'];

/** Outside the Primary tab, only these surface in the session. */
const URGENT_OUTSIDE_PRIMARY: readonly string[] = ['today', 'money', 'deals', 'owed', 'waiting'];

export type SessionGroup = EmailGroup | 'waiting' | 'new';

const MINUTES: Record<SessionGroup, number> = {
  today: 1.5,
  money: 1.5,
  deals: 1.5,
  owed: 0.5,
  intros: 0.5,
  waiting: 1,
  new: 1,
  replies: 0.5,
  archive: 0.1,
};

export interface SessionContext {
  kind: 'deal' | 'portfolio' | 'lp' | 'risk';
  label: string;
  href: string;
}

export interface SessionAnswer {
  answer: SessionAnswerKind;
  note: string | null;
  signature: 'nick' | 'arwin' | null;
  viaApp: boolean;
  at: string;
  by: string | null;
}

export interface SessionItem {
  id: string;
  who: string;
  about: string;
  group: SessionGroup;
  call: EmailQueueItem['call'];
  flags: string[];
  draft: EmailQueueItem['draft'];
  why: string | null;
  waitingDays: number | null;
  minutes: number;
  /** Nick decides it (true) or it sits in Arwin's pile (false). */
  needsNick: boolean;
  context: SessionContext[];
  answer: SessionAnswer | null;
}

export interface EmailSession {
  state: 'ok' | 'empty' | 'unavailable';
  runAt: string | null;
  items: SessionItem[];
}

const GROUP_ORDER: SessionGroup[] = [
  'today',
  'money',
  'deals',
  'owed',
  'intros',
  'new',
  'waiting',
  'replies',
  'archive',
];

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Whole-word, case-insensitive: "Arlow" matches "Arlow round", not "Harlow". */
function mentions(haystack: string, name: string): boolean {
  const n = norm(name);
  if (n.length < 3) return false;
  return ` ${haystack} `.includes(` ${n} `);
}

export interface LiveInbox {
  /** Primary-tab thread ids in the inbox right now. */
  ids: Set<string>;
  /** Inbox threads in the other tabs (Promotions, Updates, ...): shown only when urgent. */
  otherIds: Set<string>;
  /** Who/what for inbox threads the routine has not judged yet. */
  meta: Map<string, InboxThreadMeta>;
  /** Gmail label id -> name (for the triage @-labels). */
  labelNames: Map<string, string>;
}

/**
 * Sort an email the routine has not judged yet, from Nick's triage labels.
 * Pure, for tests.
 */
export function groupFromLabels(
  meta: Pick<InboxThreadMeta, 'labelIds' | 'lastFromUs'>,
  labelNames: Map<string, string>,
): SessionGroup {
  if (meta.lastFromUs) return 'archive';
  const names = meta.labelIds.map((id) => (labelNames.get(id) ?? id).toLowerCase());
  const has = (re: RegExp) => names.some((n) => re.test(n));
  if (has(/do asap/)) return 'today';
  if (has(/deals? to review/)) return 'deals';
  if (has(/for arwin/)) return 'replies';
  if (
    has(/ready to archive|low prio|to read|waiting|^category_(promotions|social|updates|forums)$/)
  ) {
    return 'archive';
  }
  return 'new';
}

/** Pure, for tests. */
export function buildSession(input: {
  snapshot: FollowUpsSnapshot;
  answers: Map<string, SessionAnswer>;
  deals: Pick<Deal, 'id' | 'company_name' | 'stage'>[];
  portfolio: Pick<PortfolioCompany, 'id' | 'name'>[];
  now: Date;
  /** Live inbox; null means "use the judged list as is" (demo, Gmail down). */
  inbox?: LiveInbox | null;
}): EmailSession {
  const { snapshot, answers, deals, portfolio, now } = input;
  const inbox = input.inbox ?? null;
  const inInbox = (id: string, group?: string) =>
    !inbox ||
    inbox.ids.has(id) ||
    (inbox.otherIds.has(id) && group !== undefined && URGENT_OUTSIDE_PRIMARY.includes(group));
  // An answer from before the email was last judged (it changed since) no longer applies.
  const answerFor = (id: string): SessionAnswer | null => {
    const a = answers.get(id) ?? null;
    const judgedAt = snapshot.emailJudgedAt[id];
    return a && judgedAt && a.at < judgedAt ? null : a;
  };
  const queue = snapshot.emailQueue;
  const days = (iso: string | null | undefined) =>
    iso ? Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 86_400_000)) : null;

  const lps = snapshot.lpPipeline?.lps ?? [];
  const risky = new Set(
    (snapshot.portfolioHealth?.companies ?? [])
      .filter((c) => c.flag === 'risk' || c.flag === 'watch')
      .map((c) => norm(c.name)),
  );
  const contextFor = (text: string): SessionContext[] => {
    const hay = norm(text);
    const out: SessionContext[] = [];
    for (const d of deals) {
      if (mentions(hay, d.company_name)) {
        out.push({
          kind: 'deal',
          label: `Deal · ${d.stage.replace(/_/g, ' ')}`,
          href: `/deals/${d.id}`,
        });
        break;
      }
    }
    for (const p of portfolio) {
      if (mentions(hay, p.name)) {
        out.push({ kind: 'portfolio', label: 'Portfolio company', href: `/portfolio/${p.id}` });
        if (risky.has(norm(p.name))) {
          out.push({ kind: 'risk', label: 'Health: needs a look', href: '/portfolio' });
        }
        break;
      }
    }
    for (const lp of lps) {
      if (mentions(hay, lp.who) || (lp.firm && mentions(hay, lp.firm))) {
        out.push({
          kind: 'lp',
          label: `Fund II · ${lp.stage.replace(/_/g, ' ')}`,
          href: '/fund-ii',
        });
        break;
      }
    }
    return out;
  };

  const items: SessionItem[] = [];
  const seenIds = new Set<string>();
  const seenWho = new Set<string>();
  for (const q of queue?.items ?? []) {
    if (seenIds.has(q.id) || !inInbox(q.id, q.group)) continue;
    seenIds.add(q.id);
    seenWho.add(norm(q.who));
    const answer = answerFor(q.id);
    items.push({
      id: q.id,
      who: q.who,
      about: q.about,
      group: q.group,
      call: q.call,
      flags: q.flags,
      draft: q.draft,
      why: q.why ?? null,
      waitingDays: days(q.waiting_since),
      minutes: MINUTES[q.group],
      needsNick: !ARWIN_GROUPS.includes(q.group) || answer?.answer === 'stop',
      context: contextFor(`${q.who} ${q.about} ${q.why ?? ''}`),
      answer,
    });
  }

  // Waiting on Nick per the radar, with no queued email for that person yet.
  for (const w of snapshot.relationships?.waiting ?? []) {
    if (!w.thread_id || seenIds.has(w.thread_id) || seenWho.has(norm(w.who))) continue;
    if (!inInbox(w.thread_id, 'waiting')) continue;
    seenIds.add(w.thread_id);
    items.push({
      id: w.thread_id,
      who: w.who,
      about: w.note ?? (w.company ? `Waiting on you · ${w.company}` : 'Waiting on you'),
      group: 'waiting',
      call: 'reply',
      flags: [],
      draft: 'none',
      why: w.company ? `${w.company} · waiting ${w.days} days` : `Waiting ${w.days} days`,
      waitingDays: w.days,
      minutes: MINUTES.waiting,
      needsNick: true,
      context: contextFor(`${w.who} ${w.company ?? ''} ${w.note ?? ''}`),
      answer: answers.get(w.thread_id) ?? null,
    });
  }

  // In the inbox but not judged yet: sorted by Nick's @-labels for now.
  for (const id of inbox?.ids ?? []) {
    if (seenIds.has(id)) continue;
    const meta = inbox?.meta.get(id);
    if (!meta) continue;
    seenIds.add(id);
    const group = groupFromLabels(meta, inbox!.labelNames);
    const answer = answers.get(id) ?? null;
    items.push({
      id,
      who: meta.who,
      about: meta.subject,
      group,
      call: group === 'archive' ? 'archive' : 'reply',
      flags: ['New'],
      draft: 'none',
      why: meta.lastFromUs
        ? 'You replied last, so nothing is waiting on you here.'
        : 'Just arrived, sorted by its Gmail label for now. The full read comes within the hour.',
      waitingDays: days(meta.latestAt),
      minutes: MINUTES[group],
      needsNick:
        !(ARWIN_GROUPS as readonly SessionGroup[]).includes(group) || answer?.answer === 'stop',
      context: contextFor(`${meta.who} ${meta.subject}`),
      answer,
    });
  }

  const rank = (g: SessionItem['group']) => GROUP_ORDER.indexOf(g);
  items.sort((a, b) => rank(a.group) - rank(b.group));
  return {
    state: items.length ? 'ok' : 'empty',
    runAt: queue?.run_at ?? snapshot.relationships?.run_at ?? null,
    items,
  };
}

/** True once an answer takes the email off Nick's queue (Later keeps it, at the back). */
export function isSettled(answer: SessionAnswer | null): boolean {
  return Boolean(answer && answer.answer !== 'later' && answer.answer !== 'stop');
}

export async function readAnswers(
  store: DataStore,
  organizationId: string,
  now: Date,
): Promise<Map<string, SessionAnswer>> {
  const since = new Date(now.getTime() - ANSWER_WINDOW_DAYS * 86_400_000).toISOString();
  const rows = (await store.list(
    'audit_events',
    organizationId,
    { eq: { action: ANSWER_ACTION }, gte: { created_at: since } },
    { orderBy: [{ field: 'created_at', direction: 'desc' }], limit: 2000 },
  )) as AuditEvent[];
  const out = new Map<string, SessionAnswer>();
  for (const row of rows) {
    if (!row.entity_id || out.has(row.entity_id)) continue;
    const m = row.metadata as Record<string, unknown>;
    const answer = ANSWERS.find((a) => a === m.answer);
    if (!answer) continue;
    out.set(row.entity_id, {
      answer,
      note: typeof m.note === 'string' ? m.note : null,
      signature: m.signature === 'nick' || m.signature === 'arwin' ? m.signature : null,
      viaApp: m.viaApp === true,
      at: row.created_at,
      by: typeof m.by === 'string' ? m.by : null,
    });
  }
  return out;
}

export async function recordAnswer(
  store: DataStore,
  organizationId: string,
  user: { id: string; name: string },
  input: SessionAnswerInput,
): Promise<void> {
  const row: AuditEvent = {
    id: newId(),
    organization_id: organizationId,
    user_id: user.id,
    action: ANSWER_ACTION,
    entity_type: 'email',
    entity_id: input.id,
    // Written directly, not through recordAudit: a note is the person's own
    // words for Arwin and must arrive as typed.
    metadata: {
      answer: input.answer,
      note: input.note ?? null,
      signature: input.signature ?? null,
      viaApp: input.viaApp ?? false,
      by: user.name,
    },
    ip_hash: null,
    created_at: new Date().toISOString(),
  };
  await store.insert('audit_events', row);
}

const INBOX_TTL_MS = 60_000;
const META_TTL_MS = 10 * 60_000;
const LABELS_TTL_MS = 60 * 60_000;
const MAX_NEW_LOOKUPS = 40;

const inboxCache = processWide('email-session-inbox', () => ({
  ids: new Map<string, { at: number; ids: string[]; otherIds: string[] }>(),
  meta: new Map<string, { at: number; meta: InboxThreadMeta | null }>(),
  labels: new Map<string, { at: number; names: Map<string, string> }>(),
}));

/** Test hook. */
export function resetInboxCache(): void {
  inboxCache.ids.clear();
  inboxCache.meta.clear();
  inboxCache.labels.clear();
}

/**
 * The inbox as it is in Gmail now (cached a minute), plus who/what for the
 * threads the routine has not judged yet. Null when Gmail cannot be read, so
 * the session falls back to the judged list instead of showing nothing.
 */
async function readLiveInbox(
  store: DataStore,
  integration: Integration,
  judged: Set<string>,
): Promise<LiveInbox | null> {
  const now = Date.now();
  let cached = inboxCache.ids.get(integration.id);
  if (!cached || now - cached.at > INBOX_TTL_MS) {
    const [primary, other] = await Promise.all([
      listInboxThreadIds(store, integration, 'category:primary'),
      listInboxThreadIds(store, integration, '-category:primary'),
    ]);
    if (!primary.ok) return null;
    cached = { at: now, ids: primary.value, otherIds: other.ok ? other.value : [] };
    inboxCache.ids.set(integration.id, cached);
  }
  let labels = inboxCache.labels.get(integration.id);
  if (!labels || now - labels.at > LABELS_TTL_MS) {
    labels = { at: now, names: await readLabelNames(store, integration) };
    inboxCache.labels.set(integration.id, labels);
  }
  const missing = cached.ids
    .filter((id) => !judged.has(id))
    .filter((id) => {
      const m = inboxCache.meta.get(id);
      return !m || now - m.at > META_TTL_MS;
    })
    .slice(0, MAX_NEW_LOOKUPS);
  for (let i = 0; i < missing.length; i += 8) {
    const batch = missing.slice(i, i + 8);
    const metas = await Promise.all(batch.map((id) => readThreadMeta(store, integration, id)));
    batch.forEach((id, k) => inboxCache.meta.set(id, { at: now, meta: metas[k] ?? null }));
  }
  const meta = new Map<string, InboxThreadMeta>();
  for (const id of cached.ids) {
    const m = inboxCache.meta.get(id)?.meta;
    if (m && !judged.has(id)) meta.set(id, m);
  }
  return {
    ids: new Set(cached.ids),
    otherIds: new Set(cached.otherIds),
    meta,
    labelNames: labels.names,
  };
}

export async function readEmailSession(
  store: DataStore,
  organizationId: string,
  options: { now?: Date } = {},
): Promise<EmailSession> {
  const now = options.now ?? new Date();
  const followUps = await readFollowUps(store, organizationId, { now });
  if (followUps.state !== 'ok') return { state: 'unavailable', runAt: null, items: [] };
  const integration = env().demoMode
    ? null
    : await getPrimaryIntegration(store, organizationId).catch(() => null);
  const inbox = integration
    ? await readLiveInbox(
        store,
        integration,
        new Set(Object.keys(followUps.snapshot.emailJudgedAt)),
      ).catch(() => null)
    : null;
  const [answers, deals, portfolio] = await Promise.all([
    readAnswers(store, organizationId, now).catch(() => new Map<string, SessionAnswer>()),
    (store.list('deals', organizationId, {}, { limit: 1000 }) as Promise<Deal[]>).catch(() => []),
    (
      store.list('portfolio_companies', organizationId, {}, { limit: 500 }) as Promise<
        PortfolioCompany[]
      >
    ).catch(() => []),
  ]);
  return buildSession({ snapshot: followUps.snapshot, answers, deals, portfolio, now, inbox });
}

/** For the Follow-ups card: how much is left for Nick, and roughly how long. */
export function sessionSummary(session: EmailSession): {
  forNick: number;
  forArwin: number;
  minutes: number;
  answered: number;
} {
  const open = session.items.filter((i) => !isSettled(i.answer));
  const forNick = open.filter((i) => i.needsNick);
  return {
    forNick: forNick.length,
    forArwin: open.filter((i) => !i.needsNick).length,
    minutes: Math.max(1, Math.round(forNick.reduce((t, i) => t + i.minutes, 0))),
    answered: session.items.length - open.length,
  };
}

export { EMAIL_GROUPS };
