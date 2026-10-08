import { NextResponse, type NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { authOrError } from '@/lib/auth/session';
import { env } from '@/lib/config/env';
import { buildAuthorizationUrl, googleConfigured } from '@/lib/google/oauth';
import { randomToken, signedValue } from '@/lib/security/crypto';
import { rateLimit } from '@/lib/security/limits';
import { statusForError } from '@/lib/util/result';

export const dynamic = 'force-dynamic';

export const OAUTH_STATE_COOKIE = 'tiptop_oauth_state';

/**
 * Begin the "Connect Google Workspace" flow.
 *
 * The `state` parameter is a signed, single-use nonce bound to the caller and
 * stored in an httpOnly cookie; the callback refuses anything that does not
 * match. That is the CSRF control for the OAuth round trip.
 *
 * `?send=1` is the "Turn on sending" button: the same flow, also asking for
 * the send scope. Only the email session's Send button uses it.
 */
export async function GET(request: NextRequest) {
  const auth = await authOrError();
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: statusForError(auth.error.code) },
    );
  }

  const limited = rateLimit(`oauth-start:${auth.value.userId}`, 10, 60_000);
  if (!limited.ok) {
    return NextResponse.json({ ok: false, error: limited.error }, { status: 429 });
  }

  if (!googleConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'not_configured',
          message: 'Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.',
        },
      },
      { status: 503 },
    );
  }

  const nonce = randomToken(24);
  const statePayload = JSON.stringify({
    nonce,
    userId: auth.value.userId,
    organizationId: auth.value.organizationId,
    issuedAt: Date.now(),
  });
  const state = signedValue(statePayload);

  const send = request.nextUrl.searchParams.get('send') === '1';
  const url = buildAuthorizationUrl(state, { send });
  if (!url.ok) {
    return NextResponse.json({ ok: false, error: url.error }, { status: 503 });
  }

  const jar = await cookies();
  jar.set(OAUTH_STATE_COOKIE, nonce, {
    httpOnly: true,
    secure: env().nodeEnv === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 600,
  });

  return NextResponse.redirect(url.value);
}
