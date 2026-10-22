import 'server-only';
import {
  readCalendarList,
  readCalendarRange,
  type CalendarSource,
} from '@/lib/calendar/range-reader';
import type { CalendarInfo, RangeEvent } from '@/lib/calendar/range-types';
import type { DataStore } from '@/lib/db/store';
import { readCalendarPrefs } from '@/lib/services/calendar-prefs';
import { readTeamMembers } from '@/lib/tasks/principal';
import { err, ok, type Result } from '@/lib/util/result';
import { addDaysToKey, localDateKey } from '@/lib/util/time';
import { inPersonPausedThrough, toBusyPicture } from './busy';
import { countingCalendarIds } from './calendar-choices';
import type { BookingConfig } from './config';
import type { BusyBlock } from './engine';
import { lastOpenDay } from './months';

/**
 * The booking link's one read of the host's calendar, over today through
 * the end of the last month the link is open for (D-078), through the
 * Calendar tab's own reader
 * (lib/calendar/range-reader.ts; cached a minute, so a burst of page views
 * asks Google once).
 *
 * Which calendars (bookingCalendarIds): his main calendar, every calendar he
 * owns, every calendar ticked in Google Calendar, and any calendar he turned
 * on in Copilot's Calendar tab. A toggle there only ever adds one: hiding a
 * personal or family calendar from the view never opens its time to the
 * public page.
 *
 * What comes back is busy intervals and travel days only (lib/booking/busy.ts).
 * A calendar that could not be read makes the whole read fail: a slot is
 * never offered from part of the calendar.
 */

/**
 * The calendars whose busy time the link reads, before any choice on the
 * Booking tab's Calendars list: the main one, every one he owns, every one
 * ticked in Google, and every one turned on in Copilot. A Copilot toggle set
 * to off never takes one away (lib/booking/calendar-choices.ts).
 */
export function bookingCalendarIds(
  calendars: readonly Pick<CalendarInfo, 'id' | 'primary' | 'accessRole' | 'selectedInGoogle'>[],
  shown: Readonly<Record<string, boolean>>,
): string[] {
  return countingCalendarIds(calendars, { shown, choices: [], teammates: new Set() });
}

/** The calendar reader takes at most this many days at once: longer windows go in parts. */
export const READ_CHUNK_DAYS = 60;

/** `from` to `to` (exclusive day keys) as parts of at most READ_CHUNK_DAYS days. */
export function readChunks(from: string, to: string): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  for (let start = from; start < to; ) {
    const next = addDaysToKey(start, READ_CHUNK_DAYS);
    const end = next < to ? next : to;
    out.push({ from: start, to: end });
    start = end;
  }
  return out;
}

/**
 * The main calendars of the organization's other members, by their sign-in
 * address (a Google main calendar's id is its owner's address).
 */
export function teammateCalendarIds(
  team: readonly { userId: string; email: string | null }[],
  principalId: string | null,
): Set<string> {
  return new Set(
    team
      .filter((m) => m.userId !== principalId && m.email)
      .map((m) => (m.email as string).trim().toLowerCase()),
  );
}

export interface BusyRead {
  busy: BusyBlock[];
  travelDays: Set<string>;
  /**
   * The main calendar is set to another zone (lib/booking/busy.ts
   * inPersonPausedThrough): in person paused through this host-zone day
   * (his next flight home lands), or every day ('all'); null when not.
   */
  inPersonPausedThrough: string | 'all' | null;
}

export async function busyPictureFor(
  store: DataStore,
  organizationId: string,
  options: {
    source: CalendarSource;
    hostZone: string;
    principalId: string | null;
    config: BookingConfig;
    now: Date;
  },
): Promise<Result<BusyRead>> {
  const { source, hostZone, config, now } = options;
  const list = await readCalendarList(source, organizationId, now.getTime());
  if (!list.ok) return err('provider_unavailable', 'The host’s calendars could not be read.');
  const prefs = options.principalId
    ? await readCalendarPrefs(store, organizationId, options.principalId)
    : { shown: {} };
  // A teammate's own calendar (the assistant's, shared with the host) is
  // their day, not the host's: it never counts toward the host's busy time,
  // even when he owns it, ticked it in Google or turned it on in Copilot.
  // The Booking tab's Calendars list may add or drop any other.
  const team = await readTeamMembers(store, organizationId);
  const teammateCalendars = teammateCalendarIds(team, options.principalId);
  const shown = countingCalendarIds(list.value.calendars, {
    shown: prefs.shown,
    choices: config.calendarChoices,
    teammates: teammateCalendars,
  });

  // Today through the end of the last open month, and a day more (an entry
  // the evening before the next day still says he travels), in parts the
  // reader takes; an entry in two parts is one entry (toBusyPicture).
  const from = localDateKey(now, hostZone);
  const last = lastOpenDay(config, from);
  const to = addDaysToKey(last, 2);
  const events: RangeEvent[] = [];
  let calendars: CalendarInfo[] = [];
  for (const part of readChunks(from, to)) {
    const range = await readCalendarRange(store, organizationId, {
      from: part.from,
      to: part.to,
      timeZone: hostZone,
      ownEmail: source.ownEmails[0] ?? '',
      calendarIds: shown,
      source,
      now: now.getTime(),
    });
    if (range.state !== 'ok' || range.failed.length > 0) {
      return err('provider_unavailable', 'The host’s calendars could not be read in full.');
    }
    events.push(...range.events);
    if (!calendars.length) calendars = range.calendars;
  }
  const range = { events, calendars };
  const picture = toBusyPicture(range.events, {
    hostZone,
    ownEmails: source.ownEmails,
    home: { city: config.homeCity, aliases: config.homeAliases, places: config.places },
  });
  return ok({
    busy: picture.busy,
    travelDays: picture.travelDays,
    inPersonPausedThrough: inPersonPausedThrough(range.calendars, picture.homeLandings, {
      hostZone,
      now,
      // The pause looks for his flight home as far as the link is open.
      horizonDays: Math.round(
        (Date.parse(`${last}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000,
      ),
    }),
  });
}
