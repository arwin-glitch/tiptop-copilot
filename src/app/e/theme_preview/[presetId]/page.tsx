import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { EventPage } from '@/components/events/render/event-page';
import { getAuthContext } from '@/lib/auth/session';
import { PUBLIC_VIEWER, SAMPLE_GUEST_VIEWER, type MotionPreview } from '@/lib/events/contracts';
import { previewPage } from '@/lib/events/preview';
import { NONCE_HEADER } from '@/lib/events/surface';
import { isThemePresetId } from '@/lib/events/themes';

/**
 * Full-page theme preview (D-075, WS2): a preset rendered by the real guest
 * renderer, on the real /e surface (nonce CSP, no Kraken chrome), with a
 * fictional starter and abstract artwork. Signed-in owners only: anyone else
 * gets a 404, so the route exposes nothing publicly. The segment name has an
 * underscore, which no event slug can contain, so it never shadows an event.
 *
 * Query: ?mode=light|dark  ?motion=full|reduced|off  ?starter=<id>
 *        ?intro=1 (play the preset's arrival intro)  ?viewer=guest
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Theme preview',
  robots: { index: false, follow: false, nocache: true },
};

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ThemePreviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ presetId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const auth = await getAuthContext();
  if (!auth) notFound();
  const { presetId } = await params;
  if (!isThemePresetId(presetId)) notFound();
  const sp = await searchParams;
  const modeParam = one(sp.mode);
  const motionParam = one(sp.motion);
  const page = previewPage(presetId, {
    starterId: one(sp.starter),
    mode: modeParam === 'light' || modeParam === 'dark' ? modeParam : undefined,
    intro: one(sp.intro) === '1',
  });
  const motion: MotionPreview | undefined =
    motionParam === 'reduced' || motionParam === 'off' || motionParam === 'full'
      ? motionParam
      : undefined;
  const viewer = one(sp.viewer) === 'guest' ? SAMPLE_GUEST_VIEWER : PUBLIC_VIEWER;
  const nonce = (await headers()).get(NONCE_HEADER) ?? undefined;
  return (
    <EventPage
      doc={page.doc}
      facts={page.facts}
      media={page.media}
      viewer={viewer}
      mode="live"
      motion={motion}
      rsvp={{ ...page.rsvp, viewer }}
      nonce={nonce}
    />
  );
}
