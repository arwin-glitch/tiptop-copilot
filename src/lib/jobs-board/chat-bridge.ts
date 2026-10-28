import 'server-only';
import { env, jobsChatRelayProblem } from '@/lib/config/env';
import { isMissingTableError } from '@/lib/db/missing-table';
import type { DataStore, Filter } from '@/lib/db/store';
import { plainLine, sanitiseBookingAnswer } from '@/lib/booking/chat-bridge';
import { FAQ_LIMITS, type FaqItem } from '@/lib/booking/chatbot-config';
import { rateLimit, rateLimitHasRoom } from '@/lib/security/limits';
import { log } from '@/lib/security/redact';
import { fireRoutineWithText, readRelayChannel } from '@/lib/services/ask-routine';
import type { JobsChatQuestion } from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';
import { processWide } from '@/lib/util/process-state';
import { unwrapSlackText } from '@/lib/util/slack-text';
import type { JobsAssistantConfig } from './assistant-config';
import {
  EMPLOYMENT_TYPE_LABELS,
  JOB_FUNCTION_LABELS,
  JOB_REMOTE_LABELS,
  SENIORITY_LABELS,
} from './fields';
import type { PublicCompany, PublicJob } from './public';

/**
 * "Ask Arwin" on the public job board, its optional AI answers, on Arwin's
 * own Claude plan: no API key, no model call from this app, nothing billed.
 * The same plumbing as the booking page assistant (lib/booking/chat-bridge.ts,
 * whose text helpers and answer sanitiser this reuses as they are, so the
 * booking assistant's behaviour is untouched), with its own markers, table,
 * routine and relay settings.
 *
 * A question neither the board's data nor the written answers can answer is
 * kept in `jobs_chat_questions` and sent to the jobs assistant routine (a
 * Claude Code routine with no data connectors, docs/JOBS_CHAT_ROUTINE.md)
 * through its API trigger, as `JOBS_QUESTION_V1` and one backticked JSON
 * object: the question and the board's public facts, nothing else (no
 * candidate, no note, no source email, no unpublished role). The routine
 * posts `JOBS_ANSWER_V1` and `{question_id, answer}` to its Slack relay;
 * while the visitor's widget waits, the app reads that channel, takes only
 * posts from the configured posters, matches the question id, and makes the
 * answer plain before anyone sees it.
 *
 * Off unless JOBS_CHAT_FIRE_URL, JOBS_CHAT_TOKEN and the relay's read token
 * are set, the relay is safe (jobsChatRelayProblem), and Portfolio > Jobs
 * turns AI answers on. Capped three ways: 3 per visitor session (in memory),
 * 5 per visitor address a day and the daily total (both counted from the
 * table, so they hold across restarts). Past any cap, or with the table
 * missing, the assistant says it has no answer.
 */

export const JOBS_QUESTION_MARKER = 'JOBS_QUESTION_V1';
export const JOBS_ANSWER_MARKER = 'JOBS_ANSWER_V1';

export const JOBS_QUESTION_MAX_CHARS = 300;
export const JOBS_ANSWER_MAX_CHARS = 600;
/** How long the widget waits for an answer before giving up. */
export const JOBS_ANSWER_WAIT_MS = 3 * 60_000;
/** A question still waiting this long is expired (a little past the widget's wait). */
export const JOBS_EXPIRE_AFTER_MS = 5 * 60_000;

export const JOBS_PER_SESSION = 3;
export const JOBS_PER_ADDRESS_PER_DAY = 5;
const SESSION_WINDOW_MS = 12 * 3_600_000;
const DAY_MS = 86_400_000;
const MIN_SLACK_CHECK_INTERVAL_MS = 3_000;
const TABLE = 'jobs_chat_questions';

const FACT_LIMITS = { companies: 20, roles: 8, text: 160 } as const;

/* ------------------------------------------------------------------ setup */

/** The routine can be fired and its answer read back, through a safe relay. */
export function jobsChatConfigured(e = env()): boolean {
  return (
    Boolean(e.jobsChatFireUrl && e.jobsChatToken && e.askRelaySlackToken) &&
    jobsChatRelayProblem(e) === null
  );
}

/* ---------------------------------------------------------------- payload */

export interface JobsFactRole {
  title: string;
  company: string;
  team: string | null;
  role_family: string | null;
  places: string[];
  work_setup: string | null;
  type: string | null;
  level: string | null;
  /** Pay only when the role itself publishes it. */
  pay: string | null;
  url: string;
}

/** What the routine is told about the board: public facts only, by name. */
export interface JobsQuestionFacts {
  board_url: string;
  open_roles: number;
  companies_hiring: { name: string; open_roles: number }[];
  /** A few published roles that look related to the question (or the newest). */
  matching_roles: JobsFactRole[];
  faq: FaqItem[];
}

export interface JobsQuestionPayload {
  question_id: string;
  question: string;
  facts: JobsQuestionFacts;
}

/** A visitor's question as it may be sent: at most 300 characters of plain text. */
export function cleanJobsQuestion(text: unknown): string {
  return plainLine(text, JOBS_QUESTION_MAX_CHARS);
}

export interface JobsFactsInput {
  boardUrl: string;
  jobs: readonly PublicJob[];
  companies: readonly PublicCompany[];
  /** Roles picked for this question (already public); the newest when empty. */
  related: readonly PublicJob[];
  faqItems: readonly FaqItem[];
  /** A role's absolute address on the board. */
  roleUrl: (job: PublicJob) => string;
}

function factRole(job: PublicJob, roleUrl: (job: PublicJob) => string): JobsFactRole {
  return {
    title: plainLine(job.title, FACT_LIMITS.text),
    company: plainLine(job.companyName, 80),
    team: job.team ? plainLine(job.team, 80) : null,
    role_family: job.fn !== 'other' ? JOB_FUNCTION_LABELS[job.fn] : null,
    places: job.locations.slice(0, 5).map((p) => plainLine(p, 80)),
    work_setup: job.remote ? JOB_REMOTE_LABELS[job.remote] : null,
    type: job.employmentType ? EMPLOYMENT_TYPE_LABELS[job.employmentType] : null,
    level: job.seniority ? SENIORITY_LABELS[job.seniority] : null,
    pay: job.comp ? plainLine(job.comp, 80) : null,
    url: plainLine(roleUrl(job), 300),
  };
}

/**
 * The facts block, built from named public fields of public roles only.
 * Nothing else can reach it: no description, no apply form, no email, no
 * note, no id other than the question's own.
 */
export function buildJobsQuestionFacts(input: JobsFactsInput): JobsQuestionFacts {
  const counts = new Map<string, number>();
  for (const job of input.jobs) counts.set(job.companySlug, (counts.get(job.companySlug) ?? 0) + 1);
  const related = input.related.length > 0 ? input.related : input.jobs;
  return {
    board_url: plainLine(input.boardUrl, 200),
    open_roles: input.jobs.length,
    companies_hiring: input.companies
      .filter((c) => (counts.get(c.slug) ?? 0) > 0)
      .sort((a, b) => counts.get(b.slug)! - counts.get(a.slug)! || a.name.localeCompare(b.name))
      .slice(0, FACT_LIMITS.companies)
      .map((c) => ({ name: plainLine(c.name, 80), open_roles: counts.get(c.slug) ?? 0 })),
    matching_roles: related.slice(0, FACT_LIMITS.roles).map((job) => factRole(job, input.roleUrl)),
    faq: input.faqItems.slice(0, FAQ_LIMITS.items).map((item) => ({
      q: plainLine(item.q, FAQ_LIMITS.question),
      a: plainLine(item.a, FAQ_LIMITS.answer),
    })),
  };
}

/** What the routine is fired with: the marker line, then the payload as one backticked JSON object. */
export function jobsQuestionText(payload: JobsQuestionPayload): string {
  return [
    JOBS_QUESTION_MARKER,
    `\`${JSON.stringify({
      question_id: payload.question_id,
      question: cleanJobsQuestion(payload.question),
      facts: payload.facts,
    })}\``,
  ].join('\n');
}

/* ----------------------------------------------------------------- answer */

export interface RelayedJobsAnswer {
  question_id: string;
  answer: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One relay message's text → the jobs answer it carries, or null. */
export function parseJobsAnswer(rawText: unknown): RelayedJobsAnswer | null {
  if (typeof rawText !== 'string') return null;
  const text = unwrapSlackText(rawText, { preferLabel: true }).trim();
  if (!text.startsWith(JOBS_ANSWER_MARKER)) return null;
  const first = text.indexOf('`');
  const last = text.lastIndexOf('`');
  if (first < 0 || last <= first) return null;
  try {
    const payload = JSON.parse(text.slice(first + 1, last)) as Partial<RelayedJobsAnswer>;
    if (
      typeof payload.question_id !== 'string' ||
      !UUID.test(payload.question_id) ||
      typeof payload.answer !== 'string' ||
      !payload.answer.trim()
    ) {
      return null;
    }
    return {
      question_id: payload.question_id.toLowerCase(),
      answer: payload.answer.slice(0, 4000),
    };
  } catch {
    log.warn('Jobs answer in the relay channel is not valid JSON', { length: text.length });
    return null;
  }
}

/**
 * The routine's answer made safe to show a visitor, by the booking
 * assistant's rules: plain text, no link except the board's own, no email
 * address or phone number, no sentence promising that a person will
 * confirm, review or get back to them, at most 600 characters. Null when
 * nothing worth showing is left.
 */
export function sanitiseJobsAnswer(raw: unknown, options: { boardUrl: string }): string | null {
  return sanitiseBookingAnswer(raw, { bookingUrl: options.boardUrl });
}

/* ------------------------------------------------------------------- asks */

export type JobsAskUnavailable =
  'off' | 'not_set_up' | 'session_cap' | 'address_cap' | 'daily_cap' | 'no_table' | 'fire_failed';

export type JobsAskOutcome =
  { kind: 'pending'; id: string } | { kind: 'unavailable'; reason: JobsAskUnavailable };

/** Questions are counted and kept one at a time per organization, so the caps cannot be raced. */
const askLocks = processWide('jobs-chat-ask-locks', () => new Map<string, Promise<void>>());

async function oneAtATime<T>(organizationId: string, work: () => Promise<T>): Promise<T> {
  const before = askLocks.get(organizationId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = before.then(() => mine);
  askLocks.set(organizationId, tail);
  await before;
  try {
    return await work();
  } finally {
    release();
    if (askLocks.get(organizationId) === tail) askLocks.delete(organizationId);
  }
}

export interface JobsAskInput {
  organizationId: string;
  assistant: Pick<JobsAssistantConfig, 'aiAnswers' | 'dailyAiCap'>;
  question: string;
  /** The widget's own random id for this visit, for the per-session cap. */
  sessionId: string;
  /** A keyed hash of the visitor's address (lib/security/crypto hashIp). */
  ipHash: string | null;
  facts: JobsQuestionFacts;
  now?: Date;
  fetchImpl?: typeof fetch;
}

/**
 * Send one question to the jobs assistant routine, within every cap.
 * Pending with the question's id when it went; otherwise why not.
 */
export async function askJobsRoutine(
  store: DataStore,
  input: JobsAskInput,
): Promise<JobsAskOutcome> {
  const unavailable = (reason: JobsAskUnavailable): JobsAskOutcome => ({
    kind: 'unavailable',
    reason,
  });
  if (!input.assistant.aiAnswers) return unavailable('off');
  const e = env();
  if (!jobsChatConfigured(e) || !e.jobsChatFireUrl || !e.jobsChatToken) {
    return unavailable('not_set_up');
  }
  if (input.assistant.dailyAiCap <= 0) return unavailable('daily_cap');
  const question = cleanJobsQuestion(input.question);
  if (!question) return unavailable('off');
  const sessionKey = `jobs-ai-session:${input.sessionId}`;
  if (!rateLimitHasRoom(sessionKey, JOBS_PER_SESSION)) return unavailable('session_cap');
  const now = input.now ?? new Date();
  const dayAgo = new Date(now.getTime() - DAY_MS).toISOString();

  const kept = await oneAtATime(input.organizationId, async () => {
    try {
      const byAddress: Filter = input.ipHash
        ? { eq: { ip_hash: input.ipHash }, gte: { created_at: dayAgo } }
        : { isNull: ['ip_hash'], gte: { created_at: dayAgo } };
      const [fromAddress, today] = await Promise.all([
        store.count(TABLE, input.organizationId, byAddress),
        store.count(TABLE, input.organizationId, { gte: { created_at: dayAgo } }),
      ]);
      if (fromAddress >= JOBS_PER_ADDRESS_PER_DAY) return unavailable('address_cap');
      if (today >= input.assistant.dailyAiCap) return unavailable('daily_cap');
      const row: JobsChatQuestion = {
        id: newId(),
        organization_id: input.organizationId,
        question,
        answer: null,
        status: 'pending',
        ip_hash: input.ipHash,
        created_at: now.toISOString(),
        answered_at: null,
      };
      await store.insert(TABLE, row);
      return row;
    } catch (error) {
      if (!isMissingTableError(error)) {
        log.warn('Jobs question could not be kept', {
          reason: error instanceof Error ? error.message : 'unknown',
        });
      }
      return unavailable('no_table');
    }
  });
  if ('kind' in kept) return kept;

  rateLimit(sessionKey, JOBS_PER_SESSION, SESSION_WINDOW_MS);
  const fired = await fireRoutineWithText(
    { url: e.jobsChatFireUrl, token: e.jobsChatToken },
    jobsQuestionText({ question_id: kept.id, question, facts: input.facts }),
    input.fetchImpl,
    'Jobs assistant routine',
  );
  if (!fired) {
    await store
      .updateWhere(
        TABLE,
        input.organizationId,
        { eq: { id: kept.id, status: 'pending' } },
        {
          status: 'expired',
        },
      )
      .catch(() => []);
    return unavailable('fire_failed');
  }
  return { kind: 'pending', id: kept.id };
}

/* ----------------------------------------------------------------- settle */

const settleState = processWide('jobs-chat-settle', () => ({
  lastSlackCheck: 0,
  inFlight: null as Promise<number> | null,
}));

/** Test hook: the throttle is process-wide. */
export function resetJobsSettleThrottle(): void {
  settleState.lastSlackCheck = 0;
  settleState.inFlight = null;
}

/** Visitors' questions (and their answers) are kept this long, then deleted. */
export const JOBS_QUESTION_RETENTION_DAYS = 30;

/** Delete questions older than the retention window. Run by the alerts job; never throws. */
export async function pruneJobsQuestions(
  store: DataStore,
  organizationId: string,
  now: Date = new Date(),
): Promise<number> {
  try {
    return await store.removeWhere(TABLE, organizationId, {
      lt: {
        created_at: new Date(now.getTime() - JOBS_QUESTION_RETENTION_DAYS * DAY_MS).toISOString(),
      },
    });
  } catch (error) {
    if (!isMissingTableError(error)) {
      log.warn('Old jobs questions could not be deleted', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
    }
    return 0;
  }
}

/** The alerts job's pass over every organization: never throws. */
export async function pruneJobsQuestionsForAll(
  store: DataStore,
  now: Date = new Date(),
): Promise<number> {
  const organizations = (await store.list('organizations', '', {}).catch(() => [])) as {
    id: string;
  }[];
  let removed = 0;
  for (const org of organizations) removed += await pruneJobsQuestions(store, org.id, now);
  return removed;
}

/**
 * If a question is waiting, read the relay channel and complete every one
 * whose answer is there, from the configured posters only, made plain
 * first. Returns how many were settled. Throttled: the widget polls.
 */
export async function settleJobsAnswers(
  store: DataStore,
  organizationId: string,
  options: { boardUrl: string; now?: Date; fetchImpl?: typeof fetch },
): Promise<number> {
  const e = env();
  if (!e.askRelaySlackToken) return 0;
  if (settleState.inFlight) return settleState.inFlight;
  if (Date.now() - settleState.lastSlackCheck < MIN_SLACK_CHECK_INTERVAL_MS) return 0;
  const now = options.now ?? new Date();
  settleState.inFlight = (async () => {
    try {
      await store.updateWhere(
        TABLE,
        organizationId,
        {
          eq: { status: 'pending' },
          lt: { created_at: new Date(now.getTime() - JOBS_EXPIRE_AFTER_MS).toISOString() },
        },
        { status: 'expired' },
      );
      const pending = await store.list(TABLE, organizationId, { eq: { status: 'pending' } });
      if (pending.length === 0) return 0;
      if (jobsChatRelayProblem(e) !== null || !e.jobsChatRelayChannelId) return 0;
      const messages = await readRelayChannel(e.jobsChatRelayChannelId, options.fetchImpl);
      if (!messages) return 0;
      const posters = e.jobsChatPosterIds;
      const waiting = new Set(pending.map((p) => p.id.toLowerCase()));
      let settled = 0;
      for (const message of messages) {
        if (message.subtype !== undefined && message.subtype !== null) continue;
        if (!(typeof message.user === 'string' && posters.includes(message.user))) continue;
        const relayed = parseJobsAnswer(message.text);
        if (!relayed || !waiting.has(relayed.question_id)) continue;
        const answer = sanitiseJobsAnswer(relayed.answer, { boardUrl: options.boardUrl });
        const id = pending.find((p) => p.id.toLowerCase() === relayed.question_id)!.id;
        const changed = await store.updateWhere(
          TABLE,
          organizationId,
          { eq: { id, status: 'pending' } },
          answer
            ? { status: 'answered', answer, answered_at: now.toISOString() }
            : { status: 'expired', answered_at: now.toISOString() },
        );
        waiting.delete(relayed.question_id);
        if (changed.length > 0) settled++;
      }
      return settled;
    } catch (error) {
      if (!isMissingTableError(error)) {
        log.warn('Settling jobs answers from Slack failed', {
          reason: error instanceof Error ? error.message : 'unknown',
        });
      }
      return 0;
    } finally {
      settleState.lastSlackCheck = Date.now();
      settleState.inFlight = null;
    }
  })();
  return settleState.inFlight;
}

export interface JobsAnswerView {
  status: JobsChatQuestion['status'];
  answer: string | null;
}

/**
 * Where one question stands, for the widget's poll: settles from the relay
 * first (throttled) while it waits, and expires it once it has waited too
 * long. Null for an id that is not a question here.
 */
export async function readJobsAnswer(
  store: DataStore,
  organizationId: string,
  id: string,
  options: { boardUrl: string; now?: Date; fetchImpl?: typeof fetch },
): Promise<JobsAnswerView | null> {
  if (!UUID.test(id)) return null;
  const now = options.now ?? new Date();
  const read = async () => {
    try {
      return await store.get(TABLE, organizationId, id);
    } catch (error) {
      if (isMissingTableError(error)) return null;
      throw error;
    }
  };
  let row = await read();
  if (!row) return null;
  if (row.status === 'pending') {
    if (now.getTime() - Date.parse(row.created_at) > JOBS_EXPIRE_AFTER_MS) {
      await store
        .updateWhere(
          TABLE,
          organizationId,
          { eq: { id: row.id, status: 'pending' } },
          {
            status: 'expired',
          },
        )
        .catch(() => []);
      return { status: 'expired', answer: null };
    }
    await settleJobsAnswers(store, organizationId, options);
    row = (await read()) ?? row;
  }
  return { status: row.status, answer: row.status === 'answered' ? row.answer : null };
}

/* ----------------------------------------------------------------- status */

export interface JobsChatStatus {
  /** The routine's trigger and the relay's read token are set, and the relay is safe. */
  configured: boolean;
  /** The questions table exists. */
  tableReady: boolean;
  lastAnswerAt: string | null;
  askedToday: number;
  answeredToday: number;
}

/** For the settings panel: set up or not, and when it last answered. */
export async function jobsChatStatus(
  store: DataStore,
  organizationId: string,
  now: Date = new Date(),
): Promise<JobsChatStatus> {
  const configured = jobsChatConfigured();
  const dayAgo = new Date(now.getTime() - DAY_MS).toISOString();
  try {
    const [last, askedToday, answeredToday] = await Promise.all([
      store.list(
        TABLE,
        organizationId,
        { eq: { status: 'answered' } },
        { orderBy: [{ field: 'answered_at', direction: 'desc' }], limit: 1 },
      ),
      store.count(TABLE, organizationId, { gte: { created_at: dayAgo } }),
      store.count(TABLE, organizationId, {
        eq: { status: 'answered' },
        gte: { created_at: dayAgo },
      }),
    ]);
    return {
      configured,
      tableReady: true,
      lastAnswerAt: last[0]?.answered_at ?? null,
      askedToday,
      answeredToday,
    };
  } catch (error) {
    if (!isMissingTableError(error)) {
      log.warn('Jobs assistant status could not be read', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
    }
    return { configured, tableReady: false, lastAnswerAt: null, askedToday: 0, answeredToday: 0 };
  }
}
