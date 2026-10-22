import type { Metadata, Viewport } from 'next';

/**
 * The board's fallback metadata, for its layouts: what any board address
 * says when its page says nothing more (a 404, an error). Never Copilot's
 * own title or description, and noindex unless a page says otherwise.
 */
export const BOARD_LAYOUT_METADATA: Metadata = {
  // Absolute: Copilot's root template ("%s · TipTop Copilot") never applies here.
  title: { absolute: 'TipTop VC Jobs', template: '%s' },
  description: 'Open roles at TipTop VC portfolio companies.',
  applicationName: 'TipTop VC Jobs',
  robots: { index: false, follow: true },
  appleWebApp: { capable: false, title: 'TipTop Jobs' },
  openGraph: {
    siteName: 'TipTop VC',
    title: 'TipTop VC Jobs',
    description: 'Open roles at TipTop VC portfolio companies.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'TipTop VC Jobs',
    description: 'Open roles at TipTop VC portfolio companies.',
  },
};

/** The board is dark only: the phone's address bar matches it, not Copilot's cream. */
export const BOARD_VIEWPORT: Viewport = {
  themeColor: '#0B0F0E',
  colorScheme: 'dark',
};
