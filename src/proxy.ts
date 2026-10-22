import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { isSupabaseAuthCookie } from '@/lib/auth/cookies';

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
const PUBLIC_PATHS = [
  '/login',
  '/privacy',
  '/api/live',
  '/api/auth',
  // The system browser lands on these during a desktop app sign-in, before
  // anyone is signed in (lib/auth/desktop-handoff.ts). Listed one by one
  // rather than opening /desktop, so nothing added there later is public by
  // accident.
  '/desktop/callback',
  '/desktop/done',
  // The desktop app's updater checks and downloads with no session: it is a
  // plain HTTP client inside the app, apart from its window. Both routes serve
  // only what every release already holds, the app checks each file's
  // signature before installing, and each route brakes per address. Listed
  // one by one: /api/desktop/download stays signed in.
  '/api/desktop/update',
  '/api/desktop/update-file',
  // The desktop app's alerts: its shell asks with its own HTTP client, apart
  // from the window, so no session cookie. A per-computer bearer token,
  // checked by the route with its own brakes (lib/desktop/alerts-endpoint.ts).
  // /api/push/desktop, which hands out those tokens, stays signed in.
  '/api/desktop/alerts',
  '/api/cron',
  // Cloud Pub/Sub delivers Gmail notifications here and carries no session
  // cookie. Listed individually rather than opening /api/integrations, which
  // is otherwise session-authenticated; the route checks its own shared secret.
  '/api/integrations/google/gmail-push',
  // Machine endpoint like gmail-push: authenticates with its own shared
  // secret, compared in constant time inside the route.
  '/api/integrations/granola/webhook',
  // Same shared-secret contract; imports the Granola backlog on demand.
  '/api/integrations/granola/backfill',
  // Same shared-secret contract; the Daily Overview/Recap cloud routines post
  // here and carry no session cookie either.
  '/api/integrations/briefing/webhook',
  // Same shared-secret contract; an external Claude session with live
  // Gmail/Calendar/Slack access reads and answers pending Ask questions here,
  // and carries no session cookie either.
  '/api/integrations/ask-bridge/webhook',
  // Same shared-secret contract; the watchers that notice a new investment
  // post it here (add-only) and carry no session cookie either.
  '/api/integrations/portfolio/webhook',
  // Same shared-secret contract; the watcher that notices new follow-ups
  // posts them here (add-only) and carries no session cookie either.
  '/api/integrations/tasks/webhook',
  // The MCP server Claude reads the CRM through. Its clients (claude.ai
  // connectors, Claude Code, the cloud routines) carry a per-client token —
  // a Bearer header or the last path segment — never a session cookie; the
  // route checks the token itself (lib/mcp/http.ts).
  '/api/mcp',
  // The booking link (D-074): the public page where people ask for time with
  // Nick (/meet/<slug>, and its photo), and its three API routes (open times,
  // a request, the chatbot). Only these two prefixes: '/meetings' and the
  // rest of /api stay signed in. The routes read busy times only, write only
  // a pending request, brake per address and check where a write came from.
  '/meet',
  '/api/meet',
  // Campaign tracking: the open pixel, tracked links and unsubscribe, loaded
  // by recipients' mail clients with no session. Each route authenticates by
  // its signed per-recipient token, and the click route redirects only to a
  // link from that campaign's own body.
  '/t',
];

/**
 * Refresh the Supabase session, persisting any rotated tokens onto `response`.
 *
 * Deliberately forgiving: a failure here must not block the request. An expired
 * or invalid session should surface as "not signed in" at the page, which
 * redirects to /login with an explanation — not as a proxy-level error on every
 * route including the login page itself.
 */
async function refreshSession(request: NextRequest): Promise<NextResponse> {
  // Read process.env directly rather than through `env()`: this module is
  // reached by the proxy runtime, and the config module is `server-only`.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return NextResponse.next({ request });

  let response = NextResponse.next({ request });

  try {
    const supabase = createServerClient(url, key, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          // Both halves are load-bearing, and writing only one is worse than
          // writing neither.
          //
          // The request copy is what the Server Component downstream will read.
          // Without it, that component sees the *old* refresh token — which
          // Supabase has just retired, because rotation is single-use — tries
          // to refresh with it, fails, and resolves to "not signed in".
          //
          // The response copy is what reaches the browser, so the next request
          // carries the new pair rather than the retired one.
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
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

  return response;
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
  const supabaseSession = request.cookies.getAll().some((c) => isSupabaseAuthCookie(c.name));

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

  // Only when a Supabase session is actually present. Demo sessions are signed
  // by this app and need no refresh, and an anonymous visitor has nothing to
  // rotate — calling out to Supabase for either would add a network round trip
  // to every static asset request for no reason.
  //
  // Never on the desktop sign-in routes, which need no session. A stale
  // session cookie in the app's window would fail to refresh, and auth-js
  // then clears every PKCE verifier in the request too: the very verifier the
  // sign-in is about to use, which would burn Google's single-use code.
  const response =
    supabaseSession && !pathname.startsWith('/api/auth/desktop/')
      ? await refreshSession(request)
      : NextResponse.next();

  // The relayed briefing page sets its own, stricter, sandboxing CSP; a second
  // policy added here would be intersected with it and block its print button.
  if (OWN_CSP_PATH.test(pathname)) return withSecurityHeaders(response, { ownCsp: true });
  return withSecurityHeaders(response);
}

/** Routes that set their own Content-Security-Policy. */
const OWN_CSP_PATH = /^\/api\/briefings\/[a-z]+\/view$/;

function withSecurityHeaders(
  response: NextResponse,
  options: { ownCsp?: boolean } = {},
): NextResponse {
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

  if (!options.ownCsp) response.headers.set('Content-Security-Policy', csp);
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
