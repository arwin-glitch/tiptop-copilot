import 'server-only';
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
  type BookingConfig,
  type MeetingKind,
  type MeetingType,
} from '@/lib/booking/config';
import { openSlots, slotProblem, type EngineInput, type LinkBooking } from '@/lib/booking/engine';
import { bookingEventDraft, declineDraft, googleCalendarTemplateUrl } from '@/lib/booking/event';
import {
  CLOSED_MESSAGE,
  knownZone,
  UNAVAILABLE_MESSAGE,
  type PublicBookingPage,
  type PublicSlots,
} from '@/lib/booking/public';
import type { BookingRequestInput } from '@/lib/booking/request';
import { calendarEditAccess } from '@/lib/calendar/edit-access';
import { sniffPhoto } from '@/lib/campaigns/photos';
import {
  calendarSource,
  invalidateCalendarCache,
  readCalendarList,
  type CalendarSource,
} from '@/lib/calendar/range-reader';
import { createCalendarEvent } from '@/lib/calendar/write';
import { isMissingTableError } from '@/lib/db/missing-table';
import type { DataStore } from '@/lib/db/store';
import { soleOrganizationId } from '@/lib/db/tenancy';
import { recordAudit } from '@/lib/security/audit';
import { rateLimit } from '@/lib/security/limits';
import { log } from '@/lib/security/redact';
import type { StorageProvider } from '@/lib/storage/provider';
import { readTeam } from '@/lib/tasks/principal';
import type { BookingRequest, BookingSettingsRow, UserProfile } from '@/lib/types/domain';
import { newId, sha256 } from '@/lib/util/hash';
import { err, ok, type Result } from '@/lib/util/result';
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

export async function saveBookingSettings(
  store: DataStore,
  organizationId: string,
  userId: string,
  input: BookingSettingsInput,
  now: Date = new Date(),
): Promise<Result<BookingSettingsView>> {
  const slug = SLUG.safeParse(input.slug);
  if (!slug.success)
    return err('invalid_input', slug.error.issues[0]?.message ?? 'Check the link.');
  const config = BOOKING_CONFIG_SCHEMA.safeParse(input.config);
  if (!config.success) {
    const issue = config.error.issues[0];
    return err(
      'invalid_input',
      `Check ${issue?.path.join(' ') || 'the settings'}: ${issue?.message ?? 'not valid'}.`,
    );
  }
  const found = await settingsRow(store, organizationId);
  if (!found.available) return err('not_configured', BOOKING_NOT_SET_UP);
  const iso = now.toISOString();
  const row: BookingSettingsRow = {
    id: found.row?.id ?? newId(),
    organization_id: organizationId,
    enabled: input.enabled,
    slug: slug.data,
    settings: config.data as unknown as Record<string, unknown>,
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
      instant: config.data.instant,
      places: config.data.places.length,
    },
  });
  return ok({
    available: true,
    enabled: row.enabled,
    slug: row.slug,
    config: config.data,
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
}

/** Everything the public page shows. Only the card, the offers and the places: no calendar. */
export async function publicBookingPage(
  store: DataStore,
  slug: string,
  deps: BookingDeps = {},
): Promise<PublicBookingPage> {
  const found = await resolveOpenLink(store, slug);
  if (!found.open) {
    return {
      state: 'closed',
      slug,
      host: null,
      hostTimeZone: 'UTC',
      offers: { call: false, inPerson: false },
      places: [],
      allowCustomPlace: false,
      kinds: [],
      chatbot: { enabled: false, mode: 'guided' },
      faq: '',
    };
  }
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
    chatbot: { enabled: config.chatbotEnabled, mode: deps.chatMode ?? 'guided' },
    faq: config.faq,
  };
}

/** The link's own requests that hold time: waiting or approved, from a day ago on. */
async function linkBookings(
  store: DataStore,
  organizationId: string,
  now: Date,
): Promise<LinkBooking[]> {
  const rows = await store.list('booking_requests', organizationId, {
    in: { status: ['pending', 'approved'] },
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
            onCalendar: r.status === 'approved' && Boolean(r.event_id),
          },
        ]
      : [],
  );
}

/**
 * The engine's input for a link: the host's busy time and travel days over
 * the horizon, his zone, and the link's own bookings. An error when the
 * calendar cannot be read in full: no slot is ever offered from part of it.
 */
export async function engineInputFor(
  store: DataStore,
  link: Pick<OpenLink, 'organizationId' | 'config'>,
  deps: BookingDeps & { fresh?: boolean } = {},
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
  const bookings = await linkBookings(store, organizationId, now);
  return ok({
    hostZone,
    source,
    input: {
      now,
      hostZone,
      config,
      busy: picture.value.busy,
      travelDays: picture.value.travelDays,
      inPersonPaused: picture.value.inPersonPaused,
      linkBookings: bookings,
    },
  });
}

function parseQuery(
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

export type SubmitOutcome = { kind: 'saved'; id: string } | { kind: 'ignored' };

/**
 * A visitor's request, checked and kept as pending. The honeypot is answered
 * as if all went well and nothing is kept. Nothing is written anywhere else:
 * no calendar, no email.
 */
export async function submitBookingRequest(
  store: DataStore,
  slug: string,
  input: BookingRequestInput,
  context: SubmitContext,
): Promise<Result<SubmitOutcome>> {
  if (input.website.trim()) return ok({ kind: 'ignored' });
  const now = context.now ?? new Date();
  const found = await resolveOpenLink(store, slug);
  if (!found.open) return err('forbidden', CLOSED_MESSAGE);
  const { organizationId, config } = found.link;

  const perEmail = rateLimit(`booking-email:${sha256(input.email).slice(0, 16)}`, 3, 3_600_000);
  if (!perEmail.ok) {
    return err('rate_limited', 'Too many requests from this email address. Try again later.');
  }
  let open: number;
  try {
    open = await store.count('booking_requests', organizationId, {
      eq: { email: input.email, status: 'pending' },
    });
  } catch (error) {
    if (isMissingTableError(error)) return err('forbidden', CLOSED_MESSAGE);
    throw error;
  }
  if (open >= MAX_OPEN_PER_EMAIL) {
    return err(
      'rate_limited',
      `You already have ${MAX_OPEN_PER_EMAIL} requests waiting. Arwin will reply to those first.`,
    );
  }

  const base = {
    id: newId(),
    organization_id: organizationId,
    status: 'pending' as const,
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

  let row: BookingRequest;
  if (input.type === 'message') {
    row = {
      ...base,
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
  } else {
    const query = { type: input.type, kind: input.type === 'in_person' ? input.kind : null };
    let place = {
      place_id: null as string | null,
      place_name: null as string | null,
      place_area: null as string | null,
      place_map_url: null as string | null,
      place_custom: false,
    };
    if (input.type === 'in_person') {
      if (!inPersonOffered(config))
        return err('invalid_input', 'In-person meetings are not offered.');
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
    const prepared = await engineInputFor(store, found.link, { now, source: context.source });
    if (!prepared.ok) return err('provider_unavailable', UNAVAILABLE_MESSAGE);
    const problem = slotProblem(prepared.value.input, query, start);
    if (problem) {
      return err('conflict', 'That time is no longer open. Pick another time.');
    }
    row = {
      ...base,
      meeting_type: input.type,
      kind: query.kind,
      starts_at: start,
      ends_at: new Date(startMs + MEETING_MINUTES[input.type] * 60_000).toISOString(),
      ...place,
    };
  }

  try {
    await store.insert('booking_requests', row);
  } catch (error) {
    if (isMissingTableError(error)) return err('forbidden', CLOSED_MESSAGE);
    throw error;
  }
  await recordAudit(store, {
    organizationId,
    userId: null,
    action: 'booking.requested',
    entityType: 'booking_request',
    entityId: row.id,
    // Ids and kinds only: never the visitor's name, address or note.
    metadata: { type: row.meeting_type, kind: row.kind, source: row.source },
  });
  return ok({ kind: 'saved', id: row.id });
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

/** How many requests wait, for Today's line. Never throws: a fault is null and no line. */
export async function countPendingBookingRequests(
  store: DataStore,
  organizationId: string,
): Promise<number | null> {
  try {
    return await store.count('booking_requests', organizationId, { eq: { status: 'pending' } });
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

function hostNameFor(config: BookingConfig, host: HostIdentity): string {
  return config.displayName.trim() || host.fullName?.trim() || '';
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

  const problem = slotProblem(
    { ...input, askedAt: new Date(request.created_at) },
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
      templateUrl: googleCalendarTemplateUrl(hostName, approvable, hostZone),
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
    return err('conflict', 'Someone is approving this request right now.');
  }

  const created = await createCalendarEvent(
    { store: ctx.store, organizationId: ctx.organizationId, userId: ctx.userId, source },
    {
      calendarId: primary.id,
      draft: bookingEventDraft(hostName, approvable, hostZone),
      // Approving a booking is the person's Send: the requester gets the invitation.
      notify: 'send',
    },
  );
  if (!created.ok) {
    await ctx.store
      .update('booking_requests', ctx.organizationId, id, { claimed_at: null })
      .catch(() => null);
    return created;
  }
  const eventId = created.value.event?.id ?? '';
  await ctx.store.update('booking_requests', ctx.organizationId, id, {
    status: 'approved',
    claimed_at: null,
    calendar_id: primary.id,
    event_id: eventId || null,
    decided_by: ctx.userId,
    decided_at: now.toISOString(),
  });
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
    meetUrl: created.value.event?.meetUrl ?? null,
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
  const changed = await ctx.store.updateWhere(
    'booking_requests',
    ctx.organizationId,
    { eq: { id, status: 'pending' } },
    {
      status: mark.status,
      claimed_at: null,
      decided_by: ctx.userId,
      decided_at: now.toISOString(),
    },
  );
  if (changed.length === 0) return err('conflict', 'That request was already decided.');
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
    const ext = kind === 'jpeg' ? 'jpg' : kind;
    const path = `booking/${organizationId}/host-photo-${version}.${ext}`;
    const put = await storage.put(path, bytes, PHOTO_TYPES[kind]);
    if (!put.ok) return put;
    photo = { path, type: PHOTO_TYPES[kind], version };
  }
  const saved = await saveBookingSettings(
    store,
    organizationId,
    userId,
    { enabled: current.enabled, slug: current.slug, config: { ...current.config, photo } },
    now,
  );
  if (!saved.ok) {
    if (photo) await storage.remove(photo.path).catch(() => null);
    return saved;
  }
  const old = current.config.photo;
  if (old && old.path !== photo?.path) await storage.remove(old.path).catch(() => null);
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
