import 'server-only';
import type { DataStore } from '@/lib/db/store';
import { sanitizeSignatureHtml } from '@/lib/email/signature-html';
import { getAccessToken } from '@/lib/google/oauth';
import { log } from '@/lib/security/redact';
import type { Integration } from '@/lib/types/domain';
import { err, ok, type Result } from '@/lib/util/result';
import { canManageFilters } from './gmail-filters';

/**
 * Gmail's own settings Kraken can show and change: the default send-as
 * address's signature, and the vacation responder. Both ride the same
 * opt-in grant as filters ("Turn on filters", gmail.settings.basic): without
 * it every write here refuses, and reading falls back to what the read
 * scope allows (the signature). Each write happens only from a person's
 * Save click in the Inbox's Signature or Vacation responder dialog (the
 * vacation responder after a confirm that says it will auto-reply). No
 * schedule, routine or AI tool imports this module, and it never touches
 * forwarding, delegates or send-as addresses beyond the signature field.
 */

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me/settings';

async function call<T>(
  store: DataStore,
  integration: Integration,
  path: string,
  init?: RequestInit,
): Promise<Result<T>> {
  const token = await getAccessToken(store, integration);
  if (!token.ok) return token;
  try {
    const response = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token.value}` },
    });
    if (response.status === 401 || response.status === 403) {
      return err(
        'provider_unauthorized',
        'Gmail refused. Mail settings may need to be turned on again.',
      );
    }
    if (!response.ok) {
      log.warn('Gmail settings request failed', {
        path: path.split('/')[1] ?? path,
        status: response.status,
      });
      return err('provider_unavailable', 'Gmail did not take that. Try again.', {
        retryable: true,
      });
    }
    const text = await response.text();
    return ok((text ? JSON.parse(text) : {}) as T);
  } catch {
    return err('provider_unavailable', 'Could not reach Gmail.', { retryable: true });
  }
}

interface SendAs {
  sendAsEmail: string;
  isPrimary?: boolean;
  isDefault?: boolean;
  signature?: string;
}

/** The address new mail goes from (Gmail's default, else the primary) and its signature. */
export async function readSignature(
  store: DataStore,
  integration: Integration,
): Promise<Result<{ email: string; html: string }>> {
  const list = await call<{ sendAs?: SendAs[] }>(store, integration, '/sendAs');
  if (!list.ok) return list;
  const pick =
    list.value.sendAs?.find((s) => s.isDefault) ?? list.value.sendAs?.find((s) => s.isPrimary);
  if (!pick) return err('not_found', 'Gmail has no send-as address for this mailbox.');
  return ok({ email: pick.sendAsEmail, html: sanitizeSignatureHtml(pick.signature ?? '') });
}

/** Save the default address's signature: from a person's Save click only. */
export async function writeSignature(
  store: DataStore,
  integration: Integration,
  html: string,
): Promise<Result<{ email: string; html: string }>> {
  if (!canManageFilters(integration)) {
    return err('forbidden', 'Mail settings are off. Turn on filters and settings first.');
  }
  const current = await readSignature(store, integration);
  if (!current.ok) return current;
  const clean = sanitizeSignatureHtml(html);
  const saved = await call<SendAs>(
    store,
    integration,
    `/sendAs/${encodeURIComponent(current.value.email)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      // Only the signature field: nothing else about the address changes.
      body: JSON.stringify({ signature: clean }),
    },
  );
  if (!saved.ok) return saved;
  return ok({
    email: current.value.email,
    html: sanitizeSignatureHtml(saved.value.signature ?? clean),
  });
}
