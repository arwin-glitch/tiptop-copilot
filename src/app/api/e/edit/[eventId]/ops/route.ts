import type { NextRequest } from 'next/server';
import { clientAddress } from '@/lib/security/client-address';
import { rateLimit } from '@/lib/security/limits';
import { applyDraftOps } from '@/lib/services/events';
import { grantFail, grantGate, grantRespond, readJson } from '../../_grant';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ eventId: string }> };

const MAX_BODY_BYTES = 256 * 1024;
/** Outsider writes: 120 ops a minute per link. */
const OUTSIDER_OPS_PER_MINUTE = 120;

/**
 * An outside editor's batch of draft ops. The same service as owners, with a
 * grant actor: merge.ts refuses (403-style 'forbidden' conflicts) any op on a
 * section, key or brand lock outside the link's scope, and the service
 * refuses everything while editing is paused. Settings, registration,
 * guests and publishing are not reachable from here at all.
 */
export async function POST(request: NextRequest, context: Context) {
  const { eventId } = await context.params;
  const gate = await grantGate(request, eventId, { bucket: 'ops-req', max: 60 });
  if (!gate.ok) return gate.response;
  if (!gate.session.grant.capabilities.editContent && !gate.session.grant.capabilities.editDesign) {
    return grantFail({
      code: 'forbidden',
      message: 'This link can view the page but not edit it.',
    });
  }
  const body = await readJson(request, MAX_BODY_BYTES);
  if (!body)
    return grantFail({ code: 'invalid_input', message: 'Those changes could not be read.' });
  const count = Array.isArray((body as { ops?: unknown }).ops)
    ? Math.min(50, (body as { ops: unknown[] }).ops.length)
    : 1;
  for (let i = 0; i < Math.max(1, count); i++) {
    const limited = rateLimit(
      `event-grant-ops:${gate.session.grant.grantId}`,
      OUTSIDER_OPS_PER_MINUTE,
      60_000,
    );
    if (!limited.ok) return grantFail(limited.error);
  }
  const result = await applyDraftOps(gate.store, gate.actor, eventId, body, {
    ip: clientAddress(request.headers),
  });
  return grantRespond(gate, result, (r) => ({ ...r }));
}
