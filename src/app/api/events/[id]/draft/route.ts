import type { NextRequest } from 'next/server';
import { eventsAuth, respond } from '@/lib/events/route-helpers';
import { getStore } from '@/lib/runtime';
import { getDraft, ownerActor } from '@/lib/services/events';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/** The draft document Studio edits, with its draft_version (signed-in owners). */
export async function GET(_request: NextRequest, context: Context) {
  const gate = await eventsAuth('draft', { max: 240, write: false });
  if (!gate.ok) return gate.response;
  const { id } = await context.params;
  const draft = await getDraft(getStore(), ownerActor(gate.owner), id);
  return respond(draft, (snapshot) => ({ ...snapshot }));
}
