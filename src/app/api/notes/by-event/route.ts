import type { NextRequest } from 'next/server';
import { done, fail, notesGate } from '@/lib/notes/route-helpers';
import { EVENT_NOTES_QUERY } from '@/lib/notes/schemas';
import { getStore } from '@/lib/runtime';
import { eventNotes } from '@/lib/services/notes-search';

export const dynamic = 'force-dynamic';

/**
 * What the calendar's event card shows (EventNotesResponse): this person's
 * meeting for the event, earlier meetings of a recurring series, and past
 * notes with these guests.
 */
export async function GET(request: NextRequest) {
  const gate = await notesGate(request, { bucket: 'read', max: 240 });
  if (!gate.ok) return gate.response;
  const query = EVENT_NOTES_QUERY.safeParse(
    Object.fromEntries(request.nextUrl.searchParams.entries()),
  );
  if (!query.success) return fail({ code: 'invalid_input', message: 'That event was not valid.' });
  const found = await eventNotes(
    { store: getStore(), auth: gate.auth },
    {
      eventId: query.data.eventId,
      recurringEventId: query.data.recurringEventId ?? null,
      emails: query.data.emails,
    },
  );
  return found.ok ? done({ ...found.value }) : fail(found.error);
}
