import type { NextRequest } from 'next/server';
import { done, fail, notesGate, readBody } from '@/lib/notes/route-helpers';
import { LIST_SEGMENTS_QUERY, UPLOAD_SEGMENTS } from '@/lib/notes/schemas';
import { getStore } from '@/lib/runtime';
import { listSegments, uploadSegments } from '@/lib/services/notes';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/** Lines after ?after=<seq>, for a viewer polling a live meeting (ListSegmentsResponse). */
export async function GET(request: NextRequest, context: Context) {
  const gate = await notesGate(request, { bucket: 'poll', max: 600 });
  if (!gate.ok) return gate.response;
  const query = LIST_SEGMENTS_QUERY.safeParse(
    Object.fromEntries(request.nextUrl.searchParams.entries()),
  );
  if (!query.success)
    return fail({ code: 'invalid_input', message: 'That request was not valid.' });
  const { id } = await context.params;
  const listed = await listSegments({ store: getStore(), auth: gate.auth }, id, query.data);
  return listed.ok ? done({ ...listed.value }) : fail(listed.error);
}

/**
 * Finished lines from the recorder (UploadSegmentsRequest →
 * UploadSegmentsResponse): at most 200, upserted on seq, so a retry is safe.
 */
export async function POST(request: NextRequest, context: Context) {
  const gate = await notesGate(request, { bucket: 'segments', max: 240, write: true });
  if (!gate.ok) return gate.response;
  const body = await readBody(request, UPLOAD_SEGMENTS);
  if (!body.ok) return body.response;
  const { id } = await context.params;
  const stored = await uploadSegments(
    { store: getStore(), auth: gate.auth },
    id,
    body.value.segments,
  );
  return stored.ok ? done({ ...stored.value }) : fail(stored.error);
}
