import type { NextRequest } from 'next/server';
import { authOrError } from '@/lib/auth/session';
import { done, fail, trackingOrigin } from '@/lib/campaigns/route-helpers';
import { getStore } from '@/lib/runtime';
import { reviewCampaign } from '@/lib/services/campaigns';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/** The host a campaign's Copilot links go through, so the review can name it. */
function hostOf(origin: string | null): string | null {
  if (!origin) return null;
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

/**
 * What the review screen shows, read from the saved campaign: the exact
 * recipient count, subject, signature, attachments and switches (tracking,
 * the unsubscribe line, and the host their links go through), the first
 * recipient as the sample, anything left to fix, and the version the
 * confirmation must echo back.
 */
export async function GET(_request: NextRequest, context: Context) {
  const auth = await authOrError();
  if (!auth.ok) return fail(auth.error);
  const { id } = await context.params;
  const store = getStore();
  const origin = trackingOrigin();
  const review = await reviewCampaign(store, auth.value.organizationId, id, { appUrl: origin });
  if (!review.ok) return fail(review.error);
  const [sample] = await store.list(
    'campaign_recipients',
    auth.value.organizationId,
    { eq: { campaign_id: id, status: 'pending' } },
    {
      orderBy: [
        { field: 'created_at', direction: 'asc' },
        { field: 'id', direction: 'asc' },
      ],
      limit: 1,
    },
  );
  const { campaign, ...rest } = review.value;
  return done({
    review: {
      ...rest,
      subject: campaign.subject,
      body_template: campaign.body_template,
      from_identity: campaign.from_identity,
      track_activity: campaign.track_activity,
      unsubscribe_link: campaign.unsubscribe_link,
      linkHost: campaign.track_activity || campaign.unsubscribe_link ? hostOf(origin) : null,
      attachments: campaign.attachments.map(({ id: aid, name, size, type }) => ({
        id: aid,
        name,
        size,
        type,
      })),
      status: campaign.status,
      sample: sample ? { email: sample.email, name: sample.name, merge: sample.merge } : null,
    },
  });
}
