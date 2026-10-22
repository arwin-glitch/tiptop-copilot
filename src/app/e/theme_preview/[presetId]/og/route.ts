import { getAuthContext } from '@/lib/auth/session';
import { renderOgImage } from '@/lib/events/og';
import { previewPage } from '@/lib/events/preview';
import { isThemePresetId } from '@/lib/events/themes';

/**
 * The share card a preset produces (D-075, WS2), for the theme gallery and
 * Sharing's OG preview of an unpublished look. Signed-in owners only (404
 * otherwise); fictional content; never cached publicly.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ presetId: string }> }) {
  const auth = await getAuthContext();
  const { presetId } = await params;
  if (!auth || !isThemePresetId(presetId)) return new Response('Not found', { status: 404 });
  const url = new URL(request.url);
  const layoutParam = url.searchParams.get('layout');
  const layout = layoutParam === 'type' || layoutParam === 'ticket' ? layoutParam : 'cover';
  const page = previewPage(presetId, { starterId: url.searchParams.get('starter') ?? undefined });
  const png = await renderOgImage({ doc: page.doc, facts: page.facts, media: {}, layout });
  if (!png) return new Response('No card', { status: 500 });
  return new Response(
    png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer,
    {
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, no-store' },
    },
  );
}
