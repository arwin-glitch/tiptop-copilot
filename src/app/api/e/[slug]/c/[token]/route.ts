import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { GRANT_COOKIE } from '@/lib/events/contracts';
import { publicDone, publicFail, publicGate, readJsonBody } from '@/lib/events/public-gate';
import { UUID_RE } from '@/lib/events/registration';
import { GUEST_TOKEN_RE } from '@/lib/events/tokens';
import { getStore } from '@/lib/runtime';
import { checkInGuest, qrPerson, resolveCheckinActor } from '@/lib/services/event-checkin';
import { resolveCheckinToken, resolvePublicEvent } from '@/lib/services/event-public';

/**
 * POST /api/e/<slug>/c/<token> — check in the person a ticket's QR names
 * (D-075). Owners (a Copilot session in this organization) and staff links
 * (the grant cookie, role 'checkin') only; anyone else gets a 403 (or, for
 * the landing page's status probe, an empty answer) and keeps seeing the
 * ticket. A GET of the QR URL never checks
 * anyone in.
 *
 *   { action: 'status' }                         → who this is, per session
 *   { action: 'checkin', sessionId, party? }      → check in (and their plus-ones)
 *   { action: 'undo', sessionId }                 → undo
 */

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ slug: string; token: string }> };

const body = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('status') }),
  z.strictObject({
    action: z.literal('checkin'),
    sessionId: z.string().regex(UUID_RE),
    party: z.boolean().optional(),
  }),
  z.strictObject({ action: z.literal('undo'), sessionId: z.string().regex(UUID_RE) }),
]);

const NOT_FOUND = { code: 'not_found' as const, message: 'This code is not valid.' };

export async function POST(request: NextRequest, context: Context) {
  const { slug, token } = await context.params;
  if (!GUEST_TOKEN_RE.test(token)) return publicFail(NOT_FOUND);
  const gate = publicGate(request, { limits: [{ bucket: 'ev-qr', max: 240, windowMs: 60_000 }] });
  if (!gate.ok) return gate.response;
  const store = getStore();
  const resolved = await resolvePublicEvent(store, slug, { personal: true });
  if (resolved.kind !== 'event') return publicFail(NOT_FOUND);
  const actor = await resolveCheckinActor(
    store,
    resolved.event,
    request.cookies.get(GRANT_COOKIE)?.value,
  );
  const read = await readJsonBody(request, 2048);
  if (!read.ok) return publicFail(read.error);
  const parsed = body.safeParse(read.body);
  if (!parsed.success)
    return publicFail({ code: 'invalid_input', message: 'That request could not be read.' });
  if (!actor) {
    // The landing page's quiet "am I staff?" probe: no, and nothing else.
    if (parsed.data.action === 'status') return publicDone({ person: null, staff: null });
    return publicFail({
      code: 'forbidden',
      message: 'Only the host and door staff can check people in.',
    });
  }
  const guest = await resolveCheckinToken(store, resolved.event, token);
  if (!guest) return publicFail(NOT_FOUND);

  if (parsed.data.action === 'status') {
    const person = await qrPerson(store, resolved.event, resolved.sessions, guest.guest);
    return publicDone({ person, staff: actor.name, timeZone: resolved.event.time_zone });
  }
  const action = parsed.data;
  const undo = action.action === 'undo';
  const sessionId = action.sessionId;
  const result = await checkInGuest(store, resolved.event, actor, {
    guestId: guest.guest.id,
    sessionId,
    undo,
  });
  if (!result.ok) return publicFail(result.error);
  const party: Awaited<ReturnType<typeof checkInGuest>>[] = [];
  if (action.action === 'checkin' && action.party && !guest.guest.parent_guest_id) {
    const person = await qrPerson(store, resolved.event, resolved.sessions, guest.guest);
    const pending = person.sessions.find((s) => s.sessionId === sessionId)?.partyPending ?? [];
    for (const id of pending) {
      party.push(await checkInGuest(store, resolved.event, actor, { guestId: id, sessionId }));
    }
  }
  const person = await qrPerson(store, resolved.event, resolved.sessions, guest.guest);
  return publicDone({
    result: result.value,
    partyCheckedIn: party.filter((p) => p.ok && p.value.state === 'checked_in').length,
    person,
    staff: actor.name,
    timeZone: resolved.event.time_zone,
  });
}
