import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { readHostBody } from '@/lib/events/host-routes';
import { eventsAuth, fail, respond } from '@/lib/events/route-helpers';
import { getStore } from '@/lib/runtime';
import { bulkGuests, getGuestDetail, updateGuest } from '@/lib/services/event-guests';

/**
 * One guest (D-075, signed in): GET the drawer (status per session, answers,
 * plus-ones, timeline), PATCH their details / host note / tags, DELETE them
 * (hard delete with their plus-ones, audited).
 */

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string; gid: string }> };

const patchBody = z.strictObject({
  first_name: z.string().max(100).nullable().optional(),
  last_name: z.string().max(100).nullable().optional(),
  email: z.string().max(320).nullable().optional(),
  company: z.string().max(200).nullable().optional(),
  title: z.string().max(200).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  host_note: z.string().max(4000).nullable().optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
});

export async function GET(_request: NextRequest, context: Context) {
  const gate = await eventsAuth('guest-read', { write: false });
  if (!gate.ok) return gate.response;
  const { id, gid } = await context.params;
  const result = await getGuestDetail(getStore(), gate.owner.organizationId, id, gid);
  return respond(result, (detail) => ({ detail }));
}

export async function PATCH(request: NextRequest, context: Context) {
  const gate = await eventsAuth('guest-update', { max: 120 });
  if (!gate.ok) return gate.response;
  const read = await readHostBody(request, 32 * 1024);
  if (!read.ok) return read.response;
  const parsed = patchBody.safeParse(read.body);
  if (!parsed.success) {
    return fail({
      code: 'invalid_input',
      message: parsed.error.issues[0]?.message ?? 'Check the details.',
    });
  }
  const { id, gid } = await context.params;
  const result = await updateGuest(getStore(), gate.owner, id, gid, parsed.data);
  return respond(result, (guest) => ({ guest }));
}

export async function DELETE(_request: NextRequest, context: Context) {
  const gate = await eventsAuth('guest-delete', { max: 60 });
  if (!gate.ok) return gate.response;
  const { id, gid } = await context.params;
  const result = await bulkGuests(getStore(), gate.owner, id, {
    action: 'remove',
    guestIds: [gid],
  });
  return respond(result, (outcome) => ({ ...outcome }));
}
