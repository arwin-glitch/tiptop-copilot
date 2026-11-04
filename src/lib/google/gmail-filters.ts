import 'server-only';
import type { DataStore } from '@/lib/db/store';
import {
  isSafeFilterBody,
  type GmailFilter,
  type GmailFilterBody,
} from '@/lib/email/inbox-filters';
import { getAccessToken } from '@/lib/google/oauth';
import { log } from '@/lib/security/redact';
import type { Integration } from '@/lib/types/domain';
import { err, ok, type Result } from '@/lib/util/result';
import { FILTER_SCOPES } from './send-scopes';

/**
 * Gmail filters: list, create and delete, each only from a person's click
 * in the Inbox (Create in the Create filter dialog, Delete in the Filters
 * list). Needs the opt-in "Turn on filters" grant (FILTER_SCOPES); without
 * it every call here refuses. Nothing on a schedule, no AI tool and no
 * routine imports this module.
 *
 * A filter body is checked again here: it may only add star, important, a
 * category or the person's own label, and only take off inbox, unread,
 * spam or important. Never a forward, never TRASH.
 */

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me/settings/filters';
const FILTER_ID = /^[0-9A-Za-z_-]{1,120}$/;

export function canManageFilters(integration: Integration | null): boolean {
  return Boolean(integration && FILTER_SCOPES.every((s) => integration.scopes.includes(s)));
}

async function call<T>(
  store: DataStore,
  integration: Integration,
  path: string,
  init?: RequestInit,
): Promise<Result<T>> {
  if (!canManageFilters(integration)) {
    return err('forbidden', 'Filters are off. Turn on filters first.');
  }
  const token = await getAccessToken(store, integration);
  if (!token.ok) return token;
  try {
    const response = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token.value}` },
    });
    if (response.status === 401 || response.status === 403) {
      return err('provider_unauthorized', 'Gmail refused. Filters may need to be turned on again.');
    }
    if (response.status === 404) return err('not_found', 'That filter is gone from Gmail.');
    if (!response.ok) {
      log.warn('Gmail filter request failed', { status: response.status });
      return err('provider_unavailable', 'Gmail did not take that. Try again.', {
        retryable: true,
      });
    }
    if (response.status === 204) return ok(undefined as T);
    const text = await response.text();
    return ok((text ? JSON.parse(text) : {}) as T);
  } catch {
    return err('provider_unavailable', 'Could not reach Gmail.', { retryable: true });
  }
}

export async function listFilters(
  store: DataStore,
  integration: Integration,
): Promise<Result<GmailFilter[]>> {
  const res = await call<{ filter?: GmailFilter[] }>(store, integration, '');
  return res.ok ? ok(res.value.filter ?? []) : res;
}

export async function createFilter(
  store: DataStore,
  integration: Integration,
  body: GmailFilterBody,
): Promise<Result<GmailFilter>> {
  if (!isSafeFilterBody(body)) {
    return err('invalid_input', 'That filter has an action Kraken does not offer.');
  }
  return call<GmailFilter>(store, integration, '', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ criteria: body.criteria, action: body.action }),
  });
}

export async function deleteFilter(
  store: DataStore,
  integration: Integration,
  id: string,
): Promise<Result<true>> {
  if (!FILTER_ID.test(id)) return err('invalid_input', 'Unknown filter.');
  const res = await call<unknown>(store, integration, `/${id}`, { method: 'DELETE' });
  return res.ok ? ok(true) : res;
}
