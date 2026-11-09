import { NextResponse, type NextRequest } from 'next/server';
import { authOrError, hasRole } from '@/lib/auth/session';
import { harmonicCheck } from '@/lib/integrations/harmonic';
import { harmonicCallTool } from '@/lib/integrations/harmonic-mcp';
import { getStore } from '@/lib/runtime';
import { statusForError } from '@/lib/util/result';

export const dynamic = 'force-dynamic';

/**
 * Admins only: what Harmonic answers for a query (status, counts, the first
 * result), to check the HARMONIC_API_KEY connection. Never returns the key.
 */
export async function GET(request: NextRequest) {
  const auth = await authOrError();
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: statusForError(auth.error.code) },
    );
  }
  if (!hasRole(auth.value, 'admin')) {
    return NextResponse.json({ ok: false }, { status: 403 });
  }
  const q = (request.nextUrl.searchParams.get('q') ?? 'rippling').slice(0, 80);
  if (request.nextUrl.searchParams.get('mcp') === '1') {
    const started = Date.now();
    const res = await harmonicCallTool(getStore(), auth.value.organizationId, 'entity_lookup', {
      query: q,
    });
    return NextResponse.json(
      res.ok
        ? { ok: true, ms: Date.now() - started, text: res.value.slice(0, 1500) }
        : { ok: false, ms: Date.now() - started, error: res.error },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return NextResponse.json(await harmonicCheck(q), { headers: { 'Cache-Control': 'no-store' } });
}
