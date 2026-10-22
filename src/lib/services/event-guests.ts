import 'server-only';
import { isMissingColumnError, isMissingTableError } from '@/lib/db/missing-table';
import type { DataStore } from '@/lib/db/store';
import {
  planAddGuests,
  planHostStatus,
  planPromote,
  planRemoveGuests,
  planSessionMembership,
  type AddGuestsOutcome,
  type AddPerson,
  type HostMove,
  type HostStatusOutcome,
} from '@/lib/events/capacity';
import {
  EMPTY_GUEST_COUNTS,
  type AudienceMember,
  type EventAudience,
  type GuestCounts,
  type NeedsNotifyingGroup,
  type NotifyKind,
} from '@/lib/events/contracts';
import {
  guestExportCsv,
  headcountCsv,
  headcounts,
  parseGuestCsv,
  parsePastedEmails,
  guessMapping,
  previewImport,
  type ImportTarget,
  type SessionHeadcount,
} from '@/lib/events/csv';
import {
  filterGuests,
  strongestStatus,
  type GuestFilter,
  type GuestListItem,
} from '@/lib/events/guest-list';
import { guestTagSchema, type RegistrationQuestion } from '@/lib/events/registration';
import { recordAudit } from '@/lib/security/audit';
import { log } from '@/lib/security/redact';
import type { EventOwner } from '@/lib/services/events';
import type {
  AuditEvent,
  EventGuest,
  EventGuestSession,
  EventGuestStatus,
  EventRecord,
  EventSession,
} from '@/lib/types/domain';
import { err, ok, type Result } from '@/lib/util/result';
import { guestLinks } from './event-public';
import { runPlanned } from './event-register';

/**
 * The host's side of the guest list (D-075): counts for the library, the
 * guest table, the drawer and its timeline, adding guests (manual, pasted,
 * CRM, Network, CSV), status decisions in bulk, tags, notes, link rotation,
 * hard delete, the CSV export and the caterer's headcount, and the two
 * things WS5's Messages tab builds on: campaign audiences (each with their
 * personal link) and the "Needs notifying" queue.
 *
 * Every seat-affecting change is planned in lib/events/capacity.ts and
 * applied atomically through event_register() (event-register.ts). Every
 * change is audited. Nothing here sends email.
 */

const NOT_SET_UP =
  'Events are not set up yet: the events tables do not exist. Run the events migrations in the Supabase SQL editor, then reload.';

async function guard<T>(operation: string, run: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await run();
  } catch (error) {
    if (isMissingTableError(error) || isMissingColumnError(error)) {
      return err('not_configured', NOT_SET_UP, { details: { operation } });
    }
    log.error('Event guest operation failed', {
      operation,
      reason: error instanceof Error ? error.message : String(error),
    });
    return err('internal', 'The guest list could not be read just now.', {
      retryable: true,
      details: { operation },
    });
  }
}

/** Guest-level status: the strongest of their per-session statuses. */
export function guestLevelStatus(statuses: readonly EventGuestStatus[]): EventGuestStatus {
  return strongestStatus(statuses);
}

export async function guestCounts(
  store: DataStore,
  organizationId: string,
  eventIds: readonly string[],
): Promise<Record<string, GuestCounts>> {
  const out: Record<string, GuestCounts> = {};
  for (const id of eventIds) out[id] = { ...EMPTY_GUEST_COUNTS };
  if (eventIds.length === 0) return out;
  try {
    const [guests, rows] = await Promise.all([
      store.list('event_guests', organizationId, { in: { event_id: [...eventIds] } }),
      store.list('event_guest_sessions', organizationId, { in: { event_id: [...eventIds] } }),
    ]);
    const byGuest = new Map<string, { statuses: EventGuestStatus[]; checkedIn: boolean }>();
    for (const row of rows) {
      const entry = byGuest.get(row.guest_id) ?? { statuses: [], checkedIn: false };
      entry.statuses.push(row.status);
      if (row.checked_in_at) entry.checkedIn = true;
      byGuest.set(row.guest_id, entry);
    }
    for (const guest of guests) {
      const counts = out[guest.event_id];
      if (!counts) continue;
      const entry = byGuest.get(guest.id);
      const status = guestLevelStatus(entry?.statuses ?? []);
      counts.total += 1;
      if (entry?.checkedIn) counts.checkedIn += 1;
      if (status === 'going') {
        counts.going += 1;
        if (guest.parent_guest_id) counts.plusOnes += 1;
      } else if (status === 'pending') counts.pending += 1;
      else if (status === 'waitlist') counts.waitlist += 1;
      else if (status === 'maybe') counts.maybe += 1;
      else if (status === 'invited') counts.invited += 1;
      else if (status === 'not_going') counts.notGoing += 1;
      else if (status === 'declined') counts.declined += 1;
    }
  } catch (error) {
    if (!isMissingTableError(error)) {
      log.error('Event guest counts failed', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return out;
}

/* ---------------------------------------------------------------- reading */

function displayName(g: Pick<EventGuest, 'first_name' | 'last_name' | 'email'>): string {
  return [g.first_name, g.last_name].filter(Boolean).join(' ').trim() || g.email || 'Guest';
}

async function loadEvent(
  store: DataStore,
  organizationId: string,
  eventId: string,
): Promise<{ event: EventRecord; sessions: EventSession[] } | null> {
  const event = await store.get('events', organizationId, eventId);
  if (!event) return null;
  const sessions = await store.list(
    'event_sessions',
    organizationId,
    { eq: { event_id: eventId } },
    { orderBy: [{ field: 'position', direction: 'asc' }] },
  );
  return { event, sessions };
}

/**
 * Campaign activity per guest email: the latest campaign carrying a personal
 * {{rsvp_link}} sent to them since the event was made, and its open. Best
 * effort until event-linked campaigns land (WS5 may pass campaignIds).
 */
async function inviteActivity(
  store: DataStore,
  organizationId: string,
  event: EventRecord,
  emails: readonly string[],
  campaignIds?: readonly string[],
): Promise<
  Map<string, { sentAt: string | null; openedAt: string | null; clickedAt: string | null }>
> {
  const out = new Map<
    string,
    { sentAt: string | null; openedAt: string | null; clickedAt: string | null }
  >();
  if (!emails.length) return out;
  try {
    let ids = campaignIds ? [...campaignIds] : null;
    if (!ids) {
      const campaigns = await store.list('campaigns', organizationId, {
        gte: { created_at: event.created_at },
      });
      ids = campaigns.filter((c) => c.body_template.includes('{{rsvp_link')).map((c) => c.id);
    }
    if (!ids.length) return out;
    const recipients = await store.list('campaign_recipients', organizationId, {
      in: { campaign_id: ids, email: [...emails] },
    });
    for (const r of recipients) {
      if (!r.sent_at) continue;
      const prev = out.get(r.email);
      if (!prev || (prev.sentAt ?? '') < r.sent_at) {
        out.set(r.email, { sentAt: r.sent_at, openedAt: r.opened_at, clickedAt: r.clicked_at });
      }
    }
  } catch {
    // Campaign tables missing or unreadable: the funnel just shows less.
  }
  return out;
}

export interface GuestRoster {
  event: Pick<
    EventRecord,
    'id' | 'slug' | 'title' | 'time_zone' | 'access' | 'status' | 'capacity'
  >;
  guests: GuestListItem[];
  sessions: Pick<EventSession, 'id' | 'name' | 'starts_at' | 'ends_at' | 'capacity' | 'position'>[];
  questions: RegistrationQuestion[];
  counts: GuestCounts;
}

export function toListItems(
  guests: readonly EventGuest[],
  rows: readonly EventGuestSession[],
  extras: {
    views?: Map<string, string>;
    invites?: Map<string, { sentAt: string | null; openedAt: string | null }>;
  } = {},
): GuestListItem[] {
  const byGuest = new Map<string, EventGuestSession[]>();
  for (const r of rows) byGuest.set(r.guest_id, [...(byGuest.get(r.guest_id) ?? []), r]);
  const byId = new Map(guests.map((g) => [g.id, g]));
  return guests.map((g) => {
    const own = byGuest.get(g.id) ?? [];
    const parent = g.parent_guest_id ? byId.get(g.parent_guest_id) : undefined;
    const invite = g.email ? extras.invites?.get(g.email) : undefined;
    const lastChange =
      [g.updated_at, ...own.map((r) => r.updated_at)].sort().at(-1) ?? g.updated_at;
    return {
      id: g.id,
      parentId: g.parent_guest_id,
      parentName: parent ? displayName(parent) : null,
      firstName: g.first_name,
      lastName: g.last_name,
      name: displayName(g),
      email: g.email,
      company: g.company,
      title: g.title,
      phone: g.phone,
      tags: g.tags,
      source: g.source,
      referral: g.referral_code,
      note: g.host_note,
      answers: g.answers,
      sessions: Object.fromEntries(
        own.map((r) => [
          r.session_id,
          {
            status: r.status,
            checkedInAt: r.checked_in_at,
            requestedAt: r.requested_at,
            decidedAt: r.decided_at,
            decisionNote: r.decision_note,
          },
        ]),
      ),
      status: guestLevelStatus(own.map((r) => r.status)),
      plusOneIds: guests.filter((c) => c.parent_guest_id === g.id).map((c) => c.id),
      registeredAt: g.registered_at,
      createdAt: g.created_at,
      updatedAt: lastChange,
      recordId: g.record_id,
      showOnWall: g.show_on_wall,
      funnel: {
        invitedAt: invite?.sentAt ?? null,
        openedAt: invite?.openedAt ?? null,
        viewedAt: extras.views?.get(g.id) ?? null,
        respondedAt: g.registered_at,
      },
    };
  });
}

/** The whole guest list for the host's table. */
export async function listGuests(
  store: DataStore,
  organizationId: string,
  eventId: string,
): Promise<Result<GuestRoster>> {
  return guard('listGuests', async () => {
    const loaded = await loadEvent(store, organizationId, eventId);
    if (!loaded) return err('not_found', 'That event does not exist.');
    const [guests, rows, views] = await Promise.all([
      store.list('event_guests', organizationId, { eq: { event_id: eventId } }),
      store.list('event_guest_sessions', organizationId, { eq: { event_id: eventId } }),
      store
        .list('event_page_views', organizationId, {
          eq: { event_id: eventId },
          notNull: ['guest_id'],
        })
        .catch(() => []),
    ]);
    const viewed = new Map<string, string>();
    for (const v of views) {
      if (v.guest_id && (!viewed.has(v.guest_id) || viewed.get(v.guest_id)! < v.created_at)) {
        viewed.set(v.guest_id, v.created_at);
      }
    }
    const invites = await inviteActivity(
      store,
      organizationId,
      loaded.event,
      guests.map((g) => g.email).filter((e): e is string => Boolean(e)),
    );
    const counts = (await guestCounts(store, organizationId, [eventId]))[eventId]!;
    const e = loaded.event;
    return ok({
      event: {
        id: e.id,
        slug: e.slug,
        title: e.title,
        time_zone: e.time_zone,
        access: e.access,
        status: e.status,
        capacity: e.capacity,
      },
      guests: toListItems(guests, rows, { views: viewed, invites }),
      sessions: loaded.sessions.map((s) => ({
        id: s.id,
        name: s.name,
        starts_at: s.starts_at,
        ends_at: s.ends_at,
        capacity: s.capacity,
        position: s.position,
      })),
      questions: e.questions as RegistrationQuestion[],
      counts,
    });
  });
}

/* ----------------------------------------------------------- the drawer */

export interface TimelineEntry {
  at: string;
  kind:
    | 'added'
    | 'invited'
    | 'opened'
    | 'clicked'
    | 'viewed'
    | 'rsvp'
    | 'status'
    | 'notified'
    | 'checkin'
    | 'checkin_undone'
    | 'note';
  text: string;
}

export interface GuestDetail {
  guest: GuestListItem;
  plusOnes: GuestListItem[];
  timeline: TimelineEntry[];
}

const TIMELINE_ACTIONS = [
  'event.guest_added',
  'event.guest_status_changed',
  'event.guest_link_rotated',
  'event.rsvp_received',
  'event.rsvp_changed',
  'event.checkin',
  'event.checkin_undone',
  'event.notified_marked',
  'event.walk_in_added',
  'event.guests_imported',
] as const;

function auditMentions(a: AuditEvent, guestId: string): boolean {
  const m = a.metadata as Record<string, unknown>;
  if (m.guest === guestId) return true;
  const list = m.guests;
  return Array.isArray(list) && list.includes(guestId);
}

function timelineText(a: AuditEvent): { kind: TimelineEntry['kind']; text: string } {
  const m = a.metadata as Record<string, unknown>;
  switch (a.action) {
    case 'event.rsvp_received':
      return { kind: 'rsvp', text: 'RSVP received' };
    case 'event.rsvp_changed':
      return { kind: 'rsvp', text: 'RSVP changed' };
    case 'event.guest_status_changed': {
      const to = typeof m.to === 'string' ? m.to.replace('_', ' ') : 'changed';
      const note = typeof m.note === 'string' && m.note ? ` – “${m.note}”` : '';
      return { kind: 'status', text: `Status set to ${to}${note}` };
    }
    case 'event.guest_link_rotated':
      return { kind: 'status', text: 'Personal link rotated' };
    case 'event.checkin':
      return { kind: 'checkin', text: 'Checked in' };
    case 'event.checkin_undone':
      return { kind: 'checkin_undone', text: 'Check-in undone' };
    case 'event.notified_marked':
      return { kind: 'notified', text: 'Notice sent' };
    case 'event.walk_in_added':
      return { kind: 'added', text: 'Added at the door' };
    case 'event.guests_imported':
      return { kind: 'added', text: 'Imported from CSV' };
    default:
      return { kind: 'added', text: 'Added to the list' };
  }
}

export async function getGuestDetail(
  store: DataStore,
  organizationId: string,
  eventId: string,
  guestId: string,
): Promise<Result<GuestDetail>> {
  return guard('getGuestDetail', async () => {
    const loaded = await loadEvent(store, organizationId, eventId);
    if (!loaded) return err('not_found', 'That event does not exist.');
    const guest = await store.get('event_guests', organizationId, guestId);
    if (!guest || guest.event_id !== eventId)
      return err('not_found', 'That guest is not on this list.');
    const [children, rows, audits, views] = await Promise.all([
      store.list('event_guests', organizationId, {
        eq: { event_id: eventId, parent_guest_id: guest.id },
      }),
      store.list('event_guest_sessions', organizationId, { eq: { event_id: eventId } }),
      store
        .list(
          'audit_events',
          organizationId,
          { eq: { entity_id: eventId }, in: { action: [...TIMELINE_ACTIONS] } },
          { orderBy: [{ field: 'created_at', direction: 'desc' }], limit: 1000 },
        )
        .catch(() => [] as AuditEvent[]),
      store
        .list('event_page_views', organizationId, { eq: { event_id: eventId, guest_id: guest.id } })
        .catch(() => []),
    ]);
    const invites = guest.email
      ? await inviteActivity(store, organizationId, loaded.event, [guest.email])
      : new Map();
    const parentRows = guest.parent_guest_id
      ? [await store.get('event_guests', organizationId, guest.parent_guest_id)].filter(
          (g): g is EventGuest => Boolean(g),
        )
      : [];
    const items = toListItems([guest, ...children, ...parentRows], rows, {
      invites,
      views: new Map(views.map((v) => [guest.id, v.created_at])),
    });
    const timeline: TimelineEntry[] = [
      { at: guest.created_at, kind: 'added', text: `Added (${guest.source.replace('_', ' ')})` },
    ];
    const invite = guest.email ? invites.get(guest.email) : undefined;
    if (invite?.sentAt)
      timeline.push({ at: invite.sentAt, kind: 'invited', text: 'Invitation sent' });
    if (invite?.openedAt)
      timeline.push({ at: invite.openedAt, kind: 'opened', text: 'Invitation opened' });
    if (invite?.clickedAt)
      timeline.push({ at: invite.clickedAt, kind: 'clicked', text: 'Link clicked' });
    for (const v of views)
      timeline.push({ at: v.created_at, kind: 'viewed', text: 'Viewed their page' });
    for (const a of audits.filter((x) => auditMentions(x, guest.id))) {
      timeline.push({ at: a.created_at, ...timelineText(a) });
    }
    timeline.sort((a, b) => b.at.localeCompare(a.at));
    return ok({
      guest: items[0]!,
      plusOnes: items.slice(1, 1 + children.length),
      timeline: timeline.slice(0, 200),
    });
  });
}

/** The guest's personal links (owners only: "Copy personal link"). */
export async function personalLinks(
  store: DataStore,
  organizationId: string,
  eventId: string,
  guestId: string,
): Promise<Result<{ invitePath: string | null; ticketPath: string | null; checkinPath: string }>> {
  return guard('personalLinks', async () => {
    const event = await store.get('events', organizationId, eventId);
    if (!event) return err('not_found', 'That event does not exist.');
    const guest = await store.get('event_guests', organizationId, guestId);
    if (!guest || guest.event_id !== eventId)
      return err('not_found', 'That guest is not on this list.');
    const links = guestLinks(event, guest);
    return ok({
      invitePath: links.invitePath,
      ticketPath: links.ticketPath,
      checkinPath: links.checkinPath,
    });
  });
}

/* ---------------------------------------------------------- adding guests */

export interface AddGuestsRequest {
  people: AddPerson[];
  sessionIds: string[];
  status: 'invited' | 'going';
  source: 'host' | 'import' | 'invite';
  tags?: string[];
}

export async function addGuests(
  store: DataStore,
  owner: EventOwner,
  eventId: string,
  request: AddGuestsRequest,
): Promise<Result<AddGuestsOutcome>> {
  if (!request.people.length) return err('invalid_input', 'Add at least one person.');
  if (request.people.length > 2000)
    return err('invalid_input', 'Add up to 2,000 people at a time.');
  const tags = (request.tags ?? []).filter((t) => guestTagSchema.safeParse(t).success);
  const result = await runPlanned<AddGuestsOutcome>(
    store,
    owner.organizationId,
    eventId,
    (loaded, now) => {
      const known = new Set(loaded.sessions.map((s) => s.id));
      const sessionIds = request.sessionIds.length
        ? request.sessionIds.filter((id) => known.has(id))
        : loaded.sessions.map((s) => s.id);
      const planned = planAddGuests(
        {
          event: loaded.event,
          sessions: loaded.sessions,
          guests: loaded.guests,
          rows: loaded.rows,
          now: now.toISOString(),
          newId: () => crypto.randomUUID(),
        },
        {
          people: request.people.map((p) => ({
            ...p,
            tags: [...new Set([...(p.tags ?? []), ...tags])],
          })),
          sessionIds,
          status: request.status,
          source: request.source,
          by: owner.userId,
        },
      );
      return { kind: 'plan', plan: planned.plan, value: planned.outcome };
    },
  );
  if (!result.ok) return result;
  await recordAudit(store, {
    organizationId: owner.organizationId,
    userId: owner.userId,
    action: request.source === 'import' ? 'event.guests_imported' : 'event.guest_added',
    entityType: 'event',
    entityId: eventId,
    metadata: {
      guests: [...result.value.added, ...result.value.merged].slice(0, 500),
      added: result.value.added.length,
      merged: result.value.merged.length,
      status: request.status,
      over_capacity: result.value.overCapacity,
    },
  });
  return result;
}

/** People from a CRM list, CRM records or Network contacts (deduplicated on email). */
export async function peopleFromCopilot(
  store: DataStore,
  organizationId: string,
  source:
    | { kind: 'list'; listId: string }
    | { kind: 'records'; recordIds: string[] }
    | { kind: 'network'; contactIds: string[] },
): Promise<Result<{ people: AddPerson[]; skipped: number }>> {
  return guard('peopleFromCopilot', async () => {
    const people: AddPerson[] = [];
    let skipped = 0;
    if (source.kind === 'network') {
      const contacts = await store.list('network_contacts', organizationId, {
        in: { id: source.contactIds.slice(0, 2000) },
      });
      for (const c of contacts) {
        if (!c.email) {
          skipped++;
          continue;
        }
        const [first, ...rest] = c.full_name.trim().split(/\s+/);
        people.push({
          email: c.email.toLowerCase(),
          first_name: first ?? null,
          last_name: rest.join(' ') || null,
          company: c.company,
          title: c.title,
          phone: null,
        });
      }
      return ok({ people, skipped });
    }
    let recordIds: string[];
    if (source.kind === 'list') {
      const list = await store.get('crm_lists', organizationId, source.listId);
      if (!list) return err('not_found', 'That list does not exist.');
      const entries = await store.list('crm_list_entries', organizationId, {
        eq: { list_id: list.id },
      });
      recordIds = entries.map((e) => e.record_id).filter((id): id is string => Boolean(id));
    } else {
      recordIds = source.recordIds;
    }
    const records = recordIds.length
      ? await store.list('crm_records', organizationId, {
          in: { id: [...new Set(recordIds)].slice(0, 2000) },
        })
      : [];
    for (const r of records) {
      const email = r.primary_email ?? r.emails[0] ?? null;
      if (r.kind !== 'person' || !email) {
        skipped++;
        continue;
      }
      const [first, ...rest] = r.name.trim().split(/\s+/);
      const company =
        typeof r.fields['Organization'] === 'string' ? (r.fields['Organization'] as string) : null;
      const title =
        typeof r.fields['Job Title'] === 'string' ? (r.fields['Job Title'] as string) : null;
      people.push({
        email: email.toLowerCase(),
        first_name: first ?? null,
        last_name: rest.join(' ') || null,
        company: company?.slice(0, 200) ?? null,
        title: title?.slice(0, 200) ?? null,
        phone: null,
        record_id: r.id,
      });
    }
    return ok({ people, skipped });
  });
}

/** Pasted emails → people (names left for the guest to fill in). */
export function peopleFromEmails(text: string): { people: AddPerson[]; invalid: string[] } {
  const { emails, invalid } = parsePastedEmails(text);
  return {
    people: emails.map((email) => ({
      email,
      first_name: null,
      last_name: null,
      company: null,
      title: null,
      phone: null,
    })),
    invalid,
  };
}

/* ------------------------------------------------------------- decisions */

export type BulkAction =
  | 'approve'
  | 'decline'
  | 'going'
  | 'waitlist'
  | 'not_going'
  | 'promote'
  | 'add_session'
  | 'remove_session'
  | 'add_tag'
  | 'remove_tag'
  | 'rotate_links'
  | 'remove';

export interface BulkRequest {
  action: BulkAction;
  guestIds: string[];
  sessionId?: string | null;
  note?: string | null;
  tag?: string | null;
  force?: boolean;
}

export interface BulkOutcome {
  changed: number;
  /** Parties left where they were: no room. */
  full: number;
  promoted: number;
  removed?: number;
}

function hostMoveFor(action: BulkAction): { to: HostMove; from?: EventGuestStatus[] } | null {
  switch (action) {
    case 'approve':
      return { to: 'going', from: ['pending'] };
    case 'decline':
      return { to: 'declined' };
    case 'going':
      return { to: 'going' };
    case 'waitlist':
      return { to: 'waitlist' };
    case 'not_going':
      return { to: 'not_going' };
    default:
      return null;
  }
}

/** One bulk-bar action (or a single guest's), with a count for the confirmation toast. */
export async function bulkGuests(
  store: DataStore,
  owner: EventOwner,
  eventId: string,
  request: BulkRequest,
): Promise<Result<BulkOutcome>> {
  const ids = [...new Set(request.guestIds)].slice(0, 2000);
  if (!ids.length) return err('invalid_input', 'Choose at least one guest.');
  const note = request.note?.trim().slice(0, 1000) || null;
  const audit = async (
    metadata: Record<string, unknown>,
    action: Parameters<typeof recordAudit>[1]['action'] = 'event.guest_status_changed',
  ) =>
    recordAudit(store, {
      organizationId: owner.organizationId,
      userId: owner.userId,
      action,
      entityType: 'event',
      entityId: eventId,
      metadata: { guests: ids.slice(0, 500), count: ids.length, ...metadata },
    });

  const move = hostMoveFor(request.action);
  if (move) {
    const result = await runPlanned<HostStatusOutcome>(
      store,
      owner.organizationId,
      eventId,
      (loaded, now) => {
        const planned = planHostStatus(
          {
            event: loaded.event,
            sessions: loaded.sessions,
            guests: loaded.guests,
            rows: loaded.rows,
            now: now.toISOString(),
            newId: () => crypto.randomUUID(),
          },
          {
            guestIds: ids,
            sessionIds: request.sessionId ? [request.sessionId] : null,
            to: move.to,
            from: move.from,
            note,
            by: owner.userId,
            force: request.force,
          },
        );
        return { kind: 'plan', plan: planned.plan, value: planned.outcome };
      },
    );
    if (!result.ok) return result;
    await audit({
      to: move.to,
      action: request.action,
      note,
      session: request.sessionId ?? null,
      changed: result.value.changed.length,
      full: result.value.full.length,
      promoted: result.value.promoted.map((p) => p.guestId),
      forced: Boolean(request.force),
    });
    return ok({
      changed: new Set(result.value.changed.map((c) => c.guestId)).size,
      full: result.value.full.length,
      promoted: result.value.promoted.length,
    });
  }

  if (request.action === 'promote') {
    const result = await runPlanned<HostStatusOutcome>(
      store,
      owner.organizationId,
      eventId,
      (loaded, now) => {
        const planned = planPromote(
          {
            event: loaded.event,
            sessions: loaded.sessions,
            guests: loaded.guests,
            rows: loaded.rows,
            now: now.toISOString(),
            newId: () => crypto.randomUUID(),
          },
          {
            guestIds: ids,
            sessionIds: request.sessionId ? [request.sessionId] : null,
            by: owner.userId,
            force: request.force,
          },
        );
        return { kind: 'plan', plan: planned.plan, value: planned.outcome };
      },
    );
    if (!result.ok) return result;
    await audit({
      to: 'going',
      action: 'promote',
      session: request.sessionId ?? null,
      forced: Boolean(request.force),
    });
    return ok({
      changed: result.value.promoted.length,
      full: result.value.full.length,
      promoted: result.value.promoted.length,
    });
  }

  if (request.action === 'add_session' || request.action === 'remove_session') {
    if (!request.sessionId) return err('invalid_input', 'Choose a session.');
    const sessionId = request.sessionId;
    const result = await runPlanned(store, owner.organizationId, eventId, (loaded, now) => {
      const planned = planSessionMembership(
        {
          event: loaded.event,
          sessions: loaded.sessions,
          guests: loaded.guests,
          rows: loaded.rows,
          now: now.toISOString(),
          newId: () => crypto.randomUUID(),
        },
        { guestIds: ids, sessionId, add: request.action === 'add_session' },
      );
      return { kind: 'plan', plan: planned.plan, value: planned.outcome };
    });
    if (!result.ok) return result;
    await audit({
      action: request.action,
      session: sessionId,
      promoted: result.value.promoted.map((p) => p.guestId),
    });
    return ok({ changed: result.value.changed, full: 0, promoted: result.value.promoted.length });
  }

  if (request.action === 'remove') {
    const result = await runPlanned(store, owner.organizationId, eventId, (loaded, now) => {
      const planned = planRemoveGuests(
        {
          event: loaded.event,
          sessions: loaded.sessions,
          guests: loaded.guests,
          rows: loaded.rows,
          now: now.toISOString(),
          newId: () => crypto.randomUUID(),
        },
        ids,
      );
      return { kind: 'plan', plan: planned.plan, value: planned.outcome };
    });
    if (!result.ok) return result;
    await audit(
      { removed: result.value.removed, promoted: result.value.promoted.map((p) => p.guestId) },
      'event.guest_deleted',
    );
    return ok({
      changed: result.value.removed,
      full: 0,
      promoted: result.value.promoted.length,
      removed: result.value.removed,
    });
  }

  return guard('bulkGuests', async () => {
    const guests = await store.list('event_guests', owner.organizationId, {
      eq: { event_id: eventId },
      in: { id: ids },
    });
    if (request.action === 'add_tag' || request.action === 'remove_tag') {
      const parsed = guestTagSchema.safeParse(request.tag ?? '');
      if (!parsed.success)
        return err('invalid_input', parsed.error.issues[0]?.message ?? 'That tag is not valid.');
      const tag = parsed.data;
      let changed = 0;
      for (const g of guests) {
        const has = g.tags.some((t) => t.toLowerCase() === tag.toLowerCase());
        if (request.action === 'add_tag' && !has && g.tags.length < 20) {
          await store.update('event_guests', owner.organizationId, g.id, {
            tags: [...g.tags, tag],
          });
          changed++;
        } else if (request.action === 'remove_tag' && has) {
          await store.update('event_guests', owner.organizationId, g.id, {
            tags: g.tags.filter((t) => t.toLowerCase() !== tag.toLowerCase()),
          });
          changed++;
        }
      }
      await audit({ action: request.action, tag, changed }, 'event.guest_updated');
      return ok({ changed, full: 0, promoted: 0 });
    }
    if (request.action === 'rotate_links') {
      for (const g of guests) {
        await store.update('event_guests', owner.organizationId, g.id, {
          token_version: g.token_version + 1,
        });
      }
      await audit({ rotated: guests.length }, 'event.guest_link_rotated');
      return ok({ changed: guests.length, full: 0, promoted: 0 });
    }
    return err('invalid_input', 'That action is not available.');
  });
}

/* ------------------------------------------------------- one guest's edits */

export interface GuestPatch {
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  company?: string | null;
  title?: string | null;
  phone?: string | null;
  host_note?: string | null;
  tags?: string[];
}

export async function updateGuest(
  store: DataStore,
  owner: EventOwner,
  eventId: string,
  guestId: string,
  patch: GuestPatch,
): Promise<Result<GuestListItem>> {
  return guard('updateGuest', async () => {
    const guest = await store.get('event_guests', owner.organizationId, guestId);
    if (!guest || guest.event_id !== eventId)
      return err('not_found', 'That guest is not on this list.');
    const next: Partial<EventGuest> = {};
    const text = (v: string | null | undefined, max: number) =>
      v === undefined ? undefined : v === null ? null : v.trim().slice(0, max) || null;
    if (patch.first_name !== undefined) next.first_name = text(patch.first_name, 100);
    if (patch.last_name !== undefined) next.last_name = text(patch.last_name, 100);
    if (patch.company !== undefined) next.company = text(patch.company, 200);
    if (patch.title !== undefined) next.title = text(patch.title, 200);
    if (patch.phone !== undefined) next.phone = text(patch.phone, 40);
    if (patch.host_note !== undefined) next.host_note = text(patch.host_note, 4000);
    if (patch.email !== undefined) {
      const email = patch.email?.trim().toLowerCase() || null;
      if (email && !/^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/.test(email)) {
        return err('invalid_input', 'That email address is not valid.');
      }
      if (!email && !guest.parent_guest_id)
        return err('invalid_input', 'A guest needs an email address.');
      if (email && email !== guest.email) {
        const clash = await store.findOne('event_guests', owner.organizationId, {
          eq: { event_id: eventId, email },
        });
        if (clash) return err('conflict', 'Someone with that email is already on the list.');
      }
      next.email = email;
    }
    if (patch.tags !== undefined) {
      const tags: string[] = [];
      for (const t of patch.tags) {
        const parsed = guestTagSchema.safeParse(t);
        if (!parsed.success)
          return err('invalid_input', parsed.error.issues[0]?.message ?? 'That tag is not valid.');
        if (!tags.some((x) => x.toLowerCase() === parsed.data.toLowerCase()))
          tags.push(parsed.data);
      }
      next.tags = tags.slice(0, 20);
    }
    const updated = await store.update('event_guests', owner.organizationId, guestId, next);
    await recordAudit(store, {
      organizationId: owner.organizationId,
      userId: owner.userId,
      action: 'event.guest_updated',
      entityType: 'event',
      entityId: eventId,
      metadata: { guest: guestId, fields: Object.keys(next) },
    });
    const rows = await store.list('event_guest_sessions', owner.organizationId, {
      eq: { guest_id: guestId },
    });
    return ok(toListItems([updated], rows)[0]!);
  });
}

/* ------------------------------------------------------------ export */

export async function exportGuests(
  store: DataStore,
  owner: EventOwner,
  eventId: string,
  options: { filter?: GuestFilter | null; kind?: 'guests' | 'headcount' } = {},
): Promise<
  Result<{ csv: string; filename: string; rows: number; headcounts?: SessionHeadcount[] }>
> {
  return guard('exportGuests', async () => {
    const loaded = await loadEvent(store, owner.organizationId, eventId);
    if (!loaded) return err('not_found', 'That event does not exist.');
    const [guests, rows] = await Promise.all([
      store.list('event_guests', owner.organizationId, { eq: { event_id: eventId } }),
      store.list('event_guest_sessions', owner.organizationId, { eq: { event_id: eventId } }),
    ]);
    let chosen = guests;
    if (options.filter) {
      const keep = new Set(
        filterGuests(toListItems(guests, rows), options.filter).map((i) => i.id),
      );
      chosen = guests.filter((g) => keep.has(g.id));
    }
    const input = {
      guests: chosen,
      rows: rows.filter((r) => chosen.some((g) => g.id === r.guest_id)),
      sessions: loaded.sessions,
      questions: loaded.event.questions as RegistrationQuestion[],
      timeZone: loaded.event.time_zone,
    };
    const kind = options.kind ?? 'guests';
    const counts = kind === 'headcount' ? headcounts({ ...input, guests, rows }) : undefined;
    const csv = kind === 'headcount' ? headcountCsv(counts!) : guestExportCsv(input);
    await recordAudit(store, {
      organizationId: owner.organizationId,
      userId: owner.userId,
      action: 'event.guests_exported',
      entityType: 'event',
      entityId: eventId,
      metadata: { kind, rows: chosen.length, filtered: Boolean(options.filter) },
    });
    const date = new Date().toISOString().slice(0, 10);
    return ok({
      csv,
      filename: `${loaded.event.slug}-${kind === 'headcount' ? 'headcount' : 'guests'}-${date}.csv`,
      rows: kind === 'headcount' ? (counts?.length ?? 0) : chosen.length,
      headcounts: counts,
    });
  });
}

/* ------------------------------------------------------------ import */

export interface ImportRequest {
  csv: string;
  mapping?: Record<string, ImportTarget>;
  sessionIds: string[];
  tags: string[];
  status: 'invited' | 'going';
  commit: boolean;
}

export interface ImportResult {
  headers: string[];
  mapping: Record<string, ImportTarget>;
  sample: { email: string; name: string; company: string | null; tags: string[] }[];
  people: number;
  existing: number;
  invalidLines: number[];
  duplicateInFile: number;
  warnings: string[];
  committed: AddGuestsOutcome | null;
}

export async function importGuests(
  store: DataStore,
  owner: EventOwner,
  eventId: string,
  request: ImportRequest,
): Promise<Result<ImportResult>> {
  return guard('importGuests', async () => {
    const event = await store.get('events', owner.organizationId, eventId);
    if (!event) return err('not_found', 'That event does not exist.');
    const csv = parseGuestCsv(request.csv);
    if (!csv.headers.length || !csv.rows.length)
      return err('invalid_input', 'That file has no rows.');
    const questions = event.questions as RegistrationQuestion[];
    const mapping = request.mapping ?? guessMapping(csv, questions);
    if (!Object.values(mapping).includes('email')) {
      return err('invalid_input', 'No column holds email addresses. Choose which one does.');
    }
    // Only real question ids may receive answers.
    const questionIds = new Set(questions.map((q) => q.id));
    for (const [h, target] of Object.entries(mapping)) {
      if (target.startsWith('question:') && !questionIds.has(target.slice(9)))
        mapping[h] = 'ignore';
    }
    const preview = previewImport(csv, mapping);
    const existing = await store.list('event_guests', owner.organizationId, {
      eq: { event_id: eventId },
    });
    const known = new Set(existing.map((g) => g.email).filter(Boolean));
    const result: ImportResult = {
      headers: csv.headers,
      mapping,
      sample: preview.people.slice(0, 8).map((p) => ({
        email: p.email,
        name: [p.first_name, p.last_name].filter(Boolean).join(' '),
        company: p.company,
        tags: p.tags,
      })),
      people: preview.people.length,
      existing: preview.people.filter((p) => known.has(p.email)).length,
      invalidLines: preview.invalidLines.slice(0, 50),
      duplicateInFile: preview.duplicateInFile,
      warnings: csv.warnings,
      committed: null,
    };
    if (!request.commit) return ok(result);
    const added = await addGuests(store, owner, eventId, {
      people: preview.people.map((p) => ({ ...p, answers: p.answers })),
      sessionIds: request.sessionIds,
      status: request.status,
      source: 'import',
      tags: request.tags,
    });
    if (!added.ok) return added;
    return ok({ ...result, committed: added.value });
  });
}

/* ----------------------------------------------------- campaign audiences */

function matchesAudience(
  audience: EventAudience,
  guest: EventGuest,
  rows: readonly EventGuestSession[],
): boolean {
  const own = rows.filter((r) => r.guest_id === guest.id);
  const inSession = (sessionId?: string | null) =>
    sessionId ? own.filter((r) => r.session_id === sessionId) : own;
  switch (audience.kind) {
    case 'all':
      return audience.sessionId ? inSession(audience.sessionId).length > 0 : true;
    case 'guests':
      return audience.guestIds.includes(guest.id);
    case 'tag': {
      const tagged = guest.tags.some((t) => t.toLowerCase() === audience.tag.toLowerCase());
      if (!tagged) return false;
      return audience.sessionId
        ? inSession(audience.sessionId).some(
            (r) => r.status !== 'declined' && r.status !== 'not_going',
          )
        : true;
    }
    case 'checked_in':
      return inSession(audience.sessionId).some((r) => r.checked_in_at);
    case 'status': {
      if (audience.sessionId) {
        const row = own.find((r) => r.session_id === audience.sessionId);
        return Boolean(row && audience.statuses.includes(row.status));
      }
      return audience.statuses.includes(guestLevelStatus(own.map((r) => r.status)));
    }
  }
}

/**
 * Campaign recipients for an audience (WS5's invite / reminder / notice /
 * blast drafts): hosts with an email, each with their personal link. Plus-ones
 * without their own email are reached through their host.
 */
export async function resolveAudience(
  store: DataStore,
  organizationId: string,
  eventId: string,
  audience: EventAudience,
): Promise<Result<AudienceMember[]>> {
  return guard('resolveAudience', async () => {
    const event = await store.get('events', organizationId, eventId);
    if (!event) return err('not_found', 'That event does not exist.');
    const [guests, rows] = await Promise.all([
      store.list('event_guests', organizationId, { eq: { event_id: eventId } }),
      store.list('event_guest_sessions', organizationId, { eq: { event_id: eventId } }),
    ]);
    const members: AudienceMember[] = [];
    for (const g of guests) {
      if (g.parent_guest_id || !g.email) continue;
      if (!matchesAudience(audience, g, rows)) continue;
      const links = guestLinks(event, g);
      if (!links.invitePath) continue;
      members.push({
        guestId: g.id,
        email: g.email,
        firstName: g.first_name,
        name: [g.first_name, g.last_name].filter(Boolean).join(' ') || null,
        company: g.company,
        recordId: g.record_id,
        rsvpPath: links.invitePath,
      });
    }
    return ok(members);
  });
}

/* ------------------------------------------------------ needs notifying */

/** Which notice a (current status, last told) pair calls for, if any. */
export function notifyKindFor(
  status: EventGuestStatus,
  told: EventGuestStatus | undefined,
): NotifyKind | null {
  if (status === told) return null;
  switch (status) {
    case 'going':
      return told === 'waitlist' ? 'promoted' : 'confirmed';
    case 'waitlist':
      return 'waitlisted';
    case 'declined':
      return 'declined';
    case 'pending':
      return 'pending';
    default:
      return null;
  }
}

const NOTIFY_ORDER: NotifyKind[] = ['confirmed', 'promoted', 'waitlisted', 'pending', 'declined'];

/**
 * The "Needs notifying (N)" queue: (guest, session) pairs whose status no
 * SENT campaign has told the guest about, one group per kind of message.
 * Hosts with an email only (plus-ones hear through their host).
 */
export async function needsNotifying(
  store: DataStore,
  organizationId: string,
  eventId: string,
): Promise<Result<NeedsNotifyingGroup[]>> {
  return guard('needsNotifying', async () => {
    const [guests, rows] = await Promise.all([
      store.list('event_guests', organizationId, { eq: { event_id: eventId } }),
      store.list('event_guest_sessions', organizationId, { eq: { event_id: eventId } }),
    ]);
    const hosts = new Map(
      guests.filter((g) => !g.parent_guest_id && g.email).map((g) => [g.id, g]),
    );
    const groups = new Map<NotifyKind, NeedsNotifyingGroup>();
    for (const r of rows) {
      const g = hosts.get(r.guest_id);
      if (!g) continue;
      const kind = notifyKindFor(r.status, g.notified_status?.[r.session_id]);
      if (!kind) continue;
      const group = groups.get(kind) ?? { kind, items: [] };
      group.items.push({ guestId: g.id, sessionId: r.session_id, status: r.status });
      groups.set(kind, group);
    }
    return ok(
      NOTIFY_ORDER.map((k) => groups.get(k)).filter((g): g is NeedsNotifyingGroup => Boolean(g)),
    );
  });
}

/**
 * Record that a SENT campaign told these guests their status. WS5 calls it
 * only after the campaign has actually sent (never on draft). A pair whose
 * status has changed again since is left in the queue.
 */
export async function markNotified(
  store: DataStore,
  organizationId: string,
  eventId: string,
  items: readonly { guestId: string; sessionId: string; status: EventGuestStatus }[],
): Promise<Result<{ updated: number }>> {
  if (!items.length) return ok({ updated: 0 });
  return guard('markNotified', async () => {
    const guestIds = [...new Set(items.map((i) => i.guestId))];
    const [guests, rows] = await Promise.all([
      store.list('event_guests', organizationId, {
        eq: { event_id: eventId },
        in: { id: guestIds },
      }),
      store.list('event_guest_sessions', organizationId, {
        eq: { event_id: eventId },
        in: { guest_id: guestIds },
      }),
    ]);
    let updated = 0;
    for (const g of guests) {
      const next = { ...(g.notified_status ?? {}) };
      let changed = false;
      for (const item of items.filter((i) => i.guestId === g.id)) {
        const row = rows.find((r) => r.guest_id === g.id && r.session_id === item.sessionId);
        if (!row || row.status !== item.status) continue;
        next[item.sessionId] = item.status;
        changed = true;
      }
      if (!changed) continue;
      await store.update('event_guests', organizationId, g.id, { notified_status: next });
      updated++;
    }
    if (updated) {
      await recordAudit(store, {
        organizationId,
        userId: null,
        action: 'event.notified_marked',
        entityType: 'event',
        entityId: eventId,
        metadata: { guests: guestIds.slice(0, 500), updated },
      });
    }
    return ok({ updated });
  });
}
