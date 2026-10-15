import { randomBytes } from 'node:crypto';
import type { CampaignFromIdentity } from '@/lib/types/domain';
import { err, ok, type Result } from '@/lib/util/result';
import type { CampaignSender, OutgoingCampaignEmail } from './sender-types';

/**
 * A sender that sends nothing: demo mode's, and the tests'. It makes no
 * network call of any kind; it hands back invented Gmail ids and keeps what
 * it was given, so a test can read the exact emails a campaign produced.
 *
 * Addresses at `fail.example` are refused, so the demo and the tests can show
 * what a failed send looks like.
 */
export class DemoCampaignSender implements CampaignSender {
  readonly kind = 'demo' as const;
  readonly sent: OutgoingCampaignEmail[] = [];

  constructor(
    readonly fromAddress: string = 'nick@tiptop.demo',
    private readonly signatures: Partial<Record<CampaignFromIdentity, string | null>> = {},
  ) {}

  async signature(identity: CampaignFromIdentity): Promise<string | null> {
    if (identity in this.signatures) return this.signatures[identity] ?? null;
    return identity === 'arwin'
      ? 'Arwin (demo)<br>Executive Assistant, TipTop VC'
      : 'Nick (demo)<br>TipTop VC';
  }

  async send(
    email: OutgoingCampaignEmail,
  ): Promise<Result<{ messageId: string; threadId: string }>> {
    if (/@fail\.example>?$/i.test(email.to.trim())) {
      return err('provider_unavailable', 'Gmail did not accept this one (demo failure).', {
        retryable: true,
      });
    }
    this.sent.push(email);
    const id = `demo${randomBytes(6).toString('hex')}`;
    return ok({ messageId: id, threadId: id });
  }
}
