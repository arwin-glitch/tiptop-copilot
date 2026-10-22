import type { CalendarInfo } from '@/lib/calendar/range-types';
import type { CalendarChoice } from './config';

/**
 * Which of the host's calendars block his time on the booking link (Booking
 * tab > Calendars, D-078). Pure and client-safe: the server's busy read
 * (lib/booking/availability.ts) and the tab's list use the same answer.
 *
 * By default: his main calendar, every calendar he owns (personal, family),
 * every one ticked in Google Calendar, and any turned on in Copilot's
 * Calendar tab (a Calendar-tab toggle only ever adds one, so hiding a family
 * calendar from the view never opens its time to the public). A choice made
 * on the Calendars tab overrides that default either way, with two fixed
 * exceptions: his main calendar always counts, and a teammate's own calendar
 * (the assistant's, shared with him) never does.
 */

type CalendarFields = Pick<CalendarInfo, 'id' | 'primary' | 'accessRole' | 'selectedInGoogle'>;

export type CalendarLock = 'main' | 'teammate' | null;

/** Whether a calendar counts before anyone chooses. */
export function countsByDefault(
  calendar: CalendarFields,
  shown: Readonly<Record<string, boolean>>,
): boolean {
  // A Calendar-tab toggle set to off never takes one away.
  return (
    calendar.primary ||
    calendar.accessRole === 'owner' ||
    calendar.selectedInGoogle ||
    shown[calendar.id] === true
  );
}

/** Why a calendar cannot be switched: his main one always counts, a teammate's never does. */
export function calendarLock(calendar: CalendarFields, teammates: ReadonlySet<string>): CalendarLock {
  if (calendar.primary) return 'main';
  if (teammates.has(calendar.id.trim().toLowerCase())) return 'teammate';
  return null;
}

export interface ChoiceContext {
  /** Copilot's Calendar-tab toggles for the host. */
  shown: Readonly<Record<string, boolean>>;
  /** What the Calendars tab saved. */
  choices: readonly CalendarChoice[];
  /** Teammates' main calendar ids (their sign-in addresses), lower case. */
  teammates: ReadonlySet<string>;
}

/** Whether a calendar counts now: the lock, else the saved choice, else the default. */
export function calendarCounts(calendar: CalendarFields, context: ChoiceContext): boolean {
  const lock = calendarLock(calendar, context.teammates);
  if (lock === 'main') return true;
  if (lock === 'teammate') return false;
  const chosen = context.choices.find((c) => c.id === calendar.id);
  return chosen ? chosen.counts : countsByDefault(calendar, context.shown);
}

/** The ids whose busy time the link reads, in the calendar list's order. */
export function countingCalendarIds(
  calendars: readonly CalendarFields[],
  context: ChoiceContext,
): string[] {
  return calendars.filter((c) => calendarCounts(c, context)).map((c) => c.id);
}

/**
 * The saved choices after one switch: a calendar set back to its default is
 * dropped from the list, so the list holds only real overrides.
 */
export function chooseCalendar(
  choices: readonly CalendarChoice[],
  calendar: CalendarFields,
  counts: boolean,
  shown: Readonly<Record<string, boolean>>,
): CalendarChoice[] {
  const rest = choices.filter((c) => c.id !== calendar.id);
  if (calendar.primary) return rest;
  return countsByDefault(calendar, shown) === counts ? rest : [...rest, { id: calendar.id, counts }];
}
