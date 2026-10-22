import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { eventsAuth, fail, respond } from '@/lib/events/route-helpers';
import { getStore } from '@/lib/runtime';
import { updateEventComms } from '@/lib/services/event-comms';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

const BODY = z.strictObject({
  reminderOffsetsMinutes: z.array(z.number().int()).max(6).optional(),
  sender: z.enum(['nick', 'arwin']).optional(),
});

/**
 * An event's messages settings (signed-in members): when reminder drafts fall
 * due ({ reminderOffsetsMinutes }) and who signs event messages by default
 * ({ sender }). Changes events.comms only; nothing is drafted or sent.
 */
export async function PUT(request: NextRequest, context: Context) {
  const gate = await eventsAuth('campaign-settings', { max: 60 });
  if (!gate.ok) return gate.response;
  const parsed = BODY.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return fail({ code: 'invalid_input', message: 'Those settings could not be read.' });
  }
  const { id } = await context.params;
  const result = await updateEventComms(getStore(), gate.owner, id, parsed.data);
  return respond(result, (comms) => ({ comms }));
}
