import type { NextRequest } from 'next/server';
import { eventsAuth, fail, respond } from '@/lib/events/route-helpers';
import { getStore } from '@/lib/runtime';
import { clientAddress } from '@/lib/security/client-address';
import { applyDraftOps, ownerActor } from '@/lib/services/events';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/** Draft batches are small; anything bigger is not Studio talking. */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * Apply a batch of Studio ops to the draft (signed-in owners):
 * { baseVersion, ops[] } → { version, applied[], conflicts[], changes }.
 * Validation, capability checks and the per-key merge all happen in the
 * service (lib/services/events.ts → lib/events/merge.ts). Outside editors
 * use the scoped proxy under /api/e/edit (WS3), never this route.
 */
export async function POST(request: NextRequest, context: Context) {
  const gate = await eventsAuth('ops', { max: 240 });
  if (!gate.ok) return gate.response;
  const raw = await request.text().catch(() => '');
  if (raw.length > MAX_BODY_BYTES) {
    return fail({ code: 'too_large', message: 'That batch of changes is too large.' });
  }
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail({ code: 'invalid_input', message: 'Those changes could not be read.' });
  }
  const { id } = await context.params;
  const result = await applyDraftOps(getStore(), ownerActor(gate.owner), id, body, {
    ip: clientAddress(request.headers),
  });
  return respond(result, (r) => ({ ...r }));
}
