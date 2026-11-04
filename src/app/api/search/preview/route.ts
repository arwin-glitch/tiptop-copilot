import { NextResponse, type NextRequest } from 'next/server';
import { authOrError } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { searchPreview } from '@/lib/services/search-preview';
import { statusForError } from '@/lib/util/result';

export const dynamic = 'force-dynamic';

/**
 * The quick search's preview panel for one company or person: signed-in
 * only, scoped to the caller's organization. Reads the database and the
 * cached relationship index only.
 */
export async function GET(request: NextRequest) {
  const auth = await authOrError();
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: statusForError(auth.error.code) },
    );
  }
  const id = request.nextUrl.searchParams.get('id') ?? '';
  const preview = await searchPreview(getStore(), auth.value, id);
  if (!preview.ok) {
    return NextResponse.json(
      { ok: false, error: preview.error },
      { status: statusForError(preview.error.code), headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return NextResponse.json(
    { ok: true, preview: preview.value },
    { headers: { 'Cache-Control': 'private, max-age=30' } },
  );
}
