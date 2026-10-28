import 'server-only';
import { unstable_cache } from 'next/cache';
import { z } from 'zod';
import { faqEntries, matchFaq } from '@/lib/booking/faq';
import { isMissingColumnError, isMissingTableError } from '@/lib/db/missing-table';
import type { DataStore } from '@/lib/db/store';
import { soleOrganizationId } from '@/lib/db/tenancy';
import {
  answerFromBoard,
  NO_ANSWER,
  isGeneralQuestion,
  relatedJobs,
  type AssistantLink,
} from '@/lib/jobs-board/assistant';
import {
  JOBS_ASSISTANT_PATCH,
  JOBS_ASSISTANT_SCHEMA,
  readJobsAssistantConfig,
  type JobsAssistantConfig,
} from '@/lib/jobs-board/assistant-config';
import {
  askJobsRoutine,
  buildJobsQuestionFacts,
  cleanJobsQuestion,
  jobsChatConfigured,
  jobsChatStatus,
  readJobsAnswer,
  type JobsAnswerView,
  type JobsChatStatus,
} from '@/lib/jobs-board/chat-bridge';
import { canonicalBoardUrl } from '@/lib/jobs-board/config';
import {
  DEFAULT_BOARD_ACCENT,
  DEFAULT_BOARD_TITLE,
  type PublicBoard,
} from '@/lib/jobs-board/public';
import { getStore } from '@/lib/runtime';
import { recordAudit } from '@/lib/security/audit';
import { log } from '@/lib/security/redact';
import type { JobBoardSettings } from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';
import { err, ok, type Result } from '@/lib/util/result';
import { JOBS_BOARD_CACHE_TAG, readPublicBoardCached, type JobsActor } from './jobs-board';

/**
 * "Ask Arwin" on the public job board: one visitor question in, one answer
 * out, in three tiers, cheapest first:
 *
 *   1. the board's own data (lib/jobs-board/assistant.ts): companies, teams,
 *      places, setups, levels, counts, how to apply, and who it is. No AI.
 *   2. the written answers from Portfolio > Jobs > Ask Arwin, matched the way
 *      the booking assistant matches its own (lib/booking/faq.ts). No AI.
 *   3. optionally, the jobs assistant routine on Arwin's own Claude plan
 *      (lib/jobs-board/chat-bridge.ts): no API key, capped, off by default.
 *
 * Only the public board (the same cached read the public pages use, so the
 * same gate: never a draft, never a hidden role) and the assistant's own
 * settings are read. The visitor's words are data: they pick roles and match
 * answers, and are never rendered as HTML anywhere.
 */

export const JOBS_CHAT_MIGRATION = 'supabase/migrations/20261028110000_jobs_chat.sql';

export const JOBS_CHAT_REQUEST = z
  .object({
    question: z.string().trim().min(1).max(600),
    /** The widget's own random id for this visit (the per-session AI cap). */
    sessionId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  })
  .strict();
export type JobsChatRequest = z.infer<typeof JOBS_CHAT_REQUEST>;

export type JobsChatReply =
  | {
      kind: 'answer';
      /** Where the answer came from: the board's data or a written answer. */
      source: 'board' | 'written';
      text: string;
      links: AssistantLink[];
      seeAll: AssistantLink | null;
      suggestions: string[];
    }
  | { kind: 'pending'; questionId: string; text: string; suggestions: string[] }
  | { kind: 'none'; text: string; suggestions: string[] };

export const PENDING_TEXT = 'Let me look into that. It can take a minute or two.';

/* ------------------------------------------------------------- settings -- */

interface StoredSettings {
  row: JobBoardSettings | null;
  config: JobsAssistantConfig;
}

async function readStored(store: DataStore, organizationId: string): Promise<StoredSettings> {
  try {
    const row = await store.findOne('job_board_settings', organizationId, {});
    return {
      row,
      config: readJobsAssistantConfig(row?.assistant),
    };
  } catch (error) {
    if (!isMissingTableError(error) && !isMissingColumnError(error)) {
      log.warn('Reading the job board assistant settings failed', {
        reason: (error as Error)?.message?.slice(0, 160),
      });
    }
    return { row: null, config: readJobsAssistantConfig(null) };
  }
}

/** The assistant's settings for this organization (defaults when nothing is saved). Never throws. */
export async function readJobsAssistant(
  store: DataStore,
  organizationId: string,
): Promise<JobsAssistantConfig> {
  return (await readStored(store, organizationId)).config;
}

class AssistantUnreadable extends Error {}

const cachedAssistant = unstable_cache(
  async (): Promise<JobsAssistantConfig> => {
    const organizationId = await soleOrganizationId('jobs-board');
    if (!organizationId) throw new AssistantUnreadable();
    return readJobsAssistant(getStore(), organizationId);
  },
  ['jobs-board-assistant-v1'],
  { tags: [JOBS_BOARD_CACHE_TAG], revalidate: 600 },
);

/**
 * The assistant's settings for the public pages, through the board's cache
 * (dropped with it the moment Kraken changes anything). Off when unreadable.
 */
export async function readJobsAssistantCached(): Promise<JobsAssistantConfig | null> {
  try {
    return await cachedAssistant();
  } catch {
    return null;
  }
}

export interface JobsAssistantPanel {
  config: JobsAssistantConfig;
  status: JobsChatStatus;
  /**
   * False while the migration has not run (its questions table is missing,
   * and the settings column comes with it): editing waits for it.
   */
  editable: boolean;
  migration: string;
}

/** For Portfolio > Jobs > Ask Arwin. Never throws. */
export async function readJobsAssistantPanel(
  store: DataStore,
  organizationId: string,
): Promise<JobsAssistantPanel> {
  const [stored, status] = await Promise.all([
    readStored(store, organizationId),
    jobsChatStatus(store, organizationId),
  ]);
  return {
    config: stored.config,
    status,
    editable: status.tableReady,
    migration: JOBS_CHAT_MIGRATION,
  };
}

const NEEDS_MIGRATION = `Editing Ask Arwin needs one more database change. Run ${JOBS_CHAT_MIGRATION} in the Supabase SQL editor. Until then it answers from the board and its default answers.`;

/** Save any of the assistant's settings, merged onto what is stored. */
export async function saveJobsAssistant(
  store: DataStore,
  actor: JobsActor,
  input: unknown,
): Promise<Result<JobsAssistantConfig>> {
  const patch = JOBS_ASSISTANT_PATCH.safeParse(input);
  if (!patch.success) {
    return err(
      'invalid_input',
      patch.error.issues[0]?.message ?? 'Those settings could not be read.',
    );
  }
  const stored = await readStored(store, actor.organizationId);
  const next = JOBS_ASSISTANT_SCHEMA.safeParse({ ...stored.config, ...patch.data });
  if (!next.success) {
    return err(
      'invalid_input',
      next.error.issues[0]?.message ?? 'Those settings could not be read.',
    );
  }
  const now = new Date().toISOString();
  try {
    const saved = stored.row
      ? await store.update('job_board_settings', actor.organizationId, stored.row.id, {
          assistant: next.data,
          updated_by: actor.userId,
          updated_at: now,
        })
      : await store.insert('job_board_settings', {
          id: newId(),
          organization_id: actor.organizationId,
          enabled: false,
          title: DEFAULT_BOARD_TITLE,
          intro: null,
          accent: DEFAULT_BOARD_ACCENT,
          assistant: next.data,
          updated_by: actor.userId,
          created_at: now,
          updated_at: now,
        });
    await recordAudit(store, {
      organizationId: actor.organizationId,
      userId: actor.userId,
      action: 'jobs.board_updated',
      entityType: 'job_board',
      entityId: saved.id,
      metadata: {
        assistant: true,
        enabled: next.data.enabled,
        aiAnswers: next.data.aiAnswers,
        answers: next.data.faqItems.length,
      },
    });
    return ok(readJobsAssistantConfig(saved.assistant ?? next.data));
  } catch (error) {
    if (isMissingTableError(error) || isMissingColumnError(error)) {
      return err('not_configured', NEEDS_MIGRATION);
    }
    log.error('Saving the job board assistant failed', {
      reason: (error as Error)?.message?.slice(0, 160),
    });
    return err('internal', 'Could not save Ask Arwin. Nothing was changed; try again.');
  }
}

/* ---------------------------------------------------------------- chat -- */

export interface JobsChatContext {
  store: DataStore;
  organizationId: string;
  board: PublicBoard;
  assistant: JobsAssistantConfig;
  /** '' on the board's own host, '/jobs' on Kraken's. */
  base: string;
  /** A keyed hash of the visitor's address, for the per-address AI cap. */
  ipHash: string | null;
  now?: Date;
  fetchImpl?: typeof fetch;
  /** The board's absolute address (canonical by default), for the routine's facts. */
  boardUrl?: string;
}

/** One question, answered by the cheapest tier that can. */
export async function answerJobsQuestion(
  request: JobsChatRequest,
  context: JobsChatContext,
): Promise<JobsChatReply> {
  const question = cleanJobsQuestion(request.question);
  if (!question) return { kind: 'none', text: NO_ANSWER, suggestions: [] };
  const instant = answerFromBoard(question, context.board, context.base);
  const written = matchFaq(question, faqEntries(context.assistant.faqItems));
  const suggestions = written.suggestions.map((m) => m.entry.q);
  // A general board answer ("There are 7 open roles") is a poor reply to a
  // question a written answer covers ("What is this job board?"): a strong
  // written answer wins those. A specific one (a team, a place, a company)
  // stays with the board.
  const writtenFirst = Boolean(
    written.best && (!instant || isGeneralQuestion(question, context.board)),
  );
  if (instant && !writtenFirst) {
    return {
      kind: 'answer',
      source: 'board',
      text: instant.text,
      links: instant.links,
      seeAll: instant.seeAll,
      suggestions: [],
    };
  }
  if (written.best) {
    return {
      kind: 'answer',
      source: 'written',
      text: written.best.entry.a,
      links: [],
      seeAll: null,
      suggestions,
    };
  }
  const none: JobsChatReply = { kind: 'none', text: NO_ANSWER, suggestions };
  if (!context.assistant.aiAnswers || !jobsChatConfigured()) return none;
  const boardUrl = context.boardUrl ?? canonicalBoardUrl('');
  const facts = buildJobsQuestionFacts({
    boardUrl,
    jobs: context.board.jobs,
    companies: context.board.companies,
    related: relatedJobs(question, context.board),
    faqItems: context.assistant.faqItems,
    roleUrl: (job) => `${boardUrl}/${job.companySlug}/${job.slug}`,
  });
  const asked = await askJobsRoutine(context.store, {
    organizationId: context.organizationId,
    assistant: context.assistant,
    question,
    sessionId: request.sessionId,
    ipHash: context.ipHash,
    facts,
    now: context.now,
    fetchImpl: context.fetchImpl,
  });
  if (asked.kind === 'unavailable') return none;
  return { kind: 'pending', questionId: asked.id, text: PENDING_TEXT, suggestions };
}

export type PublicChatSetup =
  | {
      ok: true;
      store: DataStore;
      organizationId: string;
      board: PublicBoard;
      assistant: JobsAssistantConfig;
    }
  | { ok: false };

/**
 * What a public chat request needs: the board as the public pages show it
 * (on, never the preview) and the assistant switched on.
 */
export async function publicChatSetup(): Promise<PublicChatSetup> {
  const [read, assistant] = await Promise.all([
    readPublicBoardCached(false),
    readJobsAssistantCached(),
  ]);
  if (read.state !== 'on' || read.preview || !assistant?.enabled) return { ok: false };
  try {
    const organizationId = await soleOrganizationId('jobs-board');
    if (!organizationId) return { ok: false };
    return { ok: true, store: getStore(), organizationId, board: read.board, assistant };
  } catch {
    return { ok: false };
  }
}

/** The widget's poll for a routine answer. */
export async function readJobsChatAnswer(
  store: DataStore,
  organizationId: string,
  id: string,
  options: { boardUrl?: string; now?: Date; fetchImpl?: typeof fetch } = {},
): Promise<JobsAnswerView | null> {
  return readJobsAnswer(store, organizationId, id, {
    boardUrl: options.boardUrl ?? canonicalBoardUrl(''),
    now: options.now,
    fetchImpl: options.fetchImpl,
  });
}
