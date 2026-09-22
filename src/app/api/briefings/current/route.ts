import { NextResponse } from 'next/server';
import { authOrError } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { log } from '@/lib/security/redact';
import { readBriefingVersion } from '@/lib/services/briefing';
import { statusForError } from '@/lib/util/result';

export const dynamic = 'force-dynamic';

/**
 * The Today page's open-tab watcher polls this to learn whether its briefing
 * cards are stale. It returns a fingerprint only, never card content, so the
 * page decides for itself when a full refresh is worth doing.
 */
export async function GET() {
  const auth = await authOrError();
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: statusForError(auth.error.code) },
    );
  }

  try {
    const version = await readBriefingVersion(getStore(), auth.value.organizationId);
    return NextResponse.json({ version }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    // A briefing-store fault is the Today page's to show, and it already
    // tolerates one; answered with a stack trace, every open tab's poll would
    // log it again. The watcher backs off on this status.
    log.warn('Briefing version check failed', {
      reason: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
    });
    return NextResponse.json(
      { ok: false, error: { code: 'internal', message: 'Briefing cards are unavailable.' } },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
