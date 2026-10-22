import type { NextRequest } from 'next/server';
import { done, fail, notesGate, readBody } from '@/lib/notes/route-helpers';
import { CREATE_MEETING, LIST_MEETINGS_QUERY } from '@/lib/notes/schemas';
import { getStore } from '@/lib/runtime';
import { createMeeting, meetingView } from '@/lib/services/notes';
import { listMeetings } from '@/lib/services/notes-search';

export const dynamic = 'force-dynamic';

/** The Notes tab's list, with search hits when `q` is given (ListMeetingsResponse). */
export async function GET(request: NextRequest) {
  const gate = await notesGate(request, { bucket: 'read', max: 240 });
  if (!gate.ok) return gate.response;
  const params = Object.fromEntries(request.nextUrl.searchParams.entries());
  const query = LIST_MEETINGS_QUERY.safeParse(params);
  if (!query.success) return fail({ code: 'invalid_input', message: 'That search was not valid.' });
  const listed = await listMeetings({ store: getStore(), auth: gate.auth }, query.data);
  return listed.ok ? done({ ...listed.value }) : fail(listed.error);
}

/** Make a meeting from a calendar event or ad hoc (CreateMeetingRequest → CreateMeetingResponse). */
export async function POST(request: NextRequest) {
  const gate = await notesGate(request, { bucket: 'write', max: 120, write: true });
  if (!gate.ok) return gate.response;
  const body = await readBody(request, CREATE_MEETING);
  if (!body.ok) return body.response;
  const ctx = { store: getStore(), auth: gate.auth };
  const made = await createMeeting(ctx, body.value);
  if (!made.ok) return fail(made.error);
  return done({ meeting: meetingView(ctx, made.value.meeting), created: made.value.created });
}
