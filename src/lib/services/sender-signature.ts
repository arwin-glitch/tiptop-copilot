import 'server-only';
import type { DataStore } from '@/lib/db/store';
import { ARWIN_SIGNATURE_HTML } from '@/lib/email/signatures';
import { memberGmailSignature } from './space-member-mail';

/**
 * The signature under an email signed "as Arwin": the sender's own Gmail
 * signature, exactly as Gmail has it (read live from their own connected
 * Google, Settings -> Integrations). Only when that cannot be read (not
 * connected, Google not answering, empty) does the built-in card stand in.
 */
export async function arwinSignature(
  store: DataStore,
  organizationId: string,
  userId: string | null,
): Promise<string> {
  if (userId) {
    const own = await memberGmailSignature(store, organizationId, userId).catch(() => null);
    if (own) return own;
  }
  return ARWIN_SIGNATURE_HTML;
}
