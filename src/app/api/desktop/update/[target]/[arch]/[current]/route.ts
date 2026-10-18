import { NextResponse, type NextRequest } from 'next/server';
import { isDemoMode } from '@/lib/config/env';
import { latestUpdateManifest } from '@/lib/desktop/releases';
import { parseUpdateQuery, updateAnswer } from '@/lib/desktop/updates';
import { addressKey } from '@/lib/security/client-address';
import { rateLimit, rateLimitHasRoom } from '@/lib/security/limits';
import { log } from '@/lib/security/redact';
import { err, statusForError, type AppError } from '@/lib/util/result';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };
const CHECK_CEILING = 'desktop-update-check';

function fail(error: AppError, status = statusForError(error.code)): NextResponse {
  return NextResponse.json({ ok: false, error }, { status, headers: NO_STORE });
}

function nothingNew(): Response {
  return new Response(null, { status: 204, headers: NO_STORE });
}

/**
 * The desktop app's update check (lib/desktop/updates.ts), in the format its
 * updater reads: 204 when there is nothing newer, otherwise the version, the
 * file's signature and a URL on this domain to download it from.
 *
 * Public: the updater is a plain HTTP client inside the app with no session,
 * and it learns only what every release already shows. Nothing about the
 * caller is read, stored or logged beyond the abuse brakes, which work as in
 * /api/auth/desktop/start: one limit per address, then a ceiling for everyone
 * that only requests within their own limit use up.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ target: string; arch: string; current: string }> },
) {
  const { target, arch, current } = await context.params;
  const query = parseUpdateQuery(target, arch, current);
  if (!query.ok) return fail(err('invalid_input', 'Unknown platform or version.').error);

  const allowed =
    rateLimitHasRoom(CHECK_CEILING, 1200) &&
    rateLimit(`${CHECK_CEILING}:${addressKey(request.headers)}`, 30, 3_600_000).ok &&
    rateLimit(CHECK_CEILING, 1200, 3_600_000).ok;
  if (!allowed) {
    return fail(err('rate_limited', 'Too many update checks. Try again later.').error);
  }

  if (isDemoMode() || !query.target) return nothingNew();
  const latest = await latestUpdateManifest();
  // Not 204: a manual check must never hear "up to date" when nobody looked.
  if (latest.state === 'unknown') {
    return fail(err('provider_unavailable', 'Updates could not be checked just now.').error, 503);
  }
  if (latest.state === 'none') return nothingNew();
  const answer = updateAnswer(latest.manifest, query.target, query.current);
  if (!answer) return nothingNew();

  log.info('Desktop update offered', {
    target: query.target,
    from: query.current,
    to: answer.version,
  });
  return NextResponse.json(answer, { headers: NO_STORE });
}
