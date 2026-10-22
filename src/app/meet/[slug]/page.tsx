import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { meetPageFor } from '@/lib/booking/page-data';
import { addressKey } from '@/lib/security/client-address';
import { BookingPage } from '@/components/booking/booking-page';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ slug: string }> };

/**
 * The public booking link (D-074), outside sign-in: the host's card, a
 * request form over open times, and the "Arwin" chatbot. It reads busy times
 * only, writes only a pending request, and says it is not taking bookings
 * while the link is off, missing, or not set up yet, and to a visitor past
 * the page's brake (lib/booking/page-data.ts).
 */
async function pageData(params: Props['params']) {
  const { slug } = await params;
  return meetPageFor(slug, addressKey(await headers()));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = await pageData(params).catch(() => null);
  const name = page?.state === 'open' ? page.host?.displayName : null;
  return {
    title: { absolute: name ? `Meet with ${name}` : 'Booking link' },
    description: 'Ask for a time to meet.',
  };
}

export default async function MeetPage({ params }: Props) {
  return <BookingPage data={await pageData(params)} />;
}
