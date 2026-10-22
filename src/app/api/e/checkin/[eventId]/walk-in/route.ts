import type { NextRequest } from 'next/server';
import { GRANT_COOKIE } from '@/lib/events/contracts';
import { publicDone, publicFail, publicGate, readJsonBody } from '@/lib/events/public-gate';
import { walkInInput } from '@/lib/events/registration';
import { getStore } from '@/lib/runtime';
import { addWalkIn, eventForStaff, resolveCheckinActor } from '@/lib/services/event-checkin';

/**
 * POST /api/e/checkin/<eventId>/walk-in — add someone at the door (D-075):
 * Going (past capacity if need be) and checked in at once. Staff or owner.
 */

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ eventId: string }> };

export async function POST(request: NextRequest, context: Context) {
  const { eventId } = await context.params;
  const gate = publicGate(request, {
    limits: [{ bucket: 'ev-walk-in', max: 60, windowMs: 60_000 }],
  });
  if (!gate.ok) return gate.response;
  const store = getStore();
  const event = await eventForStaff(store, eventId);
  if (!event) return publicFail({ code: 'not_found', message: 'This link is not valid.' });
  const actor = await resolveCheckinActor(store, event, request.cookies.get(GRANT_COOKIE)?.value);
  if (!actor) return publicFail({ code: 'not_found', message: 'This link is not valid.' });
  const read = await readJsonBody(request, 2048);
  if (!read.ok) return publicFail(read.error);
  const parsed = walkInInput.safeParse(read.body);
  if (!parsed.success) {
    return publicFail({
      code: 'invalid_input',
      message: parsed.error.issues[0]?.message ?? 'Check the details.',
    });
  }
  const result = await addWalkIn(store, event, actor, {
    firstName: parsed.data.firstName,
    lastName: parsed.data.lastName ?? null,
    email: parsed.data.email || null,
    company: parsed.data.company ?? null,
    sessionId: parsed.data.sessionId,
  });
  if (!result.ok) return publicFail(result.error);
  return publicDone({ guestId: result.value.guestId, merged: result.value.merged });
}
