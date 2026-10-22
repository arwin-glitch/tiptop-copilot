import type { NextRequest } from 'next/server';
import { eventsAuth, respond } from '@/lib/events/route-helpers';
import { getStore } from '@/lib/runtime';
import { archiveEvent } from '@/lib/services/events';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/** Archive: off the public web and into Past. Nothing is deleted. */
export async function POST(_request: NextRequest, context: Context) {
  const gate = await eventsAuth('archive', { max: 20 });
  if (!gate.ok) return gate.response;
  const { id } = await context.params;
  const result = await archiveEvent(getStore(), gate.owner, id);
  return respond(result, (event) => ({ event: { id: event.id, status: event.status } }));
}
