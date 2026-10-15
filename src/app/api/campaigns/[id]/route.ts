import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { authOrError } from '@/lib/auth/session';
import { campaignAuth, done, fail, respond } from '@/lib/campaigns/route-helpers';
import { getStorage, getStore } from '@/lib/runtime';
import {
  checkReplies,
  deleteCampaign,
  getCampaign,
  updateCampaign,
} from '@/lib/services/campaigns';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/** The campaign and its counts, for the progress view to poll. Replies are checked first. */
export async function GET(_request: NextRequest, context: Context) {
  const auth = await authOrError();
  if (!auth.ok) return fail(auth.error);
  const { id } = await context.params;
  const store = getStore();
  await checkReplies(store, auth.value.organizationId, { campaignId: id });
  const detail = await getCampaign(store, auth.value.organizationId, id);
  if (!detail.ok) return fail(detail.error);
  return done({ campaign: detail.value.campaign, counts: detail.value.counts });
}

const PATCH_BODY = z.object({
  name: z.string().max(300).optional(),
  subject: z.string().max(300).optional(),
  body_template: z.string().max(50_000).optional(),
  from_identity: z.enum(['nick', 'arwin']).optional(),
  track_activity: z.boolean().optional(),
  unsubscribe_link: z.boolean().optional(),
});

/** Save a draft's name, subject, body, signature, or its tracking and unsubscribe switches. */
export async function PATCH(request: NextRequest, context: Context) {
  const gate = await campaignAuth('edit', 300);
  if (!gate.ok) return gate.response;
  const parsed = PATCH_BODY.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return fail({ code: 'invalid_input', message: 'That change was not valid.' });
  const { id } = await context.params;
  const updated = await updateCampaign(getStore(), gate.auth.organizationId, id, parsed.data);
  return respond(updated, (c) => ({ campaign: c }));
}

/** Delete a draft. */
export async function DELETE(_request: NextRequest, context: Context) {
  const gate = await campaignAuth('edit');
  if (!gate.ok) return gate.response;
  const { id } = await context.params;
  const removed = await deleteCampaign(getStore(), getStorage(), gate.auth.organizationId, id, {
    userId: gate.auth.userId,
  });
  return respond(removed, () => ({}));
}
