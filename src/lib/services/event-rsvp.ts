import 'server-only';
import { randomUUID } from 'node:crypto';
import type { DataStore } from '@/lib/db/store';
import {
  planInviteResponse,
  planPublicRegistration,
  type PlusOnePlanInput,
  type PublicRegistrationInput,
  type RegistrationOutcome,
  type Response,
} from '@/lib/events/capacity';
import { PUBLIC_VIEWER, eventPaths, type EventInvitePrefill } from '@/lib/events/contracts';
import {
  checkAnswers,
  registrationAccepting,
  type InviteResponseInput,
  type PlusOneInput,
  type PublicRsvpInput,
  type RegistrationQuestion,
} from '@/lib/events/registration';
import { rememberCookieValue } from '@/lib/events/tokens';
import { sessionVisibleTo, viewerForGuest } from '@/lib/events/visibility';
import { recordAudit } from '@/lib/security/audit';
import type { EventGuest, EventRecord, EventSession } from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';
import { err, ok, type Result } from '@/lib/util/result';
import { guestLinks, type ResolvedGuest } from './event-public';
import { runPlanned } from './event-register';

/**
 * Guests' own RSVP writes (D-075): the public form and a personal link's
 * response. Both validate against the event's settings (open, closes at,
 * access, the sessions this person may see, the questions they are asked,
 * the plus-one limit), then plan with lib/events/capacity.ts and apply
 * atomically through event_register() (lib/services/event-register.ts).
 *
 * Nothing here sends anything: a new status lands in the "Needs notifying"
 * queue (event-guests.ts) for a person to confirm a campaign draft.
 */

/** What the RSVP form shows afterwards. Never contains another guest's data. */
export interface RsvpResult {
  outcome: RegistrationOutcome;
  /** For the remembered-RSVP cookie (httpOnly, scoped to /e/<slug>). */
  rememberCookie: string;
  ticketPath: string | null;
  invitePath: string | null;
}

/** The neutral answer to an email already on the list: reveals no link and no details. */
export const ALREADY_REGISTERED_MESSAGE =
  'You’re already registered. Use the link in your invitation, or contact the host.';

/**
 * On approval and invite-only events the form must not tell a stranger
 * whether an email is already on the guest list (an LP's, say). So an email
 * that is already there gets EXACTLY the answer a new request would get (the
 * same per-session outcome, no ticket link, a cookie that opens nothing), and
 * the host sees an "rsvp_duplicate" entry in the audit log instead. New
 * registrations there get no ticket link in the answer either; their
 * remembered browser finds it on the page. Open events keep the plain
 * "already registered" message.
 */
function quietDuplicates(event: Pick<EventRecord, 'access'>): boolean {
  return event.access !== 'open';
}

/**
 * A per-event cap on new self-registrations that does not depend on the
 * caller's address (which a client can sometimes choose): past it, the form
 * asks people to try again later and the host sees it in the audit log.
 */
export const SELF_REGISTRATIONS_PER_HOUR = 50;
const BUSY_MESSAGE = 'A lot of people are registering right now. Try again in a little while.';

function recentSelfRegistrations(
  guests: readonly Pick<EventGuest, 'source' | 'parent_guest_id' | 'created_at'>[],
  now: Date,
): number {
  const since = now.getTime() - 60 * 60 * 1000;
  return guests.filter(
    (g) =>
      !g.parent_guest_id &&
      (g.source === 'public' || g.source === 'request') &&
      Date.parse(g.created_at) >= since,
  ).length;
}

const CLOSED_MESSAGE = 'RSVPs are closed for this event. Contact the host to change yours.';

function personFields(input: {
  firstName?: string;
  lastName?: string;
  company?: string;
  title?: string;
  phone?: string;
}) {
  return {
    first_name: input.firstName?.trim() || null,
    last_name: input.lastName?.trim() || null,
    company: input.company?.trim() || null,
    title: input.title?.trim() || null,
    phone: input.phone?.trim() || null,
  };
}

function firstError(
  errors: Record<string, string>,
  questions: readonly RegistrationQuestion[],
): string {
  const [id, message] = Object.entries(errors)[0] ?? ['', 'Check your answers.'];
  const q = questions.find((x) => x.id === id);
  return q ? `${q.label}: ${message}` : message;
}

/** Plus-ones' answers and sessions, checked. */
function checkPlusOnes(
  event: EventRecord,
  plusOnes: readonly PlusOneInput[],
  chosen: readonly string[],
): { ok: true; value: PlusOnePlanInput[] } | { ok: false; message: string } {
  const reg = event.registration;
  if (plusOnes.length && reg.plus_ones.max === 0) {
    return { ok: false, message: 'This event does not take plus-ones.' };
  }
  const questions = event.questions as RegistrationQuestion[];
  const out: PlusOnePlanInput[] = [];
  for (const po of plusOnes) {
    const sessions =
      reg.plus_ones.per_session && po.sessions
        ? chosen.filter((id) => po.sessions!.includes(id))
        : [...chosen];
    if (!sessions.length) continue;
    let answers: Record<string, unknown> = {};
    if (reg.plus_ones.ask_questions) {
      const checked = checkAnswers(questions, po.answers, {
        sessionIds: new Set(sessions),
        plusOne: true,
      });
      if (!checked.ok) {
        return { ok: false, message: `${po.firstName}: ${firstError(checked.errors, questions)}` };
      }
      answers = checked.answers;
    }
    out.push({
      id: po.id,
      fields: {
        email: reg.plus_ones.collect_email ? (po.email ?? null) : null,
        first_name: po.firstName.trim(),
        last_name: po.lastName?.trim() || null,
        company: null,
        title: null,
        phone: null,
      },
      answers,
      sessionIds: reg.plus_ones.per_session ? sessions : null,
    });
  }
  return { ok: true, value: out };
}

function rememberFor(event: EventRecord, guest: Pick<EventGuest, 'id' | 'token_version'>): string {
  return rememberCookieValue({
    eventId: event.id,
    guestId: guest.id,
    tokenVersion: guest.token_version,
  });
}

/* ----------------------------------------------------------- public form */

export async function registerPublic(
  store: DataStore,
  event: EventRecord,
  sessions: readonly EventSession[],
  input: PublicRsvpInput,
  context: { ipHash: string | null; now?: Date },
): Promise<Result<RsvpResult>> {
  const now = context.now ?? new Date();
  if (event.status !== 'published') return err('forbidden', 'This event is not taking RSVPs.');
  if (!registrationAccepting(event.registration, now)) return err('forbidden', CLOSED_MESSAGE);
  if (event.access === 'invite_only') {
    if (!input.request || !event.registration.request_invite) {
      return err('forbidden', 'This event is by invitation. Use the link in your invitation.');
    }
  }
  // The public sees sessions without a tag list only.
  const offered = new Set(
    sessions.filter((s) => sessionVisibleTo(s, PUBLIC_VIEWER)).map((s) => s.id),
  );
  const chosen = [...new Set(input.sessions)];
  if (chosen.some((id) => !offered.has(id))) {
    return err('invalid_input', 'That session is not open for registration.');
  }
  const questions = event.questions as RegistrationQuestion[];
  const answers = checkAnswers(questions, input.answers, { sessionIds: new Set(chosen) });
  if (!answers.ok) return err('invalid_input', firstError(answers.errors, questions));
  const plusOnes = checkPlusOnes(event, input.plusOnes, chosen);
  if (!plusOnes.ok) return err('invalid_input', plusOnes.message);

  let guestRow: EventGuest | null = null;
  const quiet = quietDuplicates(event);
  let duplicate = false;
  let busy = false;
  let lastOutcome: RegistrationOutcome | null = null;
  const result = await runPlanned<RegistrationOutcome>(
    store,
    event.organization_id,
    event.id,
    (loaded) => {
      const registration: PublicRegistrationInput = {
        person: { ...personFields(input), email: input.email },
        sessionIds: chosen,
        answers: answers.answers,
        plusOnes: plusOnes.value,
        showOnWall: input.showOnWall,
        request: input.request,
        referralCode: input.via ?? null,
        utm: input.utm
          ? (Object.fromEntries(Object.entries(input.utm).filter(([, v]) => v)) as Record<
              string,
              string
            >)
          : null,
        ipHash: context.ipHash,
      };
      const plan = (guests: typeof loaded.guests, rows: typeof loaded.rows) =>
        planPublicRegistration(
          {
            event: loaded.event,
            sessions: loaded.sessions,
            guests,
            rows,
            now: now.toISOString(),
            newId,
          },
          registration,
        );
      if (recentSelfRegistrations(loaded.guests, now) >= SELF_REGISTRATIONS_PER_HOUR) {
        busy = true;
        return { kind: 'stop', result: err('rate_limited', BUSY_MESSAGE) };
      }
      const planned = plan(loaded.guests, loaded.rows);
      if (planned.kind === 'already_registered') {
        if (!quiet) return { kind: 'stop', result: err('conflict', ALREADY_REGISTERED_MESSAGE) };
        // What a brand-new person would have been told: plan without the
        // existing guest (nothing is written).
        const email = input.email.trim().toLowerCase();
        const existing = loaded.guests.find((g) => g.email === email);
        const others = loaded.guests.filter(
          (g) => g.id !== existing?.id && g.parent_guest_id !== existing?.id,
        );
        const kept = new Set(others.map((g) => g.id));
        const shape = plan(
          others,
          loaded.rows.filter((r) => kept.has(r.guest_id)),
        );
        duplicate = true;
        if (shape.kind === 'planned') return { kind: 'stop', result: ok(shape.outcome) };
        if (shape.kind === 'full') {
          return { kind: 'stop', result: err('conflict', 'This event is full.') };
        }
        return { kind: 'stop', result: err('invalid_input', 'Check the form and try again.') };
      }
      if (planned.kind === 'full') {
        return { kind: 'stop', result: err('conflict', 'This event is full.') };
      }
      if (planned.kind === 'invalid') {
        return { kind: 'stop', result: err('invalid_input', planned.message) };
      }
      guestRow = planned.plan.upsertGuests.find((g) => g.id === planned.outcome.guestId) ?? null;
      lastOutcome = planned.outcome;
      return { kind: 'plan', plan: planned.plan, value: planned.outcome };
    },
    {
      // A race with the same email, or a plus-one's email already on the list.
      onDuplicateEmail: () => {
        if (!quiet || !lastOutcome) return err('conflict', ALREADY_REGISTERED_MESSAGE);
        duplicate = true;
        return ok(lastOutcome);
      },
    },
  );
  if (!result.ok) {
    if (busy) {
      await recordAudit(store, {
        organizationId: event.organization_id,
        userId: null,
        action: 'event.rsvp_busy',
        entityType: 'event',
        entityId: event.id,
        metadata: { per_hour: SELF_REGISTRATIONS_PER_HOUR },
      });
    }
    return result;
  }
  if (duplicate) {
    await recordAudit(store, {
      organizationId: event.organization_id,
      userId: null,
      action: 'event.rsvp_duplicate',
      entityType: 'event',
      entityId: event.id,
      metadata: { sessions: chosen, plus_ones: input.plusOnes.length },
    });
    return ok({
      outcome: result.value,
      // Signed like a real one, for a guest that does not exist: it opens nothing.
      rememberCookie: rememberCookieValue({
        eventId: event.id,
        guestId: randomUUID(),
        tokenVersion: 1,
      }),
      ticketPath: null,
      invitePath: null,
    });
  }
  const guest = guestRow as EventGuest | null;
  if (!guest) return err('internal', 'That RSVP could not be saved. Try again.');

  await recordAudit(store, {
    organizationId: event.organization_id,
    userId: null,
    action: 'event.rsvp_received',
    entityType: 'event',
    entityId: event.id,
    metadata: {
      guest: guest.id,
      source: guest.source,
      sessions: result.value.sessions,
      plus_ones: result.value.plusOnes.length,
    },
  });
  const links = guestLinks(event, guest);
  return ok({
    outcome: result.value,
    rememberCookie: rememberFor(event, guest),
    ticketPath: quiet ? null : links.ticketPath,
    invitePath: quiet ? null : links.invitePath,
  });
}

/* --------------------------------------------------- personal-link answer */

/** Sessions a guest may answer for on their personal link. */
export function respondableSessions(
  event: EventRecord,
  sessions: readonly EventSession[],
  guest: ResolvedGuest,
): EventSession[] {
  const viewer = viewerForGuest(guest.guest, guest.rows);
  const placed = new Set(guest.rows.map((r) => r.session_id));
  return sessions.filter((s) => {
    if (!sessionVisibleTo(s, viewer)) return false;
    // Invite-only: the sessions the host invited them to (all visible ones
    // when the host gave none).
    if (event.access === 'invite_only' && placed.size) return placed.has(s.id);
    return true;
  });
}

/**
 * A personal link's current answers, to prefill and edit its form: the
 * guest's own fields, statuses, answers and plus-ones, and nothing else.
 */
export async function buildInvitePrefill(
  store: DataStore,
  event: EventRecord,
  sessions: readonly EventSession[],
  guest: ResolvedGuest,
): Promise<EventInvitePrefill> {
  const org = event.organization_id;
  const children = await store.list('event_guests', org, {
    eq: { event_id: event.id, parent_guest_id: guest.guest.id },
  });
  const childRows = children.length
    ? await store.list('event_guest_sessions', org, {
        eq: { event_id: event.id },
        in: { guest_id: children.map((c) => c.id) },
      })
    : [];
  const requestPath =
    event.access === 'invite_only'
      ? event.registration.request_invite
        ? `${eventPaths.page(event.slug)}?request=1`
        : null
      : eventPaths.page(event.slug);
  return {
    firstName: guest.guest.first_name,
    lastName: guest.guest.last_name,
    company: guest.guest.company,
    title: guest.guest.title,
    phone: guest.guest.phone,
    answers: guest.guest.answers,
    showOnWall: guest.guest.show_on_wall,
    responses: Object.fromEntries(guest.rows.map((r) => [r.session_id, r.status])),
    respondable: respondableSessions(event, sessions, guest).map((s) => s.id),
    plusOnes: children.map((c) => ({
      id: c.id,
      firstName: c.first_name ?? '',
      lastName: c.last_name,
      email: c.email,
      sessionIds: childRows
        .filter((r) => r.guest_id === c.id && r.status !== 'declined' && r.status !== 'not_going')
        .map((r) => r.session_id),
      answers: c.answers,
    })),
    requestPath,
  };
}

export async function respondInvite(
  store: DataStore,
  event: EventRecord,
  sessions: readonly EventSession[],
  guest: ResolvedGuest,
  input: InviteResponseInput,
  context: { now?: Date } = {},
): Promise<Result<RsvpResult>> {
  const now = context.now ?? new Date();
  if (event.status !== 'published') return err('forbidden', 'This event is not taking RSVPs.');
  if (!registrationAccepting(event.registration, now)) return err('forbidden', CLOSED_MESSAGE);
  const allowed = new Set(respondableSessions(event, sessions, guest).map((s) => s.id));
  const responses = input.responses as Record<string, Response>;
  if (Object.keys(responses).some((id) => !allowed.has(id))) {
    return err('invalid_input', 'That session is not part of your invitation.');
  }

  // Sessions they will attend (or might): what their questions are about.
  const attending = new Set(
    guest.rows
      .filter(
        (r) =>
          r.status === 'going' ||
          r.status === 'maybe' ||
          r.status === 'pending' ||
          r.status === 'waitlist',
      )
      .map((r) => r.session_id),
  );
  for (const [id, response] of Object.entries(responses)) {
    if (response === 'not_going') attending.delete(id);
    else attending.add(id);
  }
  const questions = event.questions as RegistrationQuestion[];
  // Someone who can't make any session is not asked anything.
  const answers = attending.size
    ? checkAnswers(
        questions,
        { ...guest.guest.answers, ...input.answers },
        { sessionIds: attending },
      )
    : ({ ok: true, answers: {} } as const);
  if (!answers.ok) return err('invalid_input', firstError(answers.errors, questions));

  let plusOnes: PlusOnePlanInput[] | undefined;
  if (input.plusOnes) {
    const goingTo = Object.entries(responses)
      .filter(([, r]) => r === 'going' || r === 'maybe')
      .map(([id]) => id);
    const checked = checkPlusOnes(event, input.plusOnes, goingTo.length ? goingTo : [...attending]);
    if (!checked.ok) return err('invalid_input', checked.message);
    plusOnes = checked.value;
  }
  const first = !guest.guest.registered_at;

  const result = await runPlanned<RegistrationOutcome>(
    store,
    event.organization_id,
    event.id,
    (loaded) => {
      const planned = planInviteResponse(
        {
          event: loaded.event,
          sessions: loaded.sessions,
          guests: loaded.guests,
          rows: loaded.rows,
          now: now.toISOString(),
          newId,
        },
        {
          guestId: guest.guest.id,
          responses,
          person: {
            first_name: input.firstName?.trim() || undefined,
            last_name: input.lastName === undefined ? undefined : input.lastName.trim() || null,
            company: input.company === undefined ? undefined : input.company.trim() || null,
            title: input.title === undefined ? undefined : input.title.trim() || null,
            phone: input.phone === undefined ? undefined : input.phone.trim() || null,
          },
          answers: answers.answers,
          plusOnes,
          showOnWall: input.showOnWall,
        },
      );
      if (planned.kind !== 'planned') {
        return {
          kind: 'stop',
          result: err(
            'invalid_input',
            planned.kind === 'invalid' ? planned.message : 'That RSVP could not be saved.',
          ),
        };
      }
      return { kind: 'plan', plan: planned.plan, value: planned.outcome };
    },
  );
  if (!result.ok) return result;

  await recordAudit(store, {
    organizationId: event.organization_id,
    userId: null,
    action: first ? 'event.rsvp_received' : 'event.rsvp_changed',
    entityType: 'event',
    entityId: event.id,
    metadata: {
      guest: guest.guest.id,
      via: 'personal_link',
      sessions: result.value.sessions,
      plus_ones: result.value.plusOnes.length,
      promoted: result.value.promoted.length,
    },
  });
  const links = guestLinks(event, guest.guest);
  return ok({
    outcome: result.value,
    rememberCookie: rememberFor(event, guest.guest),
    ticketPath: links.ticketPath,
    invitePath: links.invitePath,
  });
}
