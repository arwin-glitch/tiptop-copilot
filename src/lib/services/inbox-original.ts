import 'server-only';
import type { DataStore } from '@/lib/db/store';
import { demoRawMessage, emlFileName } from '@/lib/email/raw-message';
import { readMessageRaw } from '@/lib/google/gmail-inbox';
import { isDemoMode } from '@/lib/config/env';
import type { Integration } from '@/lib/types/domain';
import { err, ok, type Result } from '@/lib/util/result';
import { readLiveThread } from './inbox-live';

/**
 * One message's original source, read only: Gmail's "Show original" and
 * "Download message", and the bytes "Forward as attachment" attaches. Read
 * scope only; nothing here changes the mailbox. The demo builds a stand-in
 * from its fictional message; nothing reaches Gmail.
 */
export async function readOriginal(
  store: DataStore,
  organizationId: string,
  integration: Integration | null,
  threadId: string,
  messageId: string,
): Promise<Result<{ bytes: Buffer; fileName: string; subject: string }>> {
  const thread = await readLiveThread(store, organizationId, threadId);
  if (!thread.ok) return thread;
  const message = thread.value.messages.find((m) => m.id === messageId);
  if (!message) return err('not_found', 'That message is not in this conversation.');
  const subject = thread.value.subject;
  const fileName = emlFileName(subject);
  if (isDemoMode()) {
    const text = demoRawMessage({ ...message, subject });
    return ok({ bytes: Buffer.from(text, 'utf8'), fileName, subject });
  }
  if (!integration) return err('not_found', 'No mailbox is connected.');
  const raw = await readMessageRaw(store, integration, messageId);
  if (!raw.ok) return raw;
  return ok({ bytes: raw.value, fileName, subject });
}
