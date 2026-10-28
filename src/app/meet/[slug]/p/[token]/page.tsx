import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { BookingPage } from '@/components/booking/booking-page';
import { getStore } from '@/lib/runtime';
import { addressKey } from '@/lib/security/client-address';
import { log } from '@/lib/security/redact';
import { loadPickPage, type PublicPickPage } from '@/lib/services/booking-picks';
import { closedBookingPage } from '@/lib/services/booking';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ slug: string; token: string }> };

/**
 * Times the host picked for someone (Pick times), outside sign-in: the
 * host's card and the booking form over those times only, shown first in
 * the zone the host chose for them. The token in the path is the only key
 * (only its SHA-256 is looked up). Works while the pick is open, even with
 * the public booking link off; else "These times are no longer available."
 * Never indexed, and it sends no referrer, so a map or video link cannot
 * carry the token away.
 */
export const metadata: Metadata = {
  title: { absolute: 'Pick a time' },
  description: 'Book one of the times offered to you.',
  robots: { index: false, follow: false, nocache: true },
  referrer: 'no-referrer',
};

export default async function PickPage({ params }: Props) {
  const { slug, token } = await params;
  const data: PublicPickPage = await loadPickPage(
    getStore(),
    slug,
    token,
    addressKey(await headers()),
  ).catch((error: unknown) => {
    log.warn('A pick page could not be read', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return {
      state: 'closed' as const,
      slug,
      page: closedBookingPage(slug),
      pick: null,
      publicPath: null,
      message: null,
    };
  });
  return (
    <BookingPage
      data={data.page}
      picked={
        data.state === 'open' && data.pick
          ? { token, pick: data.pick }
          : { token, pick: null, publicPath: data.publicPath }
      }
    />
  );
}
