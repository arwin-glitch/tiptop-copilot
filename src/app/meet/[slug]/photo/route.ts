import type { NextRequest } from 'next/server';
import { getStorage, getStore } from '@/lib/runtime';
import { rateLimit } from '@/lib/security/limits';
import { addressKey } from '@/lib/security/client-address';
import { resolveOpenLink } from '@/lib/services/booking';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ slug: string }> };

/**
 * The host's photo on a booking link, served from the private bucket by this
 * route (never a public storage link): only while the link is on, only the
 * one photo Settings uploaded, only as the image type it was checked to be.
 */
export async function GET(request: NextRequest, context: Context) {
  const limited = rateLimit(`booking-photo:${addressKey(request.headers)}`, 120, 600_000);
  if (!limited.ok) return new Response('Too many requests.', { status: 429 });
  const { slug } = await context.params;
  const found = await resolveOpenLink(getStore(), slug);
  const photo = found.open ? found.link.config.photo : null;
  if (!found.open || !photo || !photo.path.startsWith(`booking/${found.link.organizationId}/`)) {
    return new Response('Not found.', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
  const bytes = await getStorage().get(photo.path);
  if (!bytes.ok) {
    return new Response('Not found.', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
  return new Response(Buffer.from(bytes.value), {
    headers: {
      'Content-Type': photo.type,
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
    },
  });
}
