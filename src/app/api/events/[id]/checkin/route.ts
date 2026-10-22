import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { readHostBody } from '@/lib/events/host-routes';
import { UUID_RE, walkInInput } from '@/lib/events/registration';
import { eventsAuth, fail, respond } from '@/lib/events/route-helpers';
import { getStore } from '@/lib/runtime';
import { addWalkIn, checkInGuest, doorList, type CheckinActor } from '@/lib/services/event-checkin';

/**
 * The Check-in tab for owners (D-075, signed in):
 *   GET  → the door list with live counters per session
 *   POST → { action: 'checkin' | 'undo', guestId, sessionId }
 *        | { action: 'walk_in', firstName, lastName?, email?, company?, sessionId }
 */

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

const uuid = z.string().regex(UUID_RE);
const checkinBody = z.strictObject({
  action: z.enum(['checkin', 'undo']),
  guestId: uuid,
  sessionId: uuid,
});

export async function GET(_request: NextRequest, context: Context) {
  const gate = await eventsAuth('checkin-read', { write: false, max: 240 });
  if (!gate.ok) return gate.response;
  const { id } = await context.params;
  const result = await doorList(getStore(), gate.owner.organizationId, id);
  return respond(result, (list) => ({ list }));
}

export async function POST(request: NextRequest, context: Context) {
  const gate = await eventsAuth('checkin-write', { max: 240 });
  if (!gate.ok) return gate.response;
  const read = await readHostBody(request, 4096);
  if (!read.ok) return read.response;
  const { id } = await context.params;
  const store = getStore();
  const event = await store.get('events', gate.owner.organizationId, id).catch(() => null);
  if (!event) return fail({ code: 'not_found', message: 'That event does not exist.' });
  const actor: CheckinActor = {
    kind: 'owner',
    userId: gate.owner.userId,
    name: gate.owner.name.split(/\s+/)[0] || 'TipTop',
  };
  const raw =
    read.body && typeof read.body === 'object' ? (read.body as Record<string, unknown>) : {};
  if (raw.action === 'walk_in') {
    const { action: _action, ...rest } = raw;
    const parsed = walkInInput.safeParse(rest);
    if (!parsed.success) {
      return fail({
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
    return respond(result, (value) => ({ ...value }));
  }
  const parsed = checkinBody.safeParse(raw);
  if (!parsed.success)
    return fail({ code: 'invalid_input', message: 'That request could not be read.' });
  const result = await checkInGuest(store, event, actor, {
    guestId: parsed.data.guestId,
    sessionId: parsed.data.sessionId,
    undo: parsed.data.action === 'undo',
  });
  return respond(result, (value) => ({ result: value }));
}
