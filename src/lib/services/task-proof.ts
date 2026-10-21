import type { AuthContext } from '@/lib/auth/session';
import { chunk, listAllPages } from '@/lib/db/paging';
import type { DataStore } from '@/lib/db/store';
import { getStore } from '@/lib/runtime';
import { recordAudit } from '@/lib/security/audit';
import { log } from '@/lib/security/redact';
import { mentionsNickOnly } from '@/lib/tasks/nick-only';
import {
  classifyDeliverable,
  DELIVERABLE_KINDS,
  notSeenLabel,
  PROOF_EVIDENCE_TYPES,
  proofJudgeAfter,
  seenSentLabel,
  type DeliverableKind,
  type ProofCheckView,
  type ProofEvidenceType,
} from '@/lib/tasks/proof';
import { isRealSend, messageRecipients, plainText } from '@/lib/tasks/real-reply';
import type {
  AuditEvent,
  CrmRecord,
  Deal,
  EmailMessage,
  Integration,
  NetworkContact,
  OrganizationMember,
  PortfolioCompany,
  PortfolioContact,
  Task,
} from '@/lib/types/domain';
import { err, ok, type Result } from '@/lib/util/result';

/**
 * The proof check for tasks a person ticks by hand (see lib/tasks/proof.ts
 * for the rules). Stored as audit rows beside each task, like the
 * task-closer's (D-052) and the money and legal marks (D-060), so there is
 * no migration and every read degrades to "nothing to show":
 *
 * - `task.proof_expected` (the person who ticked it): written with the
 *   completion when the task is a deliverable. `{v, kind, recipients, proof,
 *   completed_at, judge_after, time_zone, email_message_id}`. It belongs to
 *   that completion only: Undo or Reopen, and it no longer applies.
 * - `task.proof_seen` (no user): the deliverable was seen, by the app's own
 *   look at sent mail or a task-closer post. `{v, expected_id, source,
 *   evidence_type, evidence_id, evidence_at, ...}`. One per expectation.
 * - `task.proof_missing` (no user): the window passed with nothing seen, on
 *   a working mailbox synced past it, for a task the mailbox's owner does.
 *   `{v, expected_id, judged_at, addressed, to}`. The task shows "Ticked, not
 *   seen sent" until a person says "It's done" or reopens it. A proof that
 *   turns up later still clears it.
 * - `task.proof_confirmed` (a person): "It's done". `{v, expected_id}`.
 *   Clears the flag for good; nothing checks that completion again.
 *
 * None of them is a "person touched it" action for the task-closer, and
 * none of them ever changes a task's status: the app points, a person
 * decides. This module imports nothing from the task-closer, which calls it.
 */

export const PROOF_EXPECTED_ACTION = 'task.proof_expected';
export const PROOF_SEEN_ACTION = 'task.proof_seen';
export const PROOF_MISSING_ACTION = 'task.proof_missing';
export const PROOF_CONFIRMED_ACTION = 'task.proof_confirmed';
const PROOF_ACTIONS = [
  PROOF_EXPECTED_ACTION,
  PROOF_SEEN_ACTION,
  PROOF_MISSING_ACTION,
  PROOF_CONFIRMED_ACTION,
];
/** Read with the proof rows: an auto-close a person then reopened is evidence they turned down. */
const AUTO_CLOSE_ACTION = 'task.auto_completed';

/** How long after a tick the app keeps looking for the deliverable. */
export const PROOF_CHECK_HORIZON_DAYS = 45;
/** Sent messages read per check: the newest after the oldest task still waiting. */
const SENT_SCAN_LIMIT = 500;

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function sameInstant(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const x = Date.parse(a);
  const y = Date.parse(b);
  return !Number.isNaN(x) && !Number.isNaN(y) && Math.abs(x - y) < 1_000;
}

/* ------------------------------------------------------------- the record */

/**
 * Called with a person's completion of a task (`writeTaskStatus`): when the
 * task is a deliverable, notes what should have gone out and to whom. A plain
 * to-do, a task involving a Nick-only counterparty, or a completion that
 * already carried proof (a money or legal close) writes nothing. Never
 * throws: a fault here must not undo the tick.
 */
export async function recordProofExpectation(
  store: DataStore,
  who: { organizationId: string; userId: string | null; timeZone: string },
  task: Task,
): Promise<void> {
  try {
    if (task.status !== 'complete' || !task.completed_at) return;
    if (mentionsNickOnly(task.title, task.detail)) return;
    const found = classifyDeliverable(task.title, task.detail);
    if (!found) return;
    // A reply with no name is addressed by the email it was made from, or not at all.
    if (found.recipients.length === 0 && !task.email_message_id) return;
    const completed = new Date(task.completed_at);
    if (Number.isNaN(completed.getTime())) return;
    await recordAudit(store, {
      organizationId: who.organizationId,
      userId: who.userId,
      action: PROOF_EXPECTED_ACTION,
      entityType: 'task',
      entityId: task.id,
      metadata: {
        v: 1,
        kind: found.kind,
        recipients: found.recipients,
        proof: found.proof,
        completed_at: task.completed_at,
        judge_after: proofJudgeAfter(completed, who.timeZone).toISOString(),
        time_zone: who.timeZone,
        email_message_id: task.email_message_id,
      },
    });
  } catch (error) {
    log.warn('Could not note what a ticked task should have sent', {
      reason: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
    });
  }
}

/* ---------------------------------------------------------------- reading */

export interface ProofExpectation {
  auditId: string;
  at: string;
  kind: DeliverableKind;
  recipients: string[];
  proof: ProofEvidenceType[];
  completedAt: string;
  judgeAfter: string;
  emailMessageId: string | null;
  /** Who ticked it. */
  tickedBy: string | null;
}

export interface ProofSeen {
  auditId: string;
  at: string;
  source: string;
  evidenceType: string | null;
  evidenceId: string | null;
  evidenceAt: string | null;
}

export type ProofState = 'waiting' | 'seen' | 'flagged' | 'confirmed';

export interface TaskProofCheck {
  taskId: string;
  expectation: ProofExpectation;
  state: ProofState;
  seen: ProofSeen | null;
  /** When the window passed with nothing seen, and whether any recipient had an address. */
  missing: { at: string; addressed: boolean; to: string[] } | null;
  confirmed: { at: string; userId: string | null } | null;
  /**
   * Evidence this task already used up: what proved an earlier completion, or
   * an automatic close a person reopened. A person reopening says that was not
   * it, so it never proves a later tick.
   */
  usedEvidence: string[];
}

function readExpectation(row: AuditEvent): ProofExpectation | null {
  const m = row.metadata ?? {};
  const kind = DELIVERABLE_KINDS.find((k) => k === m.kind);
  const completedAt = str(m.completed_at);
  const judgeAfter = str(m.judge_after);
  if (!kind || !completedAt || !judgeAfter) return null;
  const strings = (value: unknown) =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  return {
    auditId: row.id,
    at: row.created_at,
    kind,
    recipients: strings(m.recipients).slice(0, 5),
    proof: strings(m.proof).filter((p): p is ProofEvidenceType =>
      (PROOF_EVIDENCE_TYPES as readonly string[]).includes(p),
    ),
    completedAt,
    judgeAfter,
    emailMessageId: str(m.email_message_id),
    tickedBy: row.user_id,
  };
}

/** Every proof row for these tasks, oldest first, a hundred ids per query. */
async function proofRows(
  store: DataStore,
  organizationId: string,
  taskIds: readonly string[],
): Promise<Map<string, AuditEvent[]>> {
  const out = new Map<string, AuditEvent[]>();
  for (const ids of chunk([...new Set(taskIds)])) {
    const rows = (await listAllPages(
      store,
      'audit_events',
      organizationId,
      {
        eq: { entity_type: 'task' },
        in: { action: [...PROOF_ACTIONS, AUTO_CLOSE_ACTION], entity_id: ids },
      },
      [{ field: 'created_at', direction: 'asc' }],
    )) as AuditEvent[];
    for (const row of rows) {
      if (!row.entity_id) continue;
      out.set(row.entity_id, [...(out.get(row.entity_id) ?? []), row]);
    }
  }
  return out;
}

/** One task's check from its rows: the expectation for its current completion, and what came of it. */
function foldCheck(task: Task, rows: readonly AuditEvent[]): TaskProofCheck | null {
  if (task.status !== 'complete') return null;
  let expectation: ProofExpectation | null = null;
  for (const row of rows) {
    if (row.action !== PROOF_EXPECTED_ACTION) continue;
    const read = readExpectation(row);
    if (read && sameInstant(read.completedAt, task.completed_at)) expectation = read;
  }
  if (!expectation) return null;
  const mine = rows.filter((row) => row.metadata?.expected_id === expectation.auditId);
  const seenRow = mine.find((row) => row.action === PROOF_SEEN_ACTION);
  const missingRow = mine.find((row) => row.action === PROOF_MISSING_ACTION);
  const confirmedRow = mine.find((row) => row.action === PROOF_CONFIRMED_ACTION && row.user_id);
  const usedEvidence = rows
    .filter(
      (row) =>
        row.action === AUTO_CLOSE_ACTION ||
        (row.action === PROOF_SEEN_ACTION && row.metadata?.expected_id !== expectation.auditId),
    )
    .map((row) => str(row.metadata?.evidence_id))
    .filter((id): id is string => !!id);
  const seen: ProofSeen | null = seenRow
    ? {
        auditId: seenRow.id,
        at: seenRow.created_at,
        source: str(seenRow.metadata?.source) ?? 'app-sent-check',
        evidenceType: str(seenRow.metadata?.evidence_type),
        evidenceId: str(seenRow.metadata?.evidence_id),
        evidenceAt: str(seenRow.metadata?.evidence_at),
      }
    : null;
  return {
    taskId: task.id,
    expectation,
    state: seen ? 'seen' : confirmedRow ? 'confirmed' : missingRow ? 'flagged' : 'waiting',
    seen,
    missing: missingRow
      ? {
          at: missingRow.created_at,
          addressed: missingRow.metadata?.addressed !== false,
          to: Array.isArray(missingRow.metadata?.to)
            ? (missingRow.metadata.to as unknown[]).filter(
                (name): name is string => typeof name === 'string',
              )
            : [],
        }
      : null,
    confirmed: confirmedRow ? { at: confirmedRow.created_at, userId: confirmedRow.user_id } : null,
    usedEvidence: [...new Set(usedEvidence)],
  };
}

/** The proof check of each completed task that has one. */
export async function readProofChecks(
  store: DataStore,
  organizationId: string,
  tasks: readonly Task[],
): Promise<Map<string, TaskProofCheck>> {
  const done = tasks.filter((t) => t.status === 'complete');
  const out = new Map<string, TaskProofCheck>();
  if (done.length === 0) return out;
  const rows = await proofRows(
    store,
    organizationId,
    done.map((t) => t.id),
  );
  for (const task of done) {
    const check = foldCheck(task, rows.get(task.id) ?? []);
    if (check) out.set(task.id, check);
  }
  return out;
}

/** The same, for a page: a fault reads as no checks, never an error. */
export async function readProofChecksSafe(
  store: DataStore,
  organizationId: string,
  tasks: readonly Task[],
): Promise<Map<string, TaskProofCheck>> {
  try {
    return await readProofChecks(store, organizationId, tasks);
  } catch {
    return new Map();
  }
}

const isOutstanding = (check: TaskProofCheck) =>
  check.state === 'waiting' || check.state === 'flagged';

/**
 * Ticked tasks whose deliverable has not been seen or confirmed, ticked within
 * the horizon: still waiting, or already flagged (a late proof clears those).
 */
export async function listAwaitingProof(
  store: DataStore,
  organizationId: string,
  now: Date = new Date(),
): Promise<{ task: Task; check: TaskProofCheck }[]> {
  const since = new Date(now.getTime() - PROOF_CHECK_HORIZON_DAYS * 86_400_000).toISOString();
  const tasks = (await listAllPages(store, 'tasks', organizationId, {
    eq: { status: 'complete' },
    gte: { completed_at: since },
  })) as Task[];
  const checks = await readProofChecks(store, organizationId, tasks);
  return tasks
    .map((task) => ({ task, check: checks.get(task.id) }))
    .filter((row): row is { task: Task; check: TaskProofCheck } =>
      Boolean(row.check && isOutstanding(row.check)),
    );
}

/**
 * Ticked tasks showing "Ticked, not seen sent", newest tick first, for
 * Today's card. Never throws.
 */
export async function readFlaggedProofTasks(
  store: DataStore,
  organizationId: string,
  now: Date = new Date(),
): Promise<{ task: Task; check: TaskProofCheck }[]> {
  try {
    const since = new Date(
      now.getTime() - (PROOF_CHECK_HORIZON_DAYS + 30) * 86_400_000,
    ).toISOString();
    const missing = (await listAllPages(store, 'audit_events', organizationId, {
      eq: { action: PROOF_MISSING_ACTION, entity_type: 'task' },
      gte: { created_at: since },
    })) as AuditEvent[];
    const ids = [
      ...new Set(missing.map((row) => row.entity_id).filter((id): id is string => !!id)),
    ];
    if (ids.length === 0) return [];
    const tasks: Task[] = [];
    for (const part of chunk(ids)) {
      tasks.push(
        ...((await store.list('tasks', organizationId, {
          in: { id: part },
          eq: { status: 'complete' },
        })) as Task[]),
      );
    }
    const checks = await readProofChecks(store, organizationId, tasks);
    return tasks
      .map((task) => ({ task, check: checks.get(task.id) }))
      .filter((row): row is { task: Task; check: TaskProofCheck } => row.check?.state === 'flagged')
      .sort(
        (a, b) =>
          Date.parse(b.task.completed_at ?? '') - Date.parse(a.task.completed_at ?? '') ||
          a.task.id.localeCompare(b.task.id),
      );
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------- the views */

export type { ProofCheckView };

/** What a Completed row or Today's card says; null for nothing to say. */
export function proofCheckView(
  check: TaskProofCheck | undefined,
  opts: { timeZone: string; messageHref: (messageId: string | null) => string | null },
): ProofCheckView | null {
  if (!check) return null;
  if (check.state === 'seen' && check.seen) {
    return {
      state: 'seen',
      label: seenSentLabel(
        check.seen.evidenceType,
        check.seen.evidenceAt,
        check.expectation.recipients,
        opts.timeZone,
      ),
      href:
        check.seen.evidenceType === 'gmail_sent' ? opts.messageHref(check.seen.evidenceId) : null,
    };
  }
  if (check.state === 'flagged') {
    return {
      state: 'flagged',
      label: 'Ticked, not seen sent',
      detail: notSeenLabel(
        check.expectation.completedAt,
        check.missing?.to.length ? check.missing.to : check.expectation.recipients,
        check.missing?.addressed ?? true,
        opts.timeZone,
      ),
    };
  }
  return null;
}

/* ------------------------------------------------------- evidence arrives */

export interface ProofEvidence {
  source: 'app-sent-check' | 'task-closer';
  evidence_type: ProofEvidenceType;
  evidence_id: string;
  evidence_at: string;
  thread_id?: string | null;
  channel?: string | null;
  reason?: string | null;
  slack_ts?: string | null;
  /**
   * For a task-closer post: when Slack says it was posted. The routine looks
   * only at tasks already ticked, so a post from before this tick was about
   * an earlier one (re-read every run, it must not prove a new tick).
   */
  posted_at?: string | null;
}

export type ProofApplied =
  | 'seen'
  | 'already_applied'
  | 'not_awaiting'
  | 'evidence_too_old'
  | 'posted_before_tick'
  | 'evidence_used'
  | 'wrong_evidence';

/**
 * Marks a ticked task's deliverable seen, from a task-closer post or the
 * app's own look at sent mail. Only a task that is complete with an
 * expectation still outstanding takes it, and only evidence of a kind that
 * proves this deliverable, later than the task's creation, not already used
 * by an earlier completion, and (for a post) posted after this tick. Never
 * changes the task. Re-reading the same post changes nothing: an expectation
 * is seen once, and a later tick is never proved by an older post.
 */
export async function applyProofEvidence(
  store: DataStore,
  organizationId: string,
  task: Task,
  evidence: ProofEvidence,
  check?: TaskProofCheck,
): Promise<ProofApplied> {
  const current = check ?? (await readProofChecks(store, organizationId, [task])).get(task.id);
  if (!current) return 'not_awaiting';
  if (current.state === 'seen') return 'already_applied';
  if (current.state === 'confirmed') return 'not_awaiting';
  const proof = current.expectation.proof;
  if (proof.length > 0 && !proof.includes(evidence.evidence_type)) return 'wrong_evidence';
  if (current.usedEvidence.includes(evidence.evidence_id)) return 'evidence_used';
  if (evidence.posted_at) {
    const posted = Date.parse(evidence.posted_at);
    const ticked = Date.parse(current.expectation.completedAt);
    if (Number.isNaN(posted) || (!Number.isNaN(ticked) && !(posted > ticked))) {
      return 'posted_before_tick';
    }
  }
  const at = Date.parse(evidence.evidence_at);
  const created = Date.parse(task.created_at);
  if (Number.isNaN(at) || (!Number.isNaN(created) && !(at > created))) return 'evidence_too_old';
  await recordAudit(store, {
    organizationId,
    userId: null,
    action: PROOF_SEEN_ACTION,
    entityType: 'task',
    entityId: task.id,
    metadata: {
      v: 1,
      expected_id: current.expectation.auditId,
      source: evidence.source,
      evidence_type: evidence.evidence_type,
      evidence_id: evidence.evidence_id,
      evidence_at: new Date(at).toISOString(),
      ...(evidence.thread_id ? { thread_id: evidence.thread_id } : {}),
      ...(evidence.channel ? { channel: evidence.channel } : {}),
      ...(evidence.reason ? { reason: evidence.reason } : {}),
      ...(evidence.slack_ts ? { slack_ts: evidence.slack_ts } : {}),
    },
  });
  return 'seen';
}

/* ---------------------------------------------------------- who receives */

export interface ProofRecipient {
  name: string;
  emails: string[];
  domains: string[];
}

function words(name: string): string[] {
  return plainText(name).split(' ').filter(Boolean);
}

/** "Dana" matches "Dana Ortiz"; "Dana Ortiz" matches only "Dana Ortiz". */
function nameMatches(candidate: string | null | undefined, name: string): boolean {
  if (!candidate) return false;
  const want = words(name);
  const have = words(candidate.replace(/^dr\.?\s+/i, ''));
  if (want.length === 0 || have.length === 0) return false;
  if (want.length === 1) return have[0] === want[0];
  return want.every((w, i) => have[i] === w);
}

/** A bare domain from a domain or a website: "https://www.acme.example/x" is "acme.example". */
function bareDomain(value: string | null | undefined): string | null {
  const text = plainText(value)
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^www\./, '')
    .split(/[/?#]/)[0];
  return text && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(text) ? text : null;
}

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1);
}

/**
 * Addresses for one name, from the sources in order: the email the task was
 * made from, the team, portfolio contacts, the network, CRM people, then
 * senders in the mailbox; for a company, its domain. A source with more than
 * one different address for a first name is ambiguous, unless exactly one of
 * them is at the company the task is linked to ("Reply to Tom" on a Girder
 * task is the Tom at Girder); otherwise the name stays without one: a wrong
 * "Seen sent" would hide a real miss.
 */
class RecipientResolver {
  private cache = new Map<string, Promise<unknown>>();

  constructor(
    private readonly store: DataStore,
    private readonly organizationId: string,
    private readonly mailbox: string,
  ) {}

  private load<T>(key: string, run: () => Promise<T>): Promise<T> {
    if (!this.cache.has(key)) {
      this.cache.set(
        key,
        run().catch(() => [] as unknown as T),
      );
    }
    return this.cache.get(key) as Promise<T>;
  }

  private members(): Promise<{ name: string | null; email: string | null }[]> {
    return this.load('members', async () => {
      const rows = (await this.store.list('organization_members', this.organizationId, {
        eq: { organization_id: this.organizationId },
      })) as OrganizationMember[];
      return Promise.all(
        rows.map(async (row) => {
          const profile = await this.store.userProfileById(row.user_id);
          return { name: profile?.full_name ?? null, email: profile?.email ?? null };
        }),
      );
    });
  }

  private portfolioContacts(): Promise<PortfolioContact[]> {
    return this.load(
      'portfolio_contacts',
      async () =>
        (await this.store.list(
          'portfolio_contacts',
          this.organizationId,
          {},
          { limit: 1000 },
        )) as PortfolioContact[],
    );
  }

  private networkContacts(): Promise<NetworkContact[]> {
    return this.load(
      'network_contacts',
      async () =>
        (await this.store.list(
          'network_contacts',
          this.organizationId,
          {},
          { limit: 1000 },
        )) as NetworkContact[],
    );
  }

  /** The domains of the deal or portfolio company a task is linked to. */
  private linkedDomains(task: Task): Promise<string[]> {
    return this.load(
      `linked:${task.deal_id ?? ''}:${task.portfolio_company_id ?? ''}`,
      async () => {
        const domains = new Set<string>();
        if (task.deal_id) {
          const deal = (await this.store
            .get('deals', this.organizationId, task.deal_id)
            .catch(() => null)) as Deal | null;
          const domain = bareDomain(deal?.domain) ?? bareDomain(deal?.website);
          if (domain) domains.add(domain);
        }
        if (task.portfolio_company_id) {
          const company = (await this.store
            .get('portfolio_companies', this.organizationId, task.portfolio_company_id)
            .catch(() => null)) as PortfolioCompany | null;
          const domain = bareDomain(company?.domain) ?? bareDomain(company?.website);
          if (domain) domains.add(domain);
        }
        domains.delete(domainOf(this.mailbox));
        return [...domains].filter((domain) => !FREE_MAIL_DOMAINS.has(domain));
      },
    );
  }

  /**
   * The one address among `emails`, or none when there are none. Several are
   * ambiguous, unless exactly one is at the task's linked company.
   */
  private async one(
    emails: readonly (string | null | undefined)[],
    task?: Task,
  ): Promise<string[] | 'ambiguous' | null> {
    const set = [
      ...new Set(
        emails.map((e) => plainText(e)).filter((e) => e.includes('@') && e !== this.mailbox),
      ),
    ];
    if (set.length === 0) return null;
    if (set.length === 1) return set;
    if (task && (task.deal_id || task.portfolio_company_id)) {
      const domains = await this.linkedDomains(task);
      const there = set.filter((e) => domains.includes(domainOf(e)));
      if (there.length === 1) return there;
    }
    return 'ambiguous';
  }

  async resolve(name: string, task: Task): Promise<ProofRecipient> {
    const out = (emails: string[] = [], domains: string[] = []): ProofRecipient => ({
      name,
      emails,
      domains,
    });
    if (name.includes('@')) return out([plainText(name)]);

    // The email the task was made from, when its sender is the one named.
    if (task.email_message_id) {
      const message = (await this.store
        .get('email_messages', this.organizationId, task.email_message_id)
        .catch(() => null)) as EmailMessage | null;
      if (message && nameMatches(message.from_name, name)) {
        const found = await this.one([message.from_address]);
        if (Array.isArray(found)) return out(found);
      }
    }

    const people: (readonly (string | null | undefined)[])[] = [
      (await this.members()).filter((m) => nameMatches(m.name, name)).map((m) => m.email),
      (await this.portfolioContacts()).filter((c) => nameMatches(c.name, name)).map((c) => c.email),
      (await this.networkContacts())
        .filter((c) => nameMatches(c.full_name, name))
        .map((c) => c.email),
    ];
    for (const emails of people) {
      const found = await this.one(emails, task);
      if (found === 'ambiguous') return out();
      if (found) return out(found);
    }

    if (words(name).length >= 2) {
      const crm = (await this.load(`crm:${plainText(name)}`, async () =>
        this.store.list(
          'crm_records',
          this.organizationId,
          { eq: { kind: 'person', name_key: plainText(name) } },
          { limit: 5 },
        ),
      )) as CrmRecord[];
      const found = await this.one(
        crm.flatMap((r) => [r.primary_email, ...(r.emails ?? [])]),
        task,
      );
      if (found === 'ambiguous') return out();
      if (found) return out(found);
    }

    // Someone who has written in under that name.
    const senders = (await this.load(`from:${plainText(name)}`, async () =>
      this.store.list(
        'email_messages',
        this.organizationId,
        { textSearch: { columns: ['from_name'], query: name, mode: 'prefix' } },
        { orderBy: [{ field: 'sent_at', direction: 'desc' }], limit: 50 },
      ),
    )) as EmailMessage[];
    const wrote = await this.one(
      senders
        .filter((m) => !(m.labels ?? []).includes('SENT') && nameMatches(m.from_name, name))
        .map((m) => m.from_address),
      task,
    );
    if (wrote === 'ambiguous') return out();
    if (wrote) return out(wrote);

    // A company: its domain, and a portfolio company's own contacts.
    return out([], await this.companyDomains(name, task));
  }

  private async companyDomains(name: string, task: Task): Promise<string[]> {
    const key = plainText(name);
    const domains = new Set<string>();
    const deals = (await this.load(`deals:${key}`, async () =>
      this.store.list(
        'deals',
        this.organizationId,
        { textSearch: { columns: ['company_name'], query: name } },
        { limit: 10 },
      ),
    )) as Deal[];
    for (const deal of deals) {
      if (plainText(deal.company_name) !== key) continue;
      const domain = bareDomain(deal.domain) ?? bareDomain(deal.website);
      if (domain) domains.add(domain);
    }
    const portfolio = (await this.load(`portfolio:${key}`, async () =>
      this.store.list(
        'portfolio_companies',
        this.organizationId,
        { textSearch: { columns: ['name'], query: name } },
        { limit: 10 },
      ),
    )) as PortfolioCompany[];
    for (const company of portfolio) {
      if (plainText(company.name) !== key) continue;
      const domain = bareDomain(company.domain) ?? bareDomain(company.website);
      if (domain) domains.add(domain);
      for (const contact of await this.portfolioContacts()) {
        if (contact.portfolio_company_id === company.id && contact.email) {
          domains.add(domainOf(plainText(contact.email)));
        }
      }
    }
    // The company the task is linked to, by the same name.
    if (domains.size === 0 && (task.deal_id || task.portfolio_company_id)) {
      const linked = task.deal_id
        ? ((await this.store
            .get('deals', this.organizationId, task.deal_id)
            .catch(() => null)) as Deal | null)
        : null;
      if (linked && nameMatches(linked.company_name, name)) {
        const domain = bareDomain(linked.domain) ?? bareDomain(linked.website);
        if (domain) domains.add(domain);
      }
    }
    domains.delete(domainOf(this.mailbox));
    // A company is never "anyone at gmail.com".
    return [...domains].filter((domain) => !FREE_MAIL_DOMAINS.has(domain));
  }
}

/** Senders nobody answers by email: calendar invites, notifications, no-reply robots. */
const NO_REPLY_SENDER =
  /^(?:no-?reply|do-?not-?reply|notifications?|calendar-notification|mailer-daemon|postmaster)[^@]*@/;

/** Mail providers whose domain says nothing about a company. */
const FREE_MAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
]);

/** Who a ticked task's deliverable should reach, with their addresses where they can be found. */
export async function resolveProofRecipients(
  store: DataStore,
  organizationId: string,
  task: Task,
  expectation: ProofExpectation,
  mailbox: string,
  resolver = new RecipientResolver(store, organizationId, mailbox),
): Promise<ProofRecipient[]> {
  if (expectation.recipients.length === 0) {
    // A reply addressed only by the email it was made from.
    if (!expectation.emailMessageId) return [];
    const message = (await store
      .get('email_messages', organizationId, expectation.emailMessageId)
      .catch(() => null)) as EmailMessage | null;
    const from = plainText(message?.from_address);
    // A reply to the mailbox's own message, or to a robot, is owed to no one.
    if (!message || !from || from === mailbox || NO_REPLY_SENDER.test(from)) return [];
    return [{ name: message.from_name?.trim() || from, emails: [from], domains: [] }];
  }
  return Promise.all(expectation.recipients.map((name) => resolver.resolve(name, task)));
}

/**
 * The first sent message that delivers this deliverable: a real send from the
 * mailbox after the task was created, to a recipient. An intro needs one
 * message to every party it found an address for, with at least two people
 * on it besides the mailbox.
 */
export function findProofMessage(
  sent: readonly EmailMessage[],
  recipients: readonly ProofRecipient[],
  kind: DeliverableKind,
  mailbox: string,
  afterMs: number,
  used: readonly string[] = [],
): EmailMessage | null {
  const addressed = recipients.filter((r) => r.emails.length > 0 || r.domains.length > 0);
  if (addressed.length === 0) return null;
  const reaches = (to: readonly string[], r: ProofRecipient) =>
    to.some((address) => r.emails.includes(address) || r.domains.includes(domainOf(address)));
  const ordered = [...sent].sort((a, b) => Date.parse(a.sent_at) - Date.parse(b.sent_at));
  // A reply is judged as the "Reply to" check judges one; an intro may loop someone in.
  const reading = kind === 'reply' ? 'reply' : kind === 'intro' ? 'intro' : 'send';
  for (const message of ordered) {
    if (used.includes(message.provider_message_id)) continue;
    if (!isRealSend(message, mailbox, afterMs, reading)) continue;
    const to = messageRecipients(message).filter((address) => address !== mailbox);
    if (kind === 'intro') {
      if (to.length >= 2 && addressed.every((r) => reaches(to, r))) return message;
    } else if (addressed.some((r) => reaches(to, r))) {
      return message;
    }
  }
  return null;
}

/* ---------------------------------------------------------------- the check */

export type ProofCheckState = 'idle' | 'no_mailbox' | 'ran';

export interface ProofCheckOutcome {
  state: ProofCheckState;
  checked: number;
  seen: number;
  flagged: number;
}

async function connectedMailbox(
  store: DataStore,
  organizationId: string,
): Promise<{ mailbox: string; ownerId: string | null; syncedThrough: number } | null> {
  const rows = (await store.list(
    'integrations',
    organizationId,
    { eq: { provider: 'google' } },
    { orderBy: [{ field: 'created_at', direction: 'desc' }], limit: 1 },
  )) as Integration[];
  const row = rows[0];
  if (!row?.account_email) return null;
  // Mail is only known missing up to the last good sync of a working connection.
  const synced =
    row.status === 'connected' && row.last_sync_at ? Date.parse(row.last_sync_at) : NaN;
  return {
    mailbox: plainText(row.account_email),
    ownerId: row.user_id ?? null,
    syncedThrough: Number.isNaN(synced) ? Number.NEGATIVE_INFINITY : synced,
  };
}

/** Sent mail to these addresses since `afterMs`, To or Cc: the one task's own look, past the scan's reach. */
async function sentTo(
  store: DataStore,
  organizationId: string,
  mailbox: string,
  emails: readonly string[],
  afterMs: number,
): Promise<EmailMessage[]> {
  if (emails.length === 0) return [];
  const since = Number.isFinite(afterMs) ? new Date(afterMs).toISOString() : null;
  const out = new Map<string, EmailMessage>();
  for (const column of ['to_addresses', 'cc_addresses']) {
    const rows = (await store.list(
      'email_messages',
      organizationId,
      {
        eq: { from_address: mailbox },
        arrayContains: { labels: 'SENT' },
        arrayOverlaps: { [column]: [...emails].slice(0, 20) },
        ...(since ? { gt: { sent_at: since } } : {}),
      },
      { orderBy: [{ field: 'sent_at', direction: 'asc' }], limit: 50 },
    )) as EmailMessage[];
    for (const row of rows) out.set(row.id, row);
  }
  return [...out.values()];
}

/**
 * The app's own look for ticked deliverables, in the synced mailbox: a sent
 * email to the recipient after the task was created marks it seen; past its
 * window with none, it is flagged "Ticked, not seen sent", once. With no
 * mailbox connected there is nothing to look in, so nothing is judged; with
 * one that is broken or has not synced since the window ended, a missing
 * email may only be unsynced, so the judging waits. Runs from the Tasks pull
 * (see task-relay.ts), after the task-closer's own proofs.
 */
export async function runProofCheck(
  store: DataStore,
  organizationId: string,
  opts: { now?: Date; scanLimit?: number } = {},
): Promise<ProofCheckOutcome> {
  const now = opts.now ?? new Date();
  const outcome = (state: ProofCheckState, checked = 0, seen = 0, flagged = 0) => ({
    state,
    checked,
    seen,
    flagged,
  });
  const awaiting = await listAwaitingProof(store, organizationId, now);
  if (awaiting.length === 0) return outcome('idle');
  const connection = await connectedMailbox(store, organizationId);
  if (!connection) return outcome('no_mailbox', awaiting.length);
  const { mailbox, ownerId, syncedThrough } = connection;

  const oldest = Math.min(
    ...awaiting.map(({ task }) => {
      const ms = Date.parse(task.created_at);
      return Number.isNaN(ms) ? now.getTime() : ms;
    }),
  );
  const sent = (await store.list(
    'email_messages',
    organizationId,
    {
      eq: { from_address: mailbox },
      arrayContains: { labels: 'SENT' },
      gt: { sent_at: new Date(oldest).toISOString() },
    },
    {
      orderBy: [{ field: 'sent_at', direction: 'desc' }],
      limit: opts.scanLimit ?? SENT_SCAN_LIMIT,
    },
  )) as EmailMessage[];

  const resolver = new RecipientResolver(store, organizationId, mailbox);
  let seen = 0;
  let flagged = 0;
  for (const { task, check } of awaiting) {
    const recipients = await resolveProofRecipients(
      store,
      organizationId,
      task,
      check.expectation,
      mailbox,
      resolver,
    );
    const created = Date.parse(task.created_at);
    const afterMs = Number.isNaN(created) ? Number.NEGATIVE_INFINITY : created;
    const judgeAfter = Date.parse(check.expectation.judgeAfter);
    const due =
      check.state === 'waiting' && !Number.isNaN(judgeAfter) && now.getTime() >= judgeAfter;
    // Only the mailbox's owner's deliverables are judged from it: a task
    // someone else does (theirs, or one they ticked unassigned) goes out from
    // their own mailbox, which the app cannot see.
    const responsible = task.assigned_to ?? check.expectation.tickedBy;
    const judgeable =
      due &&
      // A reply whose email came from the mailbox itself is owed to no one.
      recipients.length > 0 &&
      // Until the mailbox has synced past the window, a missing email may only be unsynced.
      syncedThrough >= judgeAfter &&
      !(ownerId && responsible && responsible !== ownerId);
    const find = (messages: readonly EmailMessage[]) =>
      findProofMessage(
        messages,
        recipients,
        check.expectation.kind,
        mailbox,
        afterMs,
        check.usedEvidence,
      );
    let message = find(sent);
    if (!message && judgeable) {
      // About to say nothing went out: look for this task's own recipients
      // too, since the scan above reads only the newest sent mail.
      const emails = recipients.flatMap((r) => r.emails);
      message = find(await sentTo(store, organizationId, mailbox, emails, afterMs));
    }
    if (message) {
      const applied = await applyProofEvidence(
        store,
        organizationId,
        task,
        {
          source: 'app-sent-check',
          evidence_type: 'gmail_sent',
          evidence_id: message.provider_message_id,
          evidence_at: message.sent_at,
        },
        check,
      );
      if (applied === 'seen') seen++;
      continue;
    }
    if (!judgeable) continue;
    await recordAudit(store, {
      organizationId,
      userId: null,
      action: PROOF_MISSING_ACTION,
      entityType: 'task',
      entityId: task.id,
      metadata: {
        v: 1,
        expected_id: check.expectation.auditId,
        judged_at: now.toISOString(),
        addressed: recipients.some((r) => r.emails.length > 0 || r.domains.length > 0),
        // Who it should have reached, by name, as the flag says it.
        to: recipients.map((r) => r.name).slice(0, 3),
      },
    });
    flagged++;
  }
  if (seen > 0 || flagged > 0) {
    log.info('Proof check ran', { checked: awaiting.length, seen, flagged });
  }
  return outcome('ran', awaiting.length, seen, flagged);
}

/* -------------------------------------------------------------- the person */

/**
 * "It's done": the person says the deliverable went out, so the flag goes
 * for good. Also works while the task is still waiting, which ends the
 * check early. The task stays completed.
 */
export async function confirmTaskProof(auth: AuthContext, taskId: string): Promise<Result<Task>> {
  const store = getStore();
  const task = (await store.get('tasks', auth.organizationId, taskId)) as Task | null;
  if (!task || task.status === 'cancelled') return err('not_found', 'That task does not exist.');
  if (task.status !== 'complete') return err('conflict', 'That task is open again.');
  const check = (await readProofChecks(store, auth.organizationId, [task])).get(task.id);
  if (!check || !isOutstanding(check)) return ok(task);
  await recordAudit(store, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    action: PROOF_CONFIRMED_ACTION,
    entityType: 'task',
    entityId: task.id,
    metadata: { v: 1, expected_id: check.expectation.auditId },
  });
  return ok(task);
}
