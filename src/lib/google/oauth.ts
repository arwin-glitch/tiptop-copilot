import 'server-only';
import { env } from '@/lib/config/env';
import { openToken, sealToken } from '@/lib/security/crypto';
import { log } from '@/lib/security/redact';
import type { DataStore } from '@/lib/db/store';
import type { EncryptedProviderToken, Integration } from '@/lib/types/domain';
import { err, ok, type Result } from '@/lib/util/result';
import { newId } from '@/lib/util/hash';

/**
 * Google OAuth 2.0 authorization-code flow with encrypted refresh-token
 * storage.
 *
 * Scopes are read-only and deliberately minimal. `gmail.send` is not requested
 * and is not requestable from this codebase — the product creates drafts and
 * has no send path.
 */

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.metadata',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
] as const;

/** Gmail's metadata scope conflicts with readonly on some consents; readonly wins. */
export const REQUESTED_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
] as const;

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';

export function googleConfigured(): boolean {
  const e = env();
  return Boolean(e.googleClientId && e.googleClientSecret);
}

export function buildAuthorizationUrl(state: string): Result<string> {
  const e = env();
  if (!googleConfigured()) {
    return err('not_configured', 'Google OAuth client is not configured.');
  }
  const params = new URLSearchParams({
    client_id: e.googleClientId!,
    redirect_uri: e.googleRedirectUri,
    response_type: 'code',
    scope: REQUESTED_SCOPES.join(' '),
    access_type: 'offline',
    // Forces a refresh token even when the user has consented before.
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return ok(`${AUTH_ENDPOINT}?${params.toString()}`);
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

export async function exchangeCode(code: string): Promise<Result<TokenResponse>> {
  const e = env();
  if (!googleConfigured()) return err('not_configured', 'Google OAuth client is not configured.');
  try {
    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: e.googleClientId!,
        client_secret: e.googleClientSecret!,
        redirect_uri: e.googleRedirectUri,
        grant_type: 'authorization_code',
      }),
    });
    if (!response.ok) {
      log.warn('Google token exchange failed', { status: response.status });
      return err('provider_unauthorized', 'Google rejected the authorization code.');
    }
    return ok((await response.json()) as TokenResponse);
  } catch {
    return err(
      'provider_unavailable',
      'Could not reach Google to exchange the authorization code.',
    );
  }
}

export async function fetchAccountEmail(accessToken: string): Promise<string | null> {
  try {
    const response = await fetch(USERINFO_ENDPOINT, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { email?: string };
    return data.email ?? null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------- token lifecycle */

/** AAD binds a ciphertext to its integration so it cannot be replayed elsewhere. */
function aadFor(integrationId: string, tokenType: string): string {
  return `integration:${integrationId}:${tokenType}`;
}

export async function storeTokens(
  store: DataStore,
  integration: Integration,
  tokens: { refreshToken?: string; accessToken: string; expiresInSeconds: number },
): Promise<Result<true>> {
  const now = new Date().toISOString();

  if (tokens.refreshToken) {
    const sealed = sealToken(tokens.refreshToken, aadFor(integration.id, 'refresh'));
    if (!sealed.ok) return sealed;
    await store.upsert(
      'encrypted_provider_tokens',
      {
        id: newId(),
        integration_id: integration.id,
        organization_id: integration.organization_id,
        token_type: 'refresh',
        ciphertext: sealed.value.ciphertext,
        iv: sealed.value.iv,
        auth_tag: sealed.value.authTag,
        key_version: sealed.value.keyVersion,
        expires_at: null,
        created_at: now,
        updated_at: now,
      },
      ['integration_id', 'token_type'],
    );
  }

  const sealedAccess = sealToken(tokens.accessToken, aadFor(integration.id, 'access'));
  if (!sealedAccess.ok) return sealedAccess;
  await store.upsert(
    'encrypted_provider_tokens',
    {
      id: newId(),
      integration_id: integration.id,
      organization_id: integration.organization_id,
      token_type: 'access',
      ciphertext: sealedAccess.value.ciphertext,
      iv: sealedAccess.value.iv,
      auth_tag: sealedAccess.value.authTag,
      key_version: sealedAccess.value.keyVersion,
      expires_at: new Date(Date.now() + tokens.expiresInSeconds * 1000).toISOString(),
      created_at: now,
      updated_at: now,
    },
    ['integration_id', 'token_type'],
  );

  return ok(true);
}

async function readToken(
  store: DataStore,
  integration: Integration,
  tokenType: 'refresh' | 'access',
): Promise<Result<{ value: string; expiresAt: string | null }>> {
  const row = (await store.findOne('encrypted_provider_tokens', integration.organization_id, {
    eq: { integration_id: integration.id, token_type: tokenType },
  })) as EncryptedProviderToken | null;
  if (!row) return err('not_found', `No stored ${tokenType} token for this integration.`);
  const opened = openToken(
    {
      ciphertext: row.ciphertext,
      iv: row.iv,
      authTag: row.auth_tag,
      keyVersion: row.key_version,
    },
    aadFor(integration.id, tokenType),
  );
  if (!opened.ok) return opened;
  return ok({ value: opened.value, expiresAt: row.expires_at });
}

/**
 * Return a usable access token, refreshing if it is missing or within two
 * minutes of expiry. A revoked grant is reported as `provider_unauthorized`
 * and marks the integration as needing re-authorisation.
 */
export async function getAccessToken(
  store: DataStore,
  integration: Integration,
): Promise<Result<string>> {
  const existing = await readToken(store, integration, 'access');
  if (existing.ok) {
    const expiresAt = existing.value.expiresAt ? Date.parse(existing.value.expiresAt) : 0;
    if (expiresAt - Date.now() > 120_000) return ok(existing.value.value);
  }

  const refresh = await readToken(store, integration, 'refresh');
  if (!refresh.ok) {
    await markNeedsReauth(store, integration, 'No refresh token is stored. Reconnect the account.');
    return err('provider_unauthorized', 'This Google connection needs to be re-authorised.');
  }

  const e = env();
  if (!googleConfigured()) return err('not_configured', 'Google OAuth client is not configured.');

  try {
    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: e.googleClientId!,
        client_secret: e.googleClientSecret!,
        refresh_token: refresh.value.value,
        grant_type: 'refresh_token',
      }),
    });
    if (response.status === 400 || response.status === 401) {
      await markNeedsReauth(
        store,
        integration,
        'Google reported the refresh token as invalid or revoked.',
      );
      return err('provider_unauthorized', 'This Google connection needs to be re-authorised.');
    }
    if (!response.ok) {
      return err('provider_unavailable', 'Google could not refresh the access token right now.', {
        retryable: true,
      });
    }
    const data = (await response.json()) as TokenResponse;
    const stored = await storeTokens(store, integration, {
      accessToken: data.access_token,
      expiresInSeconds: data.expires_in,
      refreshToken: data.refresh_token,
    });
    if (!stored.ok) return stored;
    if (integration.status !== 'connected') {
      await store.update('integrations', integration.organization_id, integration.id, {
        status: 'connected',
        status_detail: null,
      });
    }
    return ok(data.access_token);
  } catch {
    return err('provider_unavailable', 'Could not reach Google to refresh the access token.', {
      retryable: true,
    });
  }
}

async function markNeedsReauth(
  store: DataStore,
  integration: Integration,
  detail: string,
): Promise<void> {
  await store.update('integrations', integration.organization_id, integration.id, {
    status: 'needs_reauth',
    status_detail: detail,
  });
}

/** Best-effort revocation at Google, then local deletion regardless of result. */
export async function revokeAndForget(
  store: DataStore,
  integration: Integration,
): Promise<Result<{ revokedRemotely: boolean }>> {
  let revokedRemotely = false;
  const refresh = await readToken(store, integration, 'refresh');
  if (refresh.ok) {
    try {
      const response = await fetch(REVOKE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: refresh.value.value }),
      });
      revokedRemotely = response.ok;
    } catch {
      revokedRemotely = false;
    }
  }
  await store.removeWhere('encrypted_provider_tokens', integration.organization_id, {
    eq: { integration_id: integration.id },
  });
  await store.update('integrations', integration.organization_id, integration.id, {
    status: 'disconnected',
    status_detail: revokedRemotely
      ? 'Disconnected and revoked at Google.'
      : 'Disconnected locally. Revoke access at myaccount.google.com if it is still listed.',
    sync_cursor: null,
  });
  return ok({ revokedRemotely });
}
