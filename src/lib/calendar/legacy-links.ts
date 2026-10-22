import { isDateKey } from './grid';
import { CALENDAR_VIEWS, type CalendarViewKind } from './range-types';

/**
 * The retired day list's addresses (D-072): `/calendar?view=list` and
 * `/calendar?day=YYYY-MM-DD` (old bookmarks, pings and pages linked to them)
 * now open the Day view on that date. Pure: the page redirects to what this
 * returns, keeping any other parameters (a tour, say) as they were.
 */

type Params = Record<string, string | string[] | undefined>;

const one = (value: string | string[] | undefined) =>
  typeof value === 'string' ? value : Array.isArray(value) ? value[0] : undefined;

/**
 * Where an old day-list address goes now, or null for an address that is
 * not one: a `day` (a date, else today) in Day view, or in the view the
 * address also names.
 */
export function legacyCalendarHref(params: Params): string | null {
  const view = one(params.view);
  const day = one(params.day);
  if (view !== 'list' && day === undefined) return null;
  const date = one(params.date);
  const named = CALENDAR_VIEWS.includes(view as CalendarViewKind);
  const on = isDateKey(day) ? day : isDateKey(date) ? date : null;
  return hrefWith(params, named ? (view as CalendarViewKind) : 'day', on);
}

function hrefWith(params: Params, view: CalendarViewKind, date: string | null): string {
  const out = new URLSearchParams({ view });
  if (date) out.set('date', date);
  for (const [key, value] of Object.entries(params)) {
    if (key === 'view' || key === 'day' || key === 'date' || value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) out.append(key, v);
  }
  return `/calendar?${out}`;
}
