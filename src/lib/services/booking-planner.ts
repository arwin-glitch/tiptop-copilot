import 'server-only';
import { teammateCalendarIds } from '@/lib/booking/availability';
import {
  calendarCounts,
  calendarLock,
  countsByDefault,
  type CalendarLock,
} from '@/lib/booking/calendar-choices';
import { inPersonOffered, type BookingConfig } from '@/lib/booking/config';
import { dayPlans, PREVIEW_QUERIES, type EngineInput, type PreviewKey } from '@/lib/booking/engine';
import { furthestMonth, isRolling, openThroughLabelMonth, withoutPast } from '@/lib/booking/months';
import type { PreviewDay, PreviewPlan } from '@/lib/booking/planner-status';
import { calendarEditAccess, type CalendarEditAccess } from '@/lib/calendar/edit-access';
import { calendarSource, readCalendarList } from '@/lib/calendar/range-reader';
import type { DataStore } from '@/lib/db/store';
import { log } from '@/lib/security/redact';
import { readCalendarPrefs } from '@/lib/services/calendar-prefs';
import { readTeamMembers } from '@/lib/tasks/principal';
import { err, ok, type Result } from '@/lib/util/result';
import { addDaysToKey, localDateKey } from '@/lib/util/time';
import {
  BOOKING_NOT_SET_UP,
  engineInputFor,
  readBookingSettings,
  readHost,
  saveBookingSettings,
  type BookingDeps,
  type BookingSettingsView,
} from './booking';
import { principalTimeZone } from './push-alerts';

/**
 * The Booking tab (D-078): the parts of the booking link it edits one panel
 * at a time, the live preview of what visitors see (the same engine as the
 * public page), and which calendars block the host's time.
 *
 * Kept apart from services/booking.ts, which holds the link itself (the
 * public page, the bookings, the calendar writes): this module only reads
 * the calendar and saves settings.
 */

/**
 * The settings a Booking tab panel may change. Not the photo (only an upload
 * changes it) and not the chatbot (its own route saves it): a panel's save
 * merges onto what is stored, so two panels never undo each other.
 */
export const PANEL_KEYS = [
  'displayName',
  'title',
  'bio',
  'firmName',
  'homeCity',
  'homeAliases',
  'places',
  'allowCustomPlace',
  'weekdays',
  'callWindow',
  'kindWindows',
  'callBufferMinutes',
  'inPersonBufferMinutes',
  'stackSize',
  'stackGapMinutes',
  'stackCooldownMinutes',
  'stackLeadMinutes',
  'noticeHours',
  'openThrough',
  'rollingMonths',
  'closedMonths',
  'closedDates',
  'closedRanges',
  'dateHours',
  'calendarChoices',
  'maxLinkBookingsPerDay',
  'maxMeetingsPerDay',
  'approveFirst',
] as const satisfies readonly (keyof BookingConfig)[];
export type PanelKey = (typeof PANEL_KEYS)[number];

/** Any other field sent (the photo, the chatbot, a typo) is ignored: the stored one stays. */
const ALLOWED = new Set<string>(PANEL_KEYS);

export interface SettingsPatch {
  enabled?: boolean;
  slug?: string;
  config?: Record<string, unknown>;
}

/**
 * Save part of the booking link from one panel: the stored settings with
 * only the given fields changed, checked as a whole by the same rules as
 * before. Days and months already past drop off the planner's lists.
 */
export async function patchBookingSettings(
  store: DataStore,
  organizationId: string,
  userId: string,
  patch: SettingsPatch,
  now: Date = new Date(),
): Promise<Result<BookingSettingsView>> {
  const current = await readBookingSettings(store, organizationId);
  if (!current.available) return err('not_configured', BOOKING_NOT_SET_UP);
  const changes: Partial<BookingConfig> = {};
  for (const [key, value] of Object.entries(patch.config ?? {})) {
    if (ALLOWED.has(key)) (changes as Record<string, unknown>)[key] = value;
  }
  const zone = await principalTimeZone(store, organizationId);
  const today = localDateKey(now, zone);
  const merged = withoutPast({ ...current.config, ...changes }, today);
  if (merged.openThrough && merged.openThrough > furthestMonth(today)) {
    return err('invalid_input', 'The link can open at most six months ahead.');
  }
  return saveBookingSettings(
    store,
    organizationId,
    userId,
    {
      enabled: patch.enabled ?? current.enabled,
      slug: patch.slug ?? current.slug,
      config: merged,
    },
    now,
  );
}

/* ------------------------------------------------------------ the preview */

export interface BookingPreview {
  /** 'ok': the calendar was read; 'unavailable': the rules alone (visitors see no times). */
  state: 'ok' | 'unavailable';
  message: string | null;
  hostZone: string;
  today: string;
  /** The last month that really takes bookings; null when none does. */
  openThrough: string | null;
  rolling: boolean;
  days: PreviewDay[];
}

/** The most days one preview reads: a month and its neighbours' edges. */
export const MAX_PREVIEW_DAYS = 42;

const IN_PERSON_OFF: PreviewPlan = {
  times: [],
  reason: 'In person is off: add a home city and a place on the Places tab.',
  code: 'in_person_off',
};

/**
 * What the public page offers on each day from `from` to `to`, per kind of
 * meeting, and why a day offers nothing: the same engine, the same calendar
 * read and the same rules as a visitor's page, so the planner shows exactly
 * what they would see. When the calendar cannot be read the rules alone are
 * shown, marked so (visitors then see no times at all).
 */
export async function bookingPreview(
  store: DataStore,
  organizationId: string,
  range: { from: string; to: string },
  deps: BookingDeps = {},
): Promise<Result<BookingPreview>> {
  const now = deps.now ?? new Date();
  const settings = await readBookingSettings(store, organizationId);
  if (!settings.available) return err('not_configured', BOOKING_NOT_SET_UP);
  const { config } = settings;
  const hostZone = await principalTimeZone(store, organizationId);
  const today = localDateKey(now, hostZone);
  const to = range.to < range.from ? range.from : range.to;
  if (addDaysToKey(range.from, MAX_PREVIEW_DAYS) < to) {
    return err('invalid_input', `Pick at most ${MAX_PREVIEW_DAYS} days.`);
  }

  let input: EngineInput;
  let state: BookingPreview['state'] = 'ok';
  let message: string | null = null;
  const read = await engineInputFor(store, { organizationId, config }, deps).catch(
    (error: unknown) => {
      log.warn('Booking preview could not read the calendar', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      return null;
    },
  );
  if (read?.ok) {
    input = read.value.input;
  } else {
    state = 'unavailable';
    message =
      read && !read.ok
        ? `${read.error.message} Visitors see no times until it can be read.`
        : 'The calendar could not be read. Visitors see no times until it can be read.';
    input = { now, hostZone, config, busy: [], travelDays: new Set(), linkBookings: [] };
  }

  const inPerson = inPersonOffered(config);
  const byKey = new Map(
    PREVIEW_QUERIES.map((q) => [
      q.key,
      q.key !== 'call' && !inPerson ? null : dayPlans(input, q.query, range.from, to),
    ]),
  );
  const days: PreviewDay[] = [];
  for (let day = range.from, i = 0; day <= to; day = addDaysToKey(day, 1), i++) {
    const plans = {} as Record<PreviewKey, PreviewPlan>;
    for (const q of PREVIEW_QUERIES) {
      const plan = byKey.get(q.key)?.[i];
      plans[q.key] = plan
        ? { times: plan.slots.map((s) => s.start), reason: plan.reason, code: plan.code }
        : { ...IN_PERSON_OFF };
    }
    days.push({ date: day, plans });
  }
  return ok({
    state,
    message,
    hostZone,
    today,
    openThrough: openThroughLabelMonth(config, today),
    rolling: isRolling(config),
    days,
  });
}

/* ---------------------------------------------------------- the calendars */

export interface BookingCalendarRow {
  id: string;
  name: string;
  color: string;
  primary: boolean;
  owner: boolean;
  selectedInGoogle: boolean;
  shownInCopilot: boolean;
  lock: CalendarLock;
  /** Before any choice here. */
  defaultCounts: boolean;
  /** Now, with the saved choice. */
  counts: boolean;
}

export interface BookingCalendars {
  calendars: BookingCalendarRow[];
  /** Copilot's Calendar-tab toggles for the host, for the default of a switch. */
  shown: Record<string, boolean>;
}

/** The host's calendars, and whether each blocks his time on the link. */
export async function bookingCalendars(
  store: DataStore,
  organizationId: string,
): Promise<Result<BookingCalendars>> {
  const [settings, host] = await Promise.all([
    readBookingSettings(store, organizationId),
    readHost(store, organizationId),
  ]);
  const found = await calendarSource(store, organizationId, host.email ?? '');
  if (!found.ok) return err('not_configured', 'The host’s calendar is not connected.');
  const list = await readCalendarList(found.source, organizationId);
  if (!list.ok) return err('provider_unavailable', 'The host’s calendars could not be read.');
  const prefs = host.userId
    ? await readCalendarPrefs(store, organizationId, host.userId)
    : { shown: {} as Record<string, boolean> };
  const teammates = teammateCalendarIds(await readTeamMembers(store, organizationId), host.userId);
  const context = { shown: prefs.shown, choices: settings.config.calendarChoices, teammates };
  return ok({
    shown: { ...prefs.shown },
    calendars: list.value.calendars.map((c) => ({
      id: c.id,
      name: c.name,
      color: c.color.background,
      primary: c.primary,
      owner: c.accessRole === 'owner',
      selectedInGoogle: c.selectedInGoogle,
      shownInCopilot: prefs.shown[c.id] === true,
      lock: calendarLock(c, teammates),
      defaultCounts: calendarLock(c, teammates) === 'teammate' ? false : countsByDefault(c, prefs.shown),
      counts: calendarCounts(c, context),
    })),
  });
}

/* ------------------------------------------------------------- the status */

/** Whether the host's calendar can take the link's events (calendar editing). */
export async function bookingEditAccess(
  store: DataStore,
  organizationId: string,
): Promise<CalendarEditAccess & { connected: boolean }> {
  const host = await readHost(store, organizationId);
  const found = await calendarSource(store, organizationId, host.email ?? '');
  if (!found.ok) {
    return {
      allowed: false,
      reason: 'Connect Google in Settings first.',
      demo: false,
      connected: false,
    };
  }
  return { ...calendarEditAccess(found.source), connected: true };
}
