import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { campaignAuth, fail, respond, trackingOrigin } from '@/lib/campaigns/route-helpers';
import { campaignSenderFor } from '@/lib/campaigns/sender';
import { getStorage, getStore } from '@/lib/runtime';
import { sendTest } from '@/lib/services/campaigns';
import { getPrimaryIntegration } from '@/lib/services/inbox';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

const BODY = z.object({ recipientId: z.string().max(64).nullish() });

/**
 * "Send test to me": one email, to the signed-in person only, from a tap.
 * Marked [Test]; its tracked links and pixel go through Copilot like the real
 * email's, and record nothing.
 */
export async function POST(request: NextRequest, context: Context) {
  const gate = await campaignAuth('test', 10);
  if (!gate.ok) return gate.response;
  const parsed = BODY.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return fail({ code: 'invalid_input', message: 'That test was not valid.' });
  const store = getStore();
  const integration = await getPrimaryIntegration(store, gate.auth.organizationId);
  const sender = campaignSenderFor(gate.auth, integration);
  if (!sender.ok) return fail(sender.error, 409);
  const { id } = await context.params;
  const result = await sendTest(store, gate.auth.organizationId, id, {
    sender: sender.value,
    storage: getStorage(),
    appUrl: trackingOrigin(),
    to: gate.auth.profile.email,
    actor: { userId: gate.auth.userId },
    recipientId: parsed.data.recipientId ?? null,
  });
  return respond(result, (r) => ({ ...r, demo: sender.value.kind === 'demo' }));
}
