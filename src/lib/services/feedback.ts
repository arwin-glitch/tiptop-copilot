import 'server-only';
import { z } from 'zod';
import type { DataStore } from '@/lib/db/store';
import {
  FEEDBACK_HREF,
  FEEDBACK_TEXT_MAX,
  FEEDBACK_TITLE_MAX,
  isFeedbackPath,
  type FeedbackItem,
  type FeedbackStatus,
} from '@/lib/feedback/shared';
import type { AuditEvent } from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';
import { err, ok, type Result } from '@/lib/util/result';
import { snippet } from '@/lib/util/text';

/**
 * In-app feedback: what someone wants changed in Kraken, typed (or dictated
 * with the phone's or computer's own dictation, so the page never asks for
 * the microphone) in the Ask Arwin panel's Feedback tab, with the page it was
 * sent from. The full Ask page's Feedback tab lists every note, open ones
 * first in the count, newest first, and whoever looks after the app marks
 * each done.
 *
 * No schema change, like the email session's answers (email-session.ts):
 *
 * - a note is an `audit_events` row (`feedback.note`, entity_id = its own id,
 *   user_id = who sent it, metadata = the text, the page and the sender's
 *   first name), written directly rather than through recordAudit, so the
 *   words arrive exactly as typed;
 * - marking it done or open again appends a `feedback.status` row
 *   (entity_id = the note), and the newest one wins;
 * - "ping my computers when feedback comes in" is a `feedback.alerts` row per
 *   person (entity_id = their user id, metadata.on), newest wins. Off unless
 *   turned on, and never for a note the person sent themselves.
 *
 * Rows are only ever added, so a note cannot be lost to a race between two
 * people closing it.
 */

export const FEEDBACK_NOTE_ACTION = 'feedback.note';
export const FEEDBACK_STATUS_ACTION = 'feedback.status';
export const FEEDBACK_ALERTS_ACTION = 'feedback.alerts';
/** The list shows at most this many notes, newest first. */
export const FEEDBACK_LIST_MAX = 200;
/** A computer is pinged for feedback sent in the last day, after it was turned on. */
export const FEEDBACK_ALERT_RECENT_MS = 24 * 3_600_000;
/** Notes one desktop notification may cover. */
const FEEDBACK_ALERT_KEYS_MAX = 10;
export const FEEDBACK_ALERT_PREVIEW_MAX = 100;
const STATUS_ROWS_MAX = 2000;
const STATUS_SLACK_MS = 5 * 60_000;
const ID = /^[0-9a-f-]{36}$/i;

export const FEEDBACK_SCHEMA = z.object({
  text: z
    .string()
    .trim()
    .min(1, 'Write what to change first.')
    .max(
      FEEDBACK_TEXT_MAX,
      `Feedback is at most ${FEEDBACK_TEXT_MAX.toLocaleString('en-US')} characters.`,
    ),
  // A page that is not plainly in-app is kept as no page, never refused: the
  // note is what matters.
  path: z
    .string()
    .nullish()
    .transform((value) => (isFeedbackPath(value) ? value : null)),
  title: z
    .string()
    .nullish()
    .transform((value) => value?.replace(/\s+/g, ' ').trim().slice(0, FEEDBACK_TITLE_MAX) || null),
});
export type FeedbackInput = z.input<typeof FEEDBACK_SCHEMA>;

export const FEEDBACK_STATUS_SCHEMA = z.object({
  id: z.string().regex(ID),
  status: z.enum(['open', 'done']),
});

/** Who is writing: their user id and the first name the list shows. */
export interface FeedbackActor {
  id: string;
  name: string;
}

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value ? value : null;

function noteFrom(row: AuditEvent): FeedbackItem | null {
  const meta = row.metadata as Record<string, unknown>;
  const text = asString(meta.text);
  if (!text) return null;
  const path = asString(meta.path);
  return {
    id: row.id,
    text,
    path: isFeedbackPath(path) ? path : null,
    title: asString(meta.title),
    by: asString(meta.by),
    userId: row.user_id,
    at: row.created_at,
    status: 'open',
    changedAt: null,
    changedBy: null,
  };
}

/**
 * Each of these notes' newest status row. A status always comes after its
 * note, so the read starts at the oldest note rather than naming every id
 * (two hundred ids would make a long request URL).
 */
async function readStatuses(
  store: DataStore,
  organizationId: string,
  notes: readonly FeedbackItem[],
): Promise<Map<string, { status: FeedbackStatus; at: string; by: string | null }>> {
  const out = new Map<string, { status: FeedbackStatus; at: string; by: string | null }>();
  if (!notes.length) return out;
  const ids = new Set(notes.map((n) => n.id));
  const oldest = Math.min(...notes.map((n) => Date.parse(n.at)));
  // A few minutes' slack, for a clock that stepped back between two writes.
  const since = new Date(oldest - STATUS_SLACK_MS).toISOString();
  const rows = (await store.list(
    'audit_events',
    organizationId,
    { eq: { action: FEEDBACK_STATUS_ACTION }, gte: { created_at: since } },
    { orderBy: [{ field: 'created_at', direction: 'desc' }], limit: STATUS_ROWS_MAX },
  )) as AuditEvent[];
  for (const row of rows) {
    if (!row.entity_id || !ids.has(row.entity_id) || out.has(row.entity_id)) continue;
    const status = (row.metadata as Record<string, unknown>).status;
    if (status !== 'open' && status !== 'done') continue;
    out.set(row.entity_id, {
      status,
      at: row.created_at,
      by: asString((row.metadata as Record<string, unknown>).by),
    });
  }
  return out;
}

/**
 * The feedback notes, newest first, each with where it stands. `since` keeps
 * only notes sent from then on. Throws when the store cannot be read; a page
 * catches that and shows the list as unavailable.
 */
export async function listFeedback(
  store: DataStore,
  organizationId: string,
  options: { since?: string; limit?: number } = {},
): Promise<FeedbackItem[]> {
  const rows = (await store.list(
    'audit_events',
    organizationId,
    {
      eq: { action: FEEDBACK_NOTE_ACTION },
      ...(options.since ? { gte: { created_at: options.since } } : {}),
    },
    {
      orderBy: [{ field: 'created_at', direction: 'desc' }],
      limit: Math.min(options.limit ?? FEEDBACK_LIST_MAX, FEEDBACK_LIST_MAX),
    },
  )) as AuditEvent[];
  const notes = rows.map(noteFrom).filter((n): n is FeedbackItem => n !== null);
  const statuses = await readStatuses(store, organizationId, notes);
  return notes.map((note) => {
    const status = statuses.get(note.id);
    return status
      ? { ...note, status: status.status, changedAt: status.at, changedBy: status.by }
      : note;
  });
}

/** Save one note. The input is checked here, whoever calls. */
export async function recordFeedback(
  store: DataStore,
  organizationId: string,
  actor: FeedbackActor,
  input: FeedbackInput,
  now: Date = new Date(),
): Promise<Result<FeedbackItem>> {
  const parsed = FEEDBACK_SCHEMA.safeParse(input);
  if (!parsed.success) {
    // The two limits on the text say what to do; anything else is a bad request.
    const issue = parsed.error.issues[0];
    const said = issue?.code === 'too_small' || issue?.code === 'too_big';
    return err('invalid_input', said ? issue.message : 'That feedback is not valid.');
  }
  const id = newId();
  const row: AuditEvent = {
    id,
    organization_id: organizationId,
    user_id: actor.id,
    action: FEEDBACK_NOTE_ACTION,
    entity_type: 'feedback',
    entity_id: id,
    // Written directly, not through recordAudit: the note is the person's own
    // words and must arrive as typed.
    metadata: {
      text: parsed.data.text,
      path: parsed.data.path,
      title: parsed.data.title,
      by: actor.name,
    },
    ip_hash: null,
    created_at: now.toISOString(),
  };
  await store.insert('audit_events', row);
  const note = noteFrom(row);
  return note ? ok(note) : err('internal', 'That feedback could not be saved.');
}

/** Mark a note done, or open again. Only a note of this organization. */
export async function setFeedbackStatus(
  store: DataStore,
  organizationId: string,
  actor: FeedbackActor,
  input: { id: string; status: FeedbackStatus },
  now: Date = new Date(),
): Promise<Result<{ id: string; status: FeedbackStatus }>> {
  const parsed = FEEDBACK_STATUS_SCHEMA.safeParse(input);
  if (!parsed.success) return err('invalid_input', 'That change is not valid.');
  const note = await store.findOne('audit_events', organizationId, {
    eq: { action: FEEDBACK_NOTE_ACTION, entity_id: parsed.data.id },
  });
  if (!note) return err('not_found', 'That feedback is no longer here.');
  await store.insert('audit_events', {
    id: newId(),
    organization_id: organizationId,
    user_id: actor.id,
    action: FEEDBACK_STATUS_ACTION,
    entity_type: 'feedback',
    entity_id: parsed.data.id,
    metadata: { status: parsed.data.status, by: actor.name },
    ip_hash: null,
    created_at: now.toISOString(),
  });
  return ok({ id: parsed.data.id, status: parsed.data.status });
}

/* ------------------------------------------------------- desktop alerts */

/** Whether this person asked for their computers to ping on new feedback. */
export async function feedbackAlertsOn(
  store: DataStore,
  organizationId: string,
  userId: string,
): Promise<boolean> {
  const rows = (await store.list(
    'audit_events',
    organizationId,
    { eq: { action: FEEDBACK_ALERTS_ACTION, entity_id: userId } },
    { orderBy: [{ field: 'created_at', direction: 'desc' }], limit: 1 },
  )) as AuditEvent[];
  return (rows[0]?.metadata as Record<string, unknown> | undefined)?.on === true;
}

export async function setFeedbackAlerts(
  store: DataStore,
  organizationId: string,
  userId: string,
  on: boolean,
  now: Date = new Date(),
): Promise<void> {
  await store.insert('audit_events', {
    id: newId(),
    organization_id: organizationId,
    user_id: userId,
    action: FEEDBACK_ALERTS_ACTION,
    entity_type: 'user',
    entity_id: userId,
    metadata: { on },
    ip_hash: null,
    created_at: now.toISOString(),
  });
}

/** The ledger key of one note's desktop alert. */
export function feedbackAlertKey(id: string): string {
  return `feedback:${id}`;
}

/**
 * The notes that may ping one computer: still open, sent by someone else,
 * after the computer was turned on and within the last day, and not shown
 * on it yet. Oldest first, at most ten. Pure.
 */
export function feedbackForComputer(
  notes: readonly FeedbackItem[],
  caller: { userId: string; enabledAt: string },
  sent: ReadonlySet<string>,
  now: Date,
): FeedbackItem[] {
  const since = Math.max(
    Date.parse(caller.enabledAt) || 0,
    now.getTime() - FEEDBACK_ALERT_RECENT_MS,
  );
  return notes
    .filter(
      (n) =>
        n.status === 'open' &&
        n.userId !== caller.userId &&
        Date.parse(n.at) >= since &&
        !sent.has(feedbackAlertKey(n.id)),
    )
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .slice(-FEEDBACK_ALERT_KEYS_MAX);
}

/**
 * One notification for the notes that came in: "New feedback" (or "3 new
 * feedback notes"), the newest note's first words with its sender, and a
 * click that opens the list. Null for none. Pure.
 */
export function feedbackAlertWords(
  notes: readonly FeedbackItem[],
): { keys: string[]; title: string; body: string; url: string } | null {
  const newest = notes[notes.length - 1];
  if (!newest) return null;
  const words = snippet(newest.text, FEEDBACK_ALERT_PREVIEW_MAX);
  return {
    keys: notes.map((n) => feedbackAlertKey(n.id)),
    title: notes.length > 1 ? `${notes.length} new feedback notes` : 'New feedback',
    body: newest.by ? `${newest.by}: ${words}` : words,
    url: FEEDBACK_HREF,
  };
}

/**
 * What a computer's owner should be pinged about, when they turned feedback
 * alerts on: nothing for anyone who did not. Throws when the store cannot be
 * read; the desktop endpoint treats that as nothing to show.
 */
export async function feedbackAlertFor(
  store: DataStore,
  caller: { organizationId: string; userId: string; enabledAt: string },
  sent: ReadonlySet<string>,
  now: Date,
): Promise<{ keys: string[]; title: string; body: string; url: string } | null> {
  if (!(await feedbackAlertsOn(store, caller.organizationId, caller.userId))) return null;
  const since = new Date(
    Math.max(Date.parse(caller.enabledAt) || 0, now.getTime() - FEEDBACK_ALERT_RECENT_MS),
  ).toISOString();
  const notes = await listFeedback(store, caller.organizationId, { since, limit: 50 });
  return feedbackAlertWords(feedbackForComputer(notes, caller, sent, now));
}
