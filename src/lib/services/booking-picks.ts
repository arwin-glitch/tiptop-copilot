import 'server-only';
import {
  inPersonOffered,
  parseBookingConfig,
  SLUG,
  type BookingConfig,
  type MeetingKind,
  type MeetingType,
} from '@/lib/booking/config';
import {
  checkPickRanges,
  DEFAULT_PICK_KIND,
  PICK_CREATE_INPUT,
  PICK_GONE_MESSAGE,
  PICK_TAKEN_MESSAGE,
  PICKS_NOT_SET_UP,
  pickCandidateStarts,
  pickExpiresAt,
  pickOfferedStarts,
  spansOverlap,
  type PickRange,
  type PickView,
  type PublicPick,
} from '@/lib/booking/picks';
import { holdsBefore, type PickHold } from '@/lib/booking/engine';
import { formatPickText } from '@/lib/booking/picks-format';
import {
  knownZone,
  UNAVAILABLE_MESSAGE,
  type PublicBookingPage,
  type PublicBookingResult,
  type PublicSlots,
} from '@/lib/booking/public';
import { cleanGuests, ownDomains, type BookingRequestInput } from '@/lib/booking/request';
import type { CalendarSource } from '@/lib/calendar/range-reader';
import { env } from '@/lib/config/env';
import { isMissingColumnError, isMissingTableError } from '@/lib/db/missing-table';
import type { DataStore } from '@/lib/db/store';
import { soleOrganizationId } from '@/lib/db/tenancy';
import { recordAudit } from '@/lib/security/audit';
import { openToken, sealToken } from '@/lib/security/crypto';
import { rateLimit } from '@/lib/security/limits';
import { log } from '@/lib/security/redact';
import type {
  BookingHoldReason,
  BookingPick,
  BookingRequest,
  BookingSettingsRow,
} from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';
import { localDateKey } from '@/lib/util/time';
import { err, ok, type Result } from '@/lib/util/result';
import {
  blockedGuestAddresses,
  bookingBrakes,
  bookOnCalendar,
  chargeEmailLimits,
  closedBookingPage,
  engineInputFor,
  mainCalendarFor,
  manageTokenHash,
  managePath,
  manageUrl,
  mintManageToken,
  oneAtATime,
  publicBookingPage,
  publicBookingView,
  openPickHolds,
  scheduleHeldRetry,
  type ActorContext,
  type BookingDeps,
  type OpenLink,
  type SubmitOutcome,
} from './booking';
import type { Scheduler } from './booking-sync';

/**
 * Pick times (Vimcal-style): the host picks open ranges on Kraken's
 * Calendar, copies them with a link (/meet/<slug>/p/<token>) and pastes both
 * into an email; the person he sent it to books one start inside them.
 *
 * The rules that matter, enforced here:
 * - The link works while the pick is open and not past its expiry (read at
 *   the time, no job), even with the public booking link turned off: the
 *   booking link's settings row is needed only for the slug and the host's
 *   card. Used, cancelled, expired or unknown: "These times are no longer
 *   available."
 * - A start is offered inside the ranges (lib/booking/picks.ts) when it
 *   overlaps no busy time, no time-holding booking and no other open pick's
 *   hold. No buffers, windows, notice or caps: the host chose these times.
 * - Booking claims the pick in one compare-and-set (open and unexpired to
 *   used) inside oneAtATime, so it is used once; it skips approve first and
 *   is booked on the calendar at once, or held and placed by Kraken exactly
 *   as a public booking is (lib/services/booking.ts).
 * - While open and holding, its ranges are kept off the public link
 *   (engineInputFor's pickHolds). Holds live in booking_picks only, never as
 *   Google Calendar events.
 * - Without the table (its migration not run yet) the Calendar's panel says
 *   so, a pick link is closed, and everything else works as before.
 */

const MINUTE = 60_000;

/** The link a pick's guest opens, as a path on this site. */
export function pickPath(slug: string, token: string): string {
  return `/meet/${slug}/p/${token}`;
}

/** The same, absolute (APP_URL), for the email. */
export function pickUrl(slug: string, token: string): string {
  return `${env().appUrl.replace(/\/+$/, '')}${pickPath(slug, token)}`;
}

/** The associated data a pick's sealed token is bound to: it cannot be moved to another pick. */
const sealAad = (id: string) => `booking-pick:${id}`;

/** Whether a pick still takes bookings at `now`. */
export function pickIsOpen(row: Pick<BookingPick, 'status' | 'expires_at'>, now: Date): boolean {
  return row.status === 'open' && Date.parse(row.expires_at) > now.getTime();
}

function rangesOf(row: Pick<BookingPick, 'ranges'>): PickRange[] {
  return (Array.isArray(row.ranges) ? row.ranges : []).filter(
    (r) => r && typeof r.start === 'string' && typeof r.end === 'string',
  );
}

export function toPickView(row: BookingPick): PickView {
  return {
    id: row.id,
    status: row.status,
    meetingType: row.meeting_type,
    kind: row.kind,
    durationMinutes: row.duration_minutes,
    ranges: rangesOf(row),
    recipientName: row.recipient_name,
    recipientTimeZone: row.recipient_time_zone,
    hold: row.hold,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    canCopyAgain: Boolean(row.token_sealed),
  };
}

/** The booking link's settings row, any state: the slug and the host card come from it. */
async function linkRow(
  store: DataStore,
  organizationId: string,
): Promise<{ available: boolean; row: BookingSettingsRow | null }> {
  try {
    return { available: true, row: await store.findOne('booking_settings', organizationId, {}) };
  } catch (error) {
    if (isMissingTableError(error)) return { available: false, row: null };
    throw error;
  }
}

const NO_LINK =
  'Set up the booking link on the Booking tab first: the picked times use its address.';

/* ---------------------------------------------------------------- the host */

export interface CreatedPick {
  id: string;
  /** Absolute (APP_URL): the guest's page. */
  url: string;
  text: string;
  html: string;
  expiresAt: string;
  pick: PickView;
  /** Some of the times are held for someone else already: those are not offered. */
  warning: string | null;
}

export const PICK_NONE_FREE =
  'None of these times can be booked: they are busy or held for someone else. Pick other times.';
export const PICK_SOME_HELD =
  'Some of these times are held for someone else already, so they are not offered.';

/**
 * What a new pick would offer, checked before it is saved: every open pick
 * is older, so all their holds count, with the link's time-holding bookings
 * and, when the calendar can be read, busy time. A calendar that cannot be
 * read is no reason to refuse: the guest's page checks it again.
 */
async function newPickClearance(
  store: DataStore,
  link: Pick<OpenLink, 'organizationId' | 'config'>,
  ranges: readonly PickRange[],
  durationMinutes: number,
  deps: { now: Date; source?: CalendarSource },
): Promise<{ offered: number; heldAway: boolean }> {
  const through = lastDayOf(ranges, 'UTC');
  const prepared = await engineInputFor(store, link, {
    now: deps.now,
    source: deps.source,
    through: through ? addDay(through) : null,
  }).catch(() => null);
  const holds: readonly PickHold[] =
    prepared && prepared.ok
      ? (prepared.value.input.pickHolds ?? [])
      : await openPickHolds(store, link.organizationId, deps.now);
  const clear = {
    busy: prepared && prepared.ok ? prepared.value.input.busy : [],
    bookings: prepared && prepared.ok ? prepared.value.input.linkBookings : [],
    holds,
  };
  const pick = { ranges, durationMinutes };
  const offered = pickOfferedStarts(pick, deps.now, clear).length;
  const withoutHolds = pickOfferedStarts(pick, deps.now, { ...clear, holds: [] }).length;
  return { offered, heldAway: withoutHolds > offered };
}

/**
 * Make a pick from the Calendar's panel: the ranges checked (15-minute
 * steps, ahead, within 60 days, at most 20 once merged, each as long as the
 * meeting), a fresh token (only its hash kept for finding it, the token
 * sealed for Copy again), and the clipboard's text and HTML in the other
 * person's zone. Audited.
 */
export async function createPick(
  ctx: ActorContext,
  body: unknown,
  deps: { now?: Date; source?: CalendarSource } = {},
): Promise<Result<CreatedPick>> {
  const now = deps.now ?? new Date();
  const parsed = PICK_CREATE_INPUT.safeParse(body ?? {});
  if (!parsed.success) {
    return err('invalid_input', parsed.error.issues[0]?.message ?? 'Check the picked times.');
  }
  const input = parsed.data;
  const checked = checkPickRanges(input.ranges, input.durationMinutes, now);
  if (!checked.ok) return err('invalid_input', checked.problem);
  const link = await linkRow(ctx.store, ctx.organizationId);
  if (!link.available || !link.row) return err('not_configured', NO_LINK);
  const config = parseBookingConfig(link.row.settings);
  const type: MeetingType = input.meetingType;
  if (type === 'in_person' && !inPersonOffered(config)) {
    return err(
      'invalid_input',
      'In person needs a home city and places on the Booking tab first. Pick Video call instead.',
    );
  }
  const kind: MeetingKind | null = type === 'in_person' ? (input.kind ?? DEFAULT_PICK_KIND) : null;
  const clearance = await newPickClearance(
    ctx.store,
    { organizationId: ctx.organizationId, config },
    checked.ranges,
    input.durationMinutes,
    { now, source: deps.source },
  );
  if (clearance.offered === 0) return err('invalid_input', PICK_NONE_FREE);
  const id = newId();
  const { token, hash } = mintManageToken();
  const sealed = sealToken(token, sealAad(id));
  const iso = now.toISOString();
  const row: BookingPick = {
    id,
    organization_id: ctx.organizationId,
    token_hash: hash,
    token_sealed: sealed.ok ? sealed.value : null,
    meeting_type: type,
    kind,
    duration_minutes: input.durationMinutes,
    ranges: checked.ranges,
    recipient_name: input.recipientName || null,
    recipient_time_zone: input.recipientTimeZone,
    hold: input.hold,
    status: 'open',
    booking_request_id: null,
    expires_at: pickExpiresAt(now, input.holdHours, checked.ranges),
    created_by: ctx.userId,
    created_at: iso,
    updated_at: iso,
  };
  try {
    await ctx.store.insert('booking_picks', row);
  } catch (error) {
    if (isMissingTableError(error) || isMissingColumnError(error)) {
      return err('not_configured', PICKS_NOT_SET_UP);
    }
    throw error;
  }
  await recordAudit(ctx.store, {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    action: 'booking.pick_created',
    entityType: 'booking_pick',
    entityId: id,
    // Counts and kinds only: never the name typed for the other person.
    metadata: {
      type,
      kind,
      duration: row.duration_minutes,
      ranges: row.ranges.length,
      hold: row.hold,
    },
  });
  const url = pickUrl(link.row.slug, token);
  const copy = formatPickText({ ranges: row.ranges, timeZone: row.recipient_time_zone, url });
  return ok({
    id,
    url,
    ...copy,
    expiresAt: row.expires_at,
    pick: toPickView(row),
    warning: clearance.heldAway ? PICK_SOME_HELD : null,
  });
}

export interface PickList {
  /** The table exists (20261028000000_booking_picks.sql was run). */
  available: boolean;
  /** The booking link has its settings row (a slug): needed to copy a link. */
  linkReady: boolean;
  slug: string | null;
  /** Open, unexpired picks overlapping the range, newest first. */
  picks: PickView[];
}

/**
 * The open picks for the Calendar (its overlays and the panel's Open picks):
 * open and not past their expiry, with a range overlapping `from`..`to` when
 * given. Never throws for a missing table: `available` says so.
 */
export async function listPicks(
  store: DataStore,
  organizationId: string,
  options: { from?: string | null; to?: string | null; now?: Date } = {},
): Promise<PickList> {
  const now = options.now ?? new Date();
  const link = await linkRow(store, organizationId);
  const base = { linkReady: Boolean(link.row), slug: link.row?.slug ?? null };
  let rows: BookingPick[];
  try {
    rows = await store.list(
      'booking_picks',
      organizationId,
      { eq: { status: 'open' }, gt: { expires_at: now.toISOString() } },
      { orderBy: [{ field: 'created_at', direction: 'desc' }], limit: 100 },
    );
  } catch (error) {
    if (isMissingTableError(error) || isMissingColumnError(error)) {
      return { ...base, available: false, picks: [] };
    }
    throw error;
  }
  const from = Date.parse(options.from ?? '');
  const to = Date.parse(options.to ?? '');
  const window = {
    start: Number.isFinite(from) ? from : -Infinity,
    end: Number.isFinite(to) ? to : Infinity,
  };
  const picks = rows
    .filter((r) =>
      rangesOf(r).some((range) =>
        spansOverlap({ start: Date.parse(range.start), end: Date.parse(range.end) }, window),
      ),
    )
    .map(toPickView);
  return { ...base, available: true, picks };
}

async function pickById(ctx: ActorContext, id: string): Promise<Result<{ row: BookingPick }>> {
  let row: BookingPick | null;
  try {
    row = await ctx.store.get('booking_picks', ctx.organizationId, id);
  } catch (error) {
    if (isMissingTableError(error) || isMissingColumnError(error)) {
      return err('not_configured', PICKS_NOT_SET_UP);
    }
    throw error;
  }
  if (!row) return err('not_found', 'Those picked times are not here any more.');
  return ok({ row });
}

/** Cancel a pick: its link closes and its times are no longer held. Audited. */
export async function revokePick(
  ctx: ActorContext,
  id: string,
  deps: { now?: Date } = {},
): Promise<Result<{ pick: PickView }>> {
  const now = deps.now ?? new Date();
  const found = await pickById(ctx, id);
  if (!found.ok) return found;
  if (found.value.row.status !== 'open') {
    return err(
      'conflict',
      found.value.row.status === 'used'
        ? 'Someone already booked one of these times.'
        : 'These times were cancelled already.',
    );
  }
  const changed = await ctx.store.updateWhere(
    'booking_picks',
    ctx.organizationId,
    { eq: { id, status: 'open' } },
    { status: 'revoked', updated_at: now.toISOString() },
  );
  if (changed.length === 0) {
    return err('conflict', 'These times changed just now. Reload and try again.');
  }
  await recordAudit(ctx.store, {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    action: 'booking.pick_revoked',
    entityType: 'booking_pick',
    entityId: id,
    metadata: { type: found.value.row.meeting_type },
  });
  return ok({ pick: toPickView(changed[0] ?? { ...found.value.row, status: 'revoked' }) });
}

/**
 * "Copy again": the same link and text as when the pick was made, from its
 * sealed token. Only while it is open; an error when the token cannot be
 * opened (the app's key changed), so the panel can say to pick again.
 */
export async function copyPickAgain(
  ctx: ActorContext,
  id: string,
  deps: { now?: Date } = {},
): Promise<Result<{ url: string; text: string; html: string; expiresAt: string }>> {
  const now = deps.now ?? new Date();
  const found = await pickById(ctx, id);
  if (!found.ok) return found;
  const { row } = found.value;
  if (!pickIsOpen(row, now)) return err('conflict', PICK_GONE_MESSAGE);
  const link = await linkRow(ctx.store, ctx.organizationId);
  if (!link.row) return err('not_configured', NO_LINK);
  const token = row.token_sealed ? openToken(row.token_sealed, sealAad(row.id)) : null;
  if (
    !token?.ok ||
    !manageTokenHash(token.value) ||
    manageTokenHash(token.value) !== row.token_hash
  ) {
    return err(
      'conflict',
      'The link for these times cannot be shown again. Cancel them and pick the times again.',
    );
  }
  const url = pickUrl(link.row.slug, token.value);
  return ok({
    url,
    ...formatPickText({ ranges: rangesOf(row), timeZone: row.recipient_time_zone, url }),
    expiresAt: row.expires_at,
  });
}

/* --------------------------------------------------------------- the guest */

interface FoundPick {
  organizationId: string;
  settings: BookingSettingsRow;
  config: BookingConfig;
  pick: BookingPick;
}

/**
 * The pick a token names on a slug's link, whatever its state: the link
 * need not be on, but it must be this organization's by this slug. Null for
 * anything else, a missing table included.
 */
async function pickForToken(
  store: DataStore,
  slug: string,
  token: string,
): Promise<FoundPick | null> {
  const clean = SLUG.safeParse(slug);
  const hash = manageTokenHash(token);
  if (!clean.success || !hash) return null;
  const organizationId = await soleOrganizationId('booking-link');
  if (!organizationId) return null;
  try {
    const settings = await store.findOne('booking_settings', organizationId, {
      eq: { slug: clean.data },
    });
    if (!settings) return null;
    const pick = await store.findOne('booking_picks', organizationId, {
      eq: { token_hash: hash },
    });
    if (!pick) return null;
    return { organizationId, settings, config: parseBookingConfig(settings.settings), pick };
  } catch (error) {
    if (isMissingTableError(error) || isMissingColumnError(error)) return null;
    throw error;
  }
}

function linkOf(found: FoundPick): OpenLink {
  return { organizationId: found.organizationId, row: found.settings, config: found.config };
}

function publicPick(pick: BookingPick): PublicPick {
  return {
    type: pick.meeting_type,
    kind: pick.kind,
    durationMinutes: pick.duration_minutes,
    recipientTimeZone: knownZone(pick.recipient_time_zone) ? pick.recipient_time_zone : 'UTC',
    recipientName: pick.recipient_name,
  };
}

/** The guest page's data: the host's card and the pick, or the closed card. */
export interface PublicPickPage {
  state: 'open' | 'closed';
  slug: string;
  /** The host card, places and the like, as the booking page has them (closed: nothing). */
  page: PublicBookingPage;
  pick: PublicPick | null;
  /** The public booking link (a path), while it is on: offered on the closed card. */
  publicPath: string | null;
  message: string | null;
}

/** Views of pick pages one address may make in ten minutes, like a booking's own page. */
export const PICK_VIEWS_PER_10_MIN = 60;

function closedPickPage(slug: string, publicPath: string | null): PublicPickPage {
  return {
    state: 'closed',
    slug,
    page: closedBookingPage(slug),
    pick: null,
    publicPath,
    message: PICK_GONE_MESSAGE,
  };
}

/**
 * One view of a pick's page, braked per visitor address: the host's card
 * and the pick while it is open, else the closed card (with the public
 * booking link only while that link is on).
 */
export async function loadPickPage(
  store: DataStore,
  slug: string,
  token: string,
  addressKey: string,
  deps: BookingDeps = {},
): Promise<PublicPickPage> {
  const now = deps.now ?? new Date();
  const limited = rateLimit(`booking-pick-page:${addressKey}`, PICK_VIEWS_PER_10_MIN, 600_000);
  if (!limited.ok) return closedPickPage(slug, null);
  const found = await pickForToken(store, slug, token);
  if (!found) {
    const open = await openLinkPath(store, slug);
    return closedPickPage(slug, open);
  }
  const publicPath = found.settings.enabled ? `/meet/${found.settings.slug}` : null;
  const { pick } = found;
  if (
    !pickIsOpen(pick, now) ||
    pickCandidateStarts(rangesOf(pick), pick.duration_minutes, now).length === 0
  ) {
    return closedPickPage(found.settings.slug, publicPath);
  }
  const page = await publicBookingPage(store, found.settings.slug, {
    ...deps,
    link: linkOf(found),
  });
  return {
    state: 'open',
    slug: found.settings.slug,
    page: {
      ...page,
      // The host chose these times: booked at once, no assistant, only this kind of meeting.
      instant: true,
      chatbot: { enabled: false },
      offers: { call: pick.meeting_type === 'call', inPerson: pick.meeting_type === 'in_person' },
      kinds: pick.kind ? [pick.kind] : [],
    },
    pick: publicPick(pick),
    publicPath,
    message: null,
  };
}

/** The public booking link's path when a slug's link is on, else null. */
async function openLinkPath(store: DataStore, slug: string): Promise<string | null> {
  const clean = SLUG.safeParse(slug);
  if (!clean.success) return null;
  const organizationId = await soleOrganizationId('booking-link').catch(() => null);
  if (!organizationId) return null;
  const row = await store
    .findOne('booking_settings', organizationId, { eq: { slug: clean.data } })
    .catch(() => null);
  return row?.enabled ? `/meet/${row.slug}` : null;
}

/** A pick's open starts for the guest page, in the PublicSlots shape the time picker reads. */
export type PublicPickSlots = PublicSlots & {
  durationMinutes?: number;
  recipientTimeZone?: string;
  publicPath?: string | null;
};

/** The last host-zone day a pick's ranges reach: the busy read goes at least that far. */
function lastDayOf(ranges: readonly PickRange[], hostZone: string): string | null {
  const ends = ranges.map((r) => Date.parse(r.end)).filter(Number.isFinite);
  return ends.length ? localDateKey(new Date(Math.max(...ends)), hostZone) : null;
}

async function offeredFor(
  store: DataStore,
  found: FoundPick,
  deps: BookingDeps & { fresh?: boolean },
): Promise<
  Result<{ slots: { start: string; end: string }[]; hostZone: string; source: CalendarSource }>
> {
  const now = deps.now ?? new Date();
  const { pick } = found;
  const ranges = rangesOf(pick);
  // Through the last range's day (in UTC terms first: the zone is not known yet).
  const through = lastDayOf(ranges, 'UTC');
  const prepared = await engineInputFor(store, linkOf(found), {
    ...deps,
    now,
    through: through ? addDay(through) : null,
  }).catch((error: unknown) => {
    log.warn('Picked times could not be checked', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return null;
  });
  if (!prepared || !prepared.ok) return err('provider_unavailable', UNAVAILABLE_MESSAGE);
  const { input, hostZone, source } = prepared.value;
  const slots = pickOfferedStarts({ ranges, durationMinutes: pick.duration_minutes }, now, {
    busy: input.busy,
    bookings: input.linkBookings,
    // Only picks made before this one block it (as pickRowProblem): a newer
    // pick over the same times never shuts a link already sent.
    holds: holdsBefore(input.pickHolds ?? [], Date.parse(pick.created_at)).filter(
      (h) => h.pickId !== pick.id,
    ),
  });
  return ok({ slots, hostZone, source });
}

function addDay(key: string): string {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * The starts a pick's guest may book now (GET /api/meet/<slug>/p/<token>/slots):
 * start and end instants, the days that have them, and the zone the host
 * chose for the guest. Closed (with the gone message) when the pick is used,
 * cancelled, past its time, unknown, or has no start left.
 */
export async function pickSlots(
  store: DataStore,
  slug: string,
  token: string,
  deps: BookingDeps = {},
): Promise<PublicPickSlots> {
  const found = await pickForToken(store, slug, token);
  const type: MeetingType = found?.pick.meeting_type ?? 'call';
  const base = { type, kind: found?.pick.kind ?? null, slots: [] };
  const now = deps.now ?? new Date();
  if (!found || !pickIsOpen(found.pick, now)) {
    return {
      ...base,
      state: 'closed',
      hostTimeZone: 'UTC',
      message: PICK_GONE_MESSAGE,
      publicPath: found?.settings.enabled ? `/meet/${found.settings.slug}` : null,
    };
  }
  const offered = await offeredFor(store, found, { ...deps, now });
  const extra = {
    durationMinutes: found.pick.duration_minutes,
    recipientTimeZone: publicPick(found.pick).recipientTimeZone,
  };
  if (!offered.ok) {
    return {
      ...base,
      ...extra,
      state: 'unavailable',
      hostTimeZone: 'UTC',
      message: UNAVAILABLE_MESSAGE,
    };
  }
  const { slots, hostZone } = offered.value;
  if (slots.length === 0) {
    return {
      ...base,
      ...extra,
      state: 'closed',
      hostTimeZone: hostZone,
      message: PICK_GONE_MESSAGE,
      publicPath: found.settings.enabled ? `/meet/${found.settings.slug}` : null,
    };
  }
  const days = [...new Set(slots.map((s) => localDateKey(new Date(s.start), hostZone)))];
  return {
    ...base,
    ...extra,
    state: 'ok',
    hostTimeZone: hostZone,
    slots,
    days: days.map((date) => ({ date, state: 'open' as const })),
    months: [...new Set(days.map((d) => d.slice(0, 7)))],
  };
}

export interface PickSubmitContext {
  ipHash: string | null;
  now?: Date;
  source?: CalendarSource;
  schedule?: Scheduler;
}

/**
 * A guest books one of a pick's starts. The start is checked again against
 * the live calendar (busy time, time-holding bookings, other picks' holds),
 * the usual brakes apply, and inside oneAtATime the pick is claimed in one
 * compare-and-set (open and unexpired to used): a second guest gets 409
 * "That time was just taken." The booking skips approve first: on the
 * calendar at once, or held and placed by Kraken as a public booking is.
 */
export async function submitPickBooking(
  store: DataStore,
  slug: string,
  token: string,
  input: BookingRequestInput,
  context: PickSubmitContext,
): Promise<Result<SubmitOutcome>> {
  const now = context.now ?? new Date();
  const found = await pickForToken(store, slug, token);
  if (input.website.trim()) {
    return ok({ kind: 'ignored', result: { status: 'booked', manageUrl: null, booking: null } });
  }
  // Used a moment ago by someone else: taken (409). Cancelled, past or unknown: gone (404).
  if (found?.pick.status === 'used') return err('conflict', PICK_TAKEN_MESSAGE);
  if (!found || !pickIsOpen(found.pick, now)) return err('not_found', PICK_GONE_MESSAGE);
  if (input.type === 'message') return err('invalid_input', 'Pick a time.');
  const { organizationId, config, pick } = found;
  const link = linkOf(found);
  const type: MeetingType = pick.meeting_type;
  const kind = type === 'in_person' ? (pick.kind ?? DEFAULT_PICK_KIND) : null;

  let guests: string[] = [];
  if (input.guests.length > 0) {
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

  let place = {
    place_id: null as string | null,
    place_name: null as string | null,
    place_area: null as string | null,
    place_map_url: null as string | null,
    place_custom: false,
  };
  if (type === 'in_person') {
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

  const kept = await oneAtATime(
    organizationId,
    async (): Promise<Result<{ row: BookingRequest; result: PublicBookingResult }>> => {
      const braked = await bookingBrakes(store, organizationId, {
        email: input.email,
        guests,
        ipHash: context.ipHash,
        meeting: true,
        now,
      });
      if (!braked.ok) return braked;
      // The pick as it is now (another guest may have just used it).
      const fresh = await store.get('booking_picks', organizationId, pick.id).catch(() => null);
      if (!fresh || !pickIsOpen(fresh, now)) return err('conflict', PICK_TAKEN_MESSAGE);
      const offered = await offeredFor(
        store,
        { ...found, pick: fresh },
        { now, source: context.source, fresh: true },
      );
      if (!offered.ok) return offered;
      if (!offered.value.slots.some((s) => s.start === start)) {
        return err('conflict', PICK_TAKEN_MESSAGE);
      }
      const limited = chargeEmailLimits(input.email, guests);
      if (limited) return limited;

      const { source: calendar, hostZone } = offered.value;

      // Booked at once, or held until the calendar can be written (never approve first).
      let primary: { id: string } | null = null;
      let status: 'booked' | 'held' = 'held';
      let holdReason: BookingHoldReason | null = null;
      const target = await mainCalendarFor(calendar, organizationId);
      if (target.ok) {
        primary = target.calendar;
        status = 'booked';
      } else {
        holdReason = target.reason;
      }

      // The claim: open and unexpired to used, once.
      const claimed = await store.updateWhere(
        'booking_picks',
        organizationId,
        { eq: { id: pick.id, status: 'open' }, gt: { expires_at: now.toISOString() } },
        { status: 'used', updated_at: now.toISOString() },
      );
      if (claimed.length === 0) return err('conflict', PICK_TAKEN_MESSAGE);

      const { token: manageToken, hash } = mintManageToken();
      const iso = now.toISOString();
      const row: BookingRequest = {
        id: newId(),
        organization_id: organizationId,
        status,
        meeting_type: type,
        kind,
        starts_at: start,
        ends_at: new Date(startMs + pick.duration_minutes * MINUTE).toISOString(),
        visitor_time_zone: knownZone(input.timeZone) ? input.timeZone : null,
        name: input.name,
        email: input.email,
        company: input.company || null,
        ...place,
        note: input.note || null,
        deck_url: input.deckUrl || null,
        source: input.source,
        ip_hash: context.ipHash,
        claimed_at: null,
        calendar_id: null,
        event_id: null,
        decided_by: null,
        decided_at: null,
        created_at: iso,
        updated_at: iso,
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
        pick_id: pick.id,
      };
      try {
        await store.insert('booking_requests', row);
      } catch (error) {
        // Not kept: the pick is open again for the next try.
        await store
          .updateWhere(
            'booking_picks',
            organizationId,
            { eq: { id: pick.id, status: 'used' }, isNull: ['booking_request_id'] },
            { status: 'open', updated_at: now.toISOString() },
          )
          .catch(() => null);
        if (isMissingTableError(error) || isMissingColumnError(error)) {
          return err('not_found', PICK_GONE_MESSAGE);
        }
        throw error;
      }
      await store
        .updateWhere(
          'booking_picks',
          organizationId,
          { eq: { id: pick.id } },
          { booking_request_id: row.id },
        )
        .catch((error: unknown) => {
          log.warn('A used pick could not name its booking', {
            reason: error instanceof Error ? error.message : 'unknown',
          });
        });

      let meetUrl: string | null = null;
      if (status === 'booked' && primary) {
        const placed = await bookOnCalendar(store, link, row, {
          calendarId: primary.id,
          source: calendar,
          hostZone,
          now,
          pageUrl: manageUrl(found.settings.slug, manageToken),
          schedule: context.schedule,
        });
        meetUrl = placed.meetUrl;
      }
      return ok({
        row,
        result: {
          status: row.status === 'booked' ? 'booked' : 'held',
          manageUrl: managePath(found.settings.slug, manageToken),
          booking: publicBookingView(row, {
            config,
            hostZone,
            now,
            meetUrl,
            linkOpen: found.settings.enabled,
          }),
        },
      });
    },
  );
  if (!kept.ok) return kept;
  const { row, result } = kept.value;
  await recordAudit(store, {
    organizationId,
    userId: null,
    action: row.status === 'booked' ? 'booking.booked' : 'booking.held',
    entityType: 'booking_request',
    entityId: row.id,
    metadata: {
      type: row.meeting_type,
      kind: row.kind,
      source: row.source,
      pick: true,
      ...(row.guest_emails?.length ? { guests: row.guest_emails.length } : {}),
      ...(row.hold_reason ? { hold_reason: row.hold_reason } : {}),
    },
  });
  if (row.status === 'held') {
    scheduleHeldRetry(store, organizationId, row, now, context.schedule);
  }
  return ok({ kind: 'saved', id: row.id, result });
}
