import type { NextRequest } from 'next/server';
import { done, fail, notesGate, readBody } from '@/lib/notes/route-helpers';
import { CREATE_SHARE_LINK } from '@/lib/notes/schemas';
import { getStore } from '@/lib/runtime';
import { createShareLink, listShareLinks } from '@/lib/services/notes-share';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/** The meeting's share links (ListShareLinksResponse). */
export async function GET(request: NextRequest, context: Context) {
  const gate = await notesGate(request, { bucket: 'read', max: 240 });
  if (!gate.ok) return gate.response;
  const { id } = await context.params;
  const links = await listShareLinks({ store: getStore(), auth: gate.auth }, id);
  return links.ok ? done({ links: links.value }) : fail(links.error);
}

/** A new link (CreateShareLinkRequest → CreateShareLinkResponse). The URL is shown once. */
export async function POST(request: NextRequest, context: Context) {
  const gate = await notesGate(request, { bucket: 'share', max: 30, write: true });
  if (!gate.ok) return gate.response;
  const body = await readBody(request, CREATE_SHARE_LINK);
  if (!body.ok) return body.response;
  const { id } = await context.params;
  const made = await createShareLink({ store: getStore(), auth: gate.auth }, id, body.value);
  return made.ok ? done({ ...made.value }) : fail(made.error);
}
