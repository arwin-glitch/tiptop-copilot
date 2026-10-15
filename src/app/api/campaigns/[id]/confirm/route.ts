import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { campaignAuth, fail, respond, trackingOrigin } from '@/lib/campaigns/route-helpers';
import { campaignSenderFor } from '@/lib/campaigns/sender';
import { getStore } from '@/lib/runtime';
import { confirmCampaign } from '@/lib/services/campaigns';
import { getPrimaryIntegration } from '@/lib/services/inbox';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/** What the review screen showed, sent back so the server can refuse anything else. */
const BODY = z.object({
  version: z.string().min(1).max(64),
  recipients: z.number().int().min(1).max(100_000),
  subject: z.string().max(300),
  from: z.enum(['nick', 'arwin']),
  track: z.boolean(),
  unsubscribe: z.boolean(),
});

/**
 * The tap on Send, from the review screen. Starts the campaign (it moves to
 * "sending") only if sending is turned on and the campaign is exactly what was
 * reviewed; the page then sends it in batches while it stays open.
 */
export async function POST(request: NextRequest, context: Context) {
  const gate = await campaignAuth('confirm', 10);
  if (!gate.ok) return gate.response;
  const parsed = BODY.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return fail({ code: 'invalid_input', message: 'Review the campaign again before sending.' });
  }
  const store = getStore();
  // Refuse before starting anything if this mailbox cannot send.
  const integration = await getPrimaryIntegration(store, gate.auth.organizationId);
  const sender = campaignSenderFor(gate.auth, integration);
  if (!sender.ok) return fail(sender.error, 409);
  const { id } = await context.params;
  const confirmed = await confirmCampaign(
    store,
    gate.auth.organizationId,
    id,
    { userId: gate.auth.userId },
    parsed.data,
    { appUrl: trackingOrigin() },
  );
  return respond(confirmed, (c) => ({ campaign: c }));
}
