import { NextResponse } from 'next/server';
import { authOrError } from '@/lib/auth/session';
import { isDemoMode } from '@/lib/config/env';
import { openInstaller } from '@/lib/desktop/releases';
import { DESKTOP_INSTALLERS, isInstallerPlatform } from '@/lib/desktop/shared';
import { getStore } from '@/lib/runtime';
import { recordAudit } from '@/lib/security/audit';
import { clientAddress } from '@/lib/security/client-address';
import { rateLimit } from '@/lib/security/limits';
import { err, statusForError } from '@/lib/util/result';

export const dynamic = 'force-dynamic';

/** Back to the download page with a notice. Relative, so it stays on the host it came from. */
function backToDownload(query: string): Response {
  return new Response(null, { status: 303, headers: { Location: `/download?${query}` } });
}

/**
 * Download the desktop app's installer, through Copilot.
 *
 * The file is streamed from where releases are published (lib/desktop/
 * releases.ts) without being buffered, so a 10 MB installer costs this
 * server no memory to speak of, and nobody is ever sent to another site.
 * Signed in only. Anything that goes wrong lands back on /download with a
 * plain notice rather than an error page.
 */
export async function GET(request: Request, context: { params: Promise<{ platform: string }> }) {
  const auth = await authOrError();
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: statusForError(auth.error.code) },
    );
  }

  const { platform } = await context.params;
  if (!isInstallerPlatform(platform)) {
    const missing = err('not_found', 'There is no installer for that platform.');
    return NextResponse.json(missing, { status: 404 });
  }

  const limited = rateLimit(`desktop-download:${auth.value.userId}`, 20, 3_600_000);
  if (!limited.ok) {
    return NextResponse.json(
      { ok: false, error: limited.error },
      { status: statusForError(limited.error.code) },
    );
  }

  if (isDemoMode()) return backToDownload(`unavailable=${platform}`);

  const opened = await openInstaller(platform, request.signal);
  if (!opened.ok) {
    return backToDownload(
      opened.error.code === 'not_found' ? `unavailable=${platform}` : `failed=${platform}`,
    );
  }

  await recordAudit(getStore(), {
    organizationId: auth.value.organizationId,
    userId: auth.value.userId,
    action: 'desktop.installer_downloaded',
    entityType: 'desktop_installer',
    entityId: null,
    metadata: { platform },
    ip: clientAddress(request.headers),
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${DESKTOP_INSTALLERS[platform]}"`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (opened.value.bytes) headers['Content-Length'] = String(opened.value.bytes);
  return new Response(opened.value.body, { headers });
}
