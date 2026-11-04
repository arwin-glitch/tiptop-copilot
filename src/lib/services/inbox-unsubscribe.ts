import 'server-only';
import type { DataStore } from '@/lib/db/store';
import { ONE_CLICK_BODY, parseUnsubscribe } from '@/lib/email/unsubscribe';
import { readUnsubscribeHeaders } from '@/lib/google/gmail-inbox';
import { canSend } from '@/lib/google/gmail-send';
import { log } from '@/lib/security/redact';
import type { Integration } from '@/lib/types/domain';
import { err, ok, type Result } from '@/lib/util/result';
import { isPrivateAddress, isPublicHostname } from './jobs-board-sync';

/**
 * Gmail's one-click Unsubscribe (RFC 8058), only from a person's click on
 * Unsubscribe and then on its confirm, which names the sender. The address
 * posted to is read again from the message's own List-Unsubscribe header on
 * Gmail, never taken from the browser; it must be https on a public host,
 * redirects are not followed, and the body is exactly RFC 8058's. The demo
 * reaches nothing.
 */

const TIMEOUT_MS = 8_000;

export type HostCheck = (hostname: string) => Promise<boolean>;

async function hostIsPublic(hostname: string): Promise<boolean> {
  if (!isPublicHostname(hostname)) return false;
  try {
    const { lookup } = await import('node:dns/promises');
    const found = await lookup(hostname, { all: true });
    return found.length > 0 && found.every((a) => !isPrivateAddress(a.address));
  } catch {
    return false;
  }
}

export async function oneClickUnsubscribe(
  store: DataStore,
  demo: boolean,
  integration: Integration | null,
  messageId: string,
  deps: { fetchImpl?: typeof fetch; hostCheck?: HostCheck } = {},
): Promise<Result<{ sender: string }>> {
  if (demo) return ok({ sender: 'the demo sender' });
  if (!integration) return err('not_found', 'No mailbox is connected.');
  if (!canSend(integration)) {
    return err('forbidden', 'Unsubscribing from Kraken needs sending turned on. Use Gmail.');
  }
  const headers = await readUnsubscribeHeaders(store, integration, messageId);
  if (!headers.ok) return headers;
  const options = parseUnsubscribe(
    headers.value.listUnsubscribe,
    headers.value.listUnsubscribePost,
  );
  if (!options?.oneClick || !options.http) {
    return err('invalid_input', 'This sender does not offer one-click unsubscribe.');
  }
  const url = new URL(options.http);
  if (!(await (deps.hostCheck ?? hostIsPublic)(url.hostname))) {
    return err('invalid_input', 'That unsubscribe address is not on the public internet.');
  }
  try {
    const res = await (deps.fetchImpl ?? fetch)(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: ONE_CLICK_BODY,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status >= 200 && res.status < 400) return ok({ sender: headers.value.from });
    log.warn('One-click unsubscribe refused', { status: res.status });
    return err('provider_unavailable', 'The sender did not take the unsubscribe. Try their link.');
  } catch {
    return err('provider_unavailable', 'Could not reach the sender. Try their link instead.', {
      retryable: true,
    });
  }
}
