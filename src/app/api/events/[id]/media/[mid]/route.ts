import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { eventsAuth, fail, respond } from '@/lib/events/route-helpers';
import { getStore } from '@/lib/runtime';
import { ownerActor } from '@/lib/services/events';
import { deleteMedia, resolveMediaRows, updateMedia } from '@/lib/services/event-media';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string; mid: string }> };

const BODY = z
  .object({
    alt: z.string().max(500).nullable().optional(),
    decorative: z.boolean().optional(),
    gated: z.boolean().optional(),
    posterMediaId: z.string().max(40).nullable().optional(),
  })
  .strict();

/** Alt text, decorative, a video's poster, and who may see it (gated). */
export async function PATCH(request: NextRequest, context: Context) {
  const gate = await eventsAuth('media-update', { max: 120 });
  if (!gate.ok) return gate.response;
  const parsed = BODY.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return fail({ code: 'invalid_input', message: 'That change could not be read.' });
  const { id, mid } = await context.params;
  const updated = await updateMedia(getStore(), ownerActor(gate.owner), id, mid, parsed.data);
  if (!updated.ok) return fail(updated.error);
  const resolved = await resolveMediaRows([updated.value]);
  return respond(resolved, (map) => ({ media: map[updated.value.id] ?? null }));
}

/** Delete an item the page no longer uses. */
export async function DELETE(_request: NextRequest, context: Context) {
  const gate = await eventsAuth('media-delete', { max: 60 });
  if (!gate.ok) return gate.response;
  const { id, mid } = await context.params;
  const deleted = await deleteMedia(getStore(), ownerActor(gate.owner), id, mid);
  return respond(deleted, () => ({}));
}
