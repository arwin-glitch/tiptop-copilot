import 'server-only';
import type { AuthContext } from '@/lib/auth/session';
import { env } from '@/lib/config/env';
import { ARWIN_SIGNATURE_HTML } from '@/lib/email/signatures';
import { canSend, readPrimarySignature, sendCampaignEmail } from '@/lib/google/gmail-send';
import { getStore } from '@/lib/runtime';
import type { Integration } from '@/lib/types/domain';
import { err, ok, type Result } from '@/lib/util/result';
import { DemoCampaignSender } from './demo-sender';
import type { CampaignSender } from './sender-types';

/**
 * The sender a campaign route uses: Gmail through lib/google/gmail-send.ts
 * (the product's one send path), or in demo mode the sender that sends
 * nothing. Imported only by the campaign routes a person's tap reaches —
 * test, confirm, batch — which tests/integration/drafts.test.ts enforces.
 *
 * Exactly the composer's rules: from the connected mailbox, only with the
 * opt-in send grant, signed with Nick's real Gmail signature (read live; when
 * it cannot be read, nothing is sent) or Arwin's.
 */
export function campaignSenderFor(
  auth: AuthContext,
  integration: Integration | null,
): Result<CampaignSender> {
  if (env().demoMode) {
    // Invented data and nobody to email: the demo sends nothing at all.
    return ok(new DemoCampaignSender(auth.profile.email));
  }
  if (auth.isDemo || !integration || !canSend(integration)) {
    return err(
      'forbidden',
      'Sending is not turned on for this mailbox yet. Turn it on in Settings, then come back.',
    );
  }
  return ok(new GmailCampaignSender(integration));
}

class GmailCampaignSender implements CampaignSender {
  readonly kind = 'gmail' as const;
  private readonly signatures = new Map<string, Promise<string | null>>();

  constructor(private readonly integration: Integration) {}

  get fromAddress(): string {
    return this.integration.account_email ?? '';
  }

  signature(identity: 'nick' | 'arwin'): Promise<string | null> {
    if (identity === 'arwin') return Promise.resolve(ARWIN_SIGNATURE_HTML);
    // Read once per sender (one request), not once per email.
    let pending = this.signatures.get(identity);
    if (!pending) {
      pending = readPrimarySignature(getStore(), this.integration);
      this.signatures.set(identity, pending);
    }
    return pending;
  }

  send(email: Parameters<CampaignSender['send']>[0]) {
    return sendCampaignEmail(getStore(), this.integration, {
      to: email.to,
      subject: email.subject,
      html: email.html,
      text: email.text,
      attachments: email.attachments,
      listUnsubscribe: email.listUnsubscribe,
    });
  }
}
