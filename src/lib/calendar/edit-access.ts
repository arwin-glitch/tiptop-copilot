import 'server-only';
import { CALENDAR_EDIT_SCOPES } from '@/lib/google/send-scopes';
import type { Integration } from '@/lib/types/domain';
import type { CalendarSource } from './range-reader';

/**
 * Whether the Calendar tab may change events: the opt-in "Turn on calendar
 * editing" grant (the event scope in send-scopes.ts), or the demo's in-memory
 * calendar, which nothing outside this server sees. Read by the page to show
 * or explain the edit controls, and by lib/calendar/write.ts to refuse.
 */

export function canEditCalendar(integration: Integration | null): boolean {
  return Boolean(integration && CALENDAR_EDIT_SCOPES.every((s) => integration.scopes.includes(s)));
}

export interface CalendarEditAccess {
  allowed: boolean;
  /** Why not, for the page to explain; null when allowed. */
  reason: string | null;
  /** The demo's in-memory calendar: edits stay on this server. */
  demo: boolean;
}

export const EDITING_OFF_MESSAGE =
  'Calendar editing is off. Turn on calendar editing to create and change events here; until then the calendar is view-only.';

export function calendarEditAccess(
  source: Pick<CalendarSource, 'provider' | 'integration' | 'demo'>,
): CalendarEditAccess {
  if (source.demo) {
    // Only ever the in-memory mock: demo mode never holds a Google token.
    return source.provider.kind === 'mock'
      ? { allowed: true, reason: null, demo: true }
      : { allowed: false, reason: EDITING_OFF_MESSAGE, demo: true };
  }
  if (!source.integration) {
    return { allowed: false, reason: 'Connect Google in Settings first.', demo: false };
  }
  if (!canEditCalendar(source.integration)) {
    return { allowed: false, reason: EDITING_OFF_MESSAGE, demo: false };
  }
  return { allowed: true, reason: null, demo: false };
}
