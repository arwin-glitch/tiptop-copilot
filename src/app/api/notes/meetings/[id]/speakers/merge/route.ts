import type { NextRequest } from 'next/server';
import { done, fail, notesGate, readBody } from '@/lib/notes/route-helpers';
import { MERGE_SPEAKERS } from '@/lib/notes/schemas';
import { getStore } from '@/lib/runtime';
import { mergeSpeakers } from '@/lib/services/notes';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/** Two voices are one person (MergeSpeakersRequest → MergeSpeakersResponse). */
export async function POST(request: NextRequest, context: Context) {
  const gate = await notesGate(request, { bucket: 'write', max: 120, write: true });
  if (!gate.ok) return gate.response;
  const body = await readBody(request, MERGE_SPEAKERS);
  if (!body.ok) return body.response;
  const { id } = await context.params;
  const result = await mergeSpeakers(
    { store: getStore(), auth: gate.auth },
    id,
    body.value.from,
    body.value.into,
  );
  return result.ok ? done({ ...result.value }) : fail(result.error);
}
