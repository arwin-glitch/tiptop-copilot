import type { NextRequest } from 'next/server';
import { readHostBody } from '@/lib/events/host-routes';
import { eventsAuth, respond } from '@/lib/events/route-helpers';
import { getStore } from '@/lib/runtime';
import { getRegistration, updateRegistration } from '@/lib/services/event-registration';

/**
 * The Registration tab (D-075, signed in):
 *   GET → access, capacity, registration settings, questions, sessions,
 *         Going per session
 *   PUT → { access?, capacity?, registration?, questions? } (strict; sent
 *         fields replace; a question taken off the form is kept as removed)
 */

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, context: Context) {
  const gate = await eventsAuth('registration-read', { write: false });
  if (!gate.ok) return gate.response;
  const { id } = await context.params;
  const result = await getRegistration(getStore(), gate.owner.organizationId, id);
  return respond(result, (registration) => ({ registration }));
}

export async function PUT(request: NextRequest, context: Context) {
  const gate = await eventsAuth('registration-write', { max: 120 });
  if (!gate.ok) return gate.response;
  const read = await readHostBody(request, 128 * 1024);
  if (!read.ok) return read.response;
  const { id } = await context.params;
  const result = await updateRegistration(getStore(), gate.owner, id, read.body);
  return respond(result, (registration) => ({ registration }));
}
