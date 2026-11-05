import { NextResponse, type NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { authOrError } from '@/lib/auth/session';
import { env } from '@/lib/config/env';
import { buildAuthorizationUrl, googleConfigured } from '@/lib/google/oauth';
import { computerOnlyPage } from '@/lib/ios/computer-only';
import { isIosAppRequest } from '@/lib/ios/server';
import { randomToken, signedValue } from '@/lib/security/crypto';
import { rateLimit } from '@/lib/security/limits';
import { statusForError } from '@/lib/util/result';

export const dynamic = 'force-dynamic';

export const OAUTH_STATE_COOKIE = 'tiptop_oauth_state';

const SPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Begin the "Connect Google Workspace" flow.
 *
 * The `state` parameter is a signed, single-use nonce bound to the caller and
 * stored in an httpOnly cookie; the callback refuses anything that does not
 * match. That is the CSRF control for the OAuth round trip.
 *
 * `?send=1` is the "Turn on sending" button: the same flow, also asking for
 * the send scope. Only the email session's Send button uses it.
 *
 * `?calendar=1` is the "Turn on calendar editing" button: the same flow, also
 * asking for the event-editing scope, and back to the Calendar tab after
 * (or to Settings, with `&from=settings`, when it was started there).
 *
 * `?filters=1` is the Inbox's "Turn on filters" step: the same flow, also
 * asking for Gmail's basic settings scope (filters), and back to the Inbox
 * after (or to Settings, with `&from=settings`). Only the Inbox's Create
 * filter and Filters list use it.
 *
 * `?member=1` is "Connect your Google to contribute" (Spaces): a member's
 * OWN Google, read-only (MEMBER_READ_SCOPES alone), stored as their own
 * connection beside the main mailbox and never in its place (D-081). Back to
 * the Space it was started from (`&space=<id>`), else to Settings.
 *
 * Never from inside the iPhone app, where Google's consent screen cannot
 * finish (lib/ios/computer-only.ts).
 */
export async function GET(request: NextRequest) {
  if (isIosAppRequest(request)) {
    return computerOnlyPage('Connecting Google', { href: '/settings', label: 'Back to Settings' });
  }
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

  const send = request.nextUrl.searchParams.get('send') === '1';
  const calendar = request.nextUrl.searchParams.get('calendar') === '1';
  const filters = request.nextUrl.searchParams.get('filters') === '1';
  const fromSettings = request.nextUrl.searchParams.get('from') === 'settings';
  const member = request.nextUrl.searchParams.get('member') === '1';
  const space = request.nextUrl.searchParams.get('space') ?? '';
  const memberReturn = SPACE_ID.test(space) ? `/spaces/${space.toLowerCase()}` : '/settings';

  const nonce = randomToken(24);
  const statePayload = JSON.stringify({
    nonce,
    userId: auth.value.userId,
    organizationId: auth.value.organizationId,
    issuedAt: Date.now(),
    // A fixed page, never one taken from the request: the callback only
    // honours values on its own list.
    ...(member
      ? { member: true, returnTo: memberReturn }
      : {
          ...(calendar && !fromSettings ? { returnTo: '/calendar' } : {}),
          ...(filters && !calendar && !fromSettings ? { returnTo: '/inbox' } : {}),
        }),
  });
  const state = signedValue(statePayload);

  // A member connection asks for the read-only scopes alone, never with the others.
  const url = buildAuthorizationUrl(state, member ? { member: true } : { send, calendar, filters });
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
