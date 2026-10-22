import type { NextRequest } from 'next/server';
import { eventsAuth, respond } from '@/lib/events/route-helpers';
import { getStore } from '@/lib/runtime';
import { regenerateEditorLink } from '@/lib/services/event-editors';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string; gid: string }> };

/**
 * A new link for the same person, shown once: the old one stops working and
 * every session claimed with it ends on its next request.
 */
export async function POST(_request: NextRequest, context: Context) {
  const gate = await eventsAuth('editors-write', { max: 30 });
  if (!gate.ok) return gate.response;
  const { id, gid } = await context.params;
  const issued = await regenerateEditorLink(getStore(), gate.owner, id, gid);
  return respond(issued, (value) => ({ ...value }));
}
