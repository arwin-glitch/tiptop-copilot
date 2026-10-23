import type { NextRequest } from 'next/server';
import { done, fail, notesGate, readBody } from '@/lib/notes/route-helpers';
import { EDIT_SEGMENT } from '@/lib/notes/schemas';
import { getStore } from '@/lib/runtime';
import { editSegment } from '@/lib/services/notes';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string; seq: string }> };

/** Fix a line in place (EditSegmentRequest → EditSegmentResponse); the original is kept. */
export async function PATCH(request: NextRequest, context: Context) {
  const gate = await notesGate(request, { bucket: 'write', max: 240, write: true });
  if (!gate.ok) return gate.response;
  const body = await readBody(request, EDIT_SEGMENT);
  if (!body.ok) return body.response;
  const { id, seq } = await context.params;
  const n = Number(seq);
  if (!Number.isInteger(n) || n < 0) {
    return fail({ code: 'invalid_input', message: 'That line number is not valid.' });
  }
  const edited = await editSegment({ store: getStore(), auth: gate.auth }, id, n, body.value.text);
  return edited.ok ? done({ segment: edited.value }) : fail(edited.error);
}
