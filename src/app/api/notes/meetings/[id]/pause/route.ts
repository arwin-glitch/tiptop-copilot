import type { NextRequest } from 'next/server';
import { done, fail, notesGate, readBody } from '@/lib/notes/route-helpers';
import { PAUSE_RECORDING } from '@/lib/notes/schemas';
import { getStore } from '@/lib/runtime';
import { meetingView, pauseRecording } from '@/lib/services/notes';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/** Pause or resume (PauseRecordingRequest → MeetingResponse). Recorder only. */
export async function POST(request: NextRequest, context: Context) {
  const gate = await notesGate(request, { bucket: 'write', max: 120, write: true });
  if (!gate.ok) return gate.response;
  const body = await readBody(request, PAUSE_RECORDING);
  if (!body.ok) return body.response;
  const { id } = await context.params;
  const ctx = { store: getStore(), auth: gate.auth };
  const changed = await pauseRecording(ctx, id, body.value.paused);
  return changed.ok ? done({ meeting: meetingView(ctx, changed.value) }) : fail(changed.error);
}
