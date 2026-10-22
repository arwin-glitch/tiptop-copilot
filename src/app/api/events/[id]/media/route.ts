import type { NextRequest } from 'next/server';
import { eventsAuth, respond } from '@/lib/events/route-helpers';
import { getStore } from '@/lib/runtime';
import { ownerActor } from '@/lib/services/events';
import { listResolvedMedia } from '@/lib/services/event-media';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/** Studio's media library: every item of this event with its URLs and processing status. */
export async function GET(_request: NextRequest, context: Context) {
  const gate = await eventsAuth('media', { max: 240, write: false });
  if (!gate.ok) return gate.response;
  const { id } = await context.params;
  const media = await listResolvedMedia(getStore(), ownerActor(gate.owner), id);
  return respond(media, (list) => ({ media: list }));
}
