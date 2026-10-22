import type { NextRequest } from 'next/server';
import { done, fail, notesGate, readBody } from '@/lib/notes/route-helpers';
import { START_RECORDING } from '@/lib/notes/schemas';
import { getStore } from '@/lib/runtime';
import { meetingView, startRecording } from '@/lib/services/notes';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/**
 * Start recording (StartRecordingRequest → MeetingResponse). Needs the
 * consent step confirmed; a never-record meeting answers 403 with
 * details.never_record.
 */
export async function POST(request: NextRequest, context: Context) {
  const gate = await notesGate(request, { bucket: 'write', max: 120, write: true });
  if (!gate.ok) return gate.response;
  const body = await readBody(request, START_RECORDING);
  if (!body.ok) return body.response;
  const { id } = await context.params;
  const ctx = { store: getStore(), auth: gate.auth };
  const started = await startRecording(ctx, id, body.value);
  return started.ok ? done({ meeting: meetingView(ctx, started.value) }) : fail(started.error);
}
