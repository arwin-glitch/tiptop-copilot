import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { eventsAuth, fail, respond } from '@/lib/events/route-helpers';
import { getStore } from '@/lib/runtime';
import { ownerActor } from '@/lib/services/events';
import { createUploadUrl } from '@/lib/services/event-media';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

const BODY = z
  .object({
    kind: z.enum(['image', 'video', 'logo', 'file']),
    contentType: z.string().max(120),
    bytes: z.number().int().min(1),
    name: z.string().max(400),
    gated: z.boolean().optional(),
    width: z.number().int().optional(),
    height: z.number().int().optional(),
    durationMs: z.number().int().optional(),
  })
  .strict();

/**
 * Step 1 of an upload: a signed URL the browser PUTs the file to directly
 * (never through Copilot). Step 2 is …/media/[mid]/process.
 */
export async function POST(request: NextRequest, context: Context) {
  const gate = await eventsAuth('media-upload', { max: 60 });
  if (!gate.ok) return gate.response;
  const parsed = BODY.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return fail({ code: 'invalid_input', message: 'That upload could not be read.' });
  const { id } = await context.params;
  const ticket = await createUploadUrl(getStore(), ownerActor(gate.owner), id, parsed.data);
  return respond(ticket, (t) => ({ ...t }));
}
