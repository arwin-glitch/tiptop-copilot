import type { CampaignFromIdentity } from '@/lib/types/domain';
import type { Result } from '@/lib/util/result';

/** One finished email for one recipient: what a sender puts on the wire. */
export interface OutgoingCampaignEmail {
  /** `Name <address>` or a bare address. */
  to: string;
  subject: string;
  /** Body and signature, plus the tracking pixel and unsubscribe line when the campaign has them on. */
  html: string;
  text: string;
  attachments: { filename: string; mimeType: string; data: Buffer }[];
  /** The one-click unsubscribe URL for the List-Unsubscribe header, when there is one. */
  listUnsubscribe: string | null;
  /**
   * Addresses copied on this email (the campaign's CC and the recipient's
   * own). Absent when nobody is: then the email has no Cc header at all.
   * Never set on a test send.
   */
  cc?: string[];
  /**
   * Addresses blind-copied on this email. Absent when nobody is. Goes only
   * into the message's own Bcc header (see buildCampaignMime), never into
   * the body or anything a recipient sees. Never set on a test send.
   */
  bcc?: string[];
}

/**
 * What a campaign sends through. The campaign service takes one as a
 * parameter and never builds one, so the service (which the daily job also
 * imports, for the reply check) cannot reach Gmail's send path by itself:
 * only the campaign API routes construct a sender (lib/campaigns/sender.ts),
 * and only on a person's tap.
 */
export interface CampaignSender {
  readonly kind: 'gmail' | 'demo';
  /** The address every email goes from: the connected mailbox. */
  readonly fromAddress: string;
  /** Signature HTML for an identity, or null when it cannot be read (then nothing is sent). */
  signature(identity: CampaignFromIdentity): Promise<string | null>;
  send(email: OutgoingCampaignEmail): Promise<Result<{ messageId: string; threadId: string }>>;
}
