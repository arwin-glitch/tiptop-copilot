import type { NextRequest } from 'next/server';
import { readHostBody } from '@/lib/events/host-routes';
import { eventsAuth, respond } from '@/lib/events/route-helpers';
import { getStore } from '@/lib/runtime';
import { addSession } from '@/lib/services/event-registration';

/** POST /api/events/[id]/registration/sessions — add a session (D-075, signed in). */

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: Context) {
  const gate = await eventsAuth('sessions-write', { max: 60 });
  if (!gate.ok) return gate.response;
  const read = await readHostBody(request, 32 * 1024);
  if (!read.ok) return read.response;
  const { id } = await context.params;
  const result = await addSession(getStore(), gate.owner, id, read.body);
  return respond(result, (change) => ({ ...change }));
}
