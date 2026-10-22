import 'server-only';
import { randomBytes } from 'node:crypto';
import { busyPictureFor } from '@/lib/booking/availability';
import {
  BOOKING_CONFIG_SCHEMA,
  DEFAULT_BOOKING_CONFIG,
  firstName,
  inPersonOffered,
  MEETING_KINDS,
  MEETING_MINUTES,
  parseBookingConfig,
  SLUG,
  bookingPhotoPath,
  isOwnPhotoPath,
  type BookingConfig,
  type MeetingKind,
  type MeetingType,
  type PhotoRef,
} from '@/lib/booking/config';
import {
  bookingsBefore,
  openSlots,
  slotProblem,
  type EngineInput,
  type LinkBooking,
} from '@/lib/booking/engine';
import { bookingEventDraft, declineDraft, googleCalendarTemplateUrl } from '@/lib/booking/event';
import {
  CLOSED_MESSAGE,
  knownZone,
  UNAVAILABLE_MESSAGE,
  type BookingOutcomeStatus,
  videoProviderLabel,
  type PublicBookingPage,
  type PublicBookingResult,
  type PublicBookingView,
  type PublicSlot,
  type PublicSlots,
} from '@/lib/booking/public';
import { cleanGuests, type BookingRequestInput } from '@/lib/booking/request';
import type { EventDraft } from '@/lib/calendar/edit-rules';
import { calendarEditAccess } from '@/lib/calendar/edit-access';
import { isEmailAddress } from '@/lib/calendar/edit-rules';
import { sniffPhoto } from '@/lib/campaigns/photos';
import {
  calendarSource,
  invalidateCalendarCache,
  readCalendarList,
  type CalendarSource,
} from '@/lib/calendar/range-reader';
import { env } from '@/lib/config/env';
import { isMissingColumnError, isMissingTableError } from '@/lib/db/missing-table';
import type { DataStore } from '@/lib/db/store';
import { soleOrganizationId } from '@/lib/db/tenancy';
import { recordAudit } from '@/lib/security/audit';
import { rateLimit } from '@/lib/security/limits';
import { log } from '@/lib/security/redact';
import type { StorageProvider } from '@/lib/storage/provider';
import { readTeam } from '@/lib/tasks/principal';
import type { BookingRequest, BookingSettingsRow, UserProfile } from '@/lib/types/domain';
import { newId, sha256 } from '@/lib/util/hash';
import { processWide } from '@/lib/util/process-state';
import { err, ok, type Result } from '@/lib/util/result';
import { createLinkEvent } from './booking-calendar';
import { principalTimeZone } from './push-alerts';

/**
 * The booking link (D-074): its settings, the public page's data and open
 * times, the requests visitors send, and what Copilot does with them.
 *
 * The rules that matter, enforced here and nowhere else:
 * - The public side reads busy time only (lib/booking/availability.ts) and
 *   writes one thing: a pending request. It never touches the calendar and
 *   never sends an email.
 * - A request reaches the calendar only when a person presses Approve, which
 *   re-checks the time against the live calendar and every rule, then
 *   creates the event through lib/calendar/write.ts (the editing grant, a
 *   writable calendar), inviting the requester (Send: sendUpdates 'all').
 * - Without the tables (the migration not run yet) everything fails safe:
 *   the page is closed, the Calendar button is hidden, Settings says what to run.
 */

export const BOOKING_NOT_SET_UP =
  'The booking link needs its tables first: run supabase/migrations/20261022000000_booking_link.sql in the Supabase SQL editor.';

/** The time the approval re-check allows a claim to stand before another click may take it over. */
const CLAIM_TIMEOUT_MS = 2 * 60_000;
/** Requests waiting per email address. */
export const MAX_OPEN_PER_EMAIL = 3;
/**
 * Requests waiting per sender (the keyed hash of their address), whatever
 * email they type: kept in the table, so it holds across restarts, and it
 * stops one sender filling the link with made-up addresses.
 */
export const MAX_OPEN_PER_ADDRESS = 3;
/**
 * New meeting requests the whole link takes in a day while they wait. Each
 * holds its time, so without this a few senders could close every slot for
 * three weeks; past it, the page still takes messages.
 */
export const MAX_NEW_HOLDS_PER_DAY = 6;

export const BUSY_LINK_MESSAGE =
  'This booking link has taken a lot of bookings today. Try again tomorrow, or leave a message.';

/**
 * One request at a time per organization, from the check of its time to
 * its insert: two visitors sending the same slot at the same moment cannot
 * both be kept. The app runs as one process, like its rate limits.
 */
const submitLocks = processWide('booking-submit-locks', () => new Map<string, Promise<void>>());

export async function oneAtATime<T>(organizationId: string, work: () => Promise<T>): Promise<T> {
  const before = submitLocks.get(organizationId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = before.then(() => mine);
  submitLocks.set(organizationId, tail);
  await before;
  try {
    return await work();
  } finally {
    release();
    if (submitLocks.get(organizationId) === tail) submitLocks.delete(organizationId);
  }
}

/* ---------------------------------------------------------------- settings */

export interface BookingSettingsView {
  /** The tables exist. */
  available: boolean;
  enabled: boolean;
  slug: string;
  config: BookingConfig;
  /** No row yet: everything shown is a default. */
  saved: boolean;
}

/** A first slug for a host who has none: their first name, else "meet". */
export function suggestedSlug(name: string | null | undefined): string {
  const word = firstName(name ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]/g, '');
  return SLUG.safeParse(word).success ? word : 'meet';
}

async function settingsRow(
  store: DataStore,
  organizationId: string,
): Promise<{ available: true; row: BookingSettingsRow | null } | { available: false }> {
  try {
    return { available: true, row: await store.findOne('booking_settings', organizationId, {}) };
  } catch (error) {
    if (isMissingTableError(error)) return { available: false };
    throw error;
  }
}

export interface HostIdentity {
  userId: string | null;
  email: string | null;
  fullName: string | null;
}

/** The person whose calendar the link books: the organization's principal. */
export async function readHost(store: DataStore, organizationId: string): Promise<HostIdentity> {
  const team = await readTeam(store, organizationId);
  const userId = team.principal?.userId ?? null;
  const member = team.members.find((m) => m.userId === userId);
  return { userId, email: member?.email ?? null, fullName: member?.fullName ?? null };
}

export async function readBookingSettings(
  store: DataStore,
  organizationId: string,
): Promise<BookingSettingsView> {
  const found = await settingsRow(store, organizationId);
  if (!found.available || !found.row) {
    const host = await readHost(store, organizationId).catch(() => null);
    return {
      available: found.available,
      enabled: false,
      slug: suggestedSlug(host?.fullName),
      config: { ...structuredClone(DEFAULT_BOOKING_CONFIG), displayName: host?.fullName ?? '' },
      saved: false,
    };
  }
  return {
    available: true,
    enabled: found.row.enabled,
    slug: found.row.slug,
    config: parseBookingConfig(found.row.settings),
    saved: true,
  };
}

export interface BookingSettingsInput {
  enabled: boolean;
  slug: string;
  config: BookingConfig;
}

/**
 * Save Settings > Booking link. The photo is never taken from the input:
 * the stored one is kept, and only setBookingPhoto (an upload checked by its
 * bytes, under a path Copilot named itself) may change it. So a hand-made
 * request cannot point the public photo route at another stored file, and a
 * Settings tab open since before an upload cannot undo it.
 */
export async function saveBookingSettings(
  store: DataStore,
  organizationId: string,
  userId: string,
  input: BookingSettingsInput,
  now: Date = new Date(),
  internal: { photo?: PhotoRef | null } = {},
): Promise<Result<BookingSettingsView>> {
  const slug = SLUG.safeParse(input.slug);
  if (!slug.success)
    return err('invalid_input', slug.error.issues[0]?.message ?? 'Check the link.');
  const config = BOOKING_CONFIG_SCHEMA.safeParse({ ...input.config, photo: null });
  if (!config.success) {
    const issue = config.error.issues[0];
    return err(
      'invalid_input',
      `Check ${issue?.path.join(' ') || 'the settings'}: ${issue?.message ?? 'not valid'}.`,
    );
  }
  const found = await settingsRow(store, organizationId);
  if (!found.available) return err('not_configured', BOOKING_NOT_SET_UP);
  const photo =
    internal.photo !== undefined
      ? internal.photo
      : found.row
        ? parseBookingConfig(found.row.settings).photo
        : null;
  const saved: BookingConfig = { ...config.data, photo };
  const iso = now.toISOString();
  const row: BookingSettingsRow = {
    id: found.row?.id ?? newId(),
    organization_id: organizationId,
    enabled: input.enabled,
    slug: slug.data,
    settings: saved as unknown as Record<string, unknown>,
    updated_by: userId,
    created_at: found.row?.created_at ?? iso,
    updated_at: iso,
  };
  try {
    await store.upsert('booking_settings', row, ['organization_id']);
  } catch (error) {
    if (isMissingTableError(error)) return err('not_configured', BOOKING_NOT_SET_UP);
    if (/duplicate|unique|23505/i.test(error instanceof Error ? error.message : '')) {
      return err('conflict', 'Another booking link already uses that name. Pick another.');
    }
    throw error;
  }
  await recordAudit(store, {
    organizationId,
    userId,
    action: 'booking.settings_updated',
    entityType: 'booking_settings',
    entityId: row.id,
    metadata: {
      enabled: row.enabled,
      chatbot: config.data.chatbotEnabled,
      approveFirst: config.data.approveFirst,
      places: config.data.places.length,
    },
  });
  return ok({
    available: true,
    enabled: row.enabled,
    slug: row.slug,
    config: saved,
    saved: true,
  });
}

/* ------------------------------------------------------------ the public side */

export interface OpenLink {
  organizationId: string;
  row: BookingSettingsRow;
  config: BookingConfig;
}

/**
 * The link a slug names, while it is on. Single-tenant like the other
 * public endpoints: the one organization there is, and its slug must match.
 * Anything else (no tables, no row, off, another slug, several
 * organizations) is closed.
 */
export async function resolveOpenLink(
  store: DataStore,
  slug: string,
): Promise<{ open: true; link: OpenLink } | { open: false }> {
  const clean = SLUG.safeParse(slug);
  if (!clean.success) return { open: false };
  const organizationId = await soleOrganizationId('booking-link');
  if (!organizationId) return { open: false };
  try {
    const row = await store.findOne('booking_settings', organizationId, {
      eq: { slug: clean.data },
    });
    if (!row || !row.enabled) return { open: false };
    return { open: true, link: { organizationId, row, config: parseBookingConfig(row.settings) } };
  } catch (error) {
    if (!isMissingTableError(error)) {
      log.warn('Booking link could not be read', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
    }
    return { open: false };
  }
}

export function photoUrl(slug: string, config: BookingConfig): string | null {
  return config.photo ? `/meet/${slug}/photo?v=${encodeURIComponent(config.photo.version)}` : null;
}

export interface BookingDeps {
  now?: Date;
  /** Tests: read and write this calendar instead of the runtime's. */
  source?: CalendarSource;
  /** Whether the public chatbot can use the model right now (lib/booking/chat.ts decides). */
  chatMode?: 'live' | 'guided';
  /** The open link, when the caller resolved it already (one read per page view). */
  link?: OpenLink;
}

/** The page a closed link shows: nothing about the host at all. */
export function closedBookingPage(slug: string): PublicBookingPage {
  return {
    state: 'closed',
    slug,
    host: null,
    hostTimeZone: 'UTC',
    offers: { call: false, inPerson: false },
    places: [],
    allowCustomPlace: false,
    kinds: [],
    callProvider: videoProviderLabel(''),
    chatbot: { enabled: false, mode: 'guided' },
    faq: '',
    instant: false,
    guests: { allowed: false, max: 0 },
  };
}

/** Everything the public page shows. Only the card, the offers and the places: no calendar. */
export async function publicBookingPage(
  store: DataStore,
  slug: string,
  deps: BookingDeps = {},
): Promise<PublicBookingPage> {
  const found = deps.link
    ? { open: true as const, link: deps.link }
    : await resolveOpenLink(store, slug);
  if (!found.open) return closedBookingPage(slug);
  const { config, organizationId, row } = found.link;
  const host = await readHost(store, organizationId).catch(() => null);
  const hostTimeZone = await principalTimeZone(store, organizationId);
  const kinds = MEETING_KINDS.filter((k) => (config.kindWindows[k] ?? []).length > 0);
  // In person needs a home city, somewhere to meet and at least one kind with hours.
  const inPerson = inPersonOffered(config) && kinds.length > 0;
  return {
    state: 'open',
    slug: row.slug,
    host: {
      displayName: config.displayName || host?.fullName || config.firmName || 'Book a time',
      title: config.title,
      bio: config.bio,
      firmName: config.firmName,
      photoUrl: photoUrl(row.slug, config),
    },
    hostTimeZone,
    offers: { call: true, inPerson },
    places: inPerson ? config.places : [],
    allowCustomPlace: inPerson && config.allowCustomPlace,
    kinds: inPerson ? kinds : [],
    // What a call is on, never the saved link: that goes only in the invite.
    callProvider: videoProviderLabel(config.callLink),
    chatbot: { enabled: config.chatbotEnabled, mode: deps.chatMode ?? 'guided' },
    faq: config.faq,
    instant: !config.approveFirst,
    guests: { allowed: config.allowGuests && config.maxGuests > 0, max: config.maxGuests },
  };
}

/** How long a fresh booking holds its own time before the calendar is trusted to list it. */
export const ON_CALENDAR_AFTER_MS = 10 * 60_000;

/** Statuses whose time is taken: waiting, held, approved and booked. */
export const TIME_HOLDING_STATUSES = ['pending', 'held', 'approved', 'booked'] as const;

/**
 * The link's own bookings that hold time: waiting, held, approved or booked,
 * from a day ago on. One on the calendar (approved, or booked more than ten
 * minutes ago) is among the busy blocks already, so it is never counted
 * twice; a fresh one holds its own time until Google lists it (an entry at
 * exactly its time stands in for it, lib/booking/engine.ts).
 */
async function linkBookings(
  store: DataStore,
  organizationId: string,
  now: Date,
): Promise<LinkBooking[]> {
  const rows = await store.list('booking_requests', organizationId, {
    in: { status: [...TIME_HOLDING_STATUSES] },
    neq: { meeting_type: 'message' },
    gte: { starts_at: new Date(now.getTime() - 86_400_000).toISOString() },
  });
  return rows.flatMap((r) =>
    r.starts_at && r.ends_at && r.meeting_type !== 'message'
      ? [
          {
            id: r.id,
            start: Date.parse(r.starts_at),
            end: Date.parse(r.ends_at),
            type: r.meeting_type,
            onCalendar:
              r.status === 'approved' ||
              (r.status === 'booked' &&
                Boolean(r.event_id) &&
                now.getTime() - Date.parse(r.updated_at) > ON_CALENDAR_AFTER_MS),
            createdAt: Date.parse(r.created_at),
          },
        ]
      : [],
  );
}

/**
 * The engine's input for a link: the host's busy time and travel days over
 * the horizon, his zone, and the link's own bookings. An error when the
 * calendar cannot be read in full: no slot is ever offered from part of it.
 *
 * `fresh` reads the calendar past its one-minute cache (every check that
 * books, moves or places a time). `ignore` leaves one booking out entirely,
 * its own row and the one calendar entry at exactly its time, so the
 * booking's page can offer the times next to it when it moves.
 */
export async function engineInputFor(
  store: DataStore,
  link: Pick<OpenLink, 'organizationId' | 'config'>,
  deps: BookingDeps & {
    fresh?: boolean;
    ignore?: { id: string; start: number; end: number } | null;
  } = {},
): Promise<Result<{ input: EngineInput; source: CalendarSource; hostZone: string }>> {
  const now = deps.now ?? new Date();
  const { organizationId, config } = link;
  const [hostZone, host] = await Promise.all([
    principalTimeZone(store, organizationId),
    readHost(store, organizationId),
  ]);
  let source = deps.source;
  if (!source) {
    const found = await calendarSource(store, organizationId, host.email ?? '');
    if (!found.ok) return err('not_configured', 'The host’s calendar is not connected.');
    source = found.source;
  }
  if (deps.fresh) invalidateCalendarCache(organizationId);
  const picture = await busyPictureFor(store, organizationId, {
    source,
    hostZone,
    principalId: host.userId,
    config,
    now,
  });
  if (!picture.ok) return picture;
  let bookings = await linkBookings(store, organizationId, now);
  let busy = picture.value.busy;
  const ignore = deps.ignore;
  if (ignore) {
    bookings = bookings.filter((b) => b.id !== ignore.id);
    const own = busy.findIndex(
      (b) => !b.allDay && b.start === ignore.start && b.end === ignore.end,
    );
    if (own >= 0) busy = [...busy.slice(0, own), ...busy.slice(own + 1)];
  }
  return ok({
    hostZone,
    source,
    input: {
      now,
      hostZone,
      config,
      busy,
      travelDays: picture.value.travelDays,
      inPersonPausedThrough: picture.value.inPersonPausedThrough,
      linkBookings: bookings,
    },
  });
}

export function parseQuery(
  type: string | null,
  kind: string | null,
): { type: MeetingType; kind: MeetingKind | null } {
  const t: MeetingType = type === 'in_person' ? 'in_person' : 'call';
  const k = (MEETING_KINDS as readonly string[]).includes(kind ?? '')
    ? (kind as MeetingKind)
    : null;
  return { type: t, kind: t === 'in_person' ? k : null };
}

/** Open times for the public page: start and end instants, nothing else. */
export async function publicSlots(
  store: DataStore,
  slug: string,
  query: { type: string | null; kind: string | null },
  deps: BookingDeps = {},
): Promise<PublicSlots> {
  const q = parseQuery(query.type, query.kind);
  const base = { type: q.type, kind: q.kind, slots: [] };
  const found = await resolveOpenLink(store, slug);
  if (!found.open) {
    return { ...base, state: 'closed', hostTimeZone: 'UTC', message: CLOSED_MESSAGE };
  }
  const { config } = found.link;
  if (q.type === 'in_person' && (!inPersonOffered(config) || !q.kind)) {
    const hostTimeZone = await principalTimeZone(store, found.link.organizationId);
    return { ...base, state: 'ok', hostTimeZone };
  }
  const prepared = await engineInputFor(store, found.link, deps).catch((error: unknown) => {
    log.warn('Booking availability failed', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return null;
  });
  if (!prepared || !prepared.ok) {
    const hostTimeZone = await principalTimeZone(store, found.link.organizationId);
    return { ...base, state: 'unavailable', hostTimeZone, message: UNAVAILABLE_MESSAGE };
  }
  return {
    ...base,
    state: 'ok',
    hostTimeZone: prepared.value.hostZone,
    slots: openSlots(prepared.value.input, q).map((s) => ({ start: s.start, end: s.end })),
  };
}

export interface SubmitContext {
  /** A keyed hash of the sender's address (lib/security/crypto hashIp), for the row. */
  ipHash: string | null;
  now?: Date;
  source?: CalendarSource;
}

export type SubmitOutcome =
  | { kind: 'saved'; id: string; result: PublicBookingResult }
  | { kind: 'ignored'; result: PublicBookingResult };

/** The answer when the time was taken a moment ago: the route adds the next open times. */
export const TAKEN_MESSAGE = 'That time is no longer open. Pick another time.';

/* ------------------------------------------------------ the booking's page */

/** The booking page's token: 32 random bytes, base64url (43 characters). */
const MANAGE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** A new token for a booking's own page, and the only thing kept of it: its SHA-256. */
export function mintManageToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha256(token) };
}

/** The hash a token is looked up by, or null for anything that is not a token's shape. */
export function manageTokenHash(token: string): string | null {
  return MANAGE_TOKEN.test(token) ? sha256(token) : null;
}

/** The booking's own page, as a path on this site. */
export function managePath(slug: string, token: string): string {
  return `/meet/${slug}/b/${token}`;
}

/** The same, absolute, for the event description (the people invited open it from there). */
export function manageUrl(slug: string, token: string): string {
  return `${env().appUrl.replace(/\/+$/, '')}${managePath(slug, token)}`;
}

/**
 * Whether a write failed because the v2 columns or statuses are not there
 * yet (20261022200000_booking_v2.sql not run): the link then keeps working
 * the old way, as a request that waits.
 */
export function bookingV2Missing(error: unknown): boolean {
  if (isMissingColumnError(error)) return true;
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;
  return code === '23514' || (typeof message === 'string' && /check constraint/i.test(message));
}

/**
 * How a call is held, for the visitor: the saved video link's provider
 * (Zoom, Teams...) or Google Meet. The link itself only where the visitor is
 * an invitee holding the booking's own page; `null` leaves it out.
 */
export function callVideo(
  config: BookingConfig,
  meetUrl: string | null,
  withLink = true,
): { label: string; url: string | null } {
  const saved = config.callLink?.trim() || null;
  return { label: videoProviderLabel(saved), url: withLink ? (saved ?? meetUrl) : null };
}

/** At most this many reschedules a booking. */
export const MAX_RESCHEDULES = 5;

/**
 * One booking as the visitor sees it (the confirmation and its own page).
 * Only what they typed or picked, the place, and their own video link.
 */
export function publicBookingView(
  row: BookingRequest,
  context: {
    config: BookingConfig;
    hostZone: string;
    now: Date;
    meetUrl?: string | null;
    notice?: string | null;
    /** The link is on: a move needs its open times. */
    linkOpen?: boolean;
    /**
     * Show the call's link: only on the booking's own page, to the token
     * holder (an invitee). The confirmation names the provider alone.
     */
    withLink?: boolean;
  },
): PublicBookingView | null {
  if (row.meeting_type === 'message' || !row.starts_at || !row.ends_at) return null;
  const status: PublicBookingView['status'] =
    row.status === 'approved' || row.status === 'booked'
      ? 'booked'
      : row.status === 'held' || row.status === 'pending' || row.status === 'cancelled'
        ? row.status
        : 'declined';
  const live = status === 'booked' || status === 'held' || status === 'pending';
  const started = Date.parse(row.starts_at) <= context.now.getTime();
  const moved = row.rescheduled_count ?? 0;
  return {
    status,
    type: row.meeting_type,
    kind: row.kind,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    hostTimeZone: context.hostZone,
    visitorTimeZone: knownZone(row.visitor_time_zone) ? row.visitor_time_zone : null,
    name: row.name,
    email: row.email,
    guests: [...(row.guest_emails ?? [])],
    place:
      row.meeting_type === 'in_person' && row.place_name
        ? { name: row.place_name, area: row.place_area, mapUrl: row.place_map_url }
        : null,
    video:
      row.meeting_type === 'call'
        ? callVideo(context.config, context.meetUrl ?? null, context.withLink ?? false)
        : null,
    canReschedule: live && !started && moved < MAX_RESCHEDULES && context.linkOpen !== false,
    canCancel: live && !started,
    reschedulesLeft: Math.max(0, MAX_RESCHEDULES - moved),
    notice: context.notice ?? null,
  };
}

/**
 * Addresses that are never a guest: the host's own (every address on his
 * calendar account and every connected Google account) and every teammate's.
 */
export async function blockedGuestAddresses(
  store: DataStore,
  organizationId: string,
  ownEmails: readonly string[] = [],
): Promise<string[]> {
  const [team, accounts] = await Promise.all([
    readTeam(store, organizationId).catch(() => null),
    // The connected Google accounts too: the calendar's own address may not be a login.
    store.list('integrations', organizationId, { eq: { provider: 'google' } }).catch(() => []),
  ]);
  return [
    ...ownEmails,
    ...(team?.members.map((m) => m.email ?? '') ?? []),
    ...accounts.map((a) => a.account_email ?? ''),
  ]
    .filter(Boolean)
    .map((e) => e.toLowerCase());
}

/**
 * How many meetings an address has coming up through the link, as the
 * booker or as a guest, and how many messages it has waiting: the abuse
 * brakes count both, so guests cannot be used to get round them.
 */
async function openFor(
  store: DataStore,
  organizationId: string,
  email: string,
  now: Date,
): Promise<number> {
  const upcoming = { gte: { starts_at: now.toISOString() } };
  const [messages, booked] = await Promise.all([
    store.count('booking_requests', organizationId, {
      eq: { email, status: 'pending', meeting_type: 'message' },
    }),
    store.count('booking_requests', organizationId, {
      eq: { email },
      in: { status: ['pending', 'held', 'booked'] },
      neq: { meeting_type: 'message' },
      ...upcoming,
    }),
  ]);
  const asGuest = await store
    .count('booking_requests', organizationId, {
      arrayContains: { guest_emails: email },
      in: { status: ['pending', 'held', 'booked'] },
      ...upcoming,
    })
    .catch((error: unknown) => {
      if (isMissingColumnError(error)) return 0;
      throw error;
    });
  return messages + booked + asGuest;
}

/**
 * A visitor's booking, checked again against the live calendar and every
 * rule at the moment it is kept, one at a time per organization (D-078):
 *
 * - by default it is booked at once: the event on the host's main calendar
 *   through lib/calendar/write.ts, the visitor and their guests invited by
 *   Google (sendUpdates 'all');
 * - without calendar editing the time is held, and placed as soon as
 *   editing is on (lib/services/booking-manage.ts placeHeldBookings);
 * - with "Approve each booking first" on (Settings) it waits as a request.
 *
 * A message waits as before. The honeypot is answered as if all went well and
 * nothing is kept. Copilot sends no email of its own.
 */
export async function submitBookingRequest(
  store: DataStore,
  slug: string,
  input: BookingRequestInput,
  context: SubmitContext,
): Promise<Result<SubmitOutcome>> {
  const now = context.now ?? new Date();
  const found = await resolveOpenLink(store, slug);
  if (input.website.trim()) {
    const status: BookingOutcomeStatus =
      input.type === 'message'
        ? 'message'
        : found.open && found.link.config.approveFirst
          ? 'pending'
          : 'booked';
    return ok({ kind: 'ignored', result: { status, manageUrl: null, booking: null } });
  }
  if (!found.open) return err('forbidden', CLOSED_MESSAGE);
  const { organizationId, config } = found.link;
  const meeting = input.type !== 'message';

  // The people invited: the visitor, and the guests they added (checked
  // against the host's and the team's addresses, deduped, Settings' limit).
  let guests: string[] = [];
  if (meeting && input.guests.length > 0) {
    const cleaned = cleanGuests(input.guests, {
      booker: input.email,
      blocked: await blockedGuestAddresses(store, organizationId, context.source?.ownEmails),
      max: config.allowGuests ? config.maxGuests : 0,
    });
    if (!cleaned.ok) return err('invalid_input', cleaned.problem);
    guests = cleaned.guests;
  }

  for (const email of [input.email, ...guests]) {
    const perEmail = rateLimit(`booking-email:${sha256(email).slice(0, 16)}`, 3, 3_600_000);
    if (!perEmail.ok) {
      return err(
        'rate_limited',
        email === input.email
          ? 'Too many requests from this email address. Try again later.'
          : `Too many bookings for ${email} just now. Try again later.`,
      );
    }
  }

  // From the checks to the insert (and the event), one booking at a time:
  // two visitors racing for the same slot, or one racing past the caps,
  // cannot both be kept.
  const kept = await oneAtATime(
    organizationId,
    async (): Promise<Result<{ row: BookingRequest; result: PublicBookingResult }>> => {
      let fromAddress = 0;
      let holds = 0;
      const counts: number[] = [];
      try {
        for (const email of [input.email, ...guests]) {
          counts.push(await openFor(store, organizationId, email, now));
        }
        if (context.ipHash) {
          fromAddress =
            (await store.count('booking_requests', organizationId, {
              eq: { ip_hash: context.ipHash, status: 'pending', meeting_type: 'message' },
            })) +
            (await store.count('booking_requests', organizationId, {
              eq: { ip_hash: context.ipHash },
              in: { status: ['pending', 'held', 'booked'] },
              neq: { meeting_type: 'message' },
              gte: { starts_at: now.toISOString() },
            }));
        }
        if (meeting) {
          holds = await store.count('booking_requests', organizationId, {
            in: { status: ['pending', 'held', 'booked'] },
            neq: { meeting_type: 'message' },
            gte: { created_at: new Date(now.getTime() - 86_400_000).toISOString() },
          });
        }
      } catch (error) {
        if (isMissingTableError(error)) return err('forbidden', CLOSED_MESSAGE);
        throw error;
      }
      if ((counts[0] ?? 0) >= MAX_OPEN_PER_EMAIL) {
        return err(
          'rate_limited',
          `You already have ${MAX_OPEN_PER_EMAIL} meetings or messages on this link. Change or cancel one from its own page first.`,
        );
      }
      const busyGuest = guests.find((_, i) => (counts[i + 1] ?? 0) >= MAX_OPEN_PER_EMAIL);
      if (busyGuest) {
        return err(
          'rate_limited',
          `${busyGuest} already has ${MAX_OPEN_PER_EMAIL} meetings on this link. Leave them out this time.`,
        );
      }
      if (fromAddress >= MAX_OPEN_PER_ADDRESS) {
        return err(
          'rate_limited',
          'You already have several meetings or messages on this link. Change or cancel one from its own page first.',
        );
      }
      if (holds >= MAX_NEW_HOLDS_PER_DAY) return err('rate_limited', BUSY_LINK_MESSAGE);

      const base = {
        id: newId(),
        organization_id: organizationId,
        // Kept only when it names a real zone: it is read back to label the time.
        visitor_time_zone: knownZone(input.timeZone) ? input.timeZone : null,
        name: input.name,
        email: input.email,
        company: input.company || null,
        note: input.note || null,
        deck_url: input.deckUrl || null,
        source: input.source,
        ip_hash: context.ipHash,
        claimed_at: null,
        calendar_id: null,
        event_id: null,
        decided_by: null,
        decided_at: null,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      };

      if (!meeting) {
        const row: BookingRequest = {
          ...base,
          status: 'pending',
          meeting_type: 'message',
          kind: null,
          starts_at: null,
          ends_at: null,
          place_id: null,
          place_name: null,
          place_area: null,
          place_map_url: null,
          place_custom: false,
        };
        try {
          await store.insert('booking_requests', row);
        } catch (error) {
          if (isMissingTableError(error)) return err('forbidden', CLOSED_MESSAGE);
          throw error;
        }
        return ok({ row, result: { status: 'message', manageUrl: null, booking: null } });
      }

      const type: MeetingType = input.type === 'in_person' ? 'in_person' : 'call';
      const query = { type, kind: type === 'in_person' ? input.kind : null };
      let place = {
        place_id: null as string | null,
        place_name: null as string | null,
        place_area: null as string | null,
        place_map_url: null as string | null,
        place_custom: false,
      };
      if (type === 'in_person') {
        if (!inPersonOffered(config)) {
          return err('invalid_input', 'In-person meetings are not offered.');
        }
        const listed = input.placeId ? config.places.find((p) => p.id === input.placeId) : null;
        if (listed) {
          place = {
            place_id: listed.id,
            place_name: listed.name,
            place_area: listed.area || null,
            place_map_url: listed.mapUrl,
            place_custom: false,
          };
        } else if (input.customPlace && config.allowCustomPlace) {
          place = {
            place_id: null,
            place_name: input.customPlace,
            place_area: null,
            place_map_url: null,
            place_custom: true,
          };
        } else {
          return err('invalid_input', 'Pick one of the places listed.');
        }
      }
      const startMs = Date.parse(input.start ?? '');
      if (!Number.isFinite(startMs)) return err('invalid_input', 'Pick a time.');
      const start = new Date(startMs).toISOString();
      // The calendar read fresh, past its cache: the page's list of times is
      // never trusted, and every rule is checked again here.
      const prepared = await engineInputFor(store, found.link, {
        now,
        source: context.source,
        fresh: true,
      });
      if (!prepared.ok) return err('provider_unavailable', UNAVAILABLE_MESSAGE);
      const { input: engine, source, hostZone } = prepared.value;
      if (slotProblem(engine, query, start)) return err('conflict', TAKEN_MESSAGE);

      // Booked at once, held until editing is on, or a request (approve first).
      let primary: { id: string } | null = null;
      let status: 'booked' | 'held' | 'pending' = 'pending';
      if (!config.approveFirst) {
        status = 'held';
        if (calendarEditAccess(source).allowed) {
          const list = await readCalendarList(source, organizationId);
          const main = list.ok ? list.value.calendars.find((c) => c.primary) : null;
          if (main?.writable) {
            primary = main;
            status = 'booked';
          }
        }
      }

      const { token, hash } = mintManageToken();
      const row: BookingRequest = {
        ...base,
        status,
        meeting_type: type,
        kind: query.kind,
        starts_at: start,
        ends_at: new Date(startMs + MEETING_MINUTES[type] * 60_000).toISOString(),
        ...place,
        guest_emails: guests,
        manage_token_hash: hash,
        cancel_note: null,
        cancelled_at: null,
        cancelled_by: null,
        rescheduled_count: 0,
        previous_starts_at: null,
      };
      try {
        await store.insert('booking_requests', row);
      } catch (error) {
        if (isMissingTableError(error)) return err('forbidden', CLOSED_MESSAGE);
        if (!bookingV2Missing(error)) throw error;
        // The v2 migration is not run: kept the old way, as a request that waits.
        const legacy: BookingRequest = { ...row, status: 'pending' };
        for (const key of V2_COLUMNS) delete (legacy as unknown as Record<string, unknown>)[key];
        await store.insert('booking_requests', legacy);
        return ok({ row: legacy, result: { status: 'pending', manageUrl: null, booking: null } });
      }

      let meetUrl: string | null = null;
      if (status === 'booked' && primary) {
        const host = await readHost(store, organizationId);
        const created = await createLinkEvent(
          { store, organizationId, source, actorId: null },
          primary.id,
          linkEventDraft(hostNameFor(config, host), row, hostZone, {
            manageUrl: manageUrl(found.link.row.slug, token),
            callLink: config.callLink,
            hostEmail: hostCalendarEmail(source, host, primary.id),
          }),
        );
        if (created.ok) {
          meetUrl = created.value.meetUrl;
          await store.updateWhere(
            'booking_requests',
            organizationId,
            { eq: { id: row.id } },
            { calendar_id: primary.id, event_id: created.value.eventId },
          );
          row.calendar_id = primary.id;
          row.event_id = created.value.eventId;
        } else {
          // Google may have made it before an answer was lost (a timeout):
          // held "in doubt" (claimed_at), so placing it later looks for the
          // event first and never makes a second one.
          const doubt =
            created.error.code === 'timeout' || created.error.code === 'provider_unavailable';
          log.warn('A link booking could not be put on the calendar; it is held', {
            code: created.error.code,
          });
          const claimedAt = doubt ? now.toISOString() : null;
          await store.updateWhere(
            'booking_requests',
            organizationId,
            { eq: { id: row.id } },
            { status: 'held', claimed_at: claimedAt },
          );
          row.status = 'held';
          row.claimed_at = claimedAt;
        }
      }
      const result: PublicBookingResult = {
        status: row.status === 'booked' ? 'booked' : row.status === 'held' ? 'held' : 'pending',
        manageUrl: managePath(found.link.row.slug, token),
        booking: publicBookingView(row, { config, hostZone, now, meetUrl, linkOpen: true }),
      };
      return ok({ row, result });
    },
  );
  if (!kept.ok) return kept;
  const { row, result } = kept.value;
  await recordAudit(store, {
    organizationId,
    userId: null,
    action:
      row.status === 'booked'
        ? 'booking.booked'
        : row.status === 'held'
          ? 'booking.held'
          : 'booking.requested',
    entityType: 'booking_request',
    entityId: row.id,
    // Ids and kinds only: never the visitor's name, address or note.
    metadata: {
      type: row.meeting_type,
      kind: row.kind,
      source: row.source,
      ...(row.guest_emails?.length ? { guests: row.guest_emails.length } : {}),
    },
  });
  return ok({ kind: 'saved', id: row.id, result });
}

/** The columns 20261022200000_booking_v2.sql adds: left out of a row when it is not run yet. */
const V2_COLUMNS = [
  'guest_emails',
  'manage_token_hash',
  'cancel_note',
  'cancelled_at',
  'cancelled_by',
  'rescheduled_count',
  'previous_starts_at',
] as const;

/**
 * The event a booking becomes: the host on it as the organizer, the visitor
 * and their guests invited, the call on the saved video link (or Google Meet).
 */
export function linkEventDraft(
  hostName: string,
  row: BookingRequest,
  hostZone: string,
  options: { manageUrl: string | null; callLink: string | null; hostEmail: string | null },
): EventDraft {
  return bookingEventDraft(
    hostName,
    {
      type: row.meeting_type === 'in_person' ? 'in_person' : 'call',
      kind: row.kind,
      starts_at: row.starts_at ?? '',
      ends_at: row.ends_at ?? '',
      name: row.name,
      email: row.email,
      company: row.company,
      place_name: row.place_name,
      place_area: row.place_area,
      place_map_url: row.place_map_url,
      note: row.note,
      deck_url: row.deck_url,
      guests: row.guest_emails ?? [],
      manageUrl: options.manageUrl,
    },
    hostZone,
    { callLink: options.callLink, hostEmail: options.hostEmail },
  );
}

/**
 * The next few open times for a query, after one was taken: the page offers
 * them at once so the visitor does not start again.
 */
export async function nextOpenTimes(
  store: DataStore,
  slug: string,
  query: { type: string | null; kind: string | null },
  deps: BookingDeps = {},
  limit = 3,
): Promise<PublicSlot[]> {
  const slots = await publicSlots(store, slug, query, deps).catch(() => null);
  return slots?.state === 'ok' ? slots.slots.slice(0, limit) : [];
}

/* -------------------------------------------------------------- Copilot side */

export interface BookingRequestList {
  available: boolean;
  requests: BookingRequest[];
}

/** Pending requests, soonest slot first (messages last, newest first). */
export async function listPendingBookingRequests(
  store: DataStore,
  organizationId: string,
): Promise<BookingRequestList> {
  try {
    const rows = await store.list(
      'booking_requests',
      organizationId,
      { eq: { status: 'pending' } },
      { orderBy: [{ field: 'created_at', direction: 'desc' }], limit: 100 },
    );
    rows.sort((a, b) => {
      if (!a.starts_at || !b.starts_at) return a.starts_at ? -1 : b.starts_at ? 1 : 0;
      return a.starts_at.localeCompare(b.starts_at);
    });
    return { available: true, requests: rows };
  } catch (error) {
    if (isMissingTableError(error)) return { available: false, requests: [] };
    throw error;
  }
}

/**
 * How many requests wait, for Today's line: messages, and meeting requests
 * whose time is still ahead (one whose time has passed only needs a
 * Decline, in the drawer). Never throws: a fault is null and no line.
 */
export async function countPendingBookingRequests(
  store: DataStore,
  organizationId: string,
  now: Date = new Date(),
): Promise<number | null> {
  try {
    const [messages, meetings] = await Promise.all([
      store.count('booking_requests', organizationId, {
        eq: { status: 'pending', meeting_type: 'message' },
      }),
      store.count('booking_requests', organizationId, {
        eq: { status: 'pending' },
        neq: { meeting_type: 'message' },
        gte: { starts_at: now.toISOString() },
      }),
    ]);
    return messages + meetings;
  } catch {
    return null;
  }
}

export interface ActorContext {
  store: DataStore;
  organizationId: string;
  userId: string;
}

export type ApproveOutcome =
  | { state: 'approved'; eventId: string; calendarId: string; meetUrl: string | null }
  | { state: 'needs_grant'; reason: string; templateUrl: string };

async function pendingRequest(
  ctx: ActorContext,
  id: string,
): Promise<Result<{ request: BookingRequest }>> {
  let request: BookingRequest | null;
  try {
    request = await ctx.store.get('booking_requests', ctx.organizationId, id);
  } catch (error) {
    if (isMissingTableError(error)) return err('not_configured', BOOKING_NOT_SET_UP);
    throw error;
  }
  if (!request) return err('not_found', 'That request is not here any more.');
  if (request.status !== 'pending') {
    return err('conflict', `That request was already ${request.status}.`);
  }
  return ok({ request });
}

export function hostNameFor(config: BookingConfig, host: HostIdentity): string {
  return config.displayName.trim() || host.fullName?.trim() || '';
}

/**
 * The host's main calendar address, for the guest list: the main calendar's
 * own id (Google names it by the account's address), else the connected
 * account's, else the principal's.
 */
export function hostCalendarEmail(
  source: CalendarSource,
  host: HostIdentity,
  primaryId?: string | null,
): string | null {
  const found = [primaryId, ...source.ownEmails, host.email]
    .map((e) => e?.trim().toLowerCase() ?? '')
    .find((e) => isEmailAddress(e));
  return found ?? null;
}

/**
 * Approve: re-check the time against the live calendar and every rule, then
 * create the event on the host's main calendar through the write module,
 * inviting the requester. Refused with the reason when the time is no longer
 * free; without calendar editing, the prefilled Google Calendar link instead.
 */
export async function approveBookingRequest(
  ctx: ActorContext,
  id: string,
  deps: BookingDeps = {},
): Promise<Result<ApproveOutcome>> {
  const now = deps.now ?? new Date();
  const found = await pendingRequest(ctx, id);
  if (!found.ok) return found;
  const { request } = found.value;
  if (request.meeting_type === 'message' || !request.starts_at || !request.ends_at) {
    return err('invalid_input', 'A message has no time to approve. Mark it handled instead.');
  }
  const settings = await readBookingSettings(ctx.store, ctx.organizationId);
  const host = await readHost(ctx.store, ctx.organizationId);
  const hostName = hostNameFor(settings.config, host);
  const approvable = {
    type: request.meeting_type,
    kind: request.kind,
    starts_at: request.starts_at,
    ends_at: request.ends_at,
    name: request.name,
    email: request.email,
    company: request.company,
    place_name: request.place_name,
    place_area: request.place_area,
    place_map_url: request.place_map_url,
    note: request.note,
    deck_url: request.deck_url,
    guests: request.guest_emails ?? [],
  };

  let source = deps.source;
  if (!source) {
    const connected = await calendarSource(ctx.store, ctx.organizationId, host.email ?? '');
    if (!connected.ok) return err('not_configured', 'The host’s calendar is not connected.');
    source = connected.source;
  }
  // The re-check comes first, with or without calendar editing: a time that
  // is no longer free is refused, never offered as a Google Calendar link.
  const prepared = await engineInputFor(
    ctx.store,
    { organizationId: ctx.organizationId, config: settings.config },
    { ...deps, source, now, fresh: true },
  );
  if (!prepared.ok) return prepared;
  const { hostZone, input } = prepared.value;

  // First come, first served: checked against approved bookings and the
  // waiting requests asked for before this one, so the oldest of two that
  // overlap can always be approved and they never block each other.
  const problem = slotProblem(
    {
      ...input,
      askedAt: new Date(request.created_at),
      linkBookings: bookingsBefore(input.linkBookings, {
        id: request.id,
        createdAt: Date.parse(request.created_at),
      }),
    },
    { type: request.meeting_type, kind: request.kind },
    request.starts_at,
    request.id,
  );
  if (problem) {
    await auditRefusal(ctx, request, 'no_longer_free');
    return err(
      'conflict',
      `This time is no longer free: ${problem} Nothing was added to the calendar. Decline it, or reply with another time.`,
    );
  }

  const access = calendarEditAccess(source);
  if (!access.allowed) {
    await auditRefusal(ctx, request, 'needs_calendar_editing');
    return ok({
      state: 'needs_grant',
      reason: access.reason ?? 'Calendar editing is off.',
      templateUrl: googleCalendarTemplateUrl(hostName, approvable, hostZone, {
        callLink: settings.config.callLink,
        hostEmail: hostCalendarEmail(source, host),
      }),
    });
  }

  const list = await readCalendarList(source, ctx.organizationId);
  if (!list.ok) return list;
  const primary = list.value.calendars.find((c) => c.primary);
  if (!primary) return err('not_found', 'The host’s main calendar is not on the list.');

  // Claim it, so a second click (another tab, a double tap) cannot make a second event.
  const stamp = now.toISOString();
  let claimed = await ctx.store.updateWhere(
    'booking_requests',
    ctx.organizationId,
    { eq: { id, status: 'pending' }, isNull: ['claimed_at'] },
    { claimed_at: stamp },
  );
  if (claimed.length === 0) {
    claimed = await ctx.store.updateWhere(
      'booking_requests',
      ctx.organizationId,
      {
        eq: { id, status: 'pending' },
        lt: { claimed_at: new Date(now.getTime() - CLAIM_TIMEOUT_MS).toISOString() },
      },
      { claimed_at: stamp },
    );
  }
  if (claimed.length === 0) {
    return err(
      'conflict',
      'Someone is approving this request right now, or the last try is still being checked. Try again in two minutes.',
    );
  }

  // Approving a booking is the person's Send: the requester and their
  // guests get the invitation from Google.
  const created = await createLinkEvent(
    { store: ctx.store, organizationId: ctx.organizationId, source, actorId: ctx.userId },
    primary.id,
    bookingEventDraft(hostName, approvable, hostZone, {
      callLink: settings.config.callLink,
      hostEmail: hostCalendarEmail(source, host, primary.id),
    }),
  );
  if (!created.ok) {
    // Google may have made the event before the answer was lost: keep the
    // claim for its two minutes, so a quick second click cannot make a second
    // one, and say to look first. A clear refusal frees it at once.
    if (created.error.code === 'timeout' || created.error.code === 'provider_unavailable') {
      return err(
        created.error.code,
        `Google did not answer. Check ${firstName(hostName) ? `${firstName(hostName)}'s` : 'the'} calendar before approving again: the event may be there already. You can try again in two minutes.`,
        { retryable: true },
      );
    }
    await ctx.store
      .updateWhere(
        'booking_requests',
        ctx.organizationId,
        { eq: { id, status: 'pending', claimed_at: stamp } },
        { claimed_at: null },
      )
      .catch(() => null);
    return created;
  }
  const eventId = created.value.eventId;
  // Only while this approval still holds the claim (Decline waits for it).
  const finished = await ctx.store.updateWhere(
    'booking_requests',
    ctx.organizationId,
    { eq: { id, status: 'pending', claimed_at: stamp } },
    {
      status: 'approved',
      claimed_at: null,
      calendar_id: primary.id,
      event_id: eventId || null,
      decided_by: ctx.userId,
      decided_at: now.toISOString(),
    },
  );
  if (finished.length === 0) {
    log.warn('A booking approval finished after its claim was taken over', { request: id });
  }
  await recordAudit(ctx.store, {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    action: 'booking.approved',
    entityType: 'booking_request',
    entityId: id,
    metadata: {
      type: request.meeting_type,
      kind: request.kind,
      event_id: eventId || null,
      manual: false,
    },
  });
  return ok({
    state: 'approved',
    eventId,
    calendarId: primary.id,
    meetUrl: created.value.meetUrl,
  });
}

/** An Approve that put nothing on the calendar, and why: audited like the rest. */
async function auditRefusal(
  ctx: ActorContext,
  request: BookingRequest,
  reason: 'no_longer_free' | 'needs_calendar_editing',
): Promise<void> {
  await recordAudit(ctx.store, {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    action: 'booking.approve_refused',
    entityType: 'booking_request',
    entityId: request.id,
    metadata: { type: request.meeting_type, kind: request.kind, reason },
  });
}

export type MarkAction = 'decline' | 'handled' | 'added_by_hand';

const MARK: Record<
  MarkAction,
  {
    status: BookingRequest['status'];
    action: 'booking.declined' | 'booking.handled' | 'booking.approved';
  }
> = {
  decline: { status: 'declined', action: 'booking.declined' },
  handled: { status: 'handled', action: 'booking.handled' },
  added_by_hand: { status: 'approved', action: 'booking.approved' },
};

export interface MarkOutcome {
  status: BookingRequest['status'];
  /** For a decline: an email for the person to read and send, never sent here. */
  draft: { to: string; subject: string; body: string } | null;
}

/**
 * Decline a request, mark a message handled, or record that someone added
 * the meeting in Google Calendar by hand. Each is one compare-and-set from
 * pending, audited, and none touches a calendar or sends anything.
 */
export async function markBookingRequest(
  ctx: ActorContext,
  id: string,
  action: MarkAction,
  now: Date = new Date(),
): Promise<Result<MarkOutcome>> {
  const found = await pendingRequest(ctx, id);
  if (!found.ok) return found;
  const { request } = found.value;
  if (action === 'handled' && request.meeting_type !== 'message') {
    return err('invalid_input', 'Approve or decline a meeting request.');
  }
  if (action === 'added_by_hand' && request.meeting_type === 'message') {
    return err('invalid_input', 'A message has no meeting to add.');
  }
  const mark = MARK[action];
  const patch = {
    status: mark.status,
    claimed_at: null,
    decided_by: ctx.userId,
    decided_at: now.toISOString(),
  };
  // Never while an approval holds the claim (it may be sending the invite
  // right now); a claim older than its two minutes no longer counts.
  let changed = await ctx.store.updateWhere(
    'booking_requests',
    ctx.organizationId,
    { eq: { id, status: 'pending' }, isNull: ['claimed_at'] },
    patch,
  );
  if (changed.length === 0) {
    changed = await ctx.store.updateWhere(
      'booking_requests',
      ctx.organizationId,
      {
        eq: { id, status: 'pending' },
        lt: { claimed_at: new Date(now.getTime() - CLAIM_TIMEOUT_MS).toISOString() },
      },
      patch,
    );
  }
  if (changed.length === 0) {
    const latest = await ctx.store.get('booking_requests', ctx.organizationId, id);
    return err(
      'conflict',
      latest?.status === 'pending'
        ? 'Someone is approving this request right now. Try again in two minutes.'
        : 'That request was already decided.',
    );
  }
  await recordAudit(ctx.store, {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    action: mark.action,
    entityType: 'booking_request',
    entityId: id,
    metadata: {
      type: request.meeting_type,
      kind: request.kind,
      ...(action === 'added_by_hand' ? { manual: true } : {}),
    },
  });
  let draft: MarkOutcome['draft'] = null;
  if (action === 'decline') {
    const settings = await readBookingSettings(ctx.store, ctx.organizationId);
    const host = await readHost(ctx.store, ctx.organizationId);
    const zone = await principalTimeZone(ctx.store, ctx.organizationId);
    draft = declineDraft(
      hostNameFor(settings.config, host),
      {
        name: request.name,
        email: request.email,
        starts_at: request.starts_at ?? '',
        type: request.meeting_type,
      },
      knownZone(request.visitor_time_zone) ? request.visitor_time_zone : zone,
    );
  }
  return ok({ status: mark.status, draft });
}

/** The host's display name for the panel and the event titles. */
export async function bookingHostName(store: DataStore, organizationId: string): Promise<string> {
  const [settings, host] = await Promise.all([
    readBookingSettings(store, organizationId),
    readHost(store, organizationId),
  ]);
  return hostNameFor(settings.config, host);
}

/** The principal's profile, for the panel's time zone and the host's name. */
export async function hostProfile(
  store: DataStore,
  organizationId: string,
): Promise<UserProfile | null> {
  const host = await readHost(store, organizationId);
  return host.userId ? store.userProfileById(host.userId) : null;
}

/* ------------------------------------------------------------------- photo */

/** The host photo's size limit: plenty for a portrait, small enough to serve quickly. */
export const MAX_BOOKING_PHOTO_BYTES = 3 * 1024 * 1024;

const PHOTO_TYPES = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' } as const;

/**
 * Keep a new host photo (or remove it): checked by its own first bytes
 * (JPEG, PNG or WebP only), stored in the private bucket under the
 * organization, and named in the settings with a new version so the page's
 * photo address changes. The previous photo is removed after.
 */
export async function setBookingPhoto(
  store: DataStore,
  storage: StorageProvider,
  organizationId: string,
  userId: string,
  bytes: Uint8Array | null,
  now: Date = new Date(),
): Promise<Result<BookingSettingsView>> {
  const current = await readBookingSettings(store, organizationId);
  if (!current.available) return err('not_configured', BOOKING_NOT_SET_UP);
  let photo: BookingConfig['photo'] = null;
  if (bytes) {
    if (bytes.byteLength > MAX_BOOKING_PHOTO_BYTES) {
      return err('too_large', 'Use a photo under 3 MB.');
    }
    const kind = sniffPhoto(bytes);
    if (kind !== 'jpeg' && kind !== 'png' && kind !== 'webp') {
      return err('unsupported_media_type', 'Use a JPG, PNG or WebP photo.');
    }
    const version = newId().slice(0, 8);
    const type = PHOTO_TYPES[kind];
    const path = bookingPhotoPath(organizationId, version, type);
    const put = await storage.put(path, bytes, type);
    if (!put.ok) return put;
    photo = { path, type, version };
  }
  const saved = await saveBookingSettings(
    store,
    organizationId,
    userId,
    { enabled: current.enabled, slug: current.slug, config: current.config },
    now,
    { photo },
  );
  if (!saved.ok) {
    if (photo) await storage.remove(photo.path).catch(() => null);
    return saved;
  }
  // Only a path Copilot itself named is ever removed.
  const old = current.config.photo;
  if (old && old.path !== photo?.path && isOwnPhotoPath(organizationId, old)) {
    await storage.remove(old.path).catch(() => null);
  }
  await recordAudit(store, {
    organizationId,
    userId,
    action: 'booking.photo_updated',
    entityType: 'booking_settings',
    entityId: null,
    metadata: { removed: !photo },
  });
  return saved;
}
