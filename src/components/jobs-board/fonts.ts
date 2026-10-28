import { Fragment_Mono, Mona_Sans } from 'next/font/google';

/**
 * The Perks directory's typefaces, self-hosted by Next at build time (no
 * request to Google from a visitor's browser). Loaded only by the board's
 * layouts, so Kraken's own pages never download them.
 */
export const boardSans = Mona_Sans({
  subsets: ['latin'],
  variable: '--jb-sans',
  display: 'swap',
});

export const boardMono = Fragment_Mono({
  subsets: ['latin'],
  weight: '400',
  variable: '--jb-mono',
  display: 'swap',
});

export const boardFontClasses = `${boardSans.variable} ${boardMono.variable}`;
