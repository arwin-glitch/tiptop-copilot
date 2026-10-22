import type { RenderOgImage } from '@/lib/events/contracts';

/**
 * CONTRACT STUB — owned by WS2 (Design system). Replace the body, keep the
 * export: `renderOgImage` (type RenderOgImage in lib/events/contracts.ts).
 *
 * The real one renders the 1200×630 share card with next/og ImageResponse
 * (flexbox only, TTF fonts from assets/og-fonts) and returns the PNG bytes.
 * WS1's publish stores them at event-media/og/<event>/v<n>.png. Returning
 * null means "no card": publish goes ahead without one.
 */
export const renderOgImage: RenderOgImage = async () => null;
