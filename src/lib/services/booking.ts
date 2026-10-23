import 'server-only';
import { randomBytes } from 'node:crypto';
import { busyPictureFor } from '@/lib/booking/availability';
import {
  BOOKING_CONFIG_SCHEMA,
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
  openSlotsAndDays,
  slotProblem,
  type EngineInput,
  type LinkBooking,
} from '@/lib/booking/engine';
import { openMonthsAhead } from '@/lib/booking/months';
import {
  bookingEventDraft,
  declineDraft,
  googleCalendarTemplateUrl,
  linkRequestFromRow,
} from '@/lib/booking/event';
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
import { holdNextTryAt, holdReasonForError } from '@/lib/booking/holds';
import {
  cleanGuests,
  normalizeAddress,
  ownDomains,
  type BookingRequestInput,
} from '@/lib/booking/request';
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
import { rateLimit, rateLimitHasRoom } from '@/lib/security/limits';
import { log } from '@/lib/security/redact';
import type { StorageProvider } from '@/lib/storage/provider';
import { readTeam } from '@/lib/tasks/principal';
import type {
  BookingHoldReason,
  BookingRequest,
  BookingSettingsRow,
  UserProfile,
} from '@/lib/types/domain';
import { newId, sha256 } from '@/lib/util/hash';
import { localDateKey } from '@/lib/util/time';
import { processWide } from '@/lib/util/process-state';
import { err, ok, type Result } from '@/lib/util/result';
import { createLinkEvent } from './booking-calendar';
import {
  reconcileLinkBookings,
  scheduleDescriptionCheck,
  timerScheduler,
  type Scheduler,
} from './booking-sync';
import { principalTimeZone } from './push-alerts';

/**
 * The booking link (D-074): its settings, the public page's data and open
 * times, the requests visitors send, and what Copilot does with them.
 *
 * The rules that matter, enforced here and nowhere else:
 * - The public side reads busy time only (lib/booking/availability.ts).
 *   Copilot never sends an email of its own: the invitation, update and
 *   cancellation are Google's (sendUpdates 'all').
 * - A free time that passes every rule is booked at once (D-078, Arwin's
 *   decision): checked again against the live calendar (past its cache) and
 *   every rule, one booking at a time, then the event is created through
 *   lib/calendar/write.ts (the editing grant, a writable calendar). When it
 *   cannot be written right away (no grant, Google down) the time is held
 *   and Copilot books it by itself as soon as it can
 *   (lib/services/booking-manage.ts placeHeldBookings); nobody approves it.
 * - "Approve each booking first" is an option (off by default): then a
 *   request waits for a person's Approve, which re-checks it the same way.
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
 * The daily brakes count every meeting booked through the link in the last
 * 24 hours whatever became of it (cancelled or declined too): booking and
 * cancelling in a loop would otherwise send invitations from the host's
 * calendar without end. Addresses are compared as one inbox
 * (lib/booking/request.ts normalizeAddress), as booker or guest.
 */
export const MAX_PER_EMAIL_PER_DAY = 3;
/** Meetings one sender (the keyed hash of their address) may book in 24 hours. */
export const MAX_PER_ADDRESS_PER_DAY = 4;
/** Guests the whole link may invite in 24 hours (each one gets Google's emails). */
export const MAX_GUEST_INVITES_PER_DAY = 10;

export const BOOKED_A_LOT_MESSAGE =
  'You have booked a lot on this link today. Try again tomorrow, or leave a message.';
export const GUEST_BUDGET_MESSAGE =
  'This booking link has invited a lot of guests today. Book without guests, or try again tomorrow.';

/** The brakes as they apply (loosened only for the end-to-end demo server, env.ts). */
function dailyBrakes() {
  const scale = env().bookingBrakesRelaxed ? 25 : 1;
  return {
    holds: MAX_NEW_HOLDS_PER_DAY * scale,
    perEmail: MAX_PER_EMAIL_PER_DAY * scale,
    perAddress: MAX_PER_ADDRESS_PER_DAY * scale,
    guests: MAX_GUEST_INVITES_PER_DAY * scale,
  };
}

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
      config: parseBookingConfig({ displayName: host?.fullName ?? '' }),
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
      chatbot: config.data.chatbot.enabled,
      approve_first: config.data.approveFirst,
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
  /** The open link, when the caller resolved it already (one read per page view). */
  link?: OpenLink;
  /** Tests: when the re-read after a calendar write runs (lib/services/booking-sync.ts). */
  schedule?: Scheduler;
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
    chatbot: { enabled: false },
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
    chatbot: { enabled: config.chatbot.enabled },
    instant: !config.approveFirst,
    guests: { allowed: config.allowGuests && config.maxGuests > 0, max: config.maxGuests },
  };
}

/** How long a fresh booking holds its own time before the calendar is trusted to list it. */
export const ON_CALENDAR_AFTER_MS = 10 * 60_000;

/** Statuses whose time is taken: waiting, held, approved and booked. */
export const TIME_HOLDING_STATUSES = ['pending', 'held', 'approved', 'booked'] as const;

/** The link's own bookings that hold time (waiting, held, approved or booked), from a day ago on. */
async function timeHoldingRows(
  store: DataStore,
  organizationId: string,
  now: Date,
): Promise<BookingRequest[]> {
  return store.list('booking_requests', organizationId, {
    in: { status: [...TIME_HOLDING_STATUSES] },
    neq: { meeting_type: 'message' },
    gte: { starts_at: new Date(now.getTime() - 86_400_000).toISOString() },
  });
}

/**
 * Those rows as the engine counts them. One on the calendar (approved, or
 * booked more than ten minutes ago) is among the busy blocks already, so it
 * is never counted twice; a fresh one holds its own time until Google lists
 * it (an entry at exactly its time stands in for it, lib/booking/engine.ts).
 * A row cancelled in Google meanwhile (lib/services/booking-sync.ts) holds
 * nothing and counts toward no cap.
 */
function linkBookings(rows: readonly BookingRequest[], now: Date): LinkBooking[] {
  return rows.flatMap((r) =>
    r.starts_at &&
    r.ends_at &&
    r.meeting_type !== 'message' &&
    (TIME_HOLDING_STATUSES as readonly string[]).includes(r.status)
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
 * books, moves or places a time), and no read that began before it can
 * store an older answer after it (range-reader's generations). `ignore`
 * leaves one booking out: its own row always, and the calendar entry at
 * exactly its time only when that entry is its own event (`onCalendar`: a
 * booked or approved booking with an event), so the booking's page can offer
 * the times next to it when it moves, and a meeting the host himself put at
 * a held time is never dropped.
 */
export async function engineInputFor(
  store: DataStore,
  link: Pick<OpenLink, 'organizationId' | 'config'>,
  deps: BookingDeps & {
    fresh?: boolean;
    ignore?: { id: string; start: number; end: number; onCalendar: boolean } | null;
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
    fresh: deps.fresh === true,
  });
  if (!picture.ok) return picture;
  // The read saw the link's own events too: one deleted in Google is a
  // cancelled booking, one moved there moves, and another tool's reschedule
  // link comes back out of its description (lib/services/booking-sync.ts).
  const synced = await reconcileLinkBookings(
    { store, organizationId, source, config, hostZone, now },
    await timeHoldingRows(store, organizationId, now),
    picture.value.seen,
  );
  let bookings = linkBookings(synced.rows, now);
  let busy = picture.value.busy;
  const ignore = deps.ignore;
  if (ignore) {
    bookings = bookings.filter((b) => b.id !== ignore.id);
    if (ignore.onCalendar) {
      const own = busy.findIndex(
        (b) => !b.allDay && b.start === ignore.start && b.end === ignore.end,
      );
      if (own >= 0) busy = [...busy.slice(0, own), ...busy.slice(own + 1)];
    }
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
  const plan = openSlotsAndDays(prepared.value.input, q);
  const today = localDateKey(prepared.value.input.now, prepared.value.hostZone);
  return {
    ...base,
    state: 'ok',
    hostTimeZone: prepared.value.hostZone,
    slots: plan.slots.map((s) => ({ start: s.start, end: s.end })),
    // The calendar card: day states only (never why a day is off), and the open months.
    days: plan.days.map((d) => ({ date: d.date, state: d.state })),
    months: openMonthsAhead(config, today),
  };
}

export interface SubmitContext {
  /** A keyed hash of the sender's address (lib/security/crypto hashIp), for the row. */
  ipHash: string | null;
  now?: Date;
  source?: CalendarSource;
  /** Tests: when the re-read after the event is made runs (lib/services/booking-sync.ts). */
  schedule?: Scheduler;
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
  // Only the old status check (it names booking_requests_status): any other
  // check failing is a real fault, never read as "not migrated".
  const text = typeof message === 'string' ? message : '';
  return (
    (code === '23514' || /check constraint/i.test(text)) && /booking_requests_status/i.test(text)
  );
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
    // The saved video link only for a live booked meeting: never for one
    // that is only requested, held (no invite yet), cancelled or declined.
    video:
      row.meeting_type === 'call'
        ? callVideo(
            context.config,
            context.meetUrl ?? null,
            (context.withLink ?? false) && status === 'booked',
          )
        : null,
    canReschedule: live && !started && moved < MAX_RESCHEDULES && context.linkOpen !== false,
    canCancel: live && !started,
    reschedulesLeft: Math.max(0, MAX_RESCHEDULES - moved),
    notice: context.notice ?? null,
    icsUid: `booking-${sha256(`ics:${row.id}`).slice(0, 24)}@copilot.tiptop.vc`,
    icsSequence: moved,
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
 * - when that cannot happen right away (calendar editing off, no writable
 *   main calendar, Google not answering or refusing) the time is HELD: it
 *   stays blocked for everyone else, the visitor sees the neutral held
 *   copy, and Copilot books it by itself as soon as it can (at once when
 *   editing comes on, on a backoff for a Google fault:
 *   lib/services/booking-manage.ts placeHeldBookings). Nobody approves it;
 * - with "Approve each booking first" on (an option) it waits as a request.
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
  // against the host's and the team's addresses and the host side's own
  // domains, deduped, Settings' limit).
  let guests: string[] = [];
  if (meeting && input.guests.length > 0) {
    const blocked = await blockedGuestAddresses(store, organizationId, context.source?.ownEmails);
    const cleaned = cleanGuests(input.guests, {
      booker: input.email,
      blocked,
      blockedDomains: ownDomains(blocked),
      max: config.allowGuests ? config.maxGuests : 0,
    });
    if (!cleaned.ok) return err('invalid_input', cleaned.problem);
    guests = cleaned.guests;
  }

  // From the checks to the insert (and the event), one booking at a time:
  // two visitors racing for the same slot, or one racing past the caps,
  // cannot both be kept.
  const kept = await oneAtATime(
    organizationId,
    async (): Promise<Result<{ row: BookingRequest; result: PublicBookingResult }>> => {
      const brakes = dailyBrakes();
      let fromAddress = 0;
      const counts: number[] = [];
      let recent: BookingRequest[] = [];
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
        if (meeting) recent = await meetingsBookedSince(store, organizationId, now);
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
      if (meeting) {
        // Every meeting of the last 24 hours, cancelled ones too: booking and
        // cancelling in a loop counts every time.
        if (recent.length >= brakes.holds) return err('rate_limited', BUSY_LINK_MESSAGE);
        const appearances = (address: string) => {
          const who = normalizeAddress(address);
          return recent.filter(
            (r) =>
              normalizeAddress(r.email) === who ||
              (r.guest_emails ?? []).some((g) => normalizeAddress(g) === who),
          ).length;
        };
        if (appearances(input.email) >= brakes.perEmail) {
          return err('rate_limited', BOOKED_A_LOT_MESSAGE);
        }
        const tiredGuest = guests.find((g) => appearances(g) >= brakes.perEmail);
        if (tiredGuest) {
          return err(
            'rate_limited',
            `${tiredGuest} has been invited a lot on this link today. Leave them out this time.`,
          );
        }
        if (
          context.ipHash &&
          recent.filter((r) => r.ip_hash === context.ipHash).length >= brakes.perAddress
        ) {
          return err('rate_limited', BOOKED_A_LOT_MESSAGE);
        }
        const invited = recent.reduce((n, r) => n + (r.guest_emails?.length ?? 0), 0);
        if (guests.length > 0 && invited + guests.length > brakes.guests) {
          return err('rate_limited', GUEST_BUDGET_MESSAGE);
        }
      }

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
        const limited = chargeEmailLimits(input.email, []);
        if (limited) return limited;
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
      // Only a booking the slot allows uses up an address's hourly brake, so
      // naming someone in requests that fail never locks them out.
      const limited = chargeEmailLimits(input.email, guests);
      if (limited) return limited;

      // Booked at once, held until it can be written, or a request (approve first).
      let primary: { id: string } | null = null;
      let status: 'booked' | 'held' | 'pending' = 'pending';
      let holdReason: BookingHoldReason | null = null;
      if (!config.approveFirst) {
        const target = await mainCalendarFor(source, organizationId);
        if (target.ok) {
          primary = target.calendar;
          status = 'booked';
        } else {
          status = 'held';
          holdReason = target.reason;
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
        hold_reason: holdReason,
        hold_attempts: 0,
        hold_next_try_at: null,
      };
      try {
        await store.insert('booking_requests', row);
      } catch (error) {
        if (isMissingTableError(error)) return err('forbidden', CLOSED_MESSAGE);
        if (!bookingV2Missing(error)) throw error;
        return keepWithoutV2(store, found.link, row, { primary, source, hostZone, now });
      }

      let meetUrl: string | null = null;
      if (status === 'booked' && primary) {
        const pageUrl = manageUrl(found.link.row.slug, token);
        const placed = await bookOnCalendar(store, found.link, row, {
          calendarId: primary.id,
          source,
          hostZone,
          now,
          pageUrl,
          schedule: context.schedule,
        });
        meetUrl = placed.meetUrl;
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
      row.status === 'booked' || row.status === 'approved'
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
      ...(row.hold_reason ? { hold_reason: row.hold_reason } : {}),
    },
  });
  if (row.status === 'held') {
    // The next try, in this process (the alerts job and every visit try too).
    scheduleHeldRetry(store, organizationId, row, now, context.schedule);
  }
  return ok({ kind: 'saved', id: row.id, result });
}

/**
 * The hourly per-address brake (in memory), charged only for a booking that
 * is about to be kept: booker and guests on separate keys, each address as
 * one inbox. An error when one of them has no room left.
 */
function chargeEmailLimits(
  booker: string,
  guests: readonly string[],
): Result<{ row: BookingRequest; result: PublicBookingResult }> | null {
  const keys = [
    { key: `booking-email:${sha256(normalizeAddress(booker)).slice(0, 16)}`, email: booker },
    ...guests.map((g) => ({
      key: `booking-guest:${sha256(normalizeAddress(g)).slice(0, 16)}`,
      email: g,
    })),
  ];
  const full = keys.find((k) => !rateLimitHasRoom(k.key, 3));
  if (full) {
    return err(
      'rate_limited',
      full.email === booker
        ? 'Too many requests from this email address. Try again later.'
        : `Too many bookings for ${full.email} just now. Try again later.`,
    );
  }
  for (const k of keys) rateLimit(k.key, 3, 3_600_000);
  return null;
}

/** Every meeting booked through the link in the last 24 hours, whatever its status now. */
async function meetingsBookedSince(
  store: DataStore,
  organizationId: string,
  now: Date,
): Promise<BookingRequest[]> {
  return store.list(
    'booking_requests',
    organizationId,
    {
      neq: { meeting_type: 'message' },
      gte: { created_at: new Date(now.getTime() - 86_400_000).toISOString() },
    },
    { limit: 500 },
  );
}

/**
 * The host's main calendar when a booking can be written to it now, or why
 * not: calendar editing off, the list unreadable, or no writable main calendar.
 */
export async function mainCalendarFor(
  source: CalendarSource,
  organizationId: string,
): Promise<{ ok: true; calendar: { id: string } } | { ok: false; reason: BookingHoldReason }> {
  if (!calendarEditAccess(source).allowed) return { ok: false, reason: 'calendar_editing_off' };
  const list = await readCalendarList(source, organizationId).catch(() => null);
  if (!list?.ok) return { ok: false, reason: 'calendar_unreachable' };
  const main = list.value.calendars.find((c) => c.primary);
  if (!main?.writable) return { ok: false, reason: 'no_main_calendar' };
  return { ok: true, calendar: main };
}

/**
 * Put a just-kept booking on the host's calendar. On success the row is
 * booked with its event; when Google cannot be reached or refuses (or
 * anything after its answer fails) it becomes a hold that Copilot tries
 * again by itself. "In doubt" (claimed_at) when Google may have made the
 * event before its answer was lost, so the next try looks for it first and
 * there is never a second event. Mutates `row` to match what was stored.
 */
async function bookOnCalendar(
  store: DataStore,
  link: OpenLink,
  row: BookingRequest,
  options: {
    calendarId: string;
    source: CalendarSource;
    hostZone: string;
    now: Date;
    pageUrl: string;
    schedule?: Scheduler;
  },
): Promise<{ meetUrl: string | null }> {
  const { organizationId, config } = link;
  const { calendarId, source, hostZone, now, pageUrl } = options;
  let created: Awaited<ReturnType<typeof createLinkEvent>>;
  try {
    const host = await readHost(store, organizationId);
    created = await createLinkEvent(
      { store, organizationId, source, actorId: null },
      calendarId,
      linkEventDraft(hostNameFor(config, host), row, hostZone, {
        manageUrl: pageUrl,
        callLink: config.callLink,
        hostEmail: hostCalendarEmail(source, host, calendarId),
      }),
    );
  } catch (error) {
    // Thrown after Google may have answered (the audit write, say): in doubt.
    log.warn('A link booking’s event could not be confirmed; it is held', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    created = err('timeout', 'The calendar write could not be confirmed.');
  }
  if (created.ok) {
    try {
      await store.updateWhere(
        'booking_requests',
        organizationId,
        { eq: { id: row.id } },
        { calendar_id: calendarId, event_id: created.value.eventId },
      );
      row.calendar_id = calendarId;
      row.event_id = created.value.eventId;
    } catch (error) {
      // The event is made but the row could not say so: held in doubt, so
      // the next pass finds the event by its page link instead of making one.
      log.warn('A link booking’s event id could not be kept; it is held', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      await markHeld(store, organizationId, row, 'calendar_error', now, true).catch(() => null);
      return { meetUrl: null };
    }
    // Fyxer edits a new event a few seconds after it is made: one look
    // later puts the booking's own description back.
    scheduleDescriptionCheck(
      { store, organizationId, source, config, hostZone, now },
      row.id,
      pageUrl,
      options.schedule,
    );
    return { meetUrl: created.value.meetUrl };
  }
  const doubt = created.error.code === 'timeout' || created.error.code === 'provider_unavailable';
  log.warn('A link booking could not be put on the calendar; it is held', {
    code: created.error.code,
  });
  await markHeld(store, organizationId, row, holdReasonForError(created.error.code), now, doubt);
  return { meetUrl: null };
}

/** The row held after a failed try: the reason, one more try counted, and when the next is due. */
async function markHeld(
  store: DataStore,
  organizationId: string,
  row: BookingRequest,
  reason: BookingHoldReason,
  now: Date,
  doubt: boolean,
): Promise<void> {
  const attempts = (row.hold_attempts ?? 0) + 1;
  const patch = {
    status: 'held' as const,
    claimed_at: doubt ? now.toISOString() : null,
    hold_reason: reason,
    hold_attempts: attempts,
    hold_next_try_at: holdNextTryAt(attempts, now),
  };
  await store.updateWhere('booking_requests', organizationId, { eq: { id: row.id } }, patch);
  Object.assign(row, patch);
}

/**
 * One try at a held booking later, in this process: when its backoff ends
 * (or a minute from now while calendar editing is off). A restart loses it
 * and changes nothing: the alerts job and every visit try too.
 */
export function scheduleHeldRetry(
  store: DataStore,
  organizationId: string,
  row: Pick<BookingRequest, 'id' | 'hold_next_try_at' | 'hold_reason'>,
  now: Date,
  schedule: Scheduler = timerScheduler,
): void {
  // Waiting for calendar editing: the grant itself, the alerts job and
  // every visit try it; there is nothing to time.
  if (row.hold_reason === 'calendar_editing_off') return;
  const due = row.hold_next_try_at ? Date.parse(row.hold_next_try_at) : NaN;
  const delay = Number.isFinite(due) ? Math.max(1_000, due - now.getTime()) : 60_000;
  schedule(async () => {
    const { placeHeldBookings } = await import('./booking-manage');
    return placeHeldBookings(store, organizationId, {
      now: new Date(now.getTime() + delay),
      force: true,
      onlyId: row.id,
      schedule,
    }).catch((error: unknown) => {
      log.warn('A held booking could not be tried again', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
    });
  }, delay);
}

/**
 * The link before 20261022200000_booking_v2.sql (no held or booked status,
 * no token, no guests column): a free time is still booked at once when the
 * calendar can be written (kept as approved, as before v2), and otherwise
 * waits as a request, the only status there is. Said in the log and the
 * audit trail (no personal data) so Settings can point at the migration.
 */
async function keepWithoutV2(
  store: DataStore,
  link: OpenLink,
  row: BookingRequest,
  options: {
    primary: { id: string } | null;
    source: CalendarSource;
    hostZone: string;
    now: Date;
  },
): Promise<Result<{ row: BookingRequest; result: PublicBookingResult }>> {
  const { organizationId, config } = link;
  const { primary, source, hostZone, now } = options;
  log.warn('The booking link v2 migration is not run: kept the old way', {
    run: '20261022200000_booking_v2.sql',
  });
  const legacy: BookingRequest = { ...row, status: 'pending' };
  for (const key of V2_COLUMNS) delete (legacy as unknown as Record<string, unknown>)[key];
  await store.insert('booking_requests', legacy);
  await recordAudit(store, {
    organizationId,
    userId: null,
    action: 'booking.v2_missing',
    entityType: 'booking_request',
    entityId: legacy.id,
    metadata: { type: legacy.meeting_type, kind: legacy.kind },
  }).catch(() => null);
  if (!config.approveFirst && primary) {
    const host = await readHost(store, organizationId);
    const created = await createLinkEvent(
      { store, organizationId, source, actorId: null },
      primary.id,
      linkEventDraft(hostNameFor(config, host), legacy, hostZone, {
        manageUrl: null,
        callLink: config.callLink,
        hostEmail: hostCalendarEmail(source, host, primary.id),
      }),
    ).catch(() => null);
    if (created?.ok) {
      const patch = {
        status: 'approved' as const,
        calendar_id: primary.id,
        event_id: created.value.eventId,
        decided_at: now.toISOString(),
      };
      await store
        .updateWhere(
          'booking_requests',
          organizationId,
          { eq: { id: legacy.id, status: 'pending' } },
          patch,
        )
        .catch(() => null);
      Object.assign(legacy, patch);
      return ok({
        row: legacy,
        result: {
          status: 'booked',
          manageUrl: null,
          booking: publicBookingView(legacy, {
            config,
            hostZone,
            now,
            meetUrl: created.value.meetUrl,
            linkOpen: false,
          }),
        },
      });
    }
  }
  return ok({ row: legacy, result: { status: 'pending', manageUrl: null, booking: null } });
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
  'hold_reason',
  'hold_attempts',
  'hold_next_try_at',
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
  return bookingEventDraft(hostName, linkRequestFromRow(row, options.manageUrl), hostZone, {
    callLink: options.callLink,
    hostEmail: options.hostEmail,
  });
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
  // One booking change at a time, like a visitor's: a cancel or a move from
  // the booking's own page cannot land in the middle of an approval.
  return oneAtATime(ctx.organizationId, () => approveUnlocked(ctx, id, deps));
}

async function approveUnlocked(
  ctx: ActorContext,
  id: string,
  deps: BookingDeps,
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
  } else if (eventId) {
    scheduleDescriptionCheck(
      {
        store: ctx.store,
        organizationId: ctx.organizationId,
        source,
        config: settings.config,
        hostZone,
        now,
      },
      id,
      null,
      deps.schedule,
    );
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
