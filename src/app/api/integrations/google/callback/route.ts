import { NextResponse, type NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { authOrError } from '@/lib/auth/session';
import { env } from '@/lib/config/env';
import { exchangeCode, fetchAccountEmail, REQUESTED_SCOPES, storeTokens } from '@/lib/google/oauth';
import { encryptionAvailable, verifySignedValue } from '@/lib/security/crypto';
import { recordAudit } from '@/lib/security/audit';
import { log } from '@/lib/security/redact';
import { getStore } from '@/lib/runtime';
import { getPrimaryIntegration } from '@/lib/services/inbox';
import type { Integration } from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';
import { OAUTH_STATE_COOKIE } from '../start/route';

export const dynamic = 'force-dynamic';

/** Completes the OAuth round trip and stores encrypted tokens. */
export async function GET(request: NextRequest) {
  const auth = await authOrError();
  if (!auth.ok) return redirectWithError('Sign in before connecting an account.');

  const url = new URL(request.url);
  const error = url.searchParams.get('error');
  if (error) {
    return redirectWithError(
      error === 'access_denied'
        ? 'Google authorisation was declined. Nothing was connected.'
        : `Google returned an error: ${error}`,
    );
  }

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return redirectWithError('The Google response was incomplete.');

  // ---- Validate the state nonce against the httpOnly cookie. ----
  const jar = await cookies();
  const expectedNonce = jar.get(OAUTH_STATE_COOKIE)?.value;
  jar.delete(OAUTH_STATE_COOKIE);

  const payload = verifySignedValue(state);
  if (!payload || !expectedNonce) {
    return redirectWithError('That authorisation link is no longer valid. Start again.');
  }
  let parsed: { nonce: string; userId: string; organizationId: string; issuedAt: number };
  try {
    parsed = JSON.parse(payload);
  } catch {
    return redirectWithError('That authorisation link is malformed. Start again.');
  }
  if (
    parsed.nonce !== expectedNonce ||
    parsed.userId !== auth.value.userId ||
    parsed.organizationId !== auth.value.organizationId ||
    Date.now() - parsed.issuedAt > 600_000
  ) {
    log.warn('Rejected OAuth callback with mismatched state');
    return redirectWithError('That authorisation attempt could not be verified. Start again.');
  }

  if (!encryptionAvailable()) {
    return redirectWithError(
      'APP_ENCRYPTION_KEY is not configured, so provider tokens cannot be stored securely. Nothing was connected.',
    );
  }

  const tokens = await exchangeCode(code);
  if (!tokens.ok) return redirectWithError(tokens.error.message);

  if (!tokens.value.refresh_token) {
    return redirectWithError(
      'Google did not return a refresh token. Remove TipTop Copilot from your Google account permissions and connect again.',
    );
  }

  const accountEmail = await fetchAccountEmail(tokens.value.access_token);
  const grantedScopes = tokens.value.scope?.split(' ') ?? [...REQUESTED_SCOPES];

  const store = getStore();
  const existing = await getPrimaryIntegration(store, auth.value.organizationId);
  const now = new Date().toISOString();

  const integration: Integration = {
    id: existing?.id ?? newId(),
    organization_id: auth.value.organizationId,
    user_id: auth.value.userId,
    provider: 'google',
    kinds: [
      ...(grantedScopes.some((s) => s.includes('gmail')) ? (['gmail'] as const) : []),
      ...(grantedScopes.some((s) => s.includes('calendar')) ? (['calendar'] as const) : []),
    ],
    account_email: accountEmail,
    scopes: grantedScopes,
    status: 'connected',
    status_detail: null,
    // A fresh grant invalidates any previous history cursor.
    last_sync_at: null,
    last_sync_error: null,
    sync_cursor: null,
    watch_expires_at: existing?.watch_expires_at ?? null,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };

  const upserted = await store.upsert('integrations', integration, [
    'organization_id',
    'provider',
    'user_id',
  ]);

  const stored = await storeTokens(store, upserted.row, {
    accessToken: tokens.value.access_token,
    refreshToken: tokens.value.refresh_token,
    expiresInSeconds: tokens.value.expires_in,
  });
  if (!stored.ok) return redirectWithError(stored.error.message);

  await recordAudit(store, {
    organizationId: auth.value.organizationId,
    userId: auth.value.userId,
    action: 'integration.connected',
    entityType: 'integration',
    entityId: upserted.row.id,
    metadata: {
      provider: 'google',
      kinds: integration.kinds,
      scopes: grantedScopes,
      account_domain: accountEmail?.split('@')[1] ?? null,
    },
  });

  return NextResponse.redirect(`${env().appUrl}/settings?connected=google`);
}

function redirectWithError(message: string): NextResponse {
  const target = new URL('/settings', env().appUrl);
  target.searchParams.set('integration_error', message);
  return NextResponse.redirect(target.toString());
}
