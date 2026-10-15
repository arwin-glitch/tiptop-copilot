import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { authOrError } from '@/lib/auth/session';
import { campaignAuth, done, fail, respond } from '@/lib/campaigns/route-helpers';
import { getStore } from '@/lib/runtime';
import { listUnsubscribes, resubscribe, suppressEmail } from '@/lib/services/campaigns';

export const dynamic = 'force-dynamic';

/** Everyone currently unsubscribed from campaigns, newest first. */
export async function GET() {
  const auth = await authOrError();
  if (!auth.ok) return fail(auth.error);
  const result = await listUnsubscribes(getStore(), auth.value.organizationId);
  if (!result.ok) return fail(result.error);
  return done({ unsubscribes: result.value });
}

const BODY = z.object({
  action: z.enum(['resubscribe', 'unsubscribe']),
  email: z.string().min(3).max(320),
});

/**
 * Put an address back on (it asked to get these again), or take one off by
 * hand (it replied asking to stop). Sends nothing.
 */
export async function POST(request: NextRequest) {
  const gate = await campaignAuth('suppression', 60);
  if (!gate.ok) return gate.response;
  const parsed = BODY.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail({ code: 'invalid_input', message: 'Give an email address.' });
  const actor = { userId: gate.auth.userId };
  const store = getStore();
  const org = gate.auth.organizationId;
  if (parsed.data.action === 'resubscribe') {
    return respond(await resubscribe(store, org, actor, parsed.data.email), (r) => r);
  }
  return respond(await suppressEmail(store, org, actor, parsed.data.email), (r) => r);
}
