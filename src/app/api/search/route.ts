import { NextResponse, type NextRequest } from 'next/server';
import { authOrError } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { searchEverything } from '@/lib/services/search';
import { statusForError } from '@/lib/util/result';

export const dynamic = 'force-dynamic';

/** The Ctrl+K search box: signed-in only, scoped to the caller's organization. */
export async function GET(request: NextRequest) {
  const auth = await authOrError();
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: statusForError(auth.error.code) },
    );
  }
  const q = request.nextUrl.searchParams.get('q') ?? '';
  const results = await searchEverything(getStore(), auth.value.organizationId, q);
  return NextResponse.json({ results }, { headers: { 'Cache-Control': 'no-store' } });
}
