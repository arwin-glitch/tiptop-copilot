import { NextResponse, type NextRequest } from 'next/server';
import { EVENT_MEDIA_MIME_TYPES } from '@/lib/storage/allowed-types';
import {
  DERIVATIVE_TYPES,
  LocalEventStorage,
  getEventStorage,
  safeObjectPath,
} from '@/lib/storage/event-storage';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ path: string[] }> };

/**
 * DEMO MODE ONLY: the stand-in for the public `event-media` bucket's public
 * URLs (D-075). It serves processed derivatives from the local demo storage,
 * exactly what the real bucket would serve to anyone: sharp re-encoded
 * images, videos and share cards, never an original or a gated item (those
 * live in the private folder this route cannot name). With Supabase storage
 * in use it answers 404 for everything.
 */
export async function GET(_request: NextRequest, context: Context) {
  const storage = getEventStorage();
  if (!(storage instanceof LocalEventStorage)) return notFound();
  const { path: parts } = await context.params;
  const objectPath = (parts ?? []).join('/');
  if (!safeObjectPath(objectPath)) return notFound();
  const ext = objectPath.split('.').pop()?.toLowerCase() ?? '';
  const type = DERIVATIVE_TYPES[ext];
  if (!type || !(EVENT_MEDIA_MIME_TYPES as readonly string[]).includes(type)) return notFound();
  const file = await storage.get('public', objectPath);
  if (!file.ok) return notFound();
  return new NextResponse(Buffer.from(file.value), {
    headers: {
      'Content-Type': type,
      // Content-hashed paths never change, like the real bucket's CDN copy.
      'Cache-Control': 'public, max-age=31536000, immutable',
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
