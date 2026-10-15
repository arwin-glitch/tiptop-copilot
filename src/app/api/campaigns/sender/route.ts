import { authOrError } from '@/lib/auth/session';
import { done, fail } from '@/lib/campaigns/route-helpers';
import { campaignSenderFor } from '@/lib/campaigns/sender';
import { getStore } from '@/lib/runtime';
import { getPrimaryIntegration } from '@/lib/services/inbox';
import { htmlToPlainText } from '@/lib/util/text';

export const dynamic = 'force-dynamic';

/**
 * Who a campaign would come from, for the composer and the review screen:
 * the mailbox address, whether it can send, and the two signatures as text
 * (Nick's read live from Gmail with the read scope). Sends nothing.
 */
export async function GET() {
  const auth = await authOrError();
  if (!auth.ok) return fail(auth.error);
  const integration = await getPrimaryIntegration(getStore(), auth.value.organizationId);
  const sender = campaignSenderFor(auth.value, integration);
  if (!sender.ok) {
    return done({
      canSend: false,
      demo: false,
      fromAddress: integration?.account_email ?? null,
      reason: sender.error.message,
      signatures: { nick: null, arwin: null },
    });
  }
  const [nick, arwin] = await Promise.all([
    sender.value.signature('nick'),
    sender.value.signature('arwin'),
  ]);
  return done({
    canSend: true,
    demo: sender.value.kind === 'demo',
    fromAddress: sender.value.fromAddress,
    reason: null,
    signatures: {
      nick: nick ? htmlToPlainText(nick) : null,
      arwin: arwin ? htmlToPlainText(arwin) : null,
    },
  });
}
