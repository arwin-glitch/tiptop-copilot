import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { GRANT_COOKIE } from '@/lib/events/contracts';
import { publicDone, publicFail, publicGate, readJsonBody } from '@/lib/events/public-gate';
import { UUID_RE } from '@/lib/events/registration';
import { getStore } from '@/lib/runtime';
import { checkInGuest, eventForStaff, resolveCheckinActor } from '@/lib/services/event-checkin';

/**
 * POST /api/e/checkin/<eventId>/checkin — one-tap check-in or undo from the
 * door list (D-075), for a staff link or an owner. { guestId, sessionId, undo? }.
 */

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ eventId: string }> };

const body = z.strictObject({
  guestId: z.string().regex(UUID_RE),
  sessionId: z.string().regex(UUID_RE),
  undo: z.boolean().optional(),
});

export async function POST(request: NextRequest, context: Context) {
  const { eventId } = await context.params;
  const gate = publicGate(request, {
    limits: [{ bucket: 'ev-door-checkin', max: 240, windowMs: 60_000 }],
  });
  if (!gate.ok) return gate.response;
  const store = getStore();
  const event = await eventForStaff(store, eventId);
  if (!event) return publicFail({ code: 'not_found', message: 'This link is not valid.' });
  const actor = await resolveCheckinActor(store, event, request.cookies.get(GRANT_COOKIE)?.value);
  if (!actor) return publicFail({ code: 'not_found', message: 'This link is not valid.' });
  const read = await readJsonBody(request, 1024);
  if (!read.ok) return publicFail(read.error);
  const parsed = body.safeParse(read.body);
  if (!parsed.success)
    return publicFail({ code: 'invalid_input', message: 'That request could not be read.' });
  const result = await checkInGuest(store, event, actor, parsed.data);
  if (!result.ok) return publicFail(result.error);
  return publicDone({ result: result.value });
}
