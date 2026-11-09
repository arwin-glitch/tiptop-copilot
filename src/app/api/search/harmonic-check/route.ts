import { NextResponse, type NextRequest } from 'next/server';
import { authOrError, hasRole } from '@/lib/auth/session';
import { harmonicCheck } from '@/lib/integrations/harmonic';
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
  return NextResponse.json(await harmonicCheck(q), { headers: { 'Cache-Control': 'no-store' } });
}
