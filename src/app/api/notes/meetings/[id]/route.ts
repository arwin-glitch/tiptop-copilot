import type { NextRequest } from 'next/server';
import { done, fail, notesGate, readBody } from '@/lib/notes/route-helpers';
import { UPDATE_MEETING } from '@/lib/notes/schemas';
import { getStore } from '@/lib/runtime';
import { deleteMeeting, getMeetingDetail, meetingView, updateMeeting } from '@/lib/services/notes';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/** Everything the meeting page shows (MeetingDetailResponse). */
export async function GET(request: NextRequest, context: Context) {
  const gate = await notesGate(request, { bucket: 'read', max: 240 });
  if (!gate.ok) return gate.response;
  const { id } = await context.params;
  const detail = await getMeetingDetail({ store: getStore(), auth: gate.auth }, id);
  return detail.ok ? done({ ...detail.value }) : fail(detail.error);
}

/** Rename, file, re-template, share with teammates, or save the notepad (UpdateMeetingRequest). */
export async function PATCH(request: NextRequest, context: Context) {
  const gate = await notesGate(request, { bucket: 'write', max: 240, write: true });
  if (!gate.ok) return gate.response;
  const body = await readBody(request, UPDATE_MEETING);
  if (!body.ok) return body.response;
  const { id } = await context.params;
  const ctx = { store: getStore(), auth: gate.auth };
  const updated = await updateMeeting(ctx, id, body.value);
  return updated.ok ? done({ meeting: meetingView(ctx, updated.value) }) : fail(updated.error);
}

/** Move the meeting to the trash. Recorder only. */
export async function DELETE(request: NextRequest, context: Context) {
  const gate = await notesGate(request, { bucket: 'write', max: 120, write: true });
  if (!gate.ok) return gate.response;
  const { id } = await context.params;
  const removed = await deleteMeeting({ store: getStore(), auth: gate.auth }, id);
  return removed.ok ? done() : fail(removed.error);
}
