import type { NextRequest } from 'next/server';
import { done, fail, notesGate, readBody } from '@/lib/notes/route-helpers';
import { SPLIT_SPEAKER } from '@/lib/notes/schemas';
import { getStore } from '@/lib/runtime';
import { splitSpeaker } from '@/lib/services/notes';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/** "From here it's someone else" (SplitSpeakerRequest → SplitSpeakerResponse). */
export async function POST(request: NextRequest, context: Context) {
  const gate = await notesGate(request, { bucket: 'write', max: 120, write: true });
  if (!gate.ok) return gate.response;
  const body = await readBody(request, SPLIT_SPEAKER);
  if (!body.ok) return body.response;
  const { id } = await context.params;
  const result = await splitSpeaker({ store: getStore(), auth: gate.auth }, id, body.value);
  return result.ok ? done({ ...result.value }) : fail(result.error);
}
