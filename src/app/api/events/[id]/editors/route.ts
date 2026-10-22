import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { eventsAuth, fail, respond } from '@/lib/events/route-helpers';
import { getStore } from '@/lib/runtime';
import {
  createEditorLink,
  listEditorLinks,
  revokeEditorLink,
  updateEditorLink,
} from '@/lib/services/event-editors';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

const scope = z
  .strictObject({
    design: z.boolean().optional(),
    content: z.boolean().optional(),
    sections: z.union([z.literal('all'), z.array(z.string().max(40)).max(60)]).optional(),
    brand_locked: z.boolean().optional(),
  })
  .optional();

const expiry = z
  .union([
    z.strictObject({ days: z.number().int().min(1).max(90) }),
    z.strictObject({ eventEnd: z.literal(true) }),
  ])
  .optional();

const CREATE = z.strictObject({
  label: z.string().max(200),
  email: z.string().max(320).nullable().optional(),
  role: z.enum(['editor', 'viewer', 'checkin']),
  scope,
  expiry,
});

const UPDATE = z.strictObject({
  id: z.string().max(40),
  label: z.string().max(200).optional(),
  email: z.string().max(320).nullable().optional(),
  scope,
  expiry,
});

/** The event's outside links (editors, viewers, check-in staff). Never a hash or secret. */
export async function GET(_request: NextRequest, context: Context) {
  const gate = await eventsAuth('editors', { max: 120, write: false });
  if (!gate.ok) return gate.response;
  const { id } = await context.params;
  const links = await listEditorLinks(getStore(), gate.auth.organizationId, id);
  return respond(links, (list) => ({ links: list }));
}

/**
 * Invite an editor: a personal link, shown ONCE in this response
 * ({ link, path: '/e/edit#k=…' }). Owners copy it or open a draft email in
 * their own mail app; nothing is sent from here.
 */
export async function POST(request: NextRequest, context: Context) {
  const gate = await eventsAuth('editors-write', { max: 30 });
  if (!gate.ok) return gate.response;
  const parsed = CREATE.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return fail({ code: 'invalid_input', message: 'That link could not be read.' });
  const { id } = await context.params;
  const issued = await createEditorLink(getStore(), gate.owner, id, parsed.data);
  return respond(issued, (value) => ({ ...value }));
}

/** Extend, rename or change a link's scope. */
export async function PATCH(request: NextRequest, context: Context) {
  const gate = await eventsAuth('editors-write', { max: 60 });
  if (!gate.ok) return gate.response;
  const parsed = UPDATE.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return fail({ code: 'invalid_input', message: 'That change could not be read.' });
  const { id } = await context.params;
  const { id: linkId, ...patch } = parsed.data;
  const updated = await updateEditorLink(getStore(), gate.owner, id, linkId, patch);
  return respond(updated, (link) => ({ link }));
}

/** Revoke one link: DELETE ?link=<id>. Its sessions end on their next request. */
export async function DELETE(request: NextRequest, context: Context) {
  const gate = await eventsAuth('editors-write', { max: 60 });
  if (!gate.ok) return gate.response;
  const linkId = request.nextUrl.searchParams.get('link') ?? '';
  const { id } = await context.params;
  const revoked = await revokeEditorLink(getStore(), gate.owner, id, linkId);
  return respond(revoked, (link) => ({ link }));
}
