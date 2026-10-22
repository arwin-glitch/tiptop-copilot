import type { NextRequest } from 'next/server';
import { getDraft } from '@/lib/services/events';
import { grantGate, grantRespond } from '../../_grant';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ eventId: string }> };

/** The draft for an outside editor or viewer link (re-checked on this request). */
export async function GET(request: NextRequest, context: Context) {
  const { eventId } = await context.params;
  const gate = await grantGate(request, eventId, { bucket: 'draft', max: 120 });
  if (!gate.ok) return gate.response;
  const draft = await getDraft(gate.store, gate.actor, eventId);
  return grantRespond(gate, draft, (snapshot) => ({ ...snapshot }));
}
