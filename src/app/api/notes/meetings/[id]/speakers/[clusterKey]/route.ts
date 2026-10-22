import type { NextRequest } from 'next/server';
import { done, fail, notesGate, param, readBody } from '@/lib/notes/route-helpers';
import { refreshNotesAfterRename } from '@/lib/notes/refresh';
import { RELABEL_SPEAKER } from '@/lib/notes/schemas';
import { getStore } from '@/lib/runtime';
import { relabelSpeaker } from '@/lib/services/notes';
import { isClusterKey } from '@/lib/transcribe/cluster';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string; clusterKey: string }> };

/**
 * "This is…" (RelabelSpeakerRequest → RelabelSpeakerResponse): one update,
 * and every line of the voice reads the new name. The key is URI-encoded.
 */
export async function PATCH(request: NextRequest, context: Context) {
  const gate = await notesGate(request, { bucket: 'write', max: 240, write: true });
  if (!gate.ok) return gate.response;
  const body = await readBody(request, RELABEL_SPEAKER);
  if (!body.ok) return body.response;
  const { id, clusterKey } = await context.params;
  const key = param(clusterKey);
  if (!isClusterKey(key))
    return fail({ code: 'invalid_input', message: 'That voice is not valid.' });
  const ctx = { store: getStore(), auth: gate.auth };
  const result = await relabelSpeaker(ctx, id, key, body.value);
  if (!result.ok) return fail(result.error);
  if (result.value.notesRefreshing) await refreshNotesAfterRename(ctx, id);
  return done({ ...result.value });
}
