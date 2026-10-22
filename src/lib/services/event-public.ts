import 'server-only';
import { getAuthContext, hasRole } from '@/lib/auth/session';
import { env } from '@/lib/config/env';
import { isMissingColumnError, isMissingTableError } from '@/lib/db/missing-table';
import type { DataStore } from '@/lib/db/store';
import { soleOrganizationId } from '@/lib/db/tenancy';
import { needsApproval, seatsLeft, waitlistOn } from '@/lib/events/capacity';
import {
  EVENT_SLUG_RE,
  PUBLIC_VIEWER,
  eventPaths,
  isPageLive,
  type EventPublicFacts,
  type EventQuestionPublic,
  type EventRegistrationPublic,
  type EventSessionPublic,
  type EventVenuePublic,
  type EventViewer,
  type MediaMap,
} from '@/lib/events/contracts';
import { formToken, turnstileRequired, turnstileSiteKey } from '@/lib/events/public-gate';
import {
  activeQuestions,
  registrationAccepting,
  type RegistrationQuestion,
} from '@/lib/events/registration';
import { parseEventDoc, type EventDoc } from '@/lib/events/schema';
import {
  CHECKIN_TOKEN_PURPOSE,
  RSVP_TOKEN_PURPOSE,
  checkinToken,
  inviteToken,
  parseGuestToken,
  readRememberCookie,
  verifyGuestToken,
  type GuestTokenPurpose,
} from '@/lib/events/tokens';
import {
  filterDocForViewer,
  sessionVisibleTo,
  venueForViewer,
  viewerForGuest,
} from '@/lib/events/visibility';
import { sign } from '@/lib/security/crypto';
import { log } from '@/lib/security/redact';
import { resolveMedia } from '@/lib/services/event-media';
import { eventMediaPublicUrl } from '@/lib/storage/provider';
import type {
  EventGuest,
  EventGuestSession,
  EventGuestStatus,
  EventRecord,
  EventSession,
} from '@/lib/types/domain';
import { newId, sha256 } from '@/lib/util/hash';

/**
 * The public read side of event pages (D-075): everything /e/* shows a guest.
 *
 *   - Only the PUBLISHED snapshot (published_doc) is ever read here; drafts,
 *     templates, archived and private events do not exist on this surface.
 *   - Reads run under the service role with explicit organization_id and
 *     event filters (the deployment is single tenant: soleOrganizationId).
 *   - Who is looking is worked out from a personal token (/i/<token>), the
 *     remembered-RSVP cookie, or nobody; the document is then filtered for
 *     that viewer on the server (lib/events/visibility.ts) and the facts are
 *     built from whitelisted fields only: no emails, no host notes, no counts
 *     the host did not choose to show, no address the reveal rule hides.
 */

export type PublicEventResolution =
  | { kind: 'event'; organizationId: string; event: EventRecord; sessions: EventSession[] }
  | { kind: 'redirect'; slug: string }
  | { kind: 'not_found' };

export interface ResolvePublicOptions {
  /**
   * The request carries a guest's personal token (an invite, a ticket, a
   * QR). A PRIVATE event opens only this way: "only guests with their
   * personal link". Its bare /e/<slug> page, public calendar file and
   * public RSVP form stay 404.
   */
  personal?: boolean;
}

function shownPublicly(event: EventRecord, options: ResolvePublicOptions): boolean {
  return (
    !event.is_template &&
    (event.visibility !== 'private' || options.personal === true) &&
    isPageLive(event)
  );
}

/** The event behind /e/<slug>: the event, a 301 to its current slug, or nothing. */
export async function resolvePublicEvent(
  store: DataStore,
  slug: string,
  options: ResolvePublicOptions = {},
): Promise<PublicEventResolution> {
  if (!EVENT_SLUG_RE.test(slug)) return { kind: 'not_found' };
  try {
    const organizationId = await soleOrganizationId('event-public');
    if (!organizationId) return { kind: 'not_found' };
    const event = await store.findOne('events', organizationId, { eq: { slug } });
    if (!event) {
      const alias = await store.findOne('event_slug_aliases', organizationId, { eq: { slug } });
      if (!alias) return { kind: 'not_found' };
      const current = await store.get('events', organizationId, alias.event_id);
      return current && shownPublicly(current, options) && current.slug !== slug
        ? { kind: 'redirect', slug: current.slug }
        : { kind: 'not_found' };
    }
    if (!shownPublicly(event, options)) return { kind: 'not_found' };
    const sessions = await store.list(
      'event_sessions',
      organizationId,
      { eq: { event_id: event.id } },
      { orderBy: [{ field: 'position', direction: 'asc' }] },
    );
    return { kind: 'event', organizationId, event, sessions };
  } catch (error) {
    if (!isMissingTableError(error) && !isMissingColumnError(error)) {
      log.error('Public event read failed', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    return { kind: 'not_found' };
  }
}

/* ------------------------------------------------------------ guests */

export interface ResolvedGuest {
  guest: EventGuest;
  /** The guest's own status rows. */
  rows: EventGuestSession[];
}

async function guestWithRows(
  store: DataStore,
  event: EventRecord,
  guestId: string,
): Promise<ResolvedGuest | null> {
  const guest = await store.get('event_guests', event.organization_id, guestId);
  if (!guest || guest.event_id !== event.id) return null;
  const rows = await store.list('event_guest_sessions', event.organization_id, {
    eq: { guest_id: guest.id, event_id: event.id },
  });
  return { guest, rows };
}

/** The guest a personal invite or check-in token names, verified, or null. */
export async function resolveGuestToken(
  store: DataStore,
  event: EventRecord,
  token: string,
  purpose: GuestTokenPurpose,
): Promise<ResolvedGuest | null> {
  const named = parseGuestToken(token);
  if (!named || named.organizationId !== event.organization_id.toLowerCase()) return null;
  try {
    const found = await guestWithRows(store, event, named.guestId);
    if (!found) return null;
    const valid = verifyGuestToken(purpose, token, {
      organizationId: event.organization_id,
      eventId: event.id,
      guestId: found.guest.id,
      tokenVersion: found.guest.token_version,
    });
    return valid ? found : null;
  } catch {
    return null;
  }
}

/** A personal invite token's guest (a host, never a plus-one: plus-ones have no invite). */
export async function resolveInvite(
  store: DataStore,
  event: EventRecord,
  token: string,
): Promise<ResolvedGuest | null> {
  const found = await resolveGuestToken(store, event, token, RSVP_TOKEN_PURPOSE);
  return found && !found.guest.parent_guest_id ? found : null;
}

export async function resolveCheckinToken(
  store: DataStore,
  event: EventRecord,
  token: string,
): Promise<ResolvedGuest | null> {
  return resolveGuestToken(store, event, token, CHECKIN_TOKEN_PURPOSE);
}

/** The guest the remembered-RSVP cookie names, if it still matches their token version. */
export async function resolveRemembered(
  store: DataStore,
  event: EventRecord,
  cookieValue: string | null | undefined,
): Promise<ResolvedGuest | null> {
  const remembered = readRememberCookie(cookieValue, event.id);
  if (!remembered) return null;
  try {
    const found = await guestWithRows(store, event, remembered.guestId);
    if (!found || found.guest.token_version !== remembered.tokenVersion) return null;
    if (found.guest.parent_guest_id) return null;
    return found;
  } catch {
    return null;
  }
}

/** Personal links for a guest (app-relative). */
export function guestLinks(
  event: Pick<EventRecord, 'organization_id' | 'id' | 'slug'>,
  guest: EventGuest,
) {
  const subject = {
    organizationId: event.organization_id,
    eventId: event.id,
    guestId: guest.id,
    tokenVersion: guest.token_version,
  };
  const invite = guest.parent_guest_id ? null : inviteToken(subject);
  const checkin = checkinToken(subject);
  return {
    invitePath: invite ? eventPaths.invite(event.slug, invite) : null,
    ticketPath: invite ? `${eventPaths.invite(event.slug, invite)}/ticket` : null,
    calendarPath: invite ? eventPaths.inviteCalendar(event.slug, invite) : null,
    checkinPath: eventPaths.checkinQr(event.slug, checkin),
  };
}

/** Absolute form of an app path, for ICS files and share links. */
export function absoluteUrl(path: string): string {
  return `${env().appUrl.replace(/\/+$/, '')}${path}`;
}

/* ------------------------------------------------------------- facts */

function sessionVenue(session: EventSession, viewer: EventViewer): EventVenuePublic | null {
  return session.venue ? venueForViewer(session.venue, viewer) : null;
}

/** The sessions this viewer may see, as the page shows them. */
export function publicSessions(
  event: EventRecord,
  sessions: readonly EventSession[],
  viewer: EventViewer,
  rows: readonly EventGuestSession[],
): EventSessionPublic[] {
  return sessions
    .filter((s) => sessionVisibleTo(s, viewer))
    .map((s) => {
      const left = seatsLeft(s, event, rows);
      const full = left !== null && left <= 0;
      return {
        id: s.id,
        name: s.name,
        description: s.description,
        startsAt: s.starts_at,
        endsAt: s.ends_at,
        venue: sessionVenue(s, viewer),
        remaining: event.registration.show_remaining ? left : null,
        full,
        waitlistOpen: full && waitlistOn(s, event),
        requiresApproval: needsApproval(s, event, 'public'),
      };
    });
}

export function buildFacts(
  event: EventRecord,
  sessions: readonly EventSession[],
  viewer: EventViewer,
  rows: readonly EventGuestSession[],
  now: Date = new Date(),
): EventPublicFacts {
  const ogPath = event.og_image_path ? eventMediaPublicUrl(event.og_image_path) : null;
  return {
    id: event.id,
    slug: event.slug,
    title: event.title,
    status: event.status,
    visibility: event.visibility,
    timeZone: event.time_zone,
    startsAt: event.starts_at,
    endsAt: event.ends_at,
    venue: venueForViewer(event.venue, viewer),
    sessions: publicSessions(event, sessions, viewer, rows),
    access: event.access,
    registrationOpen:
      event.status === 'published' && registrationAccepting(event.registration, now),
    closesAt: event.registration.closes_at,
    cancelled: event.status === 'cancelled' ? { message: event.cancel_message } : null,
    scheduleVersion: event.schedule_version,
    publishedVersion: event.published_version,
    ogImageUrl: ogPath,
    path: eventPaths.page(event.slug),
  };
}

/** The questions the form shows, with their show-if conditions (v1 nice). */
export function publicQuestions(
  questions: readonly RegistrationQuestion[],
  visibleSessionIds: ReadonlySet<string>,
): EventQuestionPublic[] {
  return activeQuestions(questions)
    .filter((q) => !q.session_id || visibleSessionIds.has(q.session_id))
    .map((q) => ({
      id: q.id,
      type: q.type,
      label: q.label,
      help: q.help,
      required: q.required,
      options: q.options,
      sessionId: q.session_id,
      askPlusOnes: q.ask_plus_ones,
      showIf: q.show_if ?? null,
    }));
}

export function buildRegistrationPublic(
  event: EventRecord,
  facts: EventPublicFacts,
): EventRegistrationPublic {
  const visible = new Set(facts.sessions.map((s) => s.id));
  const reg = event.registration;
  return {
    access: event.access,
    open: facts.registrationOpen,
    closesAt: reg.closes_at,
    showRemaining: reg.show_remaining,
    responseSet: reg.response_set,
    plusOnes: {
      max: reg.plus_ones.max,
      perSession: reg.plus_ones.per_session,
      collectEmail: reg.plus_ones.collect_email,
      askQuestions: reg.plus_ones.ask_questions,
    },
    questions: publicQuestions(event.questions as RegistrationQuestion[], visible),
    sessions: facts.sessions,
    requestInvite: reg.request_invite,
    guestWall: reg.guest_wall,
    turnstileSiteKey: turnstileRequired(event) ? turnstileSiteKey() : null,
  };
}

/* ---------------------------------------------------------- the page */

export interface PublicPage {
  event: EventRecord;
  sessions: EventSession[];
  viewer: EventViewer;
  guest: ResolvedGuest | null;
  doc: EventDoc;
  facts: EventPublicFacts;
  registration: EventRegistrationPublic;
  media: MediaMap;
  formToken: string;
  /** The viewer's ticket (personal link or remembered browser), when they have one. */
  ticketPath: string | null;
  invitePath: string | null;
}

/** The published document, or null when it does not parse (logged). */
export function publishedDoc(event: EventRecord): EventDoc | null {
  const parsed = parseEventDoc(event.published_doc);
  if (parsed.ok) return parsed.value;
  log.error('A published event page failed validation', {
    event: event.id,
    issue: parsed.issues[0] ?? '',
  });
  return null;
}

/** Everything one viewer's render of /e/<slug> (or a personal link) needs. */
export async function buildPublicPage(
  store: DataStore,
  resolved: Extract<PublicEventResolution, { kind: 'event' }>,
  guest: ResolvedGuest | null,
  now: Date = new Date(),
): Promise<PublicPage | null> {
  const { event, sessions } = resolved;
  const doc = publishedDoc(event);
  if (!doc) return null;
  const rows = await store
    .list('event_guest_sessions', event.organization_id, { eq: { event_id: event.id } })
    .catch(() => [] as EventGuestSession[]);
  const viewer = guest ? viewerForGuest(guest.guest, guest.rows) : PUBLIC_VIEWER;
  const facts = buildFacts(event, sessions, viewer, rows, now);
  const visibleSessionIds = new Set(facts.sessions.map((s) => s.id));
  const filtered = filterDocForViewer(doc, viewer, {
    visibleSessionIds,
    venueRevealed: facts.venue?.revealed ?? true,
  });
  const media = await resolveMedia(store, event.organization_id, event.id, filtered, viewer);
  const links = guest ? guestLinks(event, guest.guest) : null;
  return {
    event,
    sessions,
    viewer,
    guest,
    doc: filtered,
    facts,
    registration: buildRegistrationPublic(event, facts),
    media: media.ok ? media.value : {},
    formToken: formToken(event.id, now.getTime()),
    ticketPath: guest && guest.rows.some((r) => r.status !== 'invited') ? links!.ticketPath : null,
    invitePath: links?.invitePath ?? null,
  };
}

/* ------------------------------------------------------------ ticket */

export interface TicketSession {
  id: string;
  name: string;
  startsAt: string | null;
  endsAt: string | null;
  venue: EventVenuePublic | null;
}

export interface TicketPerson {
  guestId: string;
  name: string;
  isPlusOne: boolean;
  /** App-relative QR target (/e/<slug>/c/<token>). Only Going people get one. */
  checkinPath: string | null;
  sessions: { sessionId: string; status: EventGuestStatus; checkedInAt: string | null }[];
}

export interface TicketView {
  eventId: string;
  slug: string;
  title: string;
  timeZone: string;
  cancelled: boolean;
  venue: EventVenuePublic;
  sessions: TicketSession[];
  people: TicketPerson[];
  /** Personal ICS path (host only). */
  calendarPath: string | null;
  invitePath: string | null;
}

function personName(g: EventGuest): string {
  return [g.first_name, g.last_name].filter(Boolean).join(' ').trim() || 'Guest';
}

/**
 * A guest's ticket: their sessions (status and times), their plus-ones each
 * with their own QR, the venue as the reveal rule allows. `full` adds the
 * personal links (only for the guest's own link, never for someone who
 * merely scanned a QR).
 */
export async function buildTicket(
  store: DataStore,
  event: EventRecord,
  sessions: readonly EventSession[],
  host: EventGuest,
  options: { full: boolean },
): Promise<TicketView> {
  const [children, rows] = await Promise.all([
    store.list('event_guests', event.organization_id, {
      eq: { event_id: event.id, parent_guest_id: host.id },
    }),
    store.list('event_guest_sessions', event.organization_id, { eq: { event_id: event.id } }),
  ]);
  const people = [host, ...children];
  const viewer = viewerForGuest(host, rows);
  const mine = new Set(rows.filter((r) => r.guest_id === host.id).map((r) => r.session_id));
  const links = guestLinks(event, host);
  return {
    eventId: event.id,
    slug: event.slug,
    title: event.title,
    timeZone: event.time_zone,
    cancelled: event.status === 'cancelled',
    venue: venueForViewer(event.venue, viewer),
    sessions: sessions
      .filter((s) => mine.has(s.id))
      .map((s) => ({
        id: s.id,
        name: s.name,
        startsAt: s.starts_at,
        endsAt: s.ends_at,
        venue: s.venue ? venueForViewer(s.venue, viewer) : null,
      })),
    people: people.map((p) => {
      const own = rows.filter((r) => r.guest_id === p.id);
      const going = own.some((r) => r.status === 'going');
      return {
        guestId: p.id,
        name: personName(p),
        isPlusOne: Boolean(p.parent_guest_id),
        checkinPath:
          going && event.status !== 'cancelled' ? guestLinks(event, p).checkinPath : null,
        sessions: own.map((r) => ({
          sessionId: r.session_id,
          status: r.status,
          checkedInAt: r.checked_in_at,
        })),
      };
    }),
    calendarPath: options.full ? links.calendarPath : null,
    invitePath: options.full ? links.invitePath : null,
  };
}

/* ---------------------------------------------------------- the beacon */

/** A visitor hash that changes every day (a visitor cannot be followed across days). */
export function dailyVisitorHash(day: string, ip: string, userAgent: string): string {
  const salt = sign(`event-view/v1|${day}`);
  return sha256(`${salt}|${ip}|${userAgent.slice(0, 300)}`).slice(0, 48);
}

/** Record one page view (from the JS beacon; a GET never records anything). */
export async function recordPageView(
  store: DataStore,
  event: EventRecord,
  input: {
    ip: string;
    userAgent: string;
    guestId: string | null;
    source: string | null;
    now?: Date;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  const day = now.toISOString().slice(0, 10);
  const visitorHash = dailyVisitorHash(day, input.ip, input.userAgent);
  try {
    const existing = await store.findOne('event_page_views', event.organization_id, {
      eq: { event_id: event.id, day, visitor_hash: visitorHash },
    });
    if (existing) {
      if (!existing.guest_id && input.guestId) {
        await store.update('event_page_views', event.organization_id, existing.id, {
          guest_id: input.guestId,
        });
      }
      return;
    }
    await store.insert('event_page_views', {
      id: newId(),
      organization_id: event.organization_id,
      event_id: event.id,
      day,
      visitor_hash: visitorHash,
      guest_id: input.guestId,
      source: input.source ? input.source.slice(0, 120) : null,
      created_at: now.toISOString(),
    });
  } catch (error) {
    // A second tab racing the first hits the unique key: one view either way.
    if (
      !isMissingTableError(error) &&
      !/duplicate key|23505/i.test(String((error as Error)?.message ?? ''))
    ) {
      log.warn('Event page view not recorded', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * The bare /e/<slug> page: public and unlisted events for anyone; a PRIVATE
 * event only for a browser its guest already opened through their personal
 * link (the remembered cookie) or a signed-in member of the event's
 * organization (an owner previewing the live page). Aliases redirect only
 * for events open to everyone, so an old slug never reveals a private
 * event's new address.
 */
export async function resolvePageForViewer(
  store: DataStore,
  slug: string,
  rememberCookie: string | null | undefined,
): Promise<{ resolved: PublicEventResolution; remembered: ResolvedGuest | null }> {
  const open = await resolvePublicEvent(store, slug);
  if (open.kind !== 'not_found') {
    const remembered =
      open.kind === 'event' ? await resolveRemembered(store, open.event, rememberCookie) : null;
    return { resolved: open, remembered };
  }
  const personal = await resolvePublicEvent(store, slug, { personal: true });
  if (personal.kind !== 'event' || personal.event.visibility !== 'private') {
    return { resolved: { kind: 'not_found' }, remembered: null };
  }
  const remembered = await resolveRemembered(store, personal.event, rememberCookie);
  if (remembered) return { resolved: personal, remembered };
  const auth = await getAuthContext().catch(() => null);
  const member =
    !!auth && auth.organizationId === personal.event.organization_id && hasRole(auth, 'member');
  return member
    ? { resolved: personal, remembered: null }
    : { resolved: { kind: 'not_found' }, remembered: null };
}
