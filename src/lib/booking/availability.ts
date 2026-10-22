import 'server-only';
import {
  readCalendarList,
  readCalendarRange,
  type CalendarSource,
} from '@/lib/calendar/range-reader';
import { visibleCalendarIds } from '@/lib/calendar/range-types';
import type { DataStore } from '@/lib/db/store';
import { readCalendarPrefs } from '@/lib/services/calendar-prefs';
import { err, ok, type Result } from '@/lib/util/result';
import { addDaysToKey, localDateKey } from '@/lib/util/time';
import { calendarZoneDiffers, toBusyPicture } from './busy';
import type { BookingConfig } from './config';
import type { BusyBlock } from './engine';

/**
 * The booking link's one read of the host's calendar: every calendar
 * Copilot shows for him (his own toggles on the Calendar tab, else Google's
 * ticks, and always his main calendar, so personal and family calendars
 * count), over today and the link's horizon, through the Calendar tab's own
 * reader (lib/calendar/range-reader.ts; cached a minute, so a burst of page
 * views asks Google once).
 *
 * What comes back is busy intervals and travel days only (lib/booking/busy.ts).
 * A calendar that could not be read makes the whole read fail: a slot is
 * never offered from part of the calendar.
 */

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
  const shown = new Set(visibleCalendarIds(list.value.calendars, prefs.shown));
  for (const c of list.value.calendars) if (c.primary) shown.add(c.id);

  const from = localDateKey(now, hostZone);
  const range = await readCalendarRange(store, organizationId, {
    from,
    to: addDaysToKey(from, config.horizonDays + 2),
    timeZone: hostZone,
    ownEmail: source.ownEmails[0] ?? '',
    calendarIds: [...shown],
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
