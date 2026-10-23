import type { NextRequest } from 'next/server';
import { done, fail, notesGate } from '@/lib/notes/route-helpers';
import { getStore } from '@/lib/runtime';
import { revokeShareLink } from '@/lib/services/notes-share';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string; linkId: string }> };

/** Revoke a link: from now on it opens nothing. */
export async function DELETE(request: NextRequest, context: Context) {
  const gate = await notesGate(request, { bucket: 'share', max: 60, write: true });
  if (!gate.ok) return gate.response;
  const { id, linkId } = await context.params;
  const revoked = await revokeShareLink({ store: getStore(), auth: gate.auth }, id, linkId);
  return revoked.ok ? done({ link: revoked.value }) : fail(revoked.error);
}
