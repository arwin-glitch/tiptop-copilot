import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import { MEETING_KINDS, type MeetingKind, type MeetingType } from '@/lib/booking/config';
import { meetPageFor } from '@/lib/booking/page-data';
import { rememberCookieName } from '@/lib/booking/public';
import { getStore } from '@/lib/runtime';
import { addressKey } from '@/lib/security/client-address';
import { rememberedBooking } from '@/lib/services/booking-manage';
import { BookingPage } from '@/components/booking/booking-page';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ slug: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

/** "?meal=coffee" or "?type=call": the link opens on that meeting (Voice Arwin's invites). */
function presetFrom(
  query: Record<string, string | string[] | undefined>,
): { type: MeetingType; kind: MeetingKind | null } | null {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const meal = one(query.meal);
  if (meal && (MEETING_KINDS as readonly string[]).includes(meal)) {
    return { type: 'in_person', kind: meal as MeetingKind };
  }
  if (one(query.type) === 'call') return { type: 'call', kind: null };
  return null;
}

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
    description: 'Book a time to meet.',
  };
}

export default async function MeetPage({ params, searchParams }: Props) {
  const data = await pageData(params);
  // "You have a meeting with ...": the booking this device made, while ahead (D-078).
  const token = data.state === 'open' ? (await cookies()).get(rememberCookieName(data.slug)) : null;
  const remembered = token?.value
    ? await rememberedBooking(getStore(), data.slug, token.value).catch(() => null)
    : null;
  const preset = presetFrom((await searchParams) ?? {});
  return <BookingPage data={data} remembered={remembered} preset={preset} />;
}
