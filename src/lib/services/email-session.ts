import 'server-only';
import { z } from 'zod';
import type { DataStore } from '@/lib/db/store';
import type { AuditEvent, Deal, PortfolioCompany } from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';
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
 * The queue comes from the For Nick refresh (EMAIL_QUEUE_V1 in #deal-relay).
 * The app adds what only it knows: who is waiting with no queued email yet
 * (the relationship radar), what each person is in the Copilot (a deal, a
 * portfolio company, a Fund II LP), and what Nick already answered.
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

/** Arwin's pile: the groups Nick does not have to decide. */
export const ARWIN_GROUPS: readonly EmailGroup[] = ['replies', 'archive'];

const MINUTES: Record<EmailGroup | 'waiting', number> = {
  today: 1.5,
  money: 1.5,
  deals: 1.5,
  owed: 0.5,
  intros: 0.5,
  waiting: 1,
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
  group: EmailGroup | 'waiting';
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

const GROUP_ORDER: (EmailGroup | 'waiting')[] = [
  'today',
  'money',
  'deals',
  'owed',
  'intros',
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

/** Pure, for tests. */
export function buildSession(input: {
  snapshot: FollowUpsSnapshot;
  answers: Map<string, SessionAnswer>;
  deals: Pick<Deal, 'id' | 'company_name' | 'stage'>[];
  portfolio: Pick<PortfolioCompany, 'id' | 'name'>[];
  now: Date;
}): EmailSession {
  const { snapshot, answers, deals, portfolio, now } = input;
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
    if (seenIds.has(q.id)) continue;
    seenIds.add(q.id);
    seenWho.add(norm(q.who));
    const answer = answers.get(q.id) ?? null;
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

export async function readEmailSession(
  store: DataStore,
  organizationId: string,
  options: { now?: Date } = {},
): Promise<EmailSession> {
  const now = options.now ?? new Date();
  const followUps = await readFollowUps(store, organizationId, { now });
  if (followUps.state !== 'ok') return { state: 'unavailable', runAt: null, items: [] };
  const [answers, deals, portfolio] = await Promise.all([
    readAnswers(store, organizationId, now).catch(() => new Map<string, SessionAnswer>()),
    (store.list('deals', organizationId, {}, { limit: 1000 }) as Promise<Deal[]>).catch(() => []),
    (
      store.list('portfolio_companies', organizationId, {}, { limit: 500 }) as Promise<
        PortfolioCompany[]
      >
    ).catch(() => []),
  ]);
  return buildSession({ snapshot: followUps.snapshot, answers, deals, portfolio, now });
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
