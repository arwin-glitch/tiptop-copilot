import type { NextRequest } from 'next/server';
import { ID_RE } from '@/lib/events/schema';
import { processMedia, resolveMediaRows } from '@/lib/services/event-media';
import { grantFail, grantGate, grantRespond } from '../../../../_grant';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ eventId: string; mid: string }> };

/** Process an outside editor's finished upload (re-encode, strip EXIF, variants). */
export async function POST(request: NextRequest, context: Context) {
  const { eventId, mid } = await context.params;
  const gate = await grantGate(request, eventId, { bucket: 'process', max: 30 });
  if (!gate.ok) return gate.response;
  if (!gate.session.grant.capabilities.uploadMedia) {
    return grantFail({ code: 'forbidden', message: 'This link cannot add photos or videos.' });
  }
  if (!ID_RE.test(mid)) return grantFail({ code: 'not_found', message: 'That file is not here.' });
  const media = await processMedia(gate.store, gate.actor, eventId, mid);
  if (!media.ok) return grantRespond(gate, media, () => ({}));
  // The same shape the owners' route returns (URLs included). Outsiders never
  // upload gated files, and gated ones are withheld from their links anyway.
  const resolved = await resolveMediaRows([media.value], { withholdGated: true });
  return grantRespond(gate, resolved, (map) => ({ media: map[media.value.id] ?? null }));
}
