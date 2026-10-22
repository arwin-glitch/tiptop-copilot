import type { NextRequest } from 'next/server';
import { done, fail, notesGate, readBody } from '@/lib/notes/route-helpers';
import { STOP_RECORDING } from '@/lib/notes/schemas';
import { getStore } from '@/lib/runtime';
import { loadMeeting, meetingView, stopRecording } from '@/lib/services/notes';
import { finalizeMeeting } from '@/lib/services/notes-generate';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/**
 * Stop recording and run the notes job (StopRecordingRequest →
 * StopRecordingResponse). Recorder only; post the last lines first.
 */
export async function POST(request: NextRequest, context: Context) {
  const gate = await notesGate(request, { bucket: 'write', max: 60, write: true });
  if (!gate.ok) return gate.response;
  const body = await readBody(request, STOP_RECORDING);
  if (!body.ok) return body.response;
  const { id } = await context.params;
  const ctx = { store: getStore(), auth: gate.auth };
  const stopped = await stopRecording(ctx, id, body.value);
  if (!stopped.ok) return fail(stopped.error);
  const finalized = await finalizeMeeting(ctx, id);
  const after = await loadMeeting(ctx, id);
  return done({
    meeting: meetingView(ctx, after.ok ? after.value : stopped.value),
    finalize: { queued: finalized.ok },
  });
}
