import type { NextRequest } from 'next/server';
import { eventsAuth, respond } from '@/lib/events/route-helpers';
import { ID_RE } from '@/lib/events/schema';
import { getStore } from '@/lib/runtime';
import { listActivity } from '@/lib/services/event-presence';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/**
 * Who changed what (event_edits), for Studio's per-section Activity panel
 * (?section=<id>) and the publish dialog's authors (?since=<draft version>).
 * Keys and names only, never values. Signed-in owners.
 */
export async function GET(request: NextRequest, context: Context) {
  const gate = await eventsAuth('activity', { max: 120, write: false });
  if (!gate.ok) return gate.response;
  const { id } = await context.params;
  const params = request.nextUrl.searchParams;
  const section = params.get('section');
  const since = Number(params.get('since') ?? '');
  const result = await listActivity(getStore(), gate.auth.organizationId, id, {
    sectionId: section && ID_RE.test(section) ? section : null,
    sinceVersion: Number.isSafeInteger(since) && since >= 0 ? since : undefined,
    limit: 200,
  });
  return respond(result, (entries) => ({ entries }));
}
