import { NextResponse } from 'next/server';
import { supabaseServerClient } from '@/lib/auth/session';
import { env, isDemoMode } from '@/lib/config/env';

export const dynamic = 'force-dynamic';

/**
 * Start Google sign-in.
 *
 * The login screen has linked here since the first commit; the route did not
 * exist, so `DEMO_MODE=false` produced an app nobody could enter. This is that
 * missing half — it only mints the provider URL and redirects. The session is
 * established in `/api/auth/callback`.
 *
 * Distinct from `/api/integrations/google/*`, which connects Gmail and Calendar
 * for an already-authenticated user. This one decides *who you are*; that one
 * decides what the app may read on your behalf. They share a Google client and
 * nothing else.
 */
export async function GET(request: Request) {
  const origin = env().appUrl;

  // Demo mode has its own entry and no real identity provider behind it.
  if (isDemoMode()) {
    return NextResponse.redirect(new URL('/login', origin));
  }

  const supabase = await supabaseServerClient();
  if (!supabase) {
    return NextResponse.redirect(new URL('/login?error=not_configured', origin));
  }

  // Preserve where the user was heading, but only within this app — an
  // attacker-supplied absolute URL here would make this an open redirect.
  const requested = new URL(request.url).searchParams.get('next');
  const next =
    requested && requested.startsWith('/') && !requested.startsWith('//') ? requested : '/today';

  const callback = new URL('/api/auth/callback', origin);
  callback.searchParams.set('next', next);

  const allowed = env().authAllowedDomains;
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: callback.toString(),
      queryParams: {
        prompt: 'select_account',
        // A hint to Google's account chooser when there is exactly one
        // permitted domain. It is a convenience, never the check — the
        // callback verifies the address it actually receives.
        ...(allowed.length === 1 ? { hd: allowed[0] as string } : {}),
      },
    },
  });

  if (error || !data?.url) {
    return NextResponse.redirect(new URL('/login?error=provider', origin));
  }

  return NextResponse.redirect(data.url);
}
