import type { NextRequest } from 'next/server';
import { done, fail, notesGate, readBody } from '@/lib/notes/route-helpers';
import { STOP_RECORDING } from '@/lib/notes/schemas';
import { getStore } from '@/lib/runtime';
import { guard, loadMeeting, meetingView, stopRecording } from '@/lib/services/notes';
import { withinOrAfter } from '@/lib/notes/background';
import { finalizeMeeting } from '@/lib/services/notes-generate';

/** How long Stop waits for the notes before answering; the rest finishes after the response. */
const FINALIZE_BUDGET_MS = 20_000;

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
  // A second Stop (a double click, a retry) starts no second notes job.
  const before = await guard('read the meeting', () =>
    loadMeeting(ctx, id, { recorderOnly: true }),
  );
  if (before.ok && (before.value.status === 'processing' || before.value.status === 'ready')) {
    return done({
      meeting: meetingView(ctx, before.value),
      finalize: { queued: before.value.status === 'processing' },
    });
  }
  const stopped = await stopRecording(ctx, id, body.value);
  if (!stopped.ok) return fail(stopped.error);
  // The naming pass and the notes (a model call): wait a while, then let
  // them finish after answering; the meeting reads 'processing' until then.
  const job = finalizeMeeting(ctx, id);
  const settled = await withinOrAfter('write the notes', job, FINALIZE_BUDGET_MS);
  const finalized = settled ? await job : null;
  const after = await loadMeeting(ctx, id);
  return done({
    meeting: meetingView(ctx, after.ok ? after.value : stopped.value),
    finalize: { queued: finalized ? finalized.ok : true },
  });
}
