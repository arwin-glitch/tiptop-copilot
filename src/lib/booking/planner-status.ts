import type { PreviewKey, ReasonCode } from './engine';
import { dateLabel, monthShort } from './months';

/**
 * The Booking tab's plain-words layer over the engine (D-078): what each
 * "no times" reason is called on a chip, the Overview's status checks, and
 * the "Why no times?" summary of the next two weeks. Pure and client-safe.
 */

/** A preview reason: the engine's rule, or in person switched off as a whole. */
export type PreviewCode = ReasonCode | 'in_person_off';

export interface PreviewPlan {
  /** Open start times, RFC 3339 instants. */
  times: string[];
  reason: string | null;
  code: PreviewCode | null;
}

export interface PreviewDay {
  date: string;
  plans: Record<PreviewKey, PreviewPlan>;
}

export const PREVIEW_KEYS: readonly PreviewKey[] = ['call', 'coffee', 'lunch', 'dinner'];

export const PREVIEW_LABEL: Record<PreviewKey, string> = {
  call: 'Calls',
  coffee: 'Coffee',
  lunch: 'Lunch',
  dinner: 'Dinner',
};

export type ReasonTone = 'muted' | 'closed' | 'busy' | 'warn';

/** Each reason's chip: a few words, and how loud it is. */
export const REASON_CHIP: Record<PreviewCode, { label: string; tone: ReasonTone }> = {
  past: { label: 'Passed', tone: 'muted' },
  weekday: { label: 'Not a meeting day', tone: 'muted' },
  month_closed: { label: 'Month off', tone: 'closed' },
  date_closed: { label: 'Day closed', tone: 'closed' },
  not_open: { label: 'Too far ahead', tone: 'closed' },
  hours: { label: 'Outside the hours', tone: 'muted' },
  notice: { label: 'Too soon (notice)', tone: 'muted' },
  in_person_paused: { label: 'In person paused', tone: 'warn' },
  away: { label: 'Away or travelling', tone: 'warn' },
  link_cap: { label: 'Link cap reached', tone: 'busy' },
  meeting_cap: { label: 'Day is full', tone: 'busy' },
  busy: { label: 'Fully busy', tone: 'busy' },
  waiting: { label: 'Held for a request', tone: 'busy' },
  stack: { label: 'Back-to-back stack', tone: 'busy' },
  in_person_off: { label: 'In person off', tone: 'warn' },
};

/** How many open times a day has across the kinds (calls and in person). */
export function openCount(day: PreviewDay, keys: readonly PreviewKey[] = PREVIEW_KEYS): number {
  return keys.reduce((n, key) => n + day.plans[key].times.length, 0);
}

/**
 * The one reason that closes a whole day, when every kind is closed for the
 * same rule (a Monday, a closed month, a day away for in person and busy for
 * calls is not one); null when the day offers something or the kinds differ.
 */
export function dayWideReason(day: PreviewDay): { code: PreviewCode; reason: string } | null {
  if (openCount(day) > 0) return null;
  const call = day.plans.call;
  if (!call.code || !call.reason) return null;
  const wide: PreviewCode[] = ['past', 'weekday', 'month_closed', 'date_closed', 'not_open'];
  if (!wide.includes(call.code)) return null;
  const same = PREVIEW_KEYS.every((k) => {
    const code = day.plans[k].code;
    return code === call.code || code === 'in_person_off';
  });
  return same ? { code: call.code, reason: call.reason } : null;
}

export type CheckState = 'ok' | 'warn' | 'off';

export interface StatusCheck {
  key: 'link' | 'editing' | 'profile' | 'places' | 'times' | 'months';
  state: CheckState;
  title: string;
  detail: string;
  /** Where to fix it, a Booking tab subtab key or an absolute path. */
  fix?: { label: string; href: string };
}

export interface StatusInput {
  enabled: boolean;
  editing: { allowed: boolean; demo: boolean; connected: boolean };
  profile: { displayName: string; title: string; bio: string };
  inPersonOffered: boolean;
  /** Open times over the next two weeks, or null while unknown. */
  nextTwoWeeks: { calls: number; inPerson: number } | null;
  /** The months switched on, from this month on, in order. */
  openMonths: string[];
  /** Today, host zone. */
  today: string;
  /** The last open month's last day; null when none is open. */
  lastOpenDay: string | null;
}

/** "Nov, Dec and Mar 2027": the open months in a few words (the year when it is not this one). */
export function openMonthsLabel(months: readonly string[], today: string): string {
  const year = today.slice(0, 4);
  const names = months.map((m) =>
    m.slice(0, 4) === year ? monthShort(m) : `${monthShort(m)} ${m.slice(0, 4)}`,
  );
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** The Overview's checks, in order: anything that would leave the page empty or half set up. */
export function statusChecks(input: StatusInput): StatusCheck[] {
  const checks: StatusCheck[] = [];
  checks.push(
    input.enabled
      ? { key: 'link', state: 'ok', title: 'Link is on', detail: 'Anyone with it can book.' }
      : {
          key: 'link',
          state: 'off',
          title: 'Link is off',
          detail: 'The page says it is not taking bookings.',
        },
  );
  checks.push(
    input.editing.allowed
      ? {
          key: 'editing',
          state: 'ok',
          title: 'Calendar editing is on',
          detail: input.editing.demo
            ? 'The demo calendar takes bookings at once.'
            : 'Bookings go on the calendar and the invites go out at once.',
        }
      : {
          key: 'editing',
          state: 'warn',
          title: 'Calendar editing is off',
          detail: input.editing.connected
            ? 'Bookings are held until it is on, then go on the calendar by themselves.'
            : 'Connect Google first: bookings are held until then.',
          fix: { label: 'Turn it on', href: '/settings?tab=integrations' },
        },
  );
  const profileDone = Boolean(
    input.profile.displayName.trim() && (input.profile.title.trim() || input.profile.bio.trim()),
  );
  checks.push(
    profileDone
      ? {
          key: 'profile',
          state: 'ok',
          title: 'Profile filled in',
          detail: 'Name and a line about him.',
        }
      : {
          key: 'profile',
          state: 'warn',
          title: 'Profile not filled in',
          detail: 'Add a name and a title or a short bio.',
          fix: { label: 'Profile', href: 'profile' },
        },
  );
  checks.push(
    input.inPersonOffered
      ? { key: 'places', state: 'ok', title: 'Places set', detail: 'In person is offered.' }
      : {
          key: 'places',
          state: 'warn',
          title: 'No places yet',
          detail: 'Only calls are offered until a home city and a place are set.',
          fix: { label: 'Places', href: 'places' },
        },
  );
  if (input.nextTwoWeeks) {
    const { calls, inPerson } = input.nextTwoWeeks;
    checks.push(
      calls + inPerson > 0
        ? {
            key: 'times',
            state: 'ok',
            title: 'Open times in the next 2 weeks',
            detail: `${calls} call${calls === 1 ? '' : 's'} and ${inPerson} in person.`,
          }
        : {
            key: 'times',
            state: 'warn',
            title: 'No open times in the next 2 weeks',
            detail: 'See “Why no times?” below for each day.',
          },
    );
  }
  if (!input.openMonths.length || !input.lastOpenDay) {
    checks.push({
      key: 'months',
      state: 'warn',
      title: 'No month is open',
      detail: 'Switch a month on so people can book.',
      fix: { label: 'Availability', href: 'availability' },
    });
  } else {
    const endsSoon = daysBetweenKeys(input.today, input.lastOpenDay) <= 14;
    checks.push({
      key: 'months',
      state: endsSoon ? 'warn' : 'ok',
      title: `Open: ${openMonthsLabel(input.openMonths, input.today)}`,
      detail: endsSoon
        ? `Nothing after ${dateLabel(input.lastOpenDay)}. Switch on the next month.`
        : 'Only these months offer times. Switch any month on or off under Availability.',
      fix: endsSoon ? { label: 'Availability', href: 'availability' } : undefined,
    });
  }
  return checks;
}

function daysBetweenKeys(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
}

/** Open times over some days, calls and in person apart. */
export function countOpen(days: readonly PreviewDay[]): { calls: number; inPerson: number } {
  let calls = 0;
  let inPerson = 0;
  for (const day of days) {
    calls += day.plans.call.times.length;
    inPerson +=
      day.plans.coffee.times.length + day.plans.lunch.times.length + day.plans.dinner.times.length;
  }
  return { calls, inPerson };
}
