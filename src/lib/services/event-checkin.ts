import 'server-only';
import { getAuthContext, hasRole } from '@/lib/auth/session';
import { isMissingColumnError, isMissingTableError } from '@/lib/db/missing-table';
import type { DataStore } from '@/lib/db/store';
import { soleOrganizationId } from '@/lib/db/tenancy';
import { planAddGuests } from '@/lib/events/capacity';
import type { EventGrant } from '@/lib/events/contracts';
import { resolveGrant } from '@/lib/events/editor-auth';
import { recordAudit } from '@/lib/security/audit';
import { log } from '@/lib/security/redact';
import type { EventGuest, EventGuestSession, EventRecord, EventSession } from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';
import { err, ok, type Result } from '@/lib/util/result';
import { runPlanned } from './event-register';

/**
 * Check-in (D-075): the door list, one-tap check-in and undo per session,
 * walk-ins, and the QR landing's check-in.
 *
 * Who may check people in: an owner (a signed-in member of the event's
 * organization) or a staff link's holder (WS3's grant with role 'checkin',
 * re-checked on every request, valid until the event ends + 12 h). Staff
 * see names, companies and statuses only: never emails, notes or links.
 *
 * Check-in is a single compare-and-set (`checked_in_at is null`), so two
 * phones scanning the same QR give one check-in and one amber "already
 * checked in 6:42 PM by Robin". A GET never checks anyone in.
 */

/** Staff links stop working this long after the event ends. */
export const STAFF_GRACE_MS = 12 * 60 * 60 * 1000;

export type CheckinActor =
  | { kind: 'owner'; userId: string; name: string }
  | { kind: 'staff'; grantId: string; name: string };

export function checkinActorKey(actor: CheckinActor): string {
  return actor.kind === 'owner' ? `u:${actor.userId}` : `g:${actor.grantId}`;
}

/** A staff grant as a check-in actor, when it allows check-in for this event now. */
export function staffActor(
  grant: EventGrant,
  event: Pick<EventRecord, 'id' | 'ends_at' | 'starts_at'>,
  now: Date = new Date(),
): CheckinActor | null {
  if (grant.eventId !== event.id || !grant.capabilities.checkIn) return null;
  const end = event.ends_at ?? event.starts_at;
  if (end && now.getTime() > Date.parse(end) + STAFF_GRACE_MS) return null;
  return { kind: 'staff', grantId: grant.grantId, name: grant.label };
}

/**
 * Who is checking people in on this request: a signed-in member of the
 * event's organization, else a live staff link (the grant cookie, re-checked
 * by WS3's resolveGrant on every request), else nobody.
 */
export async function resolveCheckinActor(
  store: DataStore,
  event: Pick<EventRecord, 'id' | 'organization_id' | 'ends_at' | 'starts_at'>,
  grantCookie: string | null | undefined,
): Promise<CheckinActor | null> {
  const auth = await getAuthContext().catch(() => null);
  if (auth && auth.organizationId === event.organization_id && hasRole(auth, 'member')) {
    return {
      kind: 'owner',
      userId: auth.userId,
      name: auth.profile.full_name?.split(/\s+/)[0] || 'TipTop',
    };
  }
  if (!grantCookie) return null;
  const grant = await resolveGrant(store, {
    eventId: event.id,
    cookieValue: grantCookie,
    roles: ['checkin'],
  });
  return grant.ok ? staffActor(grant.value, event) : null;
}

/** An event by id for the staff routes (no session: the sole organization). Templates never. */
export async function eventForStaff(
  store: DataStore,
  eventId: string,
): Promise<EventRecord | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(eventId)) return null;
  try {
    const organizationId = await soleOrganizationId('event-checkin');
    if (!organizationId) return null;
    const event = await store.get('events', organizationId, eventId);
    return event && !event.is_template ? event : null;
  } catch {
    return null;
  }
}

const NOT_SET_UP =
  'Events are not set up yet. Run the events migrations in the Supabase SQL editor.';

async function guard<T>(operation: string, run: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await run();
  } catch (error) {
    if (isMissingTableError(error) || isMissingColumnError(error)) {
      return err('not_configured', NOT_SET_UP, { details: { operation } });
    }
    log.error('Event check-in failed', {
      operation,
      reason: error instanceof Error ? error.message : String(error),
    });
    return err('internal', 'Check-in could not be saved. Try again.', { retryable: true });
  }
}

/* --------------------------------------------------------------- door list */

export interface DoorEntry {
  guestId: string;
  name: string;
  company: string | null;
  /** The host's name for a plus-one. */
  plusOneOf: string | null;
  /** VIP / Speaker / Sponsor / Staff / Press only: what the door needs to know. */
  badges: string[];
  /** Going sessions only. */
  sessions: Record<string, { checkedInAt: string | null }>;
}

export interface DoorSession {
  id: string;
  name: string;
  startsAt: string | null;
  endsAt: string | null;
  going: number;
  checkedIn: number;
}

export interface DoorList {
  eventId: string;
  title: string;
  timeZone: string;
  sessions: DoorSession[];
  entries: DoorEntry[];
  /** The session happening now (or next), for the default tab. */
  currentSessionId: string | null;
}

const DOOR_BADGES = ['VIP', 'Speaker', 'Sponsor', 'Staff', 'Press'];

function nameOf(g: Pick<EventGuest, 'first_name' | 'last_name'>): string {
  return [g.first_name, g.last_name].filter(Boolean).join(' ').trim() || 'Guest';
}

/** The session on now: from two hours before its start to its end (four hours when open-ended). */
export function liveSession(
  sessions: readonly Pick<EventSession, 'id' | 'starts_at' | 'ends_at'>[],
  now: Date = new Date(),
): string | null {
  const t = now.getTime();
  const live = sessions.find((s) => {
    if (!s.starts_at) return false;
    const start = Date.parse(s.starts_at) - 2 * 3_600_000;
    const end = s.ends_at ? Date.parse(s.ends_at) : Date.parse(s.starts_at) + 4 * 3_600_000;
    return t >= start && t <= end;
  });
  return live?.id ?? null;
}

/** The session on now, else the next one, else the first (the door list's default tab). */
export function currentSession(
  sessions: readonly Pick<EventSession, 'id' | 'starts_at' | 'ends_at'>[],
  now: Date = new Date(),
): string | null {
  const t = now.getTime();
  const timed = sessions.filter((s) => s.starts_at);
  const live = liveSession(sessions, now);
  if (live) return live;
  const next = [...timed]
    .filter((s) => Date.parse(s.starts_at!) > t)
    .sort((a, b) => a.starts_at!.localeCompare(b.starts_at!))[0];
  return next?.id ?? sessions[0]?.id ?? null;
}

export async function doorList(
  store: DataStore,
  organizationId: string,
  eventId: string,
  now: Date = new Date(),
): Promise<Result<DoorList>> {
  return guard('doorList', async () => {
    const event = await store.get('events', organizationId, eventId);
    if (!event) return err('not_found', 'That event does not exist.');
    const [sessions, guests, rows] = await Promise.all([
      store.list(
        'event_sessions',
        organizationId,
        { eq: { event_id: eventId } },
        { orderBy: [{ field: 'position', direction: 'asc' }] },
      ),
      store.list('event_guests', organizationId, { eq: { event_id: eventId } }),
      store.list('event_guest_sessions', organizationId, {
        eq: { event_id: eventId, status: 'going' },
      }),
    ]);
    const byId = new Map(guests.map((g) => [g.id, g]));
    const entries = new Map<string, DoorEntry>();
    for (const r of rows) {
      const g = byId.get(r.guest_id);
      if (!g) continue;
      const parent = g.parent_guest_id ? byId.get(g.parent_guest_id) : undefined;
      const entry = entries.get(g.id) ?? {
        guestId: g.id,
        name: nameOf(g),
        company: g.company,
        plusOneOf: parent ? nameOf(parent) : null,
        badges: g.tags.filter((t) => DOOR_BADGES.includes(t)),
        sessions: {},
      };
      entry.sessions[r.session_id] = { checkedInAt: r.checked_in_at };
      entries.set(g.id, entry);
    }
    return ok({
      eventId,
      title: event.title,
      timeZone: event.time_zone,
      sessions: sessions.map((s) => {
        const mine = rows.filter((r) => r.session_id === s.id);
        return {
          id: s.id,
          name: s.name,
          startsAt: s.starts_at,
          endsAt: s.ends_at,
          going: mine.length,
          checkedIn: mine.filter((r) => r.checked_in_at).length,
        };
      }),
      entries: [...entries.values()].sort((a, b) => a.name.localeCompare(b.name)),
      currentSessionId: currentSession(sessions, now),
    });
  });
}

/* ---------------------------------------------------------------- check-in */

export type CheckinState = 'checked_in' | 'already' | 'undone' | 'not_checked_in' | 'not_on_list';

export interface CheckinResult {
  state: CheckinState;
  guestId: string;
  sessionId: string;
  name: string;
  at: string | null;
  /** Who checked them in, for "already checked in 6:42 PM by Robin". */
  by: string | null;
}

/** "u:<id>" / "g:<id>" → a first name or link label, never an email. */
async function actorName(
  store: DataStore,
  organizationId: string,
  key: string | null,
): Promise<string | null> {
  if (!key) return null;
  try {
    if (key.startsWith('u:')) {
      const profile = await store.userProfileById(key.slice(2));
      return profile?.full_name?.split(/\s+/)[0] ?? 'TipTop';
    }
    if (key.startsWith('g:')) {
      const grant = await store.get('event_editors', organizationId, key.slice(2));
      return grant?.label ?? 'Door staff';
    }
  } catch {
    // fall through
  }
  return null;
}

export async function checkInGuest(
  store: DataStore,
  event: Pick<EventRecord, 'id' | 'organization_id'>,
  actor: CheckinActor,
  input: { guestId: string; sessionId: string; undo?: boolean },
  now: Date = new Date(),
): Promise<Result<CheckinResult>> {
  return guard<CheckinResult>('checkInGuest', async () => {
    const org = event.organization_id;
    const guest = await store.get('event_guests', org, input.guestId);
    if (!guest || guest.event_id !== event.id)
      return err('not_found', 'That guest is not on this list.');
    const row = await store.findOne('event_guest_sessions', org, {
      eq: { guest_id: guest.id, session_id: input.sessionId, event_id: event.id },
    });
    const base = { guestId: guest.id, sessionId: input.sessionId, name: nameOf(guest) };
    if (!row || row.status !== 'going') {
      return ok({ ...base, state: 'not_on_list', at: null, by: null });
    }
    const key = checkinActorKey(actor);
    if (input.undo) {
      if (!row.checked_in_at) return ok({ ...base, state: 'not_checked_in', at: null, by: null });
      await store.updateWhere(
        'event_guest_sessions',
        org,
        { eq: { guest_id: guest.id, session_id: input.sessionId, event_id: event.id } },
        { checked_in_at: null, checked_in_by: null },
      );
      await recordAudit(store, {
        organizationId: org,
        userId: actor.kind === 'owner' ? actor.userId : null,
        action: 'event.checkin_undone',
        entityType: 'event',
        entityId: event.id,
        metadata: { guest: guest.id, session: input.sessionId, by: key },
      });
      return ok({ ...base, state: 'undone', at: null, by: null });
    }
    const at = now.toISOString();
    const written = await store.updateWhere(
      'event_guest_sessions',
      org,
      {
        eq: {
          guest_id: guest.id,
          session_id: input.sessionId,
          event_id: event.id,
          status: 'going',
        },
        isNull: ['checked_in_at'],
      },
      { checked_in_at: at, checked_in_by: key },
    );
    if (!written.length) {
      const latest = await store.findOne('event_guest_sessions', org, {
        eq: { guest_id: guest.id, session_id: input.sessionId, event_id: event.id },
      });
      return ok({
        ...base,
        state: 'already',
        at: latest?.checked_in_at ?? null,
        by: await actorName(store, org, latest?.checked_in_by ?? null),
      });
    }
    await recordAudit(store, {
      organizationId: org,
      userId: actor.kind === 'owner' ? actor.userId : null,
      action: 'event.checkin',
      entityType: 'event',
      entityId: event.id,
      metadata: { guest: guest.id, session: input.sessionId, by: key },
    });
    return ok({ ...base, state: 'checked_in', at, by: actor.name });
  });
}

/* ------------------------------------------------------------- QR landing */

export interface QrPerson {
  guestId: string;
  name: string;
  company: string | null;
  plusOneOf: string | null;
  /** The guest's plus-ones going to each session (for "(+1)" and the party button). */
  party: { guestId: string; name: string }[];
  sessions: {
    sessionId: string;
    name: string;
    status: EventGuestSession['status'];
    checkedInAt: string | null;
    checkedInBy: string | null;
    /** Plus-ones going to this session, not yet checked in. */
    partyPending: string[];
  }[];
  /** The session on now, if any. */
  currentSessionId: string | null;
}

/** What staff see after scanning a QR: the person, their sessions and check-in states. */
export async function qrPerson(
  store: DataStore,
  event: EventRecord,
  sessions: readonly EventSession[],
  guest: EventGuest,
  now: Date = new Date(),
): Promise<QrPerson> {
  const org = event.organization_id;
  const [rows, children, parent] = await Promise.all([
    store.list('event_guest_sessions', org, { eq: { event_id: event.id } }),
    guest.parent_guest_id
      ? Promise.resolve([] as EventGuest[])
      : store.list('event_guests', org, { eq: { event_id: event.id, parent_guest_id: guest.id } }),
    guest.parent_guest_id
      ? store.get('event_guests', org, guest.parent_guest_id)
      : Promise.resolve(null),
  ]);
  const own = rows.filter((r) => r.guest_id === guest.id);
  const names = new Map<string, string | null>();
  for (const r of own) {
    if (r.checked_in_by && !names.has(r.checked_in_by)) {
      names.set(r.checked_in_by, await actorName(store, org, r.checked_in_by));
    }
  }
  return {
    guestId: guest.id,
    name: nameOf(guest),
    company: guest.company,
    plusOneOf: parent ? nameOf(parent) : null,
    party: children.map((c) => ({ guestId: c.id, name: nameOf(c) })),
    sessions: sessions
      .filter((s) => own.some((r) => r.session_id === s.id))
      .map((s) => {
        const r = own.find((x) => x.session_id === s.id)!;
        return {
          sessionId: s.id,
          name: s.name,
          status: r.status,
          checkedInAt: r.checked_in_at,
          checkedInBy: r.checked_in_by ? (names.get(r.checked_in_by) ?? null) : null,
          partyPending: children
            .filter((c) =>
              rows.some(
                (x) =>
                  x.guest_id === c.id &&
                  x.session_id === s.id &&
                  x.status === 'going' &&
                  !x.checked_in_at,
              ),
            )
            .map((c) => c.id),
        };
      }),
    // Only a session actually on now: the landing's red "not on the list"
    // must never fire for one that starts next week.
    currentSessionId: liveSession(sessions, now),
  };
}

/* ---------------------------------------------------------------- walk-ins */

export interface WalkInInput {
  firstName: string;
  lastName: string | null;
  email: string | null;
  company: string | null;
  sessionId: string;
}

/** A walk-in: added as Going (past capacity if need be) and checked in at once. */
export async function addWalkIn(
  store: DataStore,
  event: Pick<EventRecord, 'id' | 'organization_id'>,
  actor: CheckinActor,
  input: WalkInInput,
): Promise<Result<{ guestId: string; merged: boolean }>> {
  const first = input.firstName.trim().slice(0, 100);
  if (!first) return err('invalid_input', 'Add their name.');
  const email = input.email?.trim().toLowerCase() || null;
  if (email && !/^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/.test(email)) {
    return err('invalid_input', 'That email address is not valid.');
  }
  const key = checkinActorKey(actor);
  const result = await runPlanned(store, event.organization_id, event.id, (loaded, now) => {
    if (!loaded.sessions.some((s) => s.id === input.sessionId)) {
      return { kind: 'stop', result: err('invalid_input', 'Choose a session.') };
    }
    const planned = planAddGuests(
      {
        event: loaded.event,
        sessions: loaded.sessions,
        guests: loaded.guests,
        rows: loaded.rows,
        now: now.toISOString(),
        newId,
      },
      {
        people: [
          {
            email,
            first_name: first,
            last_name: input.lastName?.trim().slice(0, 100) || null,
            company: input.company?.trim().slice(0, 200) || null,
            title: null,
            phone: null,
          },
        ],
        sessionIds: [input.sessionId],
        status: 'going',
        source: 'walk_in',
        by: actor.kind === 'owner' ? actor.userId : null,
        checkedInBy: key,
      },
    );
    return { kind: 'plan', plan: planned.plan, value: planned.outcome };
  });
  if (!result.ok) return result;
  const guestId = result.value.added[0] ?? result.value.merged[0];
  if (!guestId) return err('internal', 'That walk-in could not be added.');
  // A merged (already listed) person still needs the check-in stamped.
  if (!result.value.added.length) {
    await store.updateWhere(
      'event_guest_sessions',
      event.organization_id,
      {
        eq: { guest_id: guestId, session_id: input.sessionId, event_id: event.id },
        isNull: ['checked_in_at'],
      },
      { checked_in_at: new Date().toISOString(), checked_in_by: key },
    );
  }
  await recordAudit(store, {
    organizationId: event.organization_id,
    userId: actor.kind === 'owner' ? actor.userId : null,
    action: 'event.walk_in_added',
    entityType: 'event',
    entityId: event.id,
    metadata: {
      guest: guestId,
      session: input.sessionId,
      by: key,
      merged: !result.value.added.length,
    },
  });
  return ok({ guestId, merged: !result.value.added.length });
}
