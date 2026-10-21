import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { campaignAuth, fail, respond } from '@/lib/campaigns/route-helpers';
import { getStore } from '@/lib/runtime';
import { copySettingsOf, setRecipientCc, updateCampaignCopies } from '@/lib/services/campaigns';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/**
 * The addresses as typed (commas, spaces or new lines between them); the
 * service parses and refuses anything that is not all real addresses.
 */
const BODY = z.union([
  z.object({ recipientId: z.string().max(64), cc: z.string().max(5_000) }),
  z.object({
    cc: z.string().max(5_000).optional(),
    bcc: z.string().max(5_000).optional(),
    bccMode: z.enum(['every', 'first']).optional(),
  }),
]);

/**
 * A draft's copies: the campaign's CC, its BCC and where the BCC goes, or one
 * recipient's own CC (`recipientId`). Each is a draft edit, so a review taken
 * before it can no longer be confirmed.
 */
export async function PATCH(request: NextRequest, context: Context) {
  const gate = await campaignAuth('edit', 300);
  if (!gate.ok) return gate.response;
  const parsed = BODY.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return fail({ code: 'invalid_input', message: 'That change was not valid.' });
  const { id } = await context.params;
  const store = getStore();
  const org = gate.auth.organizationId;
  if ('recipientId' in parsed.data) {
    const result = await setRecipientCc(store, org, id, {
      recipientId: parsed.data.recipientId,
      cc: parsed.data.cc,
    });
    return respond(result, (r) => ({ ...r }));
  }
  const result = await updateCampaignCopies(store, org, id, parsed.data);
  return respond(result, (campaign) => ({ copies: copySettingsOf(campaign) }));
}
