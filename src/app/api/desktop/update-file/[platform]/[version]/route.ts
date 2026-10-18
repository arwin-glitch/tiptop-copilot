import { NextResponse, type NextRequest } from 'next/server';
import { isDemoMode } from '@/lib/config/env';
import { findUpdateFile, openUpdateFile } from '@/lib/desktop/releases';
import {
  DESKTOP_UPDATE_FILES,
  isInstallerPlatform,
  parseDesktopVersion,
} from '@/lib/desktop/shared';
import { addressKey } from '@/lib/security/client-address';
import { rateLimit, rateLimitHasRoom } from '@/lib/security/limits';
import { log } from '@/lib/security/redact';
import { err, statusForError, type AppError } from '@/lib/util/result';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };
const FILE_CEILING = 'desktop-update-file';
const HOUR_MS = 3_600_000;

function fail(error: AppError, status = statusForError(error.code)): NextResponse {
  return NextResponse.json({ ok: false, error }, { status, headers: NO_STORE });
}

function limited(): NextResponse {
  return fail(err('rate_limited', 'Too many update downloads. Try again later.').error);
}

/** Fresh wording, never the upstream's. */
function unavailable(error: AppError): NextResponse {
  return error.code === 'not_found'
    ? fail(err('not_found', 'That update is not available.').error)
    : fail(err('provider_unavailable', 'The update could not be fetched just now.').error, 503);
}

/**
 * The file the desktop app's updater downloads, at the URL the update check
 * gave it (/api/desktop/update), streamed from the release without being
 * buffered. Only the version the check offers right now is served; any other
 * is a 404, and the app simply checks again later.
 *
 * Public for the same reason as the check. The app verifies the signature of
 * every byte before installing, so this route is trusted with nothing. The
 * bytes pass through exactly as published: no Content-Encoding is ever set.
 * The brakes are tighter than the check's, since each answer is a large
 * file: a few installs an hour is all that real use needs. The ceiling for
 * everyone counts only files that will stream: a version not on offer is
 * answered from the cached manifest, so it spends its caller's own limit and
 * cannot hold up anyone else's download.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ platform: string; version: string }> },
) {
  const { platform, version: raw } = await context.params;
  const version = parseDesktopVersion(raw);
  if (!isInstallerPlatform(platform) || !version || version !== raw) {
    return fail(err('not_found', 'There is no such update.').error);
  }

  if (
    !rateLimitHasRoom(FILE_CEILING, 30) ||
    !rateLimit(`${FILE_CEILING}:${addressKey(request.headers)}`, 10, HOUR_MS).ok
  ) {
    return limited();
  }

  if (isDemoMode()) return fail(err('not_found', 'That update is not available.').error);

  const found = await findUpdateFile(platform, version);
  if (!found.ok) return unavailable(found.error);
  if (!rateLimit(FILE_CEILING, 30, HOUR_MS).ok) return limited();

  const opened = await openUpdateFile(found.value, request.signal);
  if (!opened.ok) return unavailable(opened.error);

  log.info('Desktop update file served', { platform, version });
  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${DESKTOP_UPDATE_FILES[platform]}"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (opened.value.bytes) headers['Content-Length'] = String(opened.value.bytes);
  return new Response(opened.value.body, { headers });
}
