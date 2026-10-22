import type { NextRequest } from 'next/server';
import { readSyncQuery } from '@/lib/events/editor/sync-query';
import { removePresence, syncStudio } from '@/lib/services/event-presence';
import { grantDone, grantGate, grantRespond } from '../../_grant';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ eventId: string }> };

/**
 * The outside editor's sync poll: GET ?since=n&focus=<section>&typing=1.
 * Every poll re-checks the link, so a revoke, a regenerate or an expiry ends
 * the session on the next poll (about 2 seconds).
 */
export async function GET(request: NextRequest, context: Context) {
  const { eventId } = await context.params;
  const gate = await grantGate(request, eventId, { bucket: 'sync', max: 120 });
  if (!gate.ok) return gate.response;
  const query = readSyncQuery(request.nextUrl.searchParams);
  const result = await syncStudio(gate.store, gate.actor, eventId, query.since, query.presence);
  return grantRespond(gate, result, (r) => ({ ...r }));
}

/** Leaving Studio (a pagehide beacon): drop this link's presence row. */
export async function POST(request: NextRequest, context: Context) {
  const { eventId } = await context.params;
  const gate = await grantGate(request, eventId, { bucket: 'leave', max: 30 });
  if (!gate.ok) return gate.response;
  await removePresence(gate.store, gate.actor, eventId).catch(() => undefined);
  return grantDone(gate, {});
}
