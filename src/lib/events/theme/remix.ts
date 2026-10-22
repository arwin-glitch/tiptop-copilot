import type { EventTheme } from '@/lib/events/schema';
import { FONT_PAIRINGS } from '@/lib/events/fonts';
import { remixPalette } from './palette';

/**
 * Remix / Shuffle and brand kits for Studio's theme panel (D-075). Pure:
 * Studio turns the result into theme.update ops, so every step is undoable
 * and goes through the same validation and brand locks as a hand edit.
 */

type Theme = Omit<EventTheme, 'rev' | 'keyRevs'>;

const HEADLINE_STEPS: Theme['motion']['headlineEffect'][] = [
  'blur_in',
  'word_reveal',
  'letter_reveal',
  'none',
];

/**
 * Step `seed` of Shuffle: a harmonious palette variation (contrast kept), a
 * suggested font pairing in the same spirit, and a headline entrance.
 * Locked parts (brand.locks palette/fonts) are left as they are.
 * Deterministic, so Shuffle can step forward and back.
 */
export function remixTheme(theme: Theme, seed: number): Theme {
  const next: Theme = structuredClone(theme);
  const step = Math.abs(Math.trunc(seed));
  if (!theme.brand.locks.palette) {
    next.palette = remixPalette(theme.palette, step);
    next.paletteDark = remixPalette(theme.paletteDark, step);
  }
  if (!theme.brand.locks.fonts && step > 0) {
    const pairing = FONT_PAIRINGS[step % FONT_PAIRINGS.length];
    if (pairing) {
      next.typography = {
        ...next.typography,
        display: pairing.display,
        body: pairing.body,
        mono: pairing.mono,
      };
    }
  }
  next.motion = {
    ...next.motion,
    headlineEffect: HEADLINE_STEPS[step % HEADLINE_STEPS.length] ?? next.motion.headlineEffect,
  };
  return next;
}

export interface BrandKit {
  id: string;
  name: string;
  palette: Theme['palette'];
  paletteDark: Theme['paletteDark'];
  typography: Pick<Theme['typography'], 'display' | 'body' | 'mono'>;
  /** Locks applied with the kit (outside editors cannot change these parts). */
  locks: Theme['brand']['locks'];
}

/**
 * The TipTop kit: emerald and gold, Cormorant Garamond over Inter. Logos are
 * event_media uploads, so the kit carries none; Studio keeps the event's.
 * Arwin's rule: green dominates, gold only for rules, labels and display
 * accents; dark mode is near-black, never green surfaces.
 */
export const TIPTOP_BRAND_KIT: BrandKit = {
  id: 'tiptop',
  name: 'TipTop',
  palette: {
    bg: '#F6F1E4',
    surface: '#FFFDF7',
    surfaceAlt: '#EFE7D3',
    text: '#0E2720',
    muted: '#4F5B55',
    accent: '#2B6D56',
    accentFg: '#FFFDF7',
    border: '#E2D9C3',
    highlight: '#9A7420',
  },
  paletteDark: {
    bg: '#0E0F0F',
    surface: '#161817',
    surfaceAlt: '#1C1F1E',
    text: '#EEE8D6',
    muted: '#A39F92',
    accent: '#0DB376',
    accentFg: '#0E0F0F',
    border: '#2B2F2D',
    highlight: '#D4AF37',
  },
  typography: { display: 'cormorant-garamond', body: 'inter', mono: 'ibm-plex-mono' },
  locks: { logo: true, palette: true, fonts: true, intro: true },
};

export const BRAND_KITS: readonly BrandKit[] = [TIPTOP_BRAND_KIT];

/** Apply a brand kit in one click: palette, fonts, kit id and its locks. */
export function applyBrandKit(theme: Theme, kit: BrandKit): Theme {
  return {
    ...structuredClone(theme),
    palette: { ...kit.palette },
    paletteDark: { ...kit.paletteDark },
    typography: { ...theme.typography, ...kit.typography },
    brand: { ...theme.brand, kitId: kit.id, locks: { ...kit.locks } },
  };
}
