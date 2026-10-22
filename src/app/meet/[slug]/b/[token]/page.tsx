import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { BookingManage } from '@/components/booking/booking-manage';
import { getStore } from '@/lib/runtime';
import { addressKey } from '@/lib/security/client-address';
import { rateLimit } from '@/lib/security/limits';
import { log } from '@/lib/security/redact';
import { loadManagePage, notFoundManagePage } from '@/lib/services/booking-manage';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ slug: string; token: string }> };

/** Views of booking pages one address may make in ten minutes before it sees nothing. */
const MANAGE_VIEWS_PER_10_MIN = 60;

/**
 * A booking's own page (D-078), outside sign-in, on the same booking link:
 * "You have a meeting with Nick", when and where, who is coming, Add to
 * calendar, and Reschedule or Cancel. The token in the path is the only key
 * (only its SHA-256 is stored). Never indexed, and it sends no referrer, so
 * the link to a map or a video call cannot carry the token away.
 */
export const metadata: Metadata = {
  title: { absolute: 'Your meeting' },
  description: 'See, reschedule or cancel your meeting.',
  robots: { index: false, follow: false, nocache: true },
  referrer: 'no-referrer',
};

export default async function ManageBookingPage({ params }: Props) {
  const { slug, token } = await params;
  const limited = rateLimit(
    `booking-manage-page:${addressKey(await headers())}`,
    MANAGE_VIEWS_PER_10_MIN,
    600_000,
  );
  const page = limited.ok
    ? await loadManagePage(getStore(), slug, token).catch((error: unknown) => {
        log.warn('A booking page could not be read', {
          reason: error instanceof Error ? error.message : 'unknown',
        });
        return notFoundManagePage(slug);
      })
    : notFoundManagePage(slug);
  return <BookingManage data={page} token={token} />;
}
