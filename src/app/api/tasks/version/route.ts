import { NextResponse } from 'next/server';
import { authOrError } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { log } from '@/lib/security/redact';
import { pullTaskRelays, readTasksVersion } from '@/lib/services/task-relay';
import { statusForError } from '@/lib/util/result';

export const dynamic = 'force-dynamic';

/**
 * The Tasks page's open-tab watcher polls this to learn whether what it shows
 * is stale. It runs the throttled task pull first (additions, closes, the 4pm
 * reply check), so a tab left open picks them up without a reload, and
 * returns a fingerprint only — never task content.
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
    const store = getStore();
    await pullTaskRelays(store, auth.value.organizationId);
    const version = await readTasksVersion(store, auth.value.organizationId);
    return NextResponse.json({ version }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    log.warn('Tasks version check failed', {
      reason: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
    });
    return NextResponse.json(
      { ok: false, error: { code: 'internal', message: 'Tasks are unavailable.' } },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
