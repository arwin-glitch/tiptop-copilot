import type { NextRequest } from 'next/server';
import { readSyncQuery } from '@/lib/events/editor/sync-query';
import { done, eventsAuth, respond } from '@/lib/events/route-helpers';
import { getStore } from '@/lib/runtime';
import { removePresence, syncStudio } from '@/lib/services/event-presence';
import { ownerActor } from '@/lib/services/events';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/**
 * Studio's sync poll for signed-in owners: GET ?since=n&focus=<section>&typing=1
 * → DraftSyncResult (changed sections, deletions, theme, page settings and
 * who is here). Upserts the caller's presence row on the way.
 */
export async function GET(request: NextRequest, context: Context) {
  const gate = await eventsAuth('sync', { max: 240, write: false });
  if (!gate.ok) return gate.response;
  const { id } = await context.params;
  const query = readSyncQuery(request.nextUrl.searchParams);
  const result = await syncStudio(
    getStore(),
    ownerActor(gate.owner),
    id,
    query.since,
    query.presence,
  );
  return respond(result, (r) => ({ ...r }));
}

/** Leaving Studio (a pagehide beacon): drop the caller's presence row. */
export async function POST(_request: NextRequest, context: Context) {
  const gate = await eventsAuth('sync-leave', { max: 60, write: false });
  if (!gate.ok) return gate.response;
  const { id } = await context.params;
  await removePresence(getStore(), ownerActor(gate.owner), id).catch(() => undefined);
  return done();
}
