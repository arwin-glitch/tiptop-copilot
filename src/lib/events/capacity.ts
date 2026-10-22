import type {
  EventAccess,
  EventGuest,
  EventGuestSession,
  EventGuestSource,
  EventGuestStatus,
  EventRegistrationSettings,
  EventSession,
} from '@/lib/types/domain';

/**
 * Seats, approvals and waitlists (D-075): the one place that decides which
 * status a guest gets for a session.
 *
 * Every change that can take a seat (a public RSVP, a personal-link
 * response, an approval, a promotion, a bulk move, adding guests) is planned
 * here, purely, from a snapshot of the event's guests and status rows, into
 * a RegistrationPlan: the guest rows and status rows to write. The plan is
 * then applied ATOMICALLY by event_register()
 * (20261023000200_event_register_fn.sql), which locks the event and its
 * session rows FOR UPDATE, applies the writes and refuses the whole plan if
 * it would push a session (or the event) past capacity — the same invariant
 * as `capacityViolations` below. The server then re-plans from fresh rows
 * (which now say "full", so the guest is waitlisted), up to three times. So
 * two RSVPs for the last seat can never both win.
 *
 * Rules (the spec's):
 *   - Only Going counts toward capacity, plus-ones included.
 *   - A party (guest + their plus-ones in that session) takes seats
 *     together; it is seated, waitlisted or turned away as one.
 *   - Approval: a session's own requires_approval wins; otherwise an
 *     'approval' event asks it of people who registered themselves (public
 *     form or "Request an invite"), never of guests the host added.
 *   - Waitlist: per session, first in first out by requested_at; opens only
 *     when that session is full; promotion seats the first party that fits.
 *   - A host's decline is final for the guest's own link.
 *   - Owners may force a seat past capacity ("Add directly as Going").
 *
 * Pure and isomorphic; no I/O, no clock (the caller passes `now`).
 */

/* ------------------------------------------------------------------ types */

export interface EngineEvent {
  id: string;
  organization_id: string;
  access: EventAccess;
  capacity: number | null;
  registration: EventRegistrationSettings;
}

export interface EngineContext {
  event: EngineEvent;
  sessions: readonly EventSession[];
  /** Every guest of the event (plus-ones included). */
  guests: readonly EventGuest[];
  /** Every status row of the event. */
  rows: readonly EventGuestSession[];
  now: string;
  newId: () => string;
}

/** What event_register() applies, atomically. */
export interface RegistrationPlan {
  /** Full rows; inserted when new, otherwise updated. */
  upsertGuests: EventGuest[];
  /** Guests removed (plus-ones dropped, hard deletes); their rows go with them. */
  deleteGuestIds: string[];
  /** Full rows, keyed (guest_id, session_id). */
  upsertRows: EventGuestSession[];
  deleteRows: { guest_id: string; session_id: string }[];
  /** Skip the capacity check (an owner's deliberate override). */
  force: boolean;
}

export function emptyPlan(): RegistrationPlan {
  return { upsertGuests: [], deleteGuestIds: [], upsertRows: [], deleteRows: [], force: false };
}

export function planIsEmpty(plan: RegistrationPlan): boolean {
  return (
    !plan.upsertGuests.length &&
    !plan.deleteGuestIds.length &&
    !plan.upsertRows.length &&
    !plan.deleteRows.length
  );
}

/** A session's result for one person: a status, or why nothing changed. */
export type SessionOutcome = EventGuestStatus | 'full';

/* -------------------------------------------------------------- the rules */

/** Whether this session asks for an owner's approval of this guest. */
export function needsApproval(
  session: Pick<EventSession, 'requires_approval'>,
  event: Pick<EngineEvent, 'access'>,
  source: EventGuestSource,
): boolean {
  if (session.requires_approval === true) return true;
  if (session.requires_approval === false) return false;
  return event.access === 'approval' && (source === 'public' || source === 'request');
}

/** Whether a full session takes people onto its waitlist. */
export function waitlistOn(
  session: Pick<EventSession, 'waitlist'>,
  event: Pick<EngineEvent, 'registration'>,
): boolean {
  return session.waitlist ?? event.registration.waitlist;
}

/** Sessions a person with these tags may see: no tag list, or a shared tag. */
export function sessionVisibleToTags(
  session: Pick<EventSession, 'visible_to_tags'>,
  tags: readonly string[],
): boolean {
  if (!session.visible_to_tags.length) return true;
  const mine = new Set(tags.map((t) => t.toLowerCase()));
  return session.visible_to_tags.some((t) => mine.has(t.toLowerCase()));
}

export interface SessionTally {
  going: number;
  pending: number;
  waitlist: number;
  maybe: number;
  invited: number;
  notGoing: number;
  declined: number;
  checkedIn: number;
}

const EMPTY_TALLY: SessionTally = {
  going: 0,
  pending: 0,
  waitlist: 0,
  maybe: 0,
  invited: 0,
  notGoing: 0,
  declined: 0,
  checkedIn: 0,
};

/** Counts per session (plus-ones are rows like anyone else, so they count). */
export function tallyBySession(rows: readonly EventGuestSession[]): Map<string, SessionTally> {
  const out = new Map<string, SessionTally>();
  for (const row of rows) {
    const t = out.get(row.session_id) ?? { ...EMPTY_TALLY };
    if (row.status === 'going') t.going += 1;
    else if (row.status === 'pending') t.pending += 1;
    else if (row.status === 'waitlist') t.waitlist += 1;
    else if (row.status === 'maybe') t.maybe += 1;
    else if (row.status === 'invited') t.invited += 1;
    else if (row.status === 'not_going') t.notGoing += 1;
    else if (row.status === 'declined') t.declined += 1;
    if (row.checked_in_at) t.checkedIn += 1;
    out.set(row.session_id, t);
  }
  return out;
}

export function tallyFor(tallies: Map<string, SessionTally>, sessionId: string): SessionTally {
  return tallies.get(sessionId) ?? { ...EMPTY_TALLY };
}

/** Guests going to at least one session (the event-wide capacity's count). */
export function goingGuestIds(rows: readonly EventGuestSession[]): Set<string> {
  const out = new Set<string>();
  for (const row of rows) if (row.status === 'going') out.add(row.guest_id);
  return out;
}

/**
 * Seats left in a session for new people: the smaller of the session's and
 * the event's room. Null: no limit.
 */
export function seatsLeft(
  session: Pick<EventSession, 'id' | 'capacity'>,
  event: Pick<EngineEvent, 'capacity'>,
  rows: readonly EventGuestSession[],
): number | null {
  const going = rows.filter((r) => r.session_id === session.id && r.status === 'going').length;
  const sessionRoom = session.capacity === null ? null : Math.max(0, session.capacity - going);
  const eventRoom =
    event.capacity === null ? null : Math.max(0, event.capacity - goingGuestIds(rows).size);
  if (sessionRoom === null) return eventRoom;
  if (eventRoom === null) return sessionRoom;
  return Math.min(sessionRoom, eventRoom);
}

/**
 * The invariant event_register() enforces, in TypeScript: a plan may not
 * leave a session (or the event) over capacity unless it was already there
 * and the plan does not add to it. Empty when the plan is fine.
 */
export function capacityViolations(
  before: readonly EventGuestSession[],
  after: readonly EventGuestSession[],
  sessions: readonly Pick<EventSession, 'id' | 'capacity'>[],
  eventCapacity: number | null,
): string[] {
  const out: string[] = [];
  const goingIn = (rows: readonly EventGuestSession[], id: string) =>
    rows.filter((r) => r.session_id === id && r.status === 'going').length;
  for (const s of sessions) {
    if (s.capacity === null) continue;
    const was = goingIn(before, s.id);
    const now = goingIn(after, s.id);
    if (now > s.capacity && now > was) out.push(s.id);
  }
  if (eventCapacity !== null) {
    const was = goingGuestIds(before).size;
    const now = goingGuestIds(after).size;
    if (now > eventCapacity && now > was) out.push('event');
  }
  return out;
}

/** Rows after a plan is applied (what event_register() leaves behind). */
export function rowsAfterPlan(
  rows: readonly EventGuestSession[],
  plan: RegistrationPlan,
): EventGuestSession[] {
  const key = (g: string, s: string) => `${g}|${s}`;
  const map = new Map(rows.map((r) => [key(r.guest_id, r.session_id), r]));
  const deletedGuests = new Set(plan.deleteGuestIds);
  for (const [k, r] of map) if (deletedGuests.has(r.guest_id)) map.delete(k);
  for (const d of plan.deleteRows) map.delete(key(d.guest_id, d.session_id));
  for (const r of plan.upsertRows) {
    if (!deletedGuests.has(r.guest_id)) map.set(key(r.guest_id, r.session_id), r);
  }
  return [...map.values()];
}

/* ----------------------------------------------------------- working copy */

const rowKey = (guestId: string, sessionId: string) => `${guestId}|${sessionId}`;

/**
 * A mutable copy of the event's guests and rows that records what changed,
 * so multi-step plans (a response that frees a seat and then promotes
 * someone) see their own earlier steps.
 */
export class Draft {
  readonly event: EngineEvent;
  readonly sessions: readonly EventSession[];
  readonly now: string;
  readonly newId: () => string;
  private readonly rows = new Map<string, EventGuestSession>();
  private readonly guests = new Map<string, EventGuest>();
  private readonly touchedRows = new Set<string>();
  private readonly removedRows = new Map<string, { guest_id: string; session_id: string }>();
  private readonly touchedGuests = new Set<string>();
  private readonly removedGuests = new Set<string>();
  private readonly originalRows: readonly EventGuestSession[];

  constructor(ctx: EngineContext) {
    this.event = ctx.event;
    this.sessions = [...ctx.sessions].sort((a, b) => a.position - b.position);
    this.now = ctx.now;
    this.newId = ctx.newId;
    this.originalRows = ctx.rows;
    for (const g of ctx.guests) this.guests.set(g.id, g);
    for (const r of ctx.rows) this.rows.set(rowKey(r.guest_id, r.session_id), r);
  }

  session(id: string): EventSession | undefined {
    return this.sessions.find((s) => s.id === id);
  }

  guest(id: string): EventGuest | undefined {
    return this.guests.get(id);
  }

  allGuests(): EventGuest[] {
    return [...this.guests.values()];
  }

  guestByEmail(email: string): EventGuest | undefined {
    const wanted = email.trim().toLowerCase();
    for (const g of this.guests.values()) if (g.email === wanted) return g;
    return undefined;
  }

  childrenOf(guestId: string): EventGuest[] {
    return [...this.guests.values()].filter((g) => g.parent_guest_id === guestId);
  }

  row(guestId: string, sessionId: string): EventGuestSession | undefined {
    return this.rows.get(rowKey(guestId, sessionId));
  }

  status(guestId: string, sessionId: string): EventGuestStatus | null {
    return this.row(guestId, sessionId)?.status ?? null;
  }

  rowsOf(guestId: string): EventGuestSession[] {
    return [...this.rows.values()].filter((r) => r.guest_id === guestId);
  }

  allRows(): EventGuestSession[] {
    return [...this.rows.values()];
  }

  goingIn(sessionId: string): number {
    let n = 0;
    for (const r of this.rows.values()) if (r.session_id === sessionId && r.status === 'going') n++;
    return n;
  }

  goingGuests(): Set<string> {
    return goingGuestIds([...this.rows.values()]);
  }

  /** Whether these people can all be seated in the session now. */
  fits(sessionId: string, people: readonly string[]): boolean {
    const session = this.session(sessionId);
    if (!session) return false;
    const newcomers = people.filter((id) => this.status(id, sessionId) !== 'going');
    if (
      session.capacity !== null &&
      this.goingIn(sessionId) + newcomers.length > session.capacity
    ) {
      return false;
    }
    if (this.event.capacity !== null) {
      const going = this.goingGuests();
      const added = newcomers.filter((id) => !going.has(id)).length;
      if (going.size + added > this.event.capacity) return false;
    }
    return true;
  }

  upsertGuest(guest: EventGuest): void {
    this.guests.set(guest.id, guest);
    this.touchedGuests.add(guest.id);
    this.removedGuests.delete(guest.id);
  }

  deleteGuest(id: string): void {
    for (const child of this.childrenOf(id)) this.deleteGuest(child.id);
    this.guests.delete(id);
    this.touchedGuests.delete(id);
    this.removedGuests.add(id);
    for (const [k, r] of this.rows) {
      if (r.guest_id === id) {
        this.rows.delete(k);
        this.touchedRows.delete(k);
      }
    }
  }

  setStatus(
    guestId: string,
    sessionId: string,
    status: EventGuestStatus,
    extra: Partial<
      Pick<
        EventGuestSession,
        | 'requested_at'
        | 'decided_by'
        | 'decided_at'
        | 'decision_note'
        | 'claim_expires_at'
        | 'checked_in_at'
        | 'checked_in_by'
      >
    > = {},
  ): void {
    const k = rowKey(guestId, sessionId);
    const existing = this.rows.get(k);
    const base: EventGuestSession = existing ?? {
      guest_id: guestId,
      session_id: sessionId,
      organization_id: this.event.organization_id,
      event_id: this.event.id,
      status,
      requested_at: null,
      decided_by: null,
      decided_at: null,
      decision_note: null,
      claim_expires_at: null,
      checked_in_at: null,
      checked_in_by: null,
      created_at: this.now,
      updated_at: this.now,
    };
    if (existing && existing.status === status && !Object.keys(extra).length) return;
    this.rows.set(k, { ...base, ...extra, status, updated_at: this.now });
    this.touchedRows.add(k);
    this.removedRows.delete(k);
  }

  removeRow(guestId: string, sessionId: string): void {
    const k = rowKey(guestId, sessionId);
    if (!this.rows.has(k)) return;
    this.rows.delete(k);
    this.touchedRows.delete(k);
    this.removedRows.set(k, { guest_id: guestId, session_id: sessionId });
  }

  plan(force = false): RegistrationPlan {
    const removedGuests = [...this.removedGuests];
    const removedSet = new Set(removedGuests);
    return {
      upsertGuests: [...this.touchedGuests]
        .map((id) => this.guests.get(id))
        .filter((g): g is EventGuest => Boolean(g)),
      deleteGuestIds: removedGuests,
      upsertRows: [...this.touchedRows]
        .map((k) => this.rows.get(k))
        .filter((r): r is EventGuestSession => Boolean(r)),
      deleteRows: [...this.removedRows.values()].filter(
        (d) =>
          !removedSet.has(d.guest_id) &&
          this.originalRows.some((r) => r.guest_id === d.guest_id && r.session_id === d.session_id),
      ),
      force,
    };
  }
}

/* -------------------------------------------------------------- promotion */

export interface Promotion {
  guestId: string;
  sessionId: string;
  partySize: number;
}

/** FIFO order of a waitlist: request time, then when they were added. */
function waitOrder(draft: Draft, sessionId: string): EventGuest[] {
  return draft
    .allGuests()
    .filter((g) => !g.parent_guest_id && draft.status(g.id, sessionId) === 'waitlist')
    .sort((a, b) => {
      const ra = draft.row(a.id, sessionId)?.requested_at ?? a.created_at;
      const rb = draft.row(b.id, sessionId)?.requested_at ?? b.created_at;
      return ra.localeCompare(rb) || a.created_at.localeCompare(b.created_at);
    });
}

/**
 * Seat waitlisted parties, first in first out, each one that fits. With
 * `guestIds`, only those guests (an owner's "Promote"); with `force`, past
 * capacity.
 */
export function promoteWaitlist(
  draft: Draft,
  sessionIds: readonly string[],
  options: { guestIds?: readonly string[]; force?: boolean; by?: string | null } = {},
): Promotion[] {
  const promoted: Promotion[] = [];
  for (const sessionId of sessionIds) {
    for (const guest of waitOrder(draft, sessionId)) {
      if (options.guestIds && !options.guestIds.includes(guest.id)) continue;
      const party = [
        guest.id,
        ...draft
          .childrenOf(guest.id)
          .filter((c) => draft.status(c.id, sessionId) === 'waitlist')
          .map((c) => c.id),
      ];
      if (!options.force && !draft.fits(sessionId, party)) continue;
      for (const id of party) {
        draft.setStatus(id, sessionId, 'going', {
          decided_at: draft.now,
          decided_by: options.by ?? null,
        });
      }
      promoted.push({ guestId: guest.id, sessionId, partySize: party.length });
    }
    // Plus-ones waitlisted alone (an owner seated their host but not them).
    if (options.guestIds) {
      for (const id of options.guestIds) {
        const g = draft.guest(id);
        if (!g?.parent_guest_id || draft.status(id, sessionId) !== 'waitlist') continue;
        if (!options.force && !draft.fits(sessionId, [id])) continue;
        draft.setStatus(id, sessionId, 'going', {
          decided_at: draft.now,
          decided_by: options.by ?? null,
        });
        promoted.push({ guestId: id, sessionId, partySize: 1 });
      }
    }
  }
  return promoted;
}

/** Sessions whose Going count dropped between two row sets (seats freed). */
export function freedSessions(
  before: readonly EventGuestSession[],
  after: readonly EventGuestSession[],
): string[] {
  const count = (rows: readonly EventGuestSession[]) => {
    const m = new Map<string, number>();
    for (const r of rows)
      if (r.status === 'going') m.set(r.session_id, (m.get(r.session_id) ?? 0) + 1);
    return m;
  };
  const was = count(before);
  const now = count(after);
  return [...was.keys()].filter((id) => (now.get(id) ?? 0) < (was.get(id) ?? 0));
}

/** Auto-promote after seats were freed, when the event allows it. */
export function autoPromote(draft: Draft, before: readonly EventGuestSession[]): Promotion[] {
  if (!draft.event.registration.auto_promote) return [];
  const freed = freedSessions(before, draft.allRows());
  return freed.length ? promoteWaitlist(draft, freed) : [];
}

/* ----------------------------------------------------- people → new rows */

export interface PersonFields {
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  title: string | null;
  phone: string | null;
}

export function newGuestRow(
  draft: Draft,
  fields: PersonFields & {
    id?: string;
    parent_guest_id?: string | null;
    source: EventGuestSource;
    answers?: Record<string, unknown>;
    tags?: string[];
    record_id?: string | null;
    show_on_wall?: boolean;
    referral_code?: string | null;
    utm?: Record<string, string> | null;
    ip_hash?: string | null;
    registered_at?: string | null;
  },
): EventGuest {
  return {
    id: fields.id ?? draft.newId(),
    organization_id: draft.event.organization_id,
    event_id: draft.event.id,
    parent_guest_id: fields.parent_guest_id ?? null,
    email: fields.email ? fields.email.trim().toLowerCase() : null,
    first_name: fields.first_name,
    last_name: fields.last_name,
    company: fields.company,
    title: fields.title,
    phone: fields.phone,
    record_id: fields.record_id ?? null,
    tags: fields.tags ?? [],
    host_note: null,
    answers: fields.answers ?? {},
    source: fields.source,
    token_version: 1,
    show_on_wall: fields.show_on_wall ?? false,
    referral_code: fields.referral_code ?? null,
    utm: fields.utm ?? null,
    ip_hash: fields.ip_hash ?? null,
    notified_status: {},
    registered_at: fields.registered_at ?? null,
    created_at: draft.now,
    updated_at: draft.now,
  };
}

/* ------------------------------------------------- public registration */

export interface PlusOnePlanInput {
  id?: string;
  fields: PersonFields;
  answers: Record<string, unknown>;
  /** Sessions they come to; the parent's chosen sessions when null. */
  sessionIds: readonly string[] | null;
}

export interface PublicRegistrationInput {
  person: PersonFields & { email: string };
  sessionIds: readonly string[];
  answers: Record<string, unknown>;
  plusOnes: readonly PlusOnePlanInput[];
  showOnWall: boolean;
  /** An invite-only page's "Request an invite": every session waits for approval. */
  request: boolean;
  referralCode: string | null;
  utm: Record<string, string> | null;
  ipHash: string | null;
}

export interface RegistrationOutcome {
  guestId: string;
  sessions: Record<string, SessionOutcome>;
  plusOnes: { id: string; sessions: Record<string, SessionOutcome> }[];
  promoted: Promotion[];
}

export type PlanResult =
  | { kind: 'planned'; plan: RegistrationPlan; outcome: RegistrationOutcome }
  | { kind: 'already_registered' }
  | { kind: 'full' }
  | { kind: 'invalid'; message: string };

/** Which sessions one plus-one joins, of those the parent chose. */
function plusOneSessions(po: PlusOnePlanInput, chosen: readonly string[]): string[] {
  if (!po.sessionIds) return [...chosen];
  return chosen.filter((id) => po.sessionIds!.includes(id));
}

/**
 * A new registration from the public form (open or approval events) or an
 * invite-only page's "Request an invite".
 */
export function planPublicRegistration(
  ctx: EngineContext,
  input: PublicRegistrationInput,
): PlanResult {
  const draft = new Draft(ctx);
  if (draft.guestByEmail(input.person.email)) return { kind: 'already_registered' };
  const max = ctx.event.registration.plus_ones.max;
  for (const sessionId of input.sessionIds) {
    if (!draft.session(sessionId)) return { kind: 'invalid', message: 'That session is not open.' };
    const extra = input.plusOnes.filter((po) => plusOneSessions(po, [sessionId]).length).length;
    if (extra > max) {
      return {
        kind: 'invalid',
        message: max
          ? `Bring up to ${max} guest${max === 1 ? '' : 's'}.`
          : 'Guests cannot bring a plus-one.',
      };
    }
  }

  const guest = newGuestRow(draft, {
    ...input.person,
    source: input.request ? 'request' : 'public',
    answers: input.answers,
    show_on_wall: input.showOnWall,
    referral_code: input.referralCode,
    utm: input.utm,
    ip_hash: input.ipHash,
    registered_at: ctx.now,
  });
  const plusOnes = input.plusOnes.map((po) => ({
    row: newGuestRow(draft, {
      ...po.fields,
      email: ctx.event.registration.plus_ones.collect_email ? po.fields.email : null,
      parent_guest_id: guest.id,
      source: 'plus_one',
      answers: po.answers,
      registered_at: ctx.now,
    }),
    sessions: plusOneSessions(po, input.sessionIds),
  }));

  draft.upsertGuest(guest);
  for (const po of plusOnes) draft.upsertGuest(po.row);

  const outcome: RegistrationOutcome = {
    guestId: guest.id,
    sessions: {},
    plusOnes: plusOnes.map((po) => ({ id: po.row.id, sessions: {} })),
    promoted: [],
  };

  for (const sessionId of input.sessionIds) {
    const session = draft.session(sessionId)!;
    const partyPlusOnes = plusOnes.filter((po) => po.sessions.includes(sessionId));
    const party = [guest.id, ...partyPlusOnes.map((po) => po.row.id)];
    let status: SessionOutcome;
    if (input.request || needsApproval(session, ctx.event, guest.source)) status = 'pending';
    else if (draft.fits(sessionId, party)) status = 'going';
    else if (waitlistOn(session, ctx.event)) status = 'waitlist';
    else status = 'full';
    outcome.sessions[sessionId] = status;
    for (const po of partyPlusOnes) {
      outcome.plusOnes.find((p) => p.id === po.row.id)!.sessions[sessionId] = status;
    }
    if (status === 'full') continue;
    for (const id of party) draft.setStatus(id, sessionId, status, { requested_at: ctx.now });
  }

  if (Object.values(outcome.sessions).every((s) => s === 'full')) return { kind: 'full' };
  return { kind: 'planned', plan: draft.plan(), outcome };
}

/* ---------------------------------------------- personal-link responses */

export type Response = 'going' | 'maybe' | 'not_going';

export interface InviteResponsePlanInput {
  guestId: string;
  responses: Readonly<Record<string, Response>>;
  /** Fields the guest may change (email never). Undefined: unchanged. */
  person?: Partial<Omit<PersonFields, 'email'>>;
  /** Answers to merge over the stored ones (already checked). */
  answers?: Record<string, unknown>;
  /** The full plus-one list, replacing the stored one. Undefined: unchanged. */
  plusOnes?: readonly PlusOnePlanInput[];
  showOnWall?: boolean;
}

/**
 * A personal link's response: Going / Maybe / Can't go per session, with
 * plus-ones and answers. The same link edits or cancels later. Cancelling a
 * seat frees it, and auto-promote (when on) seats the first waitlisted party
 * that fits.
 */
export function planInviteResponse(ctx: EngineContext, input: InviteResponsePlanInput): PlanResult {
  const draft = new Draft(ctx);
  const guest = draft.guest(input.guestId);
  if (!guest || guest.parent_guest_id)
    return { kind: 'invalid', message: 'That invitation is not valid.' };
  const before = draft.allRows();
  const reg = ctx.event.registration;

  for (const [sessionId, response] of Object.entries(input.responses)) {
    if (!draft.session(sessionId)) return { kind: 'invalid', message: 'That session is not open.' };
    if (response === 'maybe' && !reg.response_set.maybe) {
      return { kind: 'invalid', message: 'Choose Going or Can’t go.' };
    }
  }

  // The guest's own fields and answers.
  draft.upsertGuest({
    ...guest,
    first_name: input.person?.first_name ?? guest.first_name,
    last_name: input.person?.last_name ?? guest.last_name,
    company: input.person?.company ?? guest.company,
    title: input.person?.title ?? guest.title,
    phone: input.person?.phone ?? guest.phone,
    answers: input.answers ? { ...guest.answers, ...input.answers } : guest.answers,
    show_on_wall: input.showOnWall ?? guest.show_on_wall,
    registered_at: guest.registered_at ?? ctx.now,
    updated_at: ctx.now,
  });

  // Plus-ones: the list replaces the stored one.
  const responded = Object.keys(input.responses);
  const wanted = new Map<string, readonly string[]>(); // plus-one id → sessions
  if (input.plusOnes) {
    const keep = new Set(input.plusOnes.map((p) => p.id).filter(Boolean) as string[]);
    for (const child of draft.childrenOf(guest.id))
      if (!keep.has(child.id)) draft.deleteGuest(child.id);
    for (const po of input.plusOnes) {
      const existing = po.id ? draft.guest(po.id) : undefined;
      if (po.id && (!existing || existing.parent_guest_id !== guest.id)) {
        return { kind: 'invalid', message: 'That guest is not on this invitation.' };
      }
      const row: EventGuest = existing
        ? {
            ...existing,
            first_name: po.fields.first_name,
            last_name: po.fields.last_name,
            email: reg.plus_ones.collect_email ? po.fields.email : existing.email,
            answers: { ...existing.answers, ...po.answers },
            updated_at: ctx.now,
          }
        : newGuestRow(draft, {
            ...po.fields,
            email: reg.plus_ones.collect_email ? po.fields.email : null,
            parent_guest_id: guest.id,
            source: 'plus_one',
            answers: po.answers,
            registered_at: ctx.now,
          });
      draft.upsertGuest(row);
      wanted.set(row.id, po.sessionIds ?? responded);
    }
  } else {
    for (const child of draft.childrenOf(guest.id)) {
      wanted.set(
        child.id,
        draft.rowsOf(child.id).map((r) => r.session_id),
      );
    }
  }

  for (const sessionId of responded) {
    const max = reg.plus_ones.max;
    const count = [...wanted.values()].filter((s) => s.includes(sessionId)).length;
    if (input.responses[sessionId] === 'going' && count > max) {
      return {
        kind: 'invalid',
        message: max
          ? `Bring up to ${max} guest${max === 1 ? '' : 's'}.`
          : 'Guests cannot bring a plus-one.',
      };
    }
  }

  const outcome: RegistrationOutcome = {
    guestId: guest.id,
    sessions: {},
    plusOnes: [...wanted.keys()].map((id) => ({ id, sessions: {} })),
    promoted: [],
  };
  const setPlusOne = (id: string, sessionId: string, status: SessionOutcome) => {
    const entry = outcome.plusOnes.find((p) => p.id === id);
    if (entry) entry.sessions[sessionId] = status;
  };

  for (const sessionId of responded) {
    const session = draft.session(sessionId)!;
    const response = input.responses[sessionId]!;
    const prev = draft.status(guest.id, sessionId);
    const children = [...wanted.entries()]
      .filter(([, s]) => s.includes(sessionId))
      .map(([id]) => id);
    const others = draft
      .childrenOf(guest.id)
      .map((c) => c.id)
      .filter((id) => !children.includes(id));
    // Plus-ones who no longer come to this session leave it.
    for (const id of others) draft.removeRow(id, sessionId);

    if (prev === 'declined') {
      outcome.sessions[sessionId] = 'declined';
      for (const id of children) draft.removeRow(id, sessionId);
      continue;
    }

    if (response === 'not_going' || response === 'maybe') {
      const status: EventGuestStatus = response;
      draft.setStatus(
        guest.id,
        sessionId,
        status,
        prev === status ? {} : { requested_at: ctx.now },
      );
      outcome.sessions[sessionId] = status;
      for (const id of children) {
        if (status === 'maybe') draft.setStatus(id, sessionId, 'maybe');
        else draft.removeRow(id, sessionId);
        setPlusOne(id, sessionId, status);
      }
      continue;
    }

    // Going.
    if (prev === 'going') {
      outcome.sessions[sessionId] = 'going';
      const seated = children.filter((id) => draft.status(id, sessionId) === 'going');
      const newcomers = children.filter((id) => draft.status(id, sessionId) !== 'going');
      for (const id of seated) setPlusOne(id, sessionId, 'going');
      if (!newcomers.length) continue;
      if (draft.fits(sessionId, newcomers)) {
        for (const id of newcomers) {
          draft.setStatus(id, sessionId, 'going', { requested_at: ctx.now });
          setPlusOne(id, sessionId, 'going');
        }
      } else {
        const wait = waitlistOn(session, ctx.event);
        for (const id of newcomers) {
          if (wait) draft.setStatus(id, sessionId, 'waitlist', { requested_at: ctx.now });
          else draft.removeRow(id, sessionId);
          setPlusOne(id, sessionId, wait ? 'waitlist' : 'full');
        }
      }
      continue;
    }

    if (prev === 'pending' || prev === 'waitlist') {
      outcome.sessions[sessionId] = prev;
      for (const id of children) {
        const cur = draft.status(id, sessionId);
        if (cur !== prev) draft.setStatus(id, sessionId, prev, { requested_at: ctx.now });
        setPlusOne(id, sessionId, prev);
      }
      continue;
    }

    const party = [guest.id, ...children];
    let status: SessionOutcome;
    if (needsApproval(session, ctx.event, guest.source)) status = 'pending';
    else if (draft.fits(sessionId, party)) status = 'going';
    else if (waitlistOn(session, ctx.event)) status = 'waitlist';
    else status = 'full';
    outcome.sessions[sessionId] = status;
    for (const id of children) setPlusOne(id, sessionId, status);
    if (status === 'full') {
      for (const id of children) draft.removeRow(id, sessionId);
      continue;
    }
    for (const id of party) draft.setStatus(id, sessionId, status, { requested_at: ctx.now });
  }

  outcome.promoted = autoPromote(draft, before).filter((p) => p.guestId !== guest.id);
  return { kind: 'planned', plan: draft.plan(), outcome };
}

/* ------------------------------------------------------- owner decisions */

export type HostMove =
  'going' | 'waitlist' | 'declined' | 'not_going' | 'pending' | 'invited' | 'maybe';

export interface HostStatusInput {
  guestIds: readonly string[];
  /** Sessions to change; null: every session the guest has a row in. */
  sessionIds: readonly string[] | null;
  to: HostMove;
  /** Only rows currently in these statuses (Approve: pending; Promote: waitlist). */
  from?: readonly EventGuestStatus[];
  note?: string | null;
  by: string | null;
  /** Seat past capacity. */
  force?: boolean;
}

export interface HostStatusOutcome {
  changed: {
    guestId: string;
    sessionId: string;
    from: EventGuestStatus | null;
    to: EventGuestStatus;
  }[];
  /** Parties that could not be seated (no room), by guest and session. */
  full: { guestId: string; sessionId: string }[];
  promoted: Promotion[];
}

/**
 * An owner's status change for guests (singly or in bulk): approve, decline,
 * move to Going or Waitlist, promote. Plus-ones follow their guest in each
 * session; a plus-one selected on their own moves alone.
 */
export function planHostStatus(
  ctx: EngineContext,
  input: HostStatusInput,
): { plan: RegistrationPlan; outcome: HostStatusOutcome } {
  const draft = new Draft(ctx);
  const before = draft.allRows();
  const outcome: HostStatusOutcome = { changed: [], full: [], promoted: [] };
  const selected = new Set(input.guestIds);
  const decision =
    input.to === 'going' || input.to === 'declined' || input.to === 'waitlist'
      ? { decided_by: input.by, decided_at: ctx.now, decision_note: input.note ?? null }
      : {};

  for (const guestId of input.guestIds) {
    const guest = draft.guest(guestId);
    if (!guest) continue;
    // A plus-one whose host is also selected moves with the host.
    if (guest.parent_guest_id && selected.has(guest.parent_guest_id)) continue;
    const sessionIds = input.sessionIds ?? draft.rowsOf(guestId).map((r) => r.session_id);
    for (const sessionId of sessionIds) {
      if (!draft.session(sessionId)) continue;
      const prev = draft.status(guestId, sessionId);
      if (input.from && (!prev || !input.from.includes(prev))) continue;
      if (prev === input.to && !input.note) continue;
      const party = guest.parent_guest_id
        ? [guestId]
        : [
            guestId,
            ...draft
              .childrenOf(guestId)
              .filter((c) => {
                const s = draft.status(c.id, sessionId);
                return s !== null && s !== 'declined' && s !== 'not_going';
              })
              .map((c) => c.id),
          ];
      if (input.to === 'going' && !input.force && !draft.fits(sessionId, party)) {
        outcome.full.push({ guestId, sessionId });
        continue;
      }
      for (const id of party) {
        const was = draft.status(id, sessionId);
        if (input.to === 'not_going' && id !== guestId) {
          draft.removeRow(id, sessionId);
          continue;
        }
        draft.setStatus(id, sessionId, input.to, {
          ...decision,
          ...(was === null || input.to === 'waitlist' || input.to === 'pending'
            ? { requested_at: draft.row(id, sessionId)?.requested_at ?? ctx.now }
            : {}),
        });
        if (id === guestId) outcome.changed.push({ guestId, sessionId, from: was, to: input.to });
      }
    }
  }

  // Auto-promote on cancellation (a decline or "not going"), never on an
  // owner's explicit move to the waitlist.
  if (input.to === 'declined' || input.to === 'not_going') {
    outcome.promoted = autoPromote(draft, before);
  }
  return { plan: draft.plan(Boolean(input.force)), outcome };
}

/** An owner's "Promote": seat these waitlisted guests (FIFO among them) if they fit. */
export function planPromote(
  ctx: EngineContext,
  input: {
    guestIds: readonly string[];
    sessionIds: readonly string[] | null;
    by: string | null;
    force?: boolean;
  },
): { plan: RegistrationPlan; outcome: HostStatusOutcome } {
  const draft = new Draft(ctx);
  const sessionIds = input.sessionIds ?? draft.sessions.map((s) => s.id);
  const promoted = promoteWaitlist(draft, sessionIds, {
    guestIds: input.guestIds,
    force: input.force,
    by: input.by,
  });
  const full: HostStatusOutcome['full'] = [];
  for (const guestId of input.guestIds) {
    for (const sessionId of sessionIds) {
      if (draft.status(guestId, sessionId) === 'waitlist') full.push({ guestId, sessionId });
    }
  }
  return {
    plan: draft.plan(Boolean(input.force)),
    outcome: {
      changed: promoted.map((p) => ({
        guestId: p.guestId,
        sessionId: p.sessionId,
        from: 'waitlist',
        to: 'going',
      })),
      full,
      promoted,
    },
  };
}

/* ------------------------------------------------------------ adding guests */

export interface AddPerson extends PersonFields {
  record_id?: string | null;
  tags?: string[];
  answers?: Record<string, unknown>;
}

export interface AddGuestsInput {
  people: readonly AddPerson[];
  sessionIds: readonly string[];
  /** 'invited' normally; 'going' to seat comps and VIPs directly (skips approval and capacity). */
  status: 'invited' | 'going';
  source: EventGuestSource;
  by: string | null;
  /** Walk-ins: checked in on arrival. */
  checkedInBy?: string | null;
}

export interface AddGuestsOutcome {
  added: string[];
  /** Already on the list (same email): linked/tagged, sessions added. */
  merged: string[];
  /** Seated past capacity by "Add directly as Going". */
  overCapacity: number;
}

/**
 * Add people to the guest list (manual, pasted emails, CRM, CSV import,
 * walk-ins). Deduplicated on email; an existing guest is linked to the CRM
 * record, gains the tags and any missing sessions.
 */
export function planAddGuests(
  ctx: EngineContext,
  input: AddGuestsInput,
): { plan: RegistrationPlan; outcome: AddGuestsOutcome } {
  const draft = new Draft(ctx);
  const outcome: AddGuestsOutcome = { added: [], merged: [], overCapacity: 0 };
  const seen = new Set<string>();
  for (const person of input.people) {
    const email = person.email?.trim().toLowerCase() || null;
    if (email) {
      if (seen.has(email)) continue;
      seen.add(email);
    }
    const existing = email ? draft.guestByEmail(email) : undefined;
    let guestId: string;
    if (existing) {
      guestId = existing.id;
      const tags = [...new Set([...existing.tags, ...(person.tags ?? [])])];
      draft.upsertGuest({
        ...existing,
        record_id: existing.record_id ?? person.record_id ?? null,
        tags,
        first_name: existing.first_name || person.first_name,
        last_name: existing.last_name || person.last_name,
        company: existing.company || person.company,
        title: existing.title || person.title,
        phone: existing.phone || person.phone,
        updated_at: ctx.now,
      });
      outcome.merged.push(guestId);
    } else {
      const row = newGuestRow(draft, {
        ...person,
        email,
        source: input.source,
        tags: person.tags ?? [],
        record_id: person.record_id ?? null,
        answers: person.answers ?? {},
        registered_at: input.status === 'going' ? ctx.now : null,
      });
      draft.upsertGuest(row);
      guestId = row.id;
      outcome.added.push(guestId);
    }
    for (const sessionId of input.sessionIds) {
      if (!draft.session(sessionId)) continue;
      const prev = draft.status(guestId, sessionId);
      if (input.status === 'invited') {
        if (prev === null) draft.setStatus(guestId, sessionId, 'invited');
        continue;
      }
      if (prev === 'going') continue;
      if (!draft.fits(sessionId, [guestId])) outcome.overCapacity += 1;
      draft.setStatus(guestId, sessionId, 'going', {
        requested_at: ctx.now,
        decided_at: ctx.now,
        decided_by: input.by,
        ...(input.checkedInBy ? { checked_in_at: ctx.now, checked_in_by: input.checkedInBy } : {}),
      });
    }
  }
  return { plan: draft.plan(input.status === 'going'), outcome };
}

/** Add or take away a session for these guests (bulk bar). */
export function planSessionMembership(
  ctx: EngineContext,
  input: { guestIds: readonly string[]; sessionId: string; add: boolean },
): { plan: RegistrationPlan; outcome: { changed: number; promoted: Promotion[] } } {
  const draft = new Draft(ctx);
  const before = draft.allRows();
  let changed = 0;
  if (!draft.session(input.sessionId))
    return { plan: draft.plan(), outcome: { changed, promoted: [] } };
  for (const id of input.guestIds) {
    const guest = draft.guest(id);
    if (!guest) continue;
    const ids = guest.parent_guest_id ? [id] : [id, ...draft.childrenOf(id).map((c) => c.id)];
    for (const gid of ids) {
      const prev = draft.status(gid, input.sessionId);
      if (input.add) {
        if (prev === null && gid === id) {
          draft.setStatus(gid, input.sessionId, 'invited');
          changed++;
        }
      } else if (prev !== null) {
        draft.removeRow(gid, input.sessionId);
        if (gid === id) changed++;
      }
    }
  }
  const promoted = input.add ? [] : autoPromote(draft, before);
  return { plan: draft.plan(), outcome: { changed, promoted } };
}

/** Hard-delete guests (their plus-ones and rows go with them). */
export function planRemoveGuests(
  ctx: EngineContext,
  guestIds: readonly string[],
): { plan: RegistrationPlan; outcome: { removed: number; promoted: Promotion[] } } {
  const draft = new Draft(ctx);
  const before = draft.allRows();
  let removed = 0;
  for (const id of guestIds) {
    if (!draft.guest(id)) continue;
    draft.deleteGuest(id);
    removed++;
  }
  const promoted = autoPromote(draft, before);
  return { plan: draft.plan(), outcome: { removed, promoted } };
}
