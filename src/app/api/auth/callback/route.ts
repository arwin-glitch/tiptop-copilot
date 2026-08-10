import { NextResponse } from 'next/server';
import { isEmailAllowed } from '@/lib/auth/domain';
import { supabaseServerClient } from '@/lib/auth/session';
import { env, isDemoMode } from '@/lib/config/env';

export const dynamic = 'force-dynamic';

/**
 * Complete Google sign-in.
 *
 * Exchanges the authorization code for a session, then applies the one check
 * the database does not: the email domain. `on_auth_user_created` provisions an
 * organization with owner role for every new user, so without a domain gate any
 * Google account reaching this route would be handed its own workspace — which
 * is not what the login screen promises.
 *
 * A rejected address is signed straight back out. Leaving the Supabase session
 * in place would mean the proxy sees a session cookie and stops redirecting to
 * /login, stranding the visitor in an app they have no membership in.
 */
export async function GET(request: Request) {
  const origin = env().appUrl;
  const url = new URL(request.url);

  if (isDemoMode()) {
    return NextResponse.redirect(new URL('/login', origin));
  }

  const errorParam = url.searchParams.get('error');
  if (errorParam) {
    // The user declined at Google's consent screen, or the provider failed.
    return NextResponse.redirect(new URL('/login?error=denied', origin));
  }

  const code = url.searchParams.get('code');
  if (!code) {
    return NextResponse.redirect(new URL('/login?error=no_code', origin));
  }

  const supabase = await supabaseServerClient();
  if (!supabase) {
    return NextResponse.redirect(new URL('/login?error=not_configured', origin));
  }

  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data?.user) {
    return NextResponse.redirect(new URL('/login?error=exchange', origin));
  }

  if (!isEmailAllowed(data.user.email)) {
    await supabase.auth.signOut();
    return NextResponse.redirect(new URL('/login?error=domain', origin));
  }

  const requested = url.searchParams.get('next');
  const next =
    requested && requested.startsWith('/') && !requested.startsWith('//') ? requested : '/today';

  return NextResponse.redirect(new URL(next, origin));
}
