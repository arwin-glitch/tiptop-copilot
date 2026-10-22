import 'server-only';
import {
  readCalendarList,
  readCalendarRange,
  type CalendarSource,
} from '@/lib/calendar/range-reader';
import { visibleCalendarIds, type CalendarInfo } from '@/lib/calendar/range-types';
import type { DataStore } from '@/lib/db/store';
import { readCalendarPrefs } from '@/lib/services/calendar-prefs';
import { readTeamMembers } from '@/lib/tasks/principal';
import { err, ok, type Result } from '@/lib/util/result';
import { addDaysToKey, localDateKey } from '@/lib/util/time';
import { calendarZoneDiffers, toBusyPicture } from './busy';
import type { BookingConfig } from './config';
import type { BusyBlock } from './engine';

/**
 * The booking link's one read of the host's calendar, over today and the
 * link's horizon, through the Calendar tab's own reader
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
 * The calendars whose busy time the link reads: the main one, every one he
 * owns, every one ticked in Google, and every one turned on in Copilot. A
 * Copilot toggle set to off never takes one away.
 */
export function bookingCalendarIds(
  calendars: readonly Pick<CalendarInfo, 'id' | 'primary' | 'accessRole' | 'selectedInGoogle'>[],
  shown: Readonly<Record<string, boolean>>,
): string[] {
  const ids = new Set(visibleCalendarIds(calendars, {}));
  for (const c of calendars) {
    if (c.primary || c.accessRole === 'owner' || shown[c.id] === true) ids.add(c.id);
  }
  return calendars.filter((c) => ids.has(c.id)).map((c) => c.id);
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
  inPersonPaused: boolean;
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
  const team = await readTeamMembers(store, organizationId);
  const teammateCalendars = teammateCalendarIds(team, options.principalId);
  const shown = bookingCalendarIds(list.value.calendars, prefs.shown).filter(
    (id) => !teammateCalendars.has(id.toLowerCase()),
  );

  const from = localDateKey(now, hostZone);
  const range = await readCalendarRange(store, organizationId, {
    from,
    to: addDaysToKey(from, config.horizonDays + 2),
    timeZone: hostZone,
    ownEmail: source.ownEmails[0] ?? '',
    calendarIds: shown,
    source,
    now: now.getTime(),
  });
  if (range.state !== 'ok' || range.failed.length > 0) {
    return err('provider_unavailable', 'The host’s calendars could not be read in full.');
  }
  const picture = toBusyPicture(range.events, {
    hostZone,
    ownEmails: source.ownEmails,
    home: { city: config.homeCity, aliases: config.homeAliases, places: config.places },
  });
  return ok({
    ...picture,
    inPersonPaused: calendarZoneDiffers(range.calendars, hostZone, now),
  });
}
