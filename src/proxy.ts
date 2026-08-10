import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Next.js 16 renamed `middleware` to `proxy`. This runs on the Node runtime.
 *
 * Scope, deliberately narrow: session *presence*, session *refresh*, and
 * security headers. Real authorization lives in the services, where the
 * organization scope and the record are both available — a proxy that made
 * authorization decisions would be a second, weaker copy of that logic.
 *
 * The refresh is not optional, and its absence caused a redirect loop that took
 * a live deployment down. Supabase rotates the refresh token when it issues a
 * new access token, and the rotated pair must be written back as cookies. A
 * Server Component cannot set cookies, so `supabaseServerClient()` swallows the
 * write — its comment said "the session refresh still happens in the proxy",
 * which was simply untrue until this function existed. The rotated token was
 * therefore discarded on every render: `/login` would still see a session and
 * redirect to `/today`, `/today` would see none and redirect back.
 *
 * This is the one place in the request cycle that can both read the incoming
 * cookies and write outgoing ones, which is why the refresh belongs here.
 */

const SESSION_COOKIES = ['tiptop_session', 'tiptop_demo_session'];

/** Paths reachable without a session. */
const PUBLIC_PATHS = ['/login', '/privacy', '/api/live', '/api/auth', '/api/cron'];

/**
 * Refresh the Supabase session, persisting any rotated tokens onto `response`.
 *
 * Deliberately forgiving: a failure here must not block the request. An expired
 * or invalid session should surface as "not signed in" at the page, which
 * redirects to /login with an explanation — not as a proxy-level error on every
 * route including the login page itself.
 */
async function refreshSession(request: NextRequest, response: NextResponse): Promise<void> {
  // Read process.env directly rather than through `env()`: this module is
  // reached by the proxy runtime, and the config module is `server-only`.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return;

  try {
    const supabase = createServerClient(url, key, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    });
    // The call itself is what triggers a refresh when the access token is near
    // expiry. The result is discarded — the pages resolve identity themselves.
    await supabase.auth.getUser();
  } catch {
    // Network blip, misconfigured project, malformed cookie. Let the request
    // through and let the page decide what to show.
  }
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  const isPublic =
    PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`)) ||
    pathname.startsWith('/_next') ||
    pathname === '/manifest.webmanifest' ||
    pathname === '/sw.js' ||
    pathname === '/icon.svg' ||
    /\.(png|jpg|jpeg|svg|ico|webmanifest|txt)$/.test(pathname);

  const hasSession = SESSION_COOKIES.some((name) => request.cookies.has(name));
  const supabaseSession = request.cookies
    .getAll()
    .some((c) => c.name.startsWith('sb-') && c.name.endsWith('-auth-token'));

  if (!isPublic && !hasSession && !supabaseSession) {
    // API routes get a 401 rather than an HTML redirect so clients can act on it.
    if (pathname.startsWith('/api/')) {
      return withSecurityHeaders(
        NextResponse.json(
          { ok: false, error: { code: 'unauthenticated', message: 'Sign in to continue.' } },
          { status: 401 },
        ),
      );
    }
    const target = new URL('/login', request.url);
    return withSecurityHeaders(NextResponse.redirect(target));
  }

  const response = NextResponse.next();

  // Only when a Supabase session is actually present. Demo sessions are signed
  // by this app and need no refresh, and an anonymous visitor has nothing to
  // rotate — calling out to Supabase for either would add a network round trip
  // to every static asset request for no reason.
  if (supabaseSession) {
    await refreshSession(request, response);
  }

  return withSecurityHeaders(response);
}

function withSecurityHeaders(response: NextResponse): NextResponse {
  // 'unsafe-inline' on script-src is required for the Next.js bootstrap and the
  // pre-paint theme script. There is no user- or model-supplied HTML anywhere in
  // this app — every such string renders as text through <PlainText> — so the
  // XSS surface this would normally widen does not exist here.
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' https://*.supabase.co https://*.supabase.in",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join('; ');

  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  response.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  );
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image).*)'],
};
