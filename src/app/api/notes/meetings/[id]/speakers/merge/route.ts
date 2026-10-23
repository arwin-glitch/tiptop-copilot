import type { NextRequest } from 'next/server';
import { done, fail, notesGate, readBody } from '@/lib/notes/route-helpers';
import { refreshNotesAfterRename } from '@/lib/notes/refresh';
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
  const ctx = { store: getStore(), auth: gate.auth };
  const result = await mergeSpeakers(ctx, id, body.value.from, body.value.into);
  if (!result.ok) return fail(result.error);
  // Action items owned by the merged-away voice now belong to the one it joined.
  if (result.value.notesRefreshing) {
    await refreshNotesAfterRename(ctx, id, new Map([[body.value.from, body.value.into]]));
  }
  return done({ ...result.value });
}
