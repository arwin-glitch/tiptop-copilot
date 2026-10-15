import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { campaignAuth, fail, respond } from '@/lib/campaigns/route-helpers';
import { getStore } from '@/lib/runtime';
import { controlCampaign } from '@/lib/services/campaigns';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

const BODY = z.object({
  action: z.enum(['pause', 'resume', 'cancel', 'retry_failed', 'mark_sent', 'resend']),
  // A pause sent as the sending page closes or navigates away.
  reason: z.literal('left').optional(),
  // For mark_sent / resend: which "may have gone out" recipients.
  recipientIds: z.array(z.string().max(64)).max(2_000).optional(),
});

/**
 * Pause, resume, cancel, queue the failed sends again, or settle the "may
 * have gone out" ones (mark sent, or send again). Sends nothing by itself.
 */
export async function POST(request: NextRequest, context: Context) {
  const gate = await campaignAuth('control', 60);
  if (!gate.ok) return gate.response;
  const parsed = BODY.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail({ code: 'invalid_input', message: 'That action is not valid.' });
  const { id } = await context.params;
  const result = await controlCampaign(
    getStore(),
    gate.auth.organizationId,
    id,
    { userId: gate.auth.userId },
    parsed.data.action,
    { reason: parsed.data.reason, recipientIds: parsed.data.recipientIds },
  );
  return respond(result, (c) => ({ campaign: c }));
}
