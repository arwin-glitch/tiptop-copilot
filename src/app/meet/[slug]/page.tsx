import type { Metadata } from 'next';
import { chatModeFor } from '@/lib/booking/chat';
import { getStore } from '@/lib/runtime';
import { publicBookingPage, resolveOpenLink } from '@/lib/services/booking';
import { BookingPage } from '@/components/booking/booking-page';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ slug: string }> };

/**
 * The public booking link (D-074), outside sign-in: the host's card, a
 * request form over open times, and the "Arwin" chatbot. It reads busy times
 * only, writes only a pending request, and says it is not taking bookings
 * while the link is off, missing, or not set up yet.
 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const page = await publicBookingPage(getStore(), slug).catch(() => null);
  const name = page?.state === 'open' ? page.host?.displayName : null;
  return {
    title: { absolute: name ? `Meet with ${name}` : 'Booking link' },
    description: 'Ask for a time to meet.',
  };
}

export default async function MeetPage({ params }: Props) {
  const { slug } = await params;
  const store = getStore();
  const found = await resolveOpenLink(store, slug);
  const chatMode = found.open ? (await chatModeFor(store, found.link)).mode : 'guided';
  const data = await publicBookingPage(store, slug, { chatMode });
  return <BookingPage data={data} />;
}
