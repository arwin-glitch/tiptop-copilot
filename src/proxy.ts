import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { isSupabaseAuthCookie } from '@/lib/auth/cookies';
import {
  NONCE_HEADER,
  SURFACE_HEADER,
  allowsCamera,
  eventCsp,
  isEventPublicPath,
  isPrivateEventPath,
  isPublicSurfacePath,
  newNonce,
  wantsEventCsp,
} from '@/lib/events/surface';
import { boardHostOrigin } from '@/lib/jobs-board/config';
import {
  boardHosts,
  isCopilotBoardPath,
  requestHosts,
  routeBoardHost,
} from '@/lib/jobs-board/host';
import { boardRequestAllowed } from '@/lib/jobs-board/rate-limit';

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
  // Event pages (D-075): /e/<slug>, personal invites and tickets, check-in
  // QR landings, and the outside-editor and staff entries. Guests and
  // outsiders have no Copilot session by design. Every page reads only the
  // PUBLISHED snapshot through lib/services/event-public.ts, filtered for the
  // viewer on the server; editor and staff pages re-check their link's
  // cookie on every request (lib/events/editor-auth.ts). /events (the
  // signed-in tab) stays private: the prefix test is segment-exact.
  '/e',
  // Their API: RSVP, invite responses, the view beacon, check-in, and the
  // outside editor's scoped draft/ops/sync/media proxies. Each handler works
  // out its actor (grant cookie, guest token, or nobody) and calls narrow
  // services that take (eventId, actor) and return whitelisted fields only;
  // nothing here reaches any other Copilot data. /api/events stays signed in.
  '/api/e',
  // DEMO MODE ONLY: the stand-in for the two event storage buckets — the
  // public bucket's public URLs, and signed upload/download URLs that carry
  // their own expiring HMAC token, as Supabase's do. Each route answers 404
  // unless the local demo storage is the one in use (lib/storage/event-storage.ts).
  '/api/event-media',
  // The public job board (D-077): open roles at portfolio companies, for
  // anyone. Its pages show only roles a person published, and say "coming
  // soon" with no data while the board is switched off. Handled before this
  // list is read (see proxy()); listed so the list stays the whole story.
  // /jobs-preview, the signed-in preview, is not matched and stays private.
  '/jobs',
];

/**
 * Refresh the Supabase session, persisting any rotated tokens onto `response`.
 *
 * Deliberately forgiving: a failure here must not block the request. An expired
 * or invalid session should surface as "not signed in" at the page, which
 * redirects to /login with an explanation — not as a proxy-level error on every
 * route including the login page itself.
 */
async function refreshSession(
  request: NextRequest,
  forward: () => NextResponse = () => NextResponse.next({ request }),
): Promise<NextResponse> {
  // Read process.env directly rather than through `env()`: this module is
  // reached by the proxy runtime, and the config module is `server-only`.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return forward();

  let response = forward();

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
          response = forward();
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

  // The job board's own host (jobs.tiptop.vc) is the board and nothing else:
  // every address there is rewritten to the board's pages, which need no
  // session, so the rest of this function never runs for it. An address that
  // is not shaped like a board page is a plain 404 here, before any page
  // renders, and board pages are braked per address (lib/jobs-board/rate-limit.ts).
  const board = routeBoardHost(pathname, requestHosts(request.headers), boardHosts(process.env));
  if (board.kind === 'not_found') return notFound();
  if (board.kind === 'serve') {
    // The board host's own files: public, never through Copilot's sign-in.
    if (pathname.endsWith('/opengraph-image') && !boardRequestAllowed(request.headers, pathname)) {
      return tooManyRequests();
    }
    return withSecurityHeaders(passThrough(request));
  }
  if (board.kind === 'redirect') {
    if (!boardRequestAllowed(request.headers, pathname)) return tooManyRequests();
    // Absolute (Next refuses a relative Location here), and its origin comes
    // from the environment, never from a request header.
    const target = new URL(`${board.pathname}${request.nextUrl.search}`, boardHostOrigin());
    return withSecurityHeaders(NextResponse.redirect(target, 308));
  }
  if (board.kind === 'rewrite') {
    if (!boardRequestAllowed(request.headers, pathname)) return tooManyRequests();
    const target = request.nextUrl.clone();
    target.pathname = board.pathname;
    return withSecurityHeaders(
      hasSurfaceHeaders(request)
        ? NextResponse.rewrite(target, { request: { headers: appSurfaceHeaders(request) } })
        : NextResponse.rewrite(target),
    );
  }

  // The board at Copilot's own /jobs: public, braked like the board host, and
  // never through the session refresh below, so a rotated session cookie can
  // never ride on a public page. A /jobs address the board does not serve is
  // a 404 before any page renders.
  const copilotBoard = isCopilotBoardPath(pathname);
  if (copilotBoard === false) return notFound();
  if (copilotBoard === true) {
    if (!boardRequestAllowed(request.headers, pathname)) return tooManyRequests();
    return withSecurityHeaders(passThrough(request));
  }

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
  // The public surface (lib/events/surface.ts): event pages and booking get
  // a request header the root layout reads to leave Copilot's chrome off,
  // and /e/* pages a fresh nonce and their own strict CSP, which Next.js
  // reads off the request to stamp its scripts. A client cannot fake either
  // header onto another page: both are stripped from every request that
  // carries them.
  const eventPage = wantsEventCsp(pathname);
  const nonce = eventPage ? newNonce() : null;
  const csp = nonce
    ? eventCsp({
        nonce,
        supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL,
        turnstile: Boolean(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY),
        dev: process.env.NODE_ENV === 'development',
      })
    : null;
  const surface: SurfaceExtras = {
    publicSurface: isPublicSurfacePath(pathname),
    nonce,
    csp,
  };
  const rewriteHeaders =
    surface.publicSurface ||
    eventPage ||
    request.headers.has(SURFACE_HEADER) ||
    request.headers.has(NONCE_HEADER);
  const forward = () => forwardRequest(request, surface);

  const response =
    supabaseSession && !pathname.startsWith('/api/auth/desktop/')
      ? await refreshSession(request, rewriteHeaders ? forward : undefined)
      : rewriteHeaders
        ? forward()
        : NextResponse.next();

  // The relayed briefing page sets its own, stricter, sandboxing CSP; a second
  // policy added here would be intersected with it and block its print button.
  if (OWN_CSP_PATH.test(pathname)) return withSecurityHeaders(response, { ownCsp: true });
  // Event pages: their nonce CSP, no Referer to anywhere (a personal invite's
  // token is in its path), and never indexed where the path is personal.
  if (csp) {
    return withSecurityHeaders(response, {
      csp,
      referrer: 'no-referrer',
      noindex: isPrivateEventPath(pathname),
      camera: allowsCamera(pathname),
    });
  }
  if (isEventPublicPath(pathname)) {
    return withSecurityHeaders(response, { referrer: 'no-referrer' });
  }
  return withSecurityHeaders(response);
}

interface SurfaceExtras {
  publicSurface: boolean;
  nonce: string | null;
  csp: string | null;
}

/**
 * Pass the request on with the surface headers set, or stripped. Built from
 * the request's headers at call time, so a cookie the session refresh has
 * just rotated onto the request is carried too.
 */
function forwardRequest(request: NextRequest, surface: SurfaceExtras): NextResponse {
  const headers = new Headers(request.headers);
  headers.delete(NONCE_HEADER);
  headers.delete('content-security-policy');
  // Always SET the flag, never just delete it: Next applies an override only
  // when the new header list is non-empty, so this also guarantees a forged
  // value is replaced rather than passed through.
  headers.set(SURFACE_HEADER, surface.publicSurface ? 'public' : 'app');
  if (surface.nonce && surface.csp) {
    headers.set(NONCE_HEADER, surface.nonce);
    headers.set('Content-Security-Policy', surface.csp);
  }
  return NextResponse.next({ request: { headers } });
}

/** Whether a request carries either surface header (only a forged one can reach here). */
function hasSurfaceHeaders(request: NextRequest): boolean {
  return request.headers.has(SURFACE_HEADER) || request.headers.has(NONCE_HEADER);
}

/** The request's headers marked as Copilot's own surface, with any forged nonce or CSP gone. */
function appSurfaceHeaders(request: NextRequest): Headers {
  const headers = new Headers(request.headers);
  headers.delete(NONCE_HEADER);
  headers.delete('content-security-policy');
  headers.set(SURFACE_HEADER, 'app');
  return headers;
}

/**
 * The job board's pass-through (D-077), which returns before the surface
 * handling below: untouched, unless a client forged a surface header onto
 * it, which is replaced the same way forwardRequest does.
 */
function passThrough(request: NextRequest): NextResponse {
  return hasSurfaceHeaders(request)
    ? NextResponse.next({ request: { headers: appSurfaceHeaders(request) } })
    : NextResponse.next();
}

function notFound(): NextResponse {
  return withSecurityHeaders(
    new NextResponse('Not found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    }),
  );
}

function tooManyRequests(): NextResponse {
  return withSecurityHeaders(
    new NextResponse('Too many requests. Try again in a minute.', {
      status: 429,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '60' },
    }),
  );
}

/** Routes that set their own Content-Security-Policy. */
const OWN_CSP_PATH = /^\/api\/briefings\/[a-z]+\/view$/;

function withSecurityHeaders(
  response: NextResponse,
  options: {
    ownCsp?: boolean;
    /** A route-specific policy in place of Copilot's (event pages). */
    csp?: string;
    referrer?: 'no-referrer';
    noindex?: boolean;
    camera?: boolean;
  } = {},
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

  if (!options.ownCsp) response.headers.set('Content-Security-Policy', options.csp ?? csp);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', options.referrer ?? 'strict-origin-when-cross-origin');
  response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  response.headers.set(
    'Permissions-Policy',
    `camera=${options.camera ? '(self)' : '()'}, microphone=(), geolocation=(), payment=(), usb=()`,
  );
  if (options.noindex) response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image).*)'],
};
