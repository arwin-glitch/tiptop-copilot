import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { eventsAuth, fail, respond } from '@/lib/events/route-helpers';
import { getStore } from '@/lib/runtime';
import { setEditingPaused } from '@/lib/services/event-editors';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

const BODY = z.strictObject({ paused: z.boolean() });

/** Pause (or resume) editing for every outside editor of this event. Reversible. */
export async function POST(request: NextRequest, context: Context) {
  const gate = await eventsAuth('editors-write', { max: 30 });
  if (!gate.ok) return gate.response;
  const parsed = BODY.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail({ code: 'invalid_input', message: 'Say paused or not.' });
  const { id } = await context.params;
  const result = await setEditingPaused(getStore(), gate.owner, id, parsed.data.paused);
  return respond(result, (value) => ({ ...value }));
}
