import type { NextRequest } from 'next/server';
import { readHostBody } from '@/lib/events/host-routes';
import { eventsAuth, respond } from '@/lib/events/route-helpers';
import { getStore } from '@/lib/runtime';
import { removeSession, updateSession } from '@/lib/services/event-registration';

/**
 * One session (D-075, signed in): PATCH its name, times, venue override,
 * capacity, approval/waitlist overrides or tag visibility (a time or venue
 * change bumps the ICS SEQUENCE and reports how many Going guests an update
 * notice would reach); DELETE it (?confirm=1 when guests have a status there;
 * every event keeps at least one session).
 */

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string; sid: string }> };

export async function PATCH(request: NextRequest, context: Context) {
  const gate = await eventsAuth('sessions-write', { max: 120 });
  if (!gate.ok) return gate.response;
  const read = await readHostBody(request, 32 * 1024);
  if (!read.ok) return read.response;
  const { id, sid } = await context.params;
  const result = await updateSession(getStore(), gate.owner, id, sid, read.body);
  return respond(result, (change) => ({ ...change }));
}

export async function DELETE(request: NextRequest, context: Context) {
  const gate = await eventsAuth('sessions-write', { max: 60 });
  if (!gate.ok) return gate.response;
  const { id, sid } = await context.params;
  const result = await removeSession(getStore(), gate.owner, id, sid, {
    confirm: request.nextUrl.searchParams.get('confirm') === '1',
  });
  return respond(result, (removed) => ({ ...removed }));
}
