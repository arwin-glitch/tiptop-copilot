import { NextResponse, type NextRequest } from 'next/server';
import { authOrError } from '@/lib/auth/session';
import { getStorage } from '@/lib/runtime';
import { LocalStorageProvider, verifyLocalStorageToken } from '@/lib/storage/provider';
import { statusForError } from '@/lib/util/result';

export const dynamic = 'force-dynamic';

/**
 * Serves a file from the local (demo-mode) storage provider.
 *
 * Two gates, both required: a valid session, and an unexpired HMAC-signed token
 * naming the object path. This mirrors the Supabase signed-URL semantics rather
 * than bypassing them in demo mode.
 */
export async function GET(request: NextRequest) {
  const auth = await authOrError();
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: statusForError(auth.error.code) },
    );
  }

  const token = request.nextUrl.searchParams.get('token');
  if (!token) {
    return NextResponse.json(
      { ok: false, error: { code: 'invalid_input', message: 'Missing token.' } },
      { status: 400 },
    );
  }

  const objectPath = verifyLocalStorageToken(token);
  if (!objectPath) {
    return NextResponse.json(
      { ok: false, error: { code: 'forbidden', message: 'That link has expired or is invalid.' } },
      { status: 403 },
    );
  }

  // The object path is namespaced by organization; refuse anything outside it.
  if (!objectPath.startsWith(`${auth.value.organizationId}/`)) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: 'forbidden', message: 'That file belongs to another organization.' },
      },
      { status: 403 },
    );
  }

  const storage = getStorage();
  if (!(storage instanceof LocalStorageProvider)) {
    return NextResponse.json(
      { ok: false, error: { code: 'not_found', message: 'Local storage is not in use.' } },
      { status: 404 },
    );
  }

  const file = await storage.get(objectPath);
  if (!file.ok) {
    return NextResponse.json(
      { ok: false, error: file.error },
      { status: statusForError(file.error.code) },
    );
  }

  return new NextResponse(Buffer.from(file.value), {
    headers: {
      // Always download rather than render: never let stored bytes execute in
      // the app's origin.
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
