'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireAuth } from '@/lib/auth/session';
import { generateDailyBrief } from '@/lib/services/brief';
import { ask } from '@/lib/services/chat';
import {
  addNote,
  archiveDeal,
  attachEmailToDeal,
  compareDeals,
  correctFact,
  createDealFromEmail,
  recordDecision,
  restoreDeal,
  updateDealStage,
} from '@/lib/services/deals';
import { analyzeDeal, overrideRecommendation, resolveRedFlag } from '@/lib/services/deal-analysis';
import { createDraft, updateDraft } from '@/lib/services/drafts';
import {
  classifyMessage,
  fetchFullMessage,
  ignoreMessage,
  setCategory,
  syncMailbox,
} from '@/lib/services/inbox';
import {
  classifyPortfolioEmail,
  createPortfolioCompany,
  importPortfolioCsv,
  setUpdateStatus,
} from '@/lib/services/portfolio';
import { deleteDocument, importNetworkCsv, uploadDocument } from '@/lib/services/knowledge';
import {
  assignTask,
  createTask,
  editTask,
  listTaskPeople,
  restoreTask,
  snoozeTask,
  updateTaskStatus,
} from '@/lib/services/tasks';
import {
  completeTaskWithProof,
  dismissNeedsProof,
  setMoneyLegal,
} from '@/lib/services/money-legal';
import type { TaskProof } from '@/lib/tasks/money-legal';
import type { TaskPerson } from '@/lib/tasks/task-people';
import type { TaskRestore } from '@/lib/tasks/tasks-view';
import { setTaskGlance, type GlancePatch } from '@/lib/services/task-glance';
import { updateThesis, type ThesisPatch } from '@/lib/services/thesis';
import { getStore, getUpdatesFeed } from '@/lib/runtime';
import { readUpdates } from '@/lib/services/updates';
import { isSupportedMimeType } from '@/lib/documents/extract';
import { rateLimit } from '@/lib/security/limits';
import type {
  DecisionType,
  EmailCategory,
  KnowledgeDocType,
  Recommendation,
  TaskStatus,
} from '@/lib/types/domain';
import type { AppError } from '@/lib/util/result';
import { isSupportedTimezone } from '@/lib/util/time';

/**
 * Server actions.
 *
 * Every action authenticates first, then delegates to a service. No business
 * logic lives here — this file exists to be the authenticated, CSRF-protected
 * boundary between the browser and `lib/services`.
 *
 * Actions return a discriminated result rather than throwing so the client can
 * render a specific, useful error instead of an error boundary.
 */

export interface ActionResult<T = undefined> {
  ok: boolean;
  data?: T;
  error?: { message: string; code: string; stillUsable?: string };
}

function fail(error: AppError): ActionResult<never> {
  return {
    ok: false,
    error: { message: error.message, code: error.code, stillUsable: error.stillUsable },
  };
}

function succeed<T>(data?: T): ActionResult<T> {
  return { ok: true, data };
}

/* ------------------------------------------------------------------ brief */

export async function refreshOutlookAction(): Promise<ActionResult<{ outlook: string }>> {
  const auth = await requireAuth();
  const limited = rateLimit(`brief:${auth.userId}`, 10, 60_000);
  if (!limited.ok) return fail(limited.error);

  const result = await generateDailyBrief(auth, { force: true });
  if (!result.ok) return fail(result.error);
  revalidatePath('/today');
  return succeed({ outlook: result.value.outlook });
}

/* ---------------------------------------------------------------- updates */

/**
 * Re-read the Updates tab's Slack channels. Rate-limited per user on top of
 * the reader's own per-channel floor and Slack's Retry-After, so a held-down
 * button cannot turn into a burst against Slack.
 */
export async function refreshUpdatesAction(): Promise<
  ActionResult<{ throttled: boolean; problems: number }>
> {
  const auth = await requireAuth();
  const limited = rateLimit(`updates-refresh:${auth.userId}`, 6, 60_000);
  if (!limited.ok) return fail(limited.error);

  const feed = getUpdatesFeed();
  if (!feed) {
    return fail({
      code: 'not_configured',
      message: 'The Updates tab stays closed until sign-in is limited to TipTop accounts.',
    });
  }
  const snapshot = await readUpdates(feed, { force: true });
  revalidatePath('/updates');
  return succeed({
    throttled: snapshot.throttled,
    problems: snapshot.sources.filter((s) => s.access.state !== 'ok').length,
  });
}

/* ------------------------------------------------------------------ tasks */

export async function createTaskAction(input: {
  title: string;
  detail?: string;
  dueAt?: string;
  dealId?: string;
  portfolioCompanyId?: string;
  emailMessageId?: string;
}): Promise<ActionResult<{ id: string }>> {
  const auth = await requireAuth();
  const result = await createTask(auth, {
    title: input.title,
    detail: input.detail ?? null,
    dueAt: input.dueAt || null,
    dealId: input.dealId ?? null,
    portfolioCompanyId: input.portfolioCompanyId ?? null,
    emailMessageId: input.emailMessageId ?? null,
  });
  if (!result.ok) return fail(result.error);
  revalidatePath('/today');
  revalidatePath('/tasks');
  if (input.dealId) revalidatePath(`/deals/${input.dealId}`);
  return succeed({ id: result.value.id });
}

export async function updateTaskStatusAction(
  taskId: string,
  status: TaskStatus,
): Promise<ActionResult> {
  const auth = await requireAuth();
  const result = await updateTaskStatus(auth, taskId, status);
  if (!result.ok) return fail(result.error);
  revalidatePath('/today');
  revalidatePath('/tasks');
  return succeed();
}

export async function snoozeTaskAction(taskId: string, days: number): Promise<ActionResult> {
  const auth = await requireAuth();
  const until = new Date(Date.now() + Math.max(1, days) * 86_400_000).toISOString();
  const result = await snoozeTask(auth, taskId, until);
  if (!result.ok) return fail(result.error);
  revalidatePath('/today');
  revalidatePath('/tasks');
  return succeed();
}

/** The Undo in a task toast: back to open, or snoozed until the same time. */
export async function restoreTaskAction(taskId: string, prev: TaskRestore): Promise<ActionResult> {
  const auth = await requireAuth();
  // Called from the browser, so the shape is checked rather than trusted.
  const valid =
    typeof taskId === 'string' &&
    (prev?.status === 'open' ||
      (prev?.status === 'snoozed' &&
        (prev.snoozedUntil === null || typeof prev.snoozedUntil === 'string')));
  if (!valid) return fail({ code: 'invalid_input', message: 'That undo is not valid.' });
  const result = await restoreTask(auth, taskId, prev);
  if (!result.ok) return fail(result.error);
  revalidatePath('/today');
  revalidatePath('/tasks');
  return succeed();
}

/* ----------------------------------------------------- task basics, money */

const TASK_ID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const BAD_TASK = { code: 'invalid_input', message: 'That task is not valid.' } as const;
/** How far ahead a chosen snooze may go: a year and a little. */
const MAX_SNOOZE_MS = 400 * 86_400_000;

function revalidateTasks(): void {
  revalidatePath('/today');
  revalidatePath('/tasks');
}

const EDIT_TASK_SCHEMA = z.object({
  title: z.string().max(1000),
  detail: z.string().max(10_000).nullable(),
  dueAt: z.string().max(40).nullable(),
});

/** A person's edit of a task's title, detail and due date. */
export async function editTaskAction(
  taskId: string,
  input: { title: string; detail: string | null; dueAt: string | null },
): Promise<ActionResult> {
  const auth = await requireAuth();
  const id = TASK_ID.safeParse(taskId);
  const parsed = EDIT_TASK_SCHEMA.safeParse(input);
  if (!id.success || !parsed.success) return fail(BAD_TASK);
  const result = await editTask(auth, id.data, parsed.data);
  if (!result.ok) return fail(result.error);
  revalidateTasks();
  return succeed();
}

/**
 * Deletes a task: it leaves every list, and its toast's Undo puts it back.
 * The row stays, cancelled, so a suggestion with the same title is never
 * added again.
 */
export async function deleteTaskAction(taskId: string): Promise<ActionResult> {
  const auth = await requireAuth();
  const id = TASK_ID.safeParse(taskId);
  if (!id.success) return fail(BAD_TASK);
  const result = await updateTaskStatus(auth, id.data, 'cancelled');
  if (!result.ok) return fail(result.error);
  revalidateTasks();
  return succeed();
}

/** Snooze until a chosen time: later than now, and no more than a year and a little ahead. */
export async function snoozeTaskUntilAction(taskId: string, until: string): Promise<ActionResult> {
  const auth = await requireAuth();
  const id = TASK_ID.safeParse(taskId);
  const at = z.string().max(40).safeParse(until);
  if (!id.success || !at.success) return fail(BAD_TASK);
  const ms = Date.parse(at.data);
  const now = Date.now();
  if (Number.isNaN(ms) || ms <= now) {
    return fail({ code: 'invalid_input', message: 'Pick a date after today.' });
  }
  if (ms > now + MAX_SNOOZE_MS) {
    return fail({ code: 'invalid_input', message: 'Pick a date within the next year.' });
  }
  const result = await snoozeTask(auth, id.data, new Date(ms).toISOString());
  if (!result.ok) return fail(result.error);
  revalidateTasks();
  return succeed();
}

/** Who a task is for: someone on the team, or no one (null). */
export async function assignTaskAction(
  taskId: string,
  userId: string | null,
): Promise<ActionResult> {
  const auth = await requireAuth();
  const id = TASK_ID.safeParse(taskId);
  const to = TASK_ID.nullable().safeParse(userId);
  if (!id.success || !to.success) return fail(BAD_TASK);
  const result = await assignTask(auth, id.data, to.data);
  if (!result.ok) return fail(result.error);
  revalidateTasks();
  return succeed();
}

/** The organization's members, for the assign menu and the proof dialog. */
export async function listTaskPeopleAction(): Promise<ActionResult<TaskPerson[]>> {
  const auth = await requireAuth();
  return succeed(await listTaskPeople(auth.organizationId));
}

/** Puts a task on the Money & legal tab, or takes it off, whatever the keyword rules say. */
export async function setMoneyLegalAction(taskId: string, on: boolean): Promise<ActionResult> {
  const auth = await requireAuth();
  const id = TASK_ID.safeParse(taskId);
  if (!id.success || typeof on !== 'boolean') return fail(BAD_TASK);
  const result = await setMoneyLegal(auth, id.data, on);
  if (!result.ok) return fail(result.error);
  revalidatePath('/tasks');
  return succeed();
}

/** Closes a task on proof: a link, or who confirmed it, with an optional note. */
export async function completeTaskWithProofAction(
  taskId: string,
  proof: TaskProof,
): Promise<ActionResult> {
  const auth = await requireAuth();
  const id = TASK_ID.safeParse(taskId);
  if (!id.success) return fail(BAD_TASK);
  // The proof's shape is checked by the service's schema, not trusted.
  const result = await completeTaskWithProof(auth, id.data, proof);
  if (!result.ok) return fail(result.error);
  revalidateTasks();
  return succeed();
}

/** "Not done": a money or legal task the auto-check called done without proof stays open. */
export async function dismissNeedsProofAction(taskId: string): Promise<ActionResult> {
  const auth = await requireAuth();
  const id = TASK_ID.safeParse(taskId);
  if (!id.success) return fail(BAD_TASK);
  const result = await dismissNeedsProof(auth, id.data);
  if (!result.ok) return fail(result.error);
  revalidatePath('/tasks');
  return succeed();
}

/**
 * A person's own short label or card for a task on Today's "At a glance".
 * Rate-limited, and the patch is checked by the service, not trusted.
 */
export async function setTaskGlanceAction(
  taskId: string,
  patch: GlancePatch,
): Promise<ActionResult> {
  const auth = await requireAuth();
  const limited = rateLimit(`glance:${auth.userId}`, 30, 60_000);
  if (!limited.ok) return fail(limited.error);
  if (typeof taskId !== 'string' || patch === null || typeof patch !== 'object') {
    return fail({ code: 'invalid_input', message: 'That change is not valid.' });
  }
  const result = await setTaskGlance(auth, taskId, {
    ...(typeof patch.short === 'string' ? { short: patch.short } : {}),
    ...(typeof patch.bucket === 'string' ? { bucket: patch.bucket } : {}),
  });
  if (!result.ok) return fail(result.error);
  revalidatePath('/today');
  return succeed();
}

/* ------------------------------------------------------------------ inbox */

export async function syncMailboxAction(): Promise<
  ActionResult<{ seen: number; created: number; classified: number }>
> {
  const auth = await requireAuth();
  const limited = rateLimit(`sync:${auth.organizationId}`, 6, 60_000);
  if (!limited.ok) return fail(limited.error);

  const result = await syncMailbox(auth);
  if (!result.ok) return fail(result.error);
  revalidatePath('/inbox');
  revalidatePath('/today');
  return succeed({
    seen: result.value.seen,
    created: result.value.created,
    classified: result.value.classified,
  });
}

export async function openMessageAction(messageId: string): Promise<ActionResult> {
  const auth = await requireAuth();
  const result = await fetchFullMessage(auth, messageId);
  if (!result.ok) return fail(result.error);
  revalidatePath('/inbox');
  return succeed();
}

export async function classifyMessageAction(messageId: string): Promise<ActionResult> {
  const auth = await requireAuth();
  const result = await classifyMessage(auth, messageId);
  if (!result.ok) return fail(result.error);
  revalidatePath('/inbox');
  return succeed();
}

export async function setCategoryAction(
  messageId: string,
  category: EmailCategory,
): Promise<ActionResult> {
  const auth = await requireAuth();
  const result = await setCategory(auth, messageId, category);
  if (!result.ok) return fail(result.error);
  revalidatePath('/inbox');
  return succeed();
}

export async function ignoreMessageAction(
  messageId: string,
  ignored: boolean,
): Promise<ActionResult> {
  const auth = await requireAuth();
  const result = await ignoreMessage(auth, messageId, ignored);
  if (!result.ok) return fail(result.error);
  revalidatePath('/inbox');
  return succeed();
}

export async function analyzeAsDealAction(
  messageId: string,
): Promise<ActionResult<{ dealId: string; created: boolean; duplicates: number }>> {
  const auth = await requireAuth();
  const limited = rateLimit(`analyze:${auth.userId}`, 20, 60_000);
  if (!limited.ok) return fail(limited.error);

  await fetchFullMessage(auth, messageId);
  const result = await createDealFromEmail(auth, messageId);
  if (!result.ok) return fail(result.error);

  revalidatePath('/inbox');
  revalidatePath('/deals');
  return succeed({
    dealId: result.value.deal.id,
    created: result.value.created,
    duplicates: result.value.duplicates.length,
  });
}

export async function attachEmailToDealAction(
  messageId: string,
  dealId: string,
): Promise<ActionResult> {
  const auth = await requireAuth();
  const result = await attachEmailToDeal(auth, dealId, messageId);
  if (!result.ok) return fail(result.error);
  revalidatePath('/inbox');
  revalidatePath(`/deals/${dealId}`);
  return succeed();
}

/* ------------------------------------------------------------------ deals */

export async function analyzeDealAction(
  dealId: string,
  force = false,
): Promise<ActionResult<{ recommendation: string; confidence: number }>> {
  const auth = await requireAuth();
  const limited = rateLimit(`deal-analyze:${auth.userId}`, 20, 60_000);
  if (!limited.ok) return fail(limited.error);

  const result = await analyzeDeal(auth, dealId, { force });
  if (!result.ok) return fail(result.error);
  revalidatePath(`/deals/${dealId}`);
  revalidatePath('/deals');
  return succeed({
    recommendation: result.value.recommendation,
    confidence: result.value.confidence,
  });
}

export async function updateDealStageAction(dealId: string, stage: string): Promise<ActionResult> {
  const auth = await requireAuth();
  const result = await updateDealStage(auth, dealId, stage);
  if (!result.ok) return fail(result.error);
  revalidatePath(`/deals/${dealId}`);
  revalidatePath('/deals');
  return succeed();
}

/** "Not a deal": archive it. A human action; the deal-sorter never resurrects it. */
export async function archiveDealAction(dealId: string, reason: string): Promise<ActionResult> {
  const auth = await requireAuth();
  const result = await archiveDeal(auth, dealId, reason);
  if (!result.ok) return fail(result.error);
  revalidatePath(`/deals/${dealId}`);
  revalidatePath('/deals');
  revalidatePath('/today');
  return succeed();
}

export async function restoreDealAction(dealId: string): Promise<ActionResult> {
  const auth = await requireAuth();
  const result = await restoreDeal(auth, dealId);
  if (!result.ok) return fail(result.error);
  revalidatePath(`/deals/${dealId}`);
  revalidatePath('/deals');
  revalidatePath('/today');
  return succeed();
}

export async function recordDecisionAction(
  dealId: string,
  decision: DecisionType,
  rationale: string,
): Promise<ActionResult> {
  const auth = await requireAuth();
  const result = await recordDecision(auth, dealId, decision, rationale);
  if (!result.ok) return fail(result.error);
  revalidatePath(`/deals/${dealId}`);
  revalidatePath('/deals');
  revalidatePath('/today');
  return succeed();
}

export async function overrideRecommendationAction(
  analysisId: string,
  dealId: string,
  recommendation: Recommendation,
  note: string,
): Promise<ActionResult> {
  const auth = await requireAuth();
  if (!note.trim()) {
    return {
      ok: false,
      error: { message: 'Say why you disagree — that is the useful part.', code: 'invalid_input' },
    };
  }
  const result = await overrideRecommendation(auth, analysisId, recommendation, note);
  if (!result.ok) return fail(result.error);
  revalidatePath(`/deals/${dealId}`);
  return succeed();
}

export async function resolveRedFlagAction(
  analysisId: string,
  dealId: string,
  label: string,
): Promise<ActionResult> {
  const auth = await requireAuth();
  const result = await resolveRedFlag(auth, analysisId, label);
  if (!result.ok) return fail(result.error);
  revalidatePath(`/deals/${dealId}`);
  return succeed();
}

export async function correctFactAction(
  dealId: string,
  field: string,
  value: string,
  note?: string,
): Promise<ActionResult> {
  const auth = await requireAuth();
  const result = await correctFact(auth, dealId, field, value.trim() || null, note);
  if (!result.ok) return fail(result.error);
  revalidatePath(`/deals/${dealId}`);
  return succeed();
}

export async function addNoteAction(dealId: string, body: string): Promise<ActionResult> {
  const auth = await requireAuth();
  const result = await addNote(auth, dealId, body);
  if (!result.ok) return fail(result.error);
  revalidatePath(`/deals/${dealId}`);
  return succeed();
}

export async function compareDealsAction(
  dealIds: string[],
): Promise<ActionResult<{ answer: string; whatWouldChange: string[]; dimensions: unknown[] }>> {
  const auth = await requireAuth();
  const limited = rateLimit(`compare:${auth.userId}`, 10, 60_000);
  if (!limited.ok) return fail(limited.error);

  const result = await compareDeals(auth, dealIds);
  if (!result.ok) return fail(result.error);
  return succeed({
    answer: result.value.answer,
    whatWouldChange: result.value.whatWouldChange,
    dimensions: result.value.dimensions,
  });
}

/* ----------------------------------------------------------------- drafts */

export async function createDraftAction(input: {
  kind:
    | 'missing_information'
    | 'pass'
    | 'follow_up'
    | 'meeting_request'
    | 'portfolio_reply'
    | 'generic_reply';
  dealId?: string;
  portfolioCompanyId?: string;
  emailMessageId?: string;
  guidance?: string;
}): Promise<ActionResult<{ id: string; subject: string; body: string }>> {
  const auth = await requireAuth();
  const limited = rateLimit(`draft:${auth.userId}`, 20, 60_000);
  if (!limited.ok) return fail(limited.error);

  const result = await createDraft(auth, {
    kind: input.kind,
    dealId: input.dealId ?? null,
    portfolioCompanyId: input.portfolioCompanyId ?? null,
    emailMessageId: input.emailMessageId ?? null,
    guidance: input.guidance,
  });
  if (!result.ok) return fail(result.error);
  if (input.dealId) revalidatePath(`/deals/${input.dealId}`);
  if (input.portfolioCompanyId) revalidatePath(`/portfolio/${input.portfolioCompanyId}`);
  return succeed({
    id: result.value.id,
    subject: result.value.subject,
    body: result.value.body,
  });
}

export async function updateDraftAction(
  draftId: string,
  patch: { subject?: string; body?: string },
): Promise<ActionResult> {
  const auth = await requireAuth();
  const result = await updateDraft(auth, draftId, patch);
  if (!result.ok) return fail(result.error);
  return succeed();
}

/* -------------------------------------------------------------- portfolio */

export async function createPortfolioAction(input: {
  name: string;
  website?: string;
  currentStage?: string;
  keyMetrics?: string;
  currentPriorities?: string;
  contactName?: string;
  contactEmail?: string;
}): Promise<ActionResult<{ id: string }>> {
  const auth = await requireAuth();
  const result = await createPortfolioCompany(auth, {
    name: input.name,
    website: input.website || null,
    currentStage: input.currentStage || null,
    keyMetrics: input.keyMetrics || null,
    currentPriorities: input.currentPriorities || null,
    contacts: input.contactName
      ? [{ name: input.contactName, email: input.contactEmail || null, isFounder: true }]
      : [],
  });
  if (!result.ok) return fail(result.error);
  revalidatePath('/portfolio');
  return succeed({ id: result.value.id });
}

export async function importPortfolioCsvAction(
  csvText: string,
): Promise<ActionResult<{ created: number; skipped: number; errors: string[] }>> {
  const auth = await requireAuth();
  const result = await importPortfolioCsv(auth, csvText);
  if (!result.ok) return fail(result.error);
  revalidatePath('/portfolio');
  return succeed(result.value);
}

export async function classifyPortfolioEmailAction(
  messageId: string,
): Promise<ActionResult<{ requestType: string | null }>> {
  const auth = await requireAuth();
  const result = await classifyPortfolioEmail(auth, messageId);
  if (!result.ok) return fail(result.error);
  revalidatePath('/portfolio');
  revalidatePath('/today');
  return succeed({ requestType: result.value.request_type });
}

export async function setPortfolioUpdateStatusAction(
  updateId: string,
  status: 'open' | 'handled' | 'ignored',
): Promise<ActionResult> {
  const auth = await requireAuth();
  const result = await setUpdateStatus(auth, updateId, status);
  if (!result.ok) return fail(result.error);
  revalidatePath('/portfolio');
  revalidatePath('/today');
  return succeed();
}

/* -------------------------------------------------------------- knowledge */

export async function uploadDocumentAction(
  formData: FormData,
): Promise<ActionResult<{ id: string; chunks: number; contactsImported: number }>> {
  const auth = await requireAuth();
  const limited = rateLimit(`upload:${auth.userId}`, 20, 60_000);
  if (!limited.ok) return fail(limited.error);

  const file = formData.get('file');
  const docType = String(formData.get('doc_type') ?? 'other') as KnowledgeDocType;
  const title = String(formData.get('title') ?? '');

  if (!(file instanceof File)) {
    return { ok: false, error: { message: 'Choose a file to upload.', code: 'invalid_input' } };
  }
  if (file.size === 0) {
    return { ok: false, error: { message: 'That file is empty.', code: 'invalid_input' } };
  }
  if (!isSupportedMimeType(file.type || 'application/octet-stream')) {
    return {
      ok: false,
      error: {
        message: `${file.type || 'That file type'} is not supported. Use PDF, DOCX, PPTX, text, Markdown, CSV, HTML or an image.`,
        code: 'unsupported_media_type',
      },
    };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const result = await uploadDocument(auth, {
    filename: file.name,
    mimeType: file.type || 'application/octet-stream',
    bytes,
    title: title || undefined,
    docType,
  });
  if (!result.ok) return fail(result.error);

  revalidatePath('/knowledge');
  return succeed({
    id: result.value.document.id,
    chunks: result.value.chunks,
    contactsImported: result.value.contactsImported,
  });
}

export async function deleteDocumentAction(documentId: string): Promise<ActionResult> {
  const auth = await requireAuth();
  const result = await deleteDocument(auth, documentId);
  if (!result.ok) return fail(result.error);
  revalidatePath('/knowledge');
  return succeed();
}

export async function importNetworkCsvAction(
  csvText: string,
): Promise<ActionResult<{ imported: number; skipped: number }>> {
  const auth = await requireAuth();
  const result = await importNetworkCsv(auth, csvText);
  if (!result.ok) return fail(result.error);
  revalidatePath('/knowledge');
  return succeed({ imported: result.value.imported, skipped: result.value.skipped });
}

/* --------------------------------------------------------------- settings */

export async function updateTimezoneAction(timezone: string): Promise<ActionResult> {
  const auth = await requireAuth();
  if (!isSupportedTimezone(timezone)) {
    return {
      ok: false,
      error: { message: 'That is not a recognised timezone.', code: 'invalid_input' },
    };
  }
  const store = getStore();
  await store.upsertUserProfile({
    ...auth.profile,
    timezone,
    updated_at: new Date().toISOString(),
  });
  revalidatePath('/settings');
  revalidatePath('/today');
  return succeed();
}

export async function updateThesisAction(
  patch: ThesisPatch,
): Promise<ActionResult<{ version: number }>> {
  const auth = await requireAuth();
  const totalWeight = (patch.scoring_weights ?? [])
    .filter((w) => w.enabled)
    .reduce((sum, w) => sum + w.weight, 0);
  if (patch.scoring_weights && totalWeight <= 0) {
    return {
      ok: false,
      error: {
        message: 'At least one scoring category must be enabled with a positive weight.',
        code: 'invalid_input',
      },
    };
  }
  const next = await updateThesis(getStore(), auth.organizationId, auth.userId, patch);
  revalidatePath('/settings');
  revalidatePath('/deals');
  return succeed({ version: next.version });
}

/* ------------------------------------------------------------------- chat */

export async function askAction(
  question: string,
  options: { threadId?: string; dealId?: string } = {},
): Promise<ActionResult<{ threadId: string; answer: string; toolsUsed: string[] }>> {
  const auth = await requireAuth();
  const limited = rateLimit(`ask:${auth.userId}`, 30, 60_000);
  if (!limited.ok) return fail(limited.error);

  const result = await ask(auth, question, {
    threadId: options.threadId ?? null,
    dealId: options.dealId ?? null,
  });
  if (!result.ok) return fail(result.error);

  revalidatePath('/ask');
  return succeed({
    threadId: result.value.thread.id,
    answer: result.value.assistantMessage.content,
    toolsUsed: result.value.assistantMessage.tool_calls.map((t) => t.name),
  });
}
