import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound, permanentRedirect } from 'next/navigation';
import { eventPaths } from '@/lib/events/contracts';
import { NONCE_HEADER } from '@/lib/events/surface';
import { getStore } from '@/lib/runtime';
import { buildPublicPage, resolveInvite, resolvePublicEvent } from '@/lib/services/event-public';
import { buildInvitePrefill } from '@/lib/services/event-rsvp';
import { CancelledView, EventView } from '../../event-view';

/**
 * /e/<slug>/i/<token> — a guest's personal invite (D-075). The token is a
 * stateless HMAC naming the guest (lib/events/tokens.ts); an unknown,
 * rotated or forged token is the same plain 404 as anything else. The page
 * shows the gated sections this guest qualifies for and their RSVP form,
 * preloaded; the same link edits or cancels until RSVPs close. A GET never
 * changes anything: answers go by POST, the view by the JS beacon. Never
 * indexed (proxy.ts sends X-Robots-Tag and no Referer on this path).
 */

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ slug: string; token: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const resolved = await resolvePublicEvent(getStore(), slug, { personal: true });
  const title = resolved.kind === 'event' ? resolved.event.title : 'Event';
  return {
    title: { absolute: `Your invitation – ${title}` },
    applicationName: null,
    appleWebApp: null,
    robots: { index: false, follow: false, nocache: true },
  };
}

export default async function InvitePage({ params }: Props) {
  const { slug, token } = await params;
  const store = getStore();
  const resolved = await resolvePublicEvent(store, slug, { personal: true });
  if (resolved.kind === 'redirect') permanentRedirect(eventPaths.invite(resolved.slug, token));
  if (resolved.kind === 'not_found') notFound();
  const guest = await resolveInvite(store, resolved.event, token);
  if (!guest) notFound();

  const page = await buildPublicPage(store, resolved, guest);
  if (!page) notFound();
  if (page.facts.cancelled) return <CancelledView page={page} />;

  const invite = await buildInvitePrefill(store, resolved.event, resolved.sessions, guest);
  const nonce = (await headers()).get(NONCE_HEADER) ?? undefined;
  return (
    <EventView
      page={page}
      endpoint={`/api/e/${resolved.event.slug}/i/${token}/respond`}
      invite={invite}
      token={token}
      nonce={nonce}
      organizer={null}
    />
  );
}
