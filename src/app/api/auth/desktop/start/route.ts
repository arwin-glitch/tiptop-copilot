import { NextResponse, type NextRequest } from 'next/server';
import {
  createHandoff,
  demoHandoffs,
  HANDOFF_TTL_MS,
  isSameOrigin,
  mintHandoffSecrets,
  platformFromUserAgent,
  POLL_COOKIE,
  pollCookieOptions,
  supersede,
  sweep,
} from '@/lib/auth/desktop-handoff';
import { supabaseServerClient } from '@/lib/auth/session';
import { env } from '@/lib/config/env';
import type { DataStore } from '@/lib/db/store';
import { getStore } from '@/lib/runtime';
import { addressKey } from '@/lib/security/client-address';
import { rateLimit, rateLimitHasRoom } from '@/lib/security/limits';
import { err, statusForError, type AppError } from '@/lib/util/result';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };
const START_CEILING = 'desktop-handoff-start';

function fail(error: AppError, status = statusForError(error.code)): NextResponse {
  return NextResponse.json({ ok: false, error }, { status, headers: NO_STORE });
}

/**
 * Start a desktop app sign-in (lib/auth/desktop-handoff.ts).
 *
 * Called by the app's own login page. It answers with the Google sign-in URL
 * for the system browser and nothing secret: the poll cookie is httpOnly, and
 * the short code does not exist until the browser has signed in. Supabase's
 * PKCE verifier is written into the app's cookies by `supabaseServerClient`,
 * exactly as /api/auth/google does for the web.
 *
 * Abuse brakes: one limit per address (IPv6 by /64) and a ceiling for
 * everyone. The ceiling is looked at first, so once a flood from many
 * addresses reaches it no new per-address entries are made in memory; but only
 * requests within their own address's limit count against it, so a single
 * caller cannot use it up and lock everyone else out.
 */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return fail(err('forbidden', 'This request must come from Kraken itself.').error);
  }

  const allowed =
    rateLimitHasRoom(START_CEILING, 120) &&
    rateLimit(`desktop-handoff-start:${addressKey(request.headers)}`, 20, 60_000).ok &&
    rateLimit(START_CEILING, 120, 60_000).ok;
  if (!allowed) {
    return fail(
      err('rate_limited', 'Too many sign-ins were started. Try again in a minute.').error,
    );
  }

  const notConfigured = () =>
    fail(err('not_configured', 'Sign-in is not configured on this server.').error);
  let demo: boolean;
  let store: DataStore;
  try {
    // getStore() refuses outside demo mode when no database is configured.
    demo = demoHandoffs();
    store = getStore();
  } catch {
    return notConfigured();
  }
  const supabase = demo ? null : await supabaseServerClient();
  if (!demo && !supabase) return notConfigured();

  const now = new Date();
  await supersede(store, request.cookies.get(POLL_COOKIE)?.value);
  await sweep(store, now);

  const secrets = mintHandoffSecrets();
  let url: string;
  let flowId: string | null = null;
  if (demo || !supabase) {
    // Same origin and relative: the demo has no identity provider to send the
    // browser to, so its "Google" is the callback page itself.
    url = `/desktop/callback?h=${secrets.handoffId}&code=demo`;
  } else {
    const redirectTo = new URL('/desktop/callback', env().appUrl);
    redirectTo.searchParams.set('h', secrets.handoffId);
    const allowed = env().authAllowedDomains;
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: redirectTo.toString(),
        queryParams: {
          prompt: 'select_account',
          // A hint to the account chooser, never the check; the exchange
          // verifies the address it actually receives.
          ...(allowed.length === 1 ? { hd: allowed[0] as string } : {}),
        },
      },
    });
    if (error || !data?.url) {
      return fail(err('provider_unavailable', 'Google sign-in could not be started.').error);
    }
    url = data.url;
    flowId = data.flowId ?? null;
  }

  const created = await createHandoff(store, {
    secrets,
    flowId,
    platform: platformFromUserAgent(request.headers.get('user-agent')),
    now,
  });
  if (!created.ok) return fail(created.error);

  const response = NextResponse.json(
    { ok: true, value: { url, expiresAt: created.value.expires_at } },
    { headers: NO_STORE },
  );
  response.cookies.set(POLL_COOKIE, secrets.pollSecret, pollCookieOptions(HANDOFF_TTL_MS / 1000));
  return response;
}
