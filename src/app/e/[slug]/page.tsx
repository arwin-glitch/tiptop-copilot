import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import { notFound, permanentRedirect } from 'next/navigation';
import { eventPaths } from '@/lib/events/contracts';
import { NONCE_HEADER } from '@/lib/events/surface';
import { RSVP_COOKIE } from '@/lib/events/tokens';
import { getStore } from '@/lib/runtime';
import { eventMediaPublicUrl } from '@/lib/storage/provider';
import {
  absoluteUrl,
  buildPublicPage,
  publishedDoc,
  resolvePublicEvent,
  resolveRemembered,
} from '@/lib/services/event-public';
import { CancelledView, EventView } from './event-view';

/**
 * /e/<slug> — the public event page (D-075). Serves the PUBLISHED snapshot
 * only, filtered on the server for whoever is looking (nobody, or the
 * browser that RSVP'd, via its remembered cookie). Old slugs 301 to the
 * current one; drafts, private events and unknown slugs are a plain 404.
 * Rendered per request (the nonce CSP needs it).
 */

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const resolved = await resolvePublicEvent(getStore(), slug);
  if (resolved.kind !== 'event') {
    return { title: { absolute: 'Event' }, robots: { index: false, follow: false } };
  }
  const { event } = resolved;
  const doc = publishedDoc(event);
  const title = doc?.meta.seoTitle?.trim() || event.title;
  const description = doc?.meta.seoDescription?.trim() || undefined;
  const indexable = event.visibility === 'public' && event.status === 'published';
  const url = absoluteUrl(eventPaths.page(event.slug));
  const image = event.og_image_path ? eventMediaPublicUrl(event.og_image_path) : null;
  return {
    title: { absolute: title },
    description,
    applicationName: null,
    appleWebApp: null,
    robots: indexable
      ? { index: true, follow: true }
      : { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
    alternates: indexable ? { canonical: url } : undefined,
    openGraph: {
      title,
      description,
      url,
      type: 'website',
      images: image ? [{ url: image, width: 1200, height: 630, alt: title }] : undefined,
    },
    twitter: {
      card: image ? 'summary_large_image' : 'summary',
      title,
      description,
      images: image ? [image] : undefined,
    },
  };
}

export default async function EventPublicPage({ params }: Props) {
  const { slug } = await params;
  const store = getStore();
  const resolved = await resolvePublicEvent(store, slug);
  if (resolved.kind === 'redirect') permanentRedirect(eventPaths.page(resolved.slug));
  if (resolved.kind === 'not_found') notFound();

  const jar = await cookies();
  const remembered = await resolveRemembered(store, resolved.event, jar.get(RSVP_COOKIE)?.value);
  const page = await buildPublicPage(store, resolved, remembered);
  if (!page) notFound();
  if (page.facts.cancelled) return <CancelledView page={page} />;

  const nonce = (await headers()).get(NONCE_HEADER) ?? undefined;
  const organization = await store.organizationById(resolved.organizationId).catch(() => null);
  return (
    <EventView
      page={page}
      endpoint={`/api/e/${resolved.event.slug}/rsvp`}
      invite={null}
      token={null}
      nonce={nonce}
      organizer={organization?.name ?? null}
    />
  );
}
