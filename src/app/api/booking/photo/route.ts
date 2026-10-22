import type { NextRequest } from 'next/server';
import { requireRole } from '@/lib/auth/session';
import { isOwnPhotoPath } from '@/lib/booking/config';
import { calendarAuth, done, fail } from '@/lib/calendar/route-auth';
import { getStorage, getStore } from '@/lib/runtime';
import {
  MAX_BOOKING_PHOTO_BYTES,
  readBookingSettings,
  setBookingPhoto,
} from '@/lib/services/booking';

export const dynamic = 'force-dynamic';

async function gate(request: NextRequest) {
  const auth = await calendarAuth(request, { bucket: 'booking-photo', max: 20, write: true });
  if (!auth.ok) return auth;
  const admin = requireRole(auth.auth, 'admin');
  if (!admin.ok) return { ok: false as const, response: fail(admin.error) };
  return auth;
}

/**
 * Upload the host's photo for the booking page (Settings > Booking link):
 * one JPG, PNG or WebP under 3 MB, checked by its bytes, kept in the private
 * bucket. Signed in, an admin or the owner, from Copilot's own pages.
 */
export async function POST(request: NextRequest) {
  const checked = await gate(request);
  if (!checked.ok) return checked.response;
  if (Number(request.headers.get('content-length') ?? '0') > MAX_BOOKING_PHOTO_BYTES + 64_000) {
    return fail({ code: 'too_large', message: 'Use a photo under 3 MB.' });
  }
  const form = await request.formData().catch(() => null);
  const file = form?.get('photo');
  if (!file || typeof file === 'string') {
    return fail({ code: 'invalid_input', message: 'Choose a photo.' });
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const saved = await setBookingPhoto(
    getStore(),
    getStorage(),
    checked.auth.organizationId,
    checked.auth.userId,
    bytes,
  );
  if (!saved.ok) return fail(saved.error);
  return done({ settings: saved.value });
}

/** Remove the photo: the page shows initials instead. */
export async function DELETE(request: NextRequest) {
  const checked = await gate(request);
  if (!checked.ok) return checked.response;
  const saved = await setBookingPhoto(
    getStore(),
    getStorage(),
    checked.auth.organizationId,
    checked.auth.userId,
    null,
  );
  if (!saved.ok) return fail(saved.error);
  return done({ settings: saved.value });
}

/**
 * The photo for Settings' own preview: signed in, any member, whether or not
 * the link is on (the public route serves it only while it is).
 */
export async function GET(request: NextRequest) {
  const auth = await calendarAuth(request, { bucket: 'booking-photo-view', max: 60 });
  if (!auth.ok) return auth.response;
  const settings = await readBookingSettings(getStore(), auth.auth.organizationId).catch(
    () => null,
  );
  const photo = settings?.config.photo;
  if (!photo || !isOwnPhotoPath(auth.auth.organizationId, photo)) {
    return new Response('Not found.', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
  const bytes = await getStorage().get(photo.path);
  if (!bytes.ok) {
    return new Response('Not found.', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
  return new Response(Buffer.from(bytes.value), {
    headers: {
      'Content-Type': photo.type,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
    },
  });
}
