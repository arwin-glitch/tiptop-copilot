import { NextResponse, type NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { authOrError, hasRole } from '@/lib/auth/session';
import { env } from '@/lib/config/env';
import { harmonicConnectStart, HARMONIC_STATE_COOKIE } from '@/lib/integrations/harmonic-mcp';
import { computerOnlyPage } from '@/lib/ios/computer-only';
import { isIosAppRequest } from '@/lib/ios/server';
import { getStore } from '@/lib/runtime';
import { rateLimit } from '@/lib/security/limits';
import { statusForError } from '@/lib/util/result';

export const dynamic = 'force-dynamic';

/**
 * Begin "Connect Harmonic": an org admin signs in at Harmonic (OAuth) so
 * Kraken search can look up people and companies nobody has met yet. The
 * state is bound to an httpOnly cookie scoped to the Harmonic routes; the
 * callback refuses anything that does not match.
 *
 * Never from inside the iPhone app, where the sign-in cannot finish.
 */
export async function GET(request: NextRequest) {
  if (isIosAppRequest(request)) {
    return computerOnlyPage('Connecting Harmonic', {
      href: '/settings?tab=integrations',
      label: 'Back to Settings',
    });
  }
  const auth = await authOrError();
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: statusForError(auth.error.code) },
    );
  }
  if (!hasRole(auth.value, 'admin')) return settingsRedirect('forbidden');

  const limited = rateLimit(`harmonic-start:${auth.value.userId}`, 10, 60_000);
  if (!limited.ok) {
    return NextResponse.json({ ok: false, error: limited.error }, { status: 429 });
  }

  const redirectUri = `${env().appUrl}/api/integrations/harmonic/callback`;
  const started = await harmonicConnectStart(getStore(), auth.value, redirectUri);
  if (!started.ok) return settingsRedirect('error');

  const jar = await cookies();
  jar.set(HARMONIC_STATE_COOKIE, started.value.cookieValue, {
    httpOnly: true,
    secure: env().nodeEnv === 'production',
    sameSite: 'lax',
    path: '/api/integrations/harmonic',
    maxAge: 600,
  });

  return NextResponse.redirect(started.value.url, 302);
}

function settingsRedirect(outcome: string): NextResponse {
  return NextResponse.redirect(
    `${env().appUrl}/settings?tab=integrations&harmonic=${outcome}`,
    302,
  );
}
