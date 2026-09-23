import { NextResponse } from 'next/server';
import { authOrError } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { log } from '@/lib/security/redact';
import { pullDealsFromSlack, readDealsVersion } from '@/lib/services/deal-relay';
import { statusForError } from '@/lib/util/result';

export const dynamic = 'force-dynamic';

/**
 * The Deals page's open-tab watcher polls this to learn whether the pipeline
 * it shows is stale. It runs the throttled relay pull first, so a tab left
 * open picks up the deal-sorter's posts without anyone reloading, and returns
 * a fingerprint only — never deal content.
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
    await pullDealsFromSlack(store, auth.value.organizationId);
    const version = await readDealsVersion(store, auth.value.organizationId);
    return NextResponse.json({ version }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    // The watcher backs off on this status; a stack trace per open tab per
    // poll would only repeat what the page itself already shows.
    log.warn('Deals version check failed', {
      reason: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
    });
    return NextResponse.json(
      { ok: false, error: { code: 'internal', message: 'The pipeline is unavailable.' } },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
