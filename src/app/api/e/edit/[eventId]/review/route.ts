import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { clientAddress } from '@/lib/security/client-address';
import { markReadyForReview } from '@/lib/services/event-editors';
import { grantGate, grantRespond, readJson } from '../../_grant';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ eventId: string }> };

const BODY = z.strictObject({ note: z.string().max(280).nullable().optional() });

/** "Ready for review": tells the owners (Sharing, Today, alerts). Never publishes. */
export async function POST(request: NextRequest, context: Context) {
  const { eventId } = await context.params;
  const gate = await grantGate(request, eventId, { bucket: 'review', max: 10 });
  if (!gate.ok) return gate.response;
  const parsed = BODY.safeParse((await readJson(request, 4096)) ?? {});
  const result = await markReadyForReview(
    gate.store,
    gate.session.grant,
    parsed.success ? (parsed.data.note ?? null) : null,
    clientAddress(request.headers),
  );
  return grantRespond(gate, result, (r) => ({ ...r }));
}
