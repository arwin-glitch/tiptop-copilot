import type { NextRequest } from 'next/server';
import { eventsAuth, fail, done } from '@/lib/events/route-helpers';
import { getStore } from '@/lib/runtime';
import { getEvent, getEventSessions } from '@/lib/services/events';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/**
 * One event's settings and sessions (signed in). The page documents are not
 * included: Studio reads the draft from …/draft. PATCH and DELETE land with
 * WS1 part 2 (updateEventSettings, deleteEvent).
 */
export async function GET(_request: NextRequest, context: Context) {
  const gate = await eventsAuth('read', { max: 240, write: false });
  if (!gate.ok) return gate.response;
  const { id } = await context.params;
  const store = getStore();
  const event = await getEvent(store, gate.auth.organizationId, id);
  if (!event.ok) return fail(event.error);
  const sessions = await getEventSessions(store, gate.auth.organizationId, id);
  if (!sessions.ok) return fail(sessions.error);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- dropped on purpose
  const { draft_doc, published_doc, password_hash, ...settings } = event.value;
  return done({ event: settings, sessions: sessions.value });
}
