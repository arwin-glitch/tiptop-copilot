import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { eventsAuth, fail, respond } from '@/lib/events/route-helpers';
import { getStore } from '@/lib/runtime';
import { duplicateEvent } from '@/lib/services/events';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

const BODY = z
  .object({
    shiftDays: z.number().int().min(-3660).max(3660).default(0),
    title: z.string().max(140).optional(),
    asTemplate: z.boolean().optional(),
  })
  .strict();

/**
 * "Duplicate", "Duplicate as next year" (shiftDays 364 keeps the weekday) and
 * "Save as template" (asTemplate): a new draft; guests, versions and edit
 * links are never copied.
 */
export async function POST(request: NextRequest, context: Context) {
  const gate = await eventsAuth('duplicate', { max: 20 });
  if (!gate.ok) return gate.response;
  const parsed = BODY.safeParse((await request.json().catch(() => null)) ?? {});
  if (!parsed.success)
    return fail({ code: 'invalid_input', message: 'That copy could not be read.' });
  const { id } = await context.params;
  const copy = await duplicateEvent(getStore(), gate.owner, id, parsed.data);
  return respond(copy, (event) => ({ id: event.id, slug: event.slug }));
}
