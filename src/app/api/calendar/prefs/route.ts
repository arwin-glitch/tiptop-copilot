import type { NextRequest } from 'next/server';
import { calendarAuth, done, fail } from '@/lib/calendar/route-auth';
import { getStore } from '@/lib/runtime';
import { CALENDAR_PREFS_PATCH, saveCalendarPrefs } from '@/lib/services/calendar-prefs';

export const dynamic = 'force-dynamic';

/**
 * Remember a person's Calendar tab choices: the new views on or off, the
 * view they were on, the calendars they toggled. Their own settings only;
 * nothing here reaches Google.
 */
export async function POST(request: NextRequest) {
  const gate = await calendarAuth(request, { bucket: 'prefs', max: 120, write: true });
  if (!gate.ok) return gate.response;
  const parsed = CALENDAR_PREFS_PATCH.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return fail({ code: 'invalid_input', message: 'That setting is not valid.' });
  const saved = await saveCalendarPrefs(
    getStore(),
    gate.auth.organizationId,
    gate.auth.userId,
    parsed.data,
  );
  return saved.ok ? done({ prefs: saved.value }) : fail(saved.error);
}
