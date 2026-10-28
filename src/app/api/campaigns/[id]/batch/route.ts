import type { NextRequest } from 'next/server';
import { campaignAuth, fail, respond, trackingOrigin } from '@/lib/campaigns/route-helpers';
import { campaignSenderFor } from '@/lib/campaigns/sender';
import { getStorage, getStore } from '@/lib/runtime';
import { sendBatch } from '@/lib/services/campaigns';
import { getPrimaryIntegration } from '@/lib/services/inbox';

export const dynamic = 'force-dynamic';
// A batch stops starting sends after 25 seconds; this is headroom, not a target.
export const maxDuration = 60;

type Context = { params: Promise<{ id: string }> };

/**
 * The next few emails of a campaign a person already confirmed. Called by
 * that person's open page, one batch after another, and by a later visit's
 * "Continue sending". Does nothing unless the campaign is sending.
 */
export async function POST(_request: NextRequest, context: Context) {
  const gate = await campaignAuth('batch', 60);
  if (!gate.ok) return gate.response;
  const store = getStore();
  const integration = await getPrimaryIntegration(store, gate.auth.organizationId);
  const sender = campaignSenderFor(gate.auth, integration);
  if (!sender.ok) return fail(sender.error, 409);
  const { id } = await context.params;
  const result = await sendBatch(store, gate.auth.organizationId, id, {
    sender: sender.value,
    storage: getStorage(),
    // Null while APP_URL is local: a campaign with Kraken links then refuses.
    appUrl: trackingOrigin(),
  });
  return respond(result, (progress) => ({ progress }));
}
