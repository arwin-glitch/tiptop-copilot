import type { NextRequest } from 'next/server';
import { GRANT_COOKIE } from '@/lib/events/contracts';
import { publicDone, publicFail, publicGate } from '@/lib/events/public-gate';
import { getStore } from '@/lib/runtime';
import { doorList, eventForStaff, resolveCheckinActor } from '@/lib/services/event-checkin';

/**
 * GET /api/e/checkin/<eventId>/guests — the door list (D-075) for a staff
 * link's holder or an owner: names, companies, badges and check-in times of
 * Going guests, live counters per session. Never emails, notes or links.
 */

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ eventId: string }> };

export async function GET(request: NextRequest, context: Context) {
  const { eventId } = await context.params;
  const gate = publicGate(request, {
    write: false,
    limits: [{ bucket: 'ev-door-list', max: 120, windowMs: 60_000 }],
  });
  if (!gate.ok) return gate.response;
  const store = getStore();
  const event = await eventForStaff(store, eventId);
  if (!event) return publicFail({ code: 'not_found', message: 'This link is not valid.' });
  const actor = await resolveCheckinActor(store, event, request.cookies.get(GRANT_COOKIE)?.value);
  if (!actor) return publicFail({ code: 'not_found', message: 'This link is not valid.' });
  const list = await doorList(store, event.organization_id, event.id);
  if (!list.ok) return publicFail(list.error);
  return publicDone({ list: list.value, staff: actor.name });
}
