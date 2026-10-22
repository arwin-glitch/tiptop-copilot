import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { eventsAuth, fail, respond } from '@/lib/events/route-helpers';
import { getStore } from '@/lib/runtime';
import { cancelEvent } from '@/lib/services/events';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

const BODY = z.object({ message: z.string().max(2000).nullable().optional() }).strict();

/**
 * Cancel: the page stays live as a "Cancelled" notice with the host's
 * message. Telling guests is a campaign draft a person reviews and sends.
 */
export async function POST(request: NextRequest, context: Context) {
  const gate = await eventsAuth('cancel', { max: 20 });
  if (!gate.ok) return gate.response;
  const parsed = BODY.safeParse((await request.json().catch(() => null)) ?? {});
  if (!parsed.success)
    return fail({ code: 'invalid_input', message: 'That message could not be read.' });
  const { id } = await context.params;
  const result = await cancelEvent(getStore(), gate.owner, id, parsed.data.message ?? null);
  return respond(result, (event) => ({
    event: { id: event.id, status: event.status, cancelledAt: event.cancelled_at },
  }));
}
