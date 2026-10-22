import { NextResponse, type NextRequest } from 'next/server';
import { DERIVATIVE_TYPES, LocalEventStorage, getEventStorage } from '@/lib/storage/event-storage';

export const dynamic = 'force-dynamic';

/** Re-encoded images and videos may show inline; anything else downloads. */
const INLINE = new Set(['avif', 'webp', 'jpg', 'png', 'mp4', 'webm']);

/**
 * DEMO MODE ONLY: the stand-in for a Supabase signed URL into the PRIVATE
 * `event-originals` bucket (D-075): gated media and Materials files. The
 * HMAC-signed token names one object and expires in 15 minutes, like the
 * real one; it is minted only by resolveMedia for a viewer the server
 * already let see that section. With Supabase storage in use it answers 404.
 */
export async function GET(request: NextRequest) {
  const storage = getEventStorage();
  if (!(storage instanceof LocalEventStorage)) return notFound();
  const claim = LocalEventStorage.verifyReadToken(request.nextUrl.searchParams.get('token') ?? '');
  if (!claim) return notFound();
  const file = await storage.get('private', claim.path);
  if (!file.ok) return notFound();
  const ext = claim.path.split('.').pop()?.toLowerCase() ?? '';
  const inline = INLINE.has(ext) && !claim.download;
  const name = (claim.download ?? `file.${ext}`).replace(/["\\\r\n]/g, '');
  return new NextResponse(Buffer.from(file.value), {
    headers: {
      'Content-Type': inline
        ? (DERIVATIVE_TYPES[ext] ?? 'application/octet-stream')
        : 'application/octet-stream',
      'Content-Disposition': inline ? 'inline' : `attachment; filename="${name}"`,
      'Cache-Control': 'private, max-age=900',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
}

function notFound() {
  return NextResponse.json(
    { ok: false, error: { code: 'not_found', message: 'Not found.' } },
    { status: 404, headers: { 'Cache-Control': 'no-store' } },
  );
}
