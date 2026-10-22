import type { NextRequest } from 'next/server';
import { eventsAuth, respond } from '@/lib/events/route-helpers';
import { getStore } from '@/lib/runtime';
import { clientAddress } from '@/lib/security/client-address';
import { ownerActor } from '@/lib/services/events';
import { restoreVersion } from '@/lib/services/event-versions';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string; vid: string }> };

/**
 * "Restore as draft" (owners): the current draft is saved first, the version
 * becomes a new draft, and nothing goes live until Publish.
 */
export async function POST(request: NextRequest, context: Context) {
  const gate = await eventsAuth('restore', { max: 20 });
  if (!gate.ok) return gate.response;
  const { id, vid } = await context.params;
  const result = await restoreVersion(getStore(), ownerActor(gate.owner), id, vid, {
    ip: clientAddress(request.headers),
  });
  return respond(result, (r) => ({ ...r }));
}
