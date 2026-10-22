import type { NextRequest } from 'next/server';
import { eventsAuth, fail, respond } from '@/lib/events/route-helpers';
import { getStore } from '@/lib/runtime';
import { ownerActor } from '@/lib/services/events';
import { processMedia, resolveMediaRows } from '@/lib/services/event-media';

export const dynamic = 'force-dynamic';
/** Re-encoding a large photo to six sizes takes a few seconds. */
export const maxDuration = 60;

type Context = { params: Promise<{ id: string; mid: string }> };

/**
 * Step 2 of an upload: re-encode the uploaded original (EXIF stripped,
 * AVIF/WebP sizes, thumbhash, colours) and return the item with its URLs.
 */
export async function POST(_request: NextRequest, context: Context) {
  const gate = await eventsAuth('media-process', { max: 60 });
  if (!gate.ok) return gate.response;
  const { id, mid } = await context.params;
  const processed = await processMedia(getStore(), ownerActor(gate.owner), id, mid);
  if (!processed.ok) return fail(processed.error);
  const resolved = await resolveMediaRows([processed.value]);
  return respond(resolved, (map) => ({ media: map[processed.value.id] ?? null }));
}
