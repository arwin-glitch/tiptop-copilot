import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { ID_RE } from '@/lib/events/schema';
import { updateMedia } from '@/lib/services/event-media';
import { grantFail, grantGate, grantRespond, readJson } from '../../../_grant';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ eventId: string; mid: string }> };

/** Alt text and "decorative" only: gating a file is an owner decision. */
const BODY = z.strictObject({
  alt: z.string().max(500).nullable().optional(),
  decorative: z.boolean().optional(),
});

export async function PATCH(request: NextRequest, context: Context) {
  const { eventId, mid } = await context.params;
  const gate = await grantGate(request, eventId, { bucket: 'media-edit', max: 60 });
  if (!gate.ok) return gate.response;
  const caps = gate.session.grant.capabilities;
  if (!caps.editContent && !caps.editDesign) {
    return grantFail({
      code: 'forbidden',
      message: 'This link can view the page but not edit it.',
    });
  }
  if (!ID_RE.test(mid)) return grantFail({ code: 'not_found', message: 'That file is not here.' });
  const parsed = BODY.safeParse(await readJson(request, 4096));
  if (!parsed.success) {
    return grantFail({ code: 'invalid_input', message: 'That change could not be read.' });
  }
  const media = await updateMedia(gate.store, gate.actor, eventId, mid, parsed.data);
  return grantRespond(gate, media, (m) => ({
    media: { id: m.id, alt: m.alt, decorative: m.decorative, status: m.status },
  }));
}
