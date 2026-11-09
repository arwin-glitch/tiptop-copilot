import { NextResponse, type NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { authOrError } from '@/lib/auth/session';
import { env } from '@/lib/config/env';
import { harmonicConnectFinish, HARMONIC_STATE_COOKIE } from '@/lib/integrations/harmonic-mcp';
import { getStore } from '@/lib/runtime';
import { log } from '@/lib/security/redact';

export const dynamic = 'force-dynamic';

/** Completes the Harmonic OAuth round trip; the module checks state and stores tokens. */
export async function GET(request: NextRequest) {
  const auth = await authOrError();
  if (!auth.ok) return settingsRedirect('error');

  const url = new URL(request.url);
  const jar = await cookies();
  const cookieValue = jar.get(HARMONIC_STATE_COOKIE)?.value;
  // Single use, whatever happens next.
  jar.delete({ name: HARMONIC_STATE_COOKIE, path: '/api/integrations/harmonic' });

  if (url.searchParams.get('error')) return settingsRedirect('denied');

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return settingsRedirect('error');

  const finished = await harmonicConnectFinish(getStore(), auth.value, {
    code,
    state,
    cookieValue,
    redirectUri: `${env().appUrl}/api/integrations/harmonic/callback`,
  });
  if (!finished.ok) {
    log.warn('Harmonic connection could not be finished', { code: finished.error.code });
    return settingsRedirect(finished.error.code === 'forbidden' ? 'forbidden' : 'error');
  }
  return settingsRedirect('connected');
}

function settingsRedirect(outcome: string): NextResponse {
  return NextResponse.redirect(`${env().appUrl}/settings?tab=integrations&harmonic=${outcome}`);
}
