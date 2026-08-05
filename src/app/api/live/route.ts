import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Public liveness probe.
 *
 * Deliberately says nothing beyond "the process is up". No version, no
 * configuration, no dependency status — anything that could help someone
 * fingerprint the deployment requires a session (see /api/health).
 */
export function GET() {
  return NextResponse.json({ status: 'ok' }, { headers: { 'Cache-Control': 'no-store' } });
}
