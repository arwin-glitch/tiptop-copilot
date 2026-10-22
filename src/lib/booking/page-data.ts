import 'server-only';
import { cache } from 'react';
import type { AIProvider } from '@/lib/ai/provider';
import type { DataStore } from '@/lib/db/store';
import { getStore } from '@/lib/runtime';
import { rateLimit } from '@/lib/security/limits';
import {
  closedBookingPage,
  publicBookingPage,
  resolveOpenLink,
  type BookingDeps,
} from '@/lib/services/booking';
import type { PublicBookingPage } from './public';

/**
 * Everything one view of the public booking page reads, braked per visitor
 * address. The page is outside sign-in, so a loop over its address must not
 * become a cheap way to load the database the whole app runs on: past the
 * brake it shows the closed page and reads nothing, the link is read once
 * per view (the metadata and the page share it through React's `cache`).
 * The assistant spends nothing (D-078), so there is no spend check to make.
 */

export const PAGE_VIEWS_PER_10_MIN = 120;

export async function loadMeetPage(
  store: DataStore,
  slug: string,
  addressKey: string,
  deps: BookingDeps & { ai?: AIProvider } = {},
): Promise<PublicBookingPage> {
  const limited = rateLimit(`booking-page:${addressKey}`, PAGE_VIEWS_PER_10_MIN, 600_000);
  if (!limited.ok) return closedBookingPage(slug);
  const found = await resolveOpenLink(store, slug);
  if (!found.open) return closedBookingPage(slug);
  return publicBookingPage(store, slug, { ...deps, link: found.link });
}

/** One view's page data: computed once per request for a slug and an address. */
export const meetPageFor = cache((slug: string, addressKey: string) =>
  loadMeetPage(getStore(), slug, addressKey),
);
