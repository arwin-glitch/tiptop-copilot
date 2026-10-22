import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { eventsAuth, respond } from '@/lib/events/route-helpers';
import { getStore } from '@/lib/runtime';
import { revokeAllEditorLinks } from '@/lib/services/event-editors';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

const BODY = z.strictObject({
  roles: z
    .array(z.enum(['editor', 'viewer', 'checkin']))
    .min(1)
    .max(3)
    .optional(),
});

/** The panic button: every live link of this event stops now. New ones can be made after. */
export async function POST(request: NextRequest, context: Context) {
  const gate = await eventsAuth('editors-write', { max: 10 });
  if (!gate.ok) return gate.response;
  const parsed = BODY.safeParse((await request.json().catch(() => null)) ?? {});
  const { id } = await context.params;
  const result = await revokeAllEditorLinks(
    getStore(),
    gate.owner,
    id,
    parsed.success && parsed.data.roles ? parsed.data.roles : undefined,
  );
  return respond(result, (value) => ({ ...value }));
}
