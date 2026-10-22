import 'server-only';
import { isMissingColumnError, isMissingTableError } from '@/lib/db/missing-table';
import type { DataStore } from '@/lib/db/store';
import {
  questionsSchema,
  registrationPatchSchema,
  sessionInputSchema,
  type RegistrationQuestion,
  type SessionInput,
} from '@/lib/events/registration';
import { recordAudit } from '@/lib/security/audit';
import { log } from '@/lib/security/redact';
import type { EventOwner } from '@/lib/services/events';
import type {
  EventAccess,
  EventRecord,
  EventRegistrationSettings,
  EventSession,
} from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';
import { err, ok, type Result } from '@/lib/util/result';

/**
 * The Registration tab (D-075): access mode, event capacity, the
 * registration settings (open, closes at, remaining, responses, plus-ones,
 * waitlist, auto-promote, request an invite, guest wall), the questions
 * builder and the sessions editor.
 *
 * Questions are never lost: one taken off the list keeps its id with
 * removed_at set, so exports still show "(removed) Label" and stored answers
 * keep their meaning. A session's time or venue change bumps the event's
 * schedule_version (the ICS SEQUENCE) and tells the caller how many Going
 * guests an update notice would reach (WS5 drafts it; nothing is sent).
 */

const NOT_SET_UP =
  'Events are not set up yet. Run the events migrations in the Supabase SQL editor.';

async function guard<T>(operation: string, run: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await run();
  } catch (error) {
    if (isMissingTableError(error) || isMissingColumnError(error)) {
      return err('not_configured', NOT_SET_UP, { details: { operation } });
    }
    log.error('Event registration settings failed', {
      operation,
      reason: error instanceof Error ? error.message : String(error),
    });
    return err('internal', 'Registration settings could not be saved just now.', {
      retryable: true,
    });
  }
}

export interface RegistrationView {
  eventId: string;
  title: string;
  slug: string;
  timeZone: string;
  access: EventAccess;
  capacity: number | null;
  registration: EventRegistrationSettings;
  questions: RegistrationQuestion[];
  sessions: EventSession[];
  scheduleVersion: number;
  /** Going per session (for "N of 80" next to capacity). */
  going: Record<string, number>;
}

export async function getRegistration(
  store: DataStore,
  organizationId: string,
  eventId: string,
): Promise<Result<RegistrationView>> {
  return guard('getRegistration', async () => {
    const event = await store.get('events', organizationId, eventId);
    if (!event) return err('not_found', 'That event does not exist.');
    const [sessions, rows] = await Promise.all([
      store.list(
        'event_sessions',
        organizationId,
        { eq: { event_id: eventId } },
        { orderBy: [{ field: 'position', direction: 'asc' }] },
      ),
      store.list('event_guest_sessions', organizationId, {
        eq: { event_id: eventId, status: 'going' },
      }),
    ]);
    const going: Record<string, number> = {};
    for (const r of rows) going[r.session_id] = (going[r.session_id] ?? 0) + 1;
    return ok({
      eventId,
      title: event.title,
      slug: event.slug,
      timeZone: event.time_zone,
      access: event.access,
      capacity: event.capacity,
      registration: event.registration,
      questions: event.questions as RegistrationQuestion[],
      sessions,
      scheduleVersion: event.schedule_version,
      going,
    });
  });
}

/** Keep removed questions (and any the client dropped) with removed_at set. */
export function reconcileQuestions(
  previous: readonly RegistrationQuestion[],
  next: readonly RegistrationQuestion[],
  now: string,
): RegistrationQuestion[] {
  const out = next.map((q) => ({ ...q }));
  for (const old of previous) {
    if (!out.some((q) => q.id === old.id)) out.push({ ...old, removed_at: old.removed_at ?? now });
  }
  return out;
}

/** Problems with a question list against the event's sessions. */
export function questionProblems(
  questions: readonly RegistrationQuestion[],
  sessionIds: ReadonlySet<string>,
): string | null {
  const ids = new Set<string>();
  for (const q of questions) {
    if (ids.has(q.id)) return 'Two questions share an id.';
    ids.add(q.id);
  }
  for (const q of questions) {
    if (q.removed_at) continue;
    if (q.session_id && !sessionIds.has(q.session_id))
      return `"${q.label}" is tied to a session that no longer exists.`;
    if (q.show_if?.kind === 'session' && !sessionIds.has(q.show_if.session_id)) {
      return `"${q.label}" depends on a session that no longer exists.`;
    }
    const cond = q.show_if;
    if (cond?.kind === 'answer') {
      const target = questions.find((x) => x.id === cond.question_id && !x.removed_at);
      if (!target) return `"${q.label}" depends on a question that is not on the form.`;
      if (target.show_if?.kind === 'answer' && target.show_if.question_id === q.id) {
        return `"${q.label}" and "${target.label}" depend on each other.`;
      }
    }
  }
  return null;
}

export async function updateRegistration(
  store: DataStore,
  owner: EventOwner,
  eventId: string,
  body: unknown,
): Promise<Result<RegistrationView>> {
  const parsed = registrationPatchSchema.safeParse(body);
  if (!parsed.success) {
    return err(
      'invalid_input',
      parsed.error.issues[0]?.message ?? 'Those settings could not be read.',
    );
  }
  const patch = parsed.data;
  const result = await guard('updateRegistration', async () => {
    const event = await store.get('events', owner.organizationId, eventId);
    if (!event) return err('not_found', 'That event does not exist.');
    const next: Partial<EventRecord> = {};
    if (patch.access !== undefined) next.access = patch.access;
    if (patch.capacity !== undefined) next.capacity = patch.capacity;
    if (patch.registration !== undefined) next.registration = patch.registration;
    if (patch.questions !== undefined) {
      const sessions = await store.list('event_sessions', owner.organizationId, {
        eq: { event_id: eventId },
      });
      const merged = reconcileQuestions(
        event.questions as RegistrationQuestion[],
        patch.questions as RegistrationQuestion[],
        new Date().toISOString(),
      );
      const checked = questionsSchema.safeParse(merged);
      if (!checked.success)
        return err('invalid_input', checked.error.issues[0]?.message ?? 'Check the questions.');
      const problem = questionProblems(merged, new Set(sessions.map((s) => s.id)));
      if (problem) return err('invalid_input', problem);
      next.questions = merged;
    }
    if (!Object.keys(next).length) return ok(true);
    await store.update('events', owner.organizationId, eventId, next);
    await recordAudit(store, {
      organizationId: owner.organizationId,
      userId: owner.userId,
      action: 'event.registration_changed',
      entityType: 'event',
      entityId: eventId,
      metadata: { fields: Object.keys(next), access: next.access ?? null },
    });
    return ok(true);
  });
  if (!result.ok) return result;
  return getRegistration(store, owner.organizationId, eventId);
}

/* --------------------------------------------------------------- sessions */

export interface SessionChange {
  session: EventSession;
  /** Times or venue moved: the ICS SEQUENCE was bumped. */
  scheduleChanged: boolean;
  /** Going guests in the session (an update notice's reach). */
  goingCount: number;
}

function validTimes(input: Pick<SessionInput, 'starts_at' | 'ends_at'>): string | null {
  if (
    input.starts_at &&
    input.ends_at &&
    Date.parse(input.ends_at) <= Date.parse(input.starts_at)
  ) {
    return 'A session ends after it starts.';
  }
  return null;
}

/** Keep the event's own start and end spanning its sessions. */
async function syncEventSpan(
  store: DataStore,
  organizationId: string,
  eventId: string,
  extra: Partial<EventRecord> = {},
): Promise<void> {
  const sessions = await store.list('event_sessions', organizationId, {
    eq: { event_id: eventId },
  });
  const starts = sessions
    .map((s) => s.starts_at)
    .filter((t): t is string => Boolean(t))
    .sort();
  const ends = sessions
    .map((s) => s.ends_at ?? s.starts_at)
    .filter((t): t is string => Boolean(t))
    .sort();
  const patch: Partial<EventRecord> = { ...extra };
  if (starts.length) patch.starts_at = starts[0]!;
  if (ends.length) patch.ends_at = ends.at(-1)!;
  if (Object.keys(patch).length) await store.update('events', organizationId, eventId, patch);
}

export async function addSession(
  store: DataStore,
  owner: EventOwner,
  eventId: string,
  body: unknown,
): Promise<Result<SessionChange>> {
  const parsed = sessionInputSchema.safeParse(body);
  if (!parsed.success)
    return err('invalid_input', parsed.error.issues[0]?.message ?? 'Check the session.');
  const input = parsed.data;
  const timeProblem = validTimes(input);
  if (timeProblem) return err('invalid_input', timeProblem);
  return guard('addSession', async () => {
    const event = await store.get('events', owner.organizationId, eventId);
    if (!event) return err('not_found', 'That event does not exist.');
    const existing = await store.list('event_sessions', owner.organizationId, {
      eq: { event_id: eventId },
    });
    if (existing.length >= 20) return err('invalid_input', 'An event has at most 20 sessions.');
    const now = new Date().toISOString();
    const session: EventSession = {
      id: newId(),
      organization_id: owner.organizationId,
      event_id: eventId,
      name: input.name,
      description: input.description ?? null,
      starts_at: input.starts_at ?? null,
      ends_at: input.ends_at ?? null,
      venue: input.venue ?? null,
      capacity: input.capacity ?? null,
      requires_approval: input.requires_approval ?? null,
      waitlist: input.waitlist ?? null,
      visible_to_tags: input.visible_to_tags ?? [],
      position: input.position ?? Math.max(-1, ...existing.map((s) => s.position)) + 1,
      created_at: now,
      updated_at: now,
    };
    await store.insert('event_sessions', session);
    await syncEventSpan(store, owner.organizationId, eventId, {
      schedule_version: event.schedule_version + 1,
    });
    await recordAudit(store, {
      organizationId: owner.organizationId,
      userId: owner.userId,
      action: 'event.registration_changed',
      entityType: 'event',
      entityId: eventId,
      metadata: { session_added: session.id },
    });
    return ok({ session, scheduleChanged: true, goingCount: 0 });
  });
}

function sameVenue(a: EventSession['venue'], b: EventSession['venue']): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export async function updateSession(
  store: DataStore,
  owner: EventOwner,
  eventId: string,
  sessionId: string,
  body: unknown,
): Promise<Result<SessionChange>> {
  const parsed = sessionInputSchema.partial().safeParse(body);
  if (!parsed.success)
    return err('invalid_input', parsed.error.issues[0]?.message ?? 'Check the session.');
  const input = parsed.data;
  return guard('updateSession', async () => {
    const event = await store.get('events', owner.organizationId, eventId);
    if (!event) return err('not_found', 'That event does not exist.');
    const session = await store.get('event_sessions', owner.organizationId, sessionId);
    if (!session || session.event_id !== eventId)
      return err('not_found', 'That session does not exist.');
    const next: Partial<EventSession> = {};
    if (input.name !== undefined) next.name = input.name;
    if (input.description !== undefined) next.description = input.description ?? null;
    if (input.starts_at !== undefined) next.starts_at = input.starts_at ?? null;
    if (input.ends_at !== undefined) next.ends_at = input.ends_at ?? null;
    if (input.venue !== undefined) next.venue = input.venue ?? null;
    if (input.capacity !== undefined) next.capacity = input.capacity ?? null;
    if (input.requires_approval !== undefined)
      next.requires_approval = input.requires_approval ?? null;
    if (input.waitlist !== undefined) next.waitlist = input.waitlist ?? null;
    if (input.visible_to_tags !== undefined) next.visible_to_tags = input.visible_to_tags;
    if (input.position !== undefined) next.position = input.position;
    const timeProblem = validTimes({
      starts_at: next.starts_at !== undefined ? next.starts_at : session.starts_at,
      ends_at: next.ends_at !== undefined ? next.ends_at : session.ends_at,
    });
    if (timeProblem) return err('invalid_input', timeProblem);
    const scheduleChanged =
      (next.starts_at !== undefined && next.starts_at !== session.starts_at) ||
      (next.ends_at !== undefined && next.ends_at !== session.ends_at) ||
      (next.venue !== undefined && !sameVenue(next.venue, session.venue));
    const updated = Object.keys(next).length
      ? await store.update('event_sessions', owner.organizationId, sessionId, next)
      : session;
    if (scheduleChanged) {
      await syncEventSpan(store, owner.organizationId, eventId, {
        schedule_version: event.schedule_version + 1,
      });
    }
    const goingCount = await store.count('event_guest_sessions', owner.organizationId, {
      eq: { session_id: sessionId, status: 'going' },
    });
    await recordAudit(store, {
      organizationId: owner.organizationId,
      userId: owner.userId,
      action: 'event.registration_changed',
      entityType: 'event',
      entityId: eventId,
      metadata: {
        session: sessionId,
        fields: Object.keys(next),
        schedule_changed: scheduleChanged,
      },
    });
    return ok({ session: updated, scheduleChanged, goingCount });
  });
}

export async function removeSession(
  store: DataStore,
  owner: EventOwner,
  eventId: string,
  sessionId: string,
  options: { confirm?: boolean } = {},
): Promise<Result<{ removed: true; guestsAffected: number }>> {
  return guard('removeSession', async () => {
    const event = await store.get('events', owner.organizationId, eventId);
    if (!event) return err('not_found', 'That event does not exist.');
    const sessions = await store.list('event_sessions', owner.organizationId, {
      eq: { event_id: eventId },
    });
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return err('not_found', 'That session does not exist.');
    if (sessions.length <= 1)
      return err('invalid_input', 'Every event keeps at least one session.');
    const guestsAffected = await store.count('event_guest_sessions', owner.organizationId, {
      eq: { session_id: sessionId },
    });
    if (guestsAffected && !options.confirm) {
      return err(
        'conflict',
        `${guestsAffected} guest${guestsAffected === 1 ? ' has' : 's have'} a status for this session. Confirm to remove it and their RSVPs for it.`,
        { details: { guests: guestsAffected } },
      );
    }
    await store.removeWhere('event_guest_sessions', owner.organizationId, {
      eq: { session_id: sessionId },
    });
    await store.remove('event_sessions', owner.organizationId, sessionId);
    // Questions tied to it stay stored (removed) for exports.
    const now = new Date().toISOString();
    const questions = (event.questions as RegistrationQuestion[]).map((q) =>
      q.session_id === sessionId && !q.removed_at ? { ...q, removed_at: now } : q,
    );
    await syncEventSpan(store, owner.organizationId, eventId, {
      schedule_version: event.schedule_version + 1,
      questions,
    });
    await recordAudit(store, {
      organizationId: owner.organizationId,
      userId: owner.userId,
      action: 'event.registration_changed',
      entityType: 'event',
      entityId: eventId,
      metadata: { session_removed: sessionId, guests_affected: guestsAffected },
    });
    return ok({ removed: true, guestsAffected });
  });
}
