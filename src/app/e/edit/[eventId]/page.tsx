import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { GRANT_COOKIE, resolveGrant } from '@/lib/events/editor-auth';
import { ID_RE } from '@/lib/events/schema';
import { getStore } from '@/lib/runtime';
import { loadOutsiderStudio } from '@/components/events/studio/load-studio';
import { Studio } from '@/components/events/studio/studio';

export const metadata: Metadata = {
  title: { absolute: 'Event page editor' },
  robots: { index: false, follow: false, nocache: true },
  referrer: 'no-referrer',
};
export const dynamic = 'force-dynamic';

/**
 * Studio for an outside editor or viewer link. No Kraken session: the
 * path-scoped tiptop_ev_grant cookie is re-checked against the link on this
 * request (revoked, expired, regenerated, paused, wrong event: a generic
 * 404), and every API call it makes is re-checked again.
 */
export default async function OutsideStudioPage({
  params,
}: {
  params: Promise<{ eventId: string }>;
}) {
  const { eventId } = await params;
  if (!ID_RE.test(eventId)) notFound();
  const jar = await cookies();
  const store = getStore();
  const grant = await resolveGrant(store, {
    eventId,
    cookieValue: jar.get(GRANT_COOKIE)?.value,
  });
  if (!grant.ok) notFound();
  const boot = await loadOutsiderStudio(store, grant.value);
  if (!boot.ok) notFound();
  return <Studio boot={boot.value} />;
}
