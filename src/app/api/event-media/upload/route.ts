import { NextResponse, type NextRequest } from 'next/server';
import { normalizeMimeType } from '@/lib/storage/allowed-types';
import { LocalEventStorage, getEventStorage } from '@/lib/storage/event-storage';
import { statusForError } from '@/lib/util/result';

export const dynamic = 'force-dynamic';

/**
 * DEMO MODE ONLY: the stand-in for a Supabase signed upload URL (D-075). The
 * browser PUTs an original here with the HMAC-signed, expiring token
 * createUploadUrl minted for ONE object path in the private originals
 * folder; the token caps the size, and the folder takes only the types the
 * real private bucket takes. No session is needed (an outside editor has
 * none), exactly like the real signed URL. With Supabase storage in use it
 * answers 404.
 */
export async function PUT(request: NextRequest) {
  const storage = getEventStorage();
  if (!(storage instanceof LocalEventStorage)) return fail(404, 'not_found', 'Not found.');
  const claim = LocalEventStorage.verifyUploadToken(
    request.nextUrl.searchParams.get('token') ?? '',
  );
  if (!claim) return fail(403, 'forbidden', 'That upload link has expired or is invalid.');

  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > claim.maxBytes) return fail(413, 'too_large', 'That file is too large.');
  const body = request.body;
  if (!body) return fail(400, 'invalid_input', 'No file was sent.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > claim.maxBytes) {
      await reader.cancel();
      return fail(413, 'too_large', 'That file is too large.');
    }
    chunks.push(value);
  }
  if (size === 0) return fail(400, 'invalid_input', 'No file was sent.');
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  const type = normalizeMimeType(request.headers.get('content-type'));
  const stored = await storage.put('private', claim.path, bytes, type);
  if (!stored.ok) {
    return fail(statusForError(stored.error.code), stored.error.code, stored.error.message);
  }
  return NextResponse.json(
    { ok: true, path: claim.path },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

function fail(status: number, code: string, message: string) {
  return NextResponse.json(
    { ok: false, error: { code, message } },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}
