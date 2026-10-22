import type { Palette } from '@/lib/events/schema';
import { hexToOklch, hexToRgb, oklchToHex } from './color';

/**
 * WCAG 2.2 contrast for the event theme engine.
 *
 * Studio shows a live badge on every text/background pair; the Fix button
 * calls `fixContrast` and changes the colour only when the host clicks it
 * (we never silently tint a brand colour, unlike Luma). Every shipped preset
 * passes AA in light AND dark (tests/unit/events-contrast.test.ts).
 */

const channel = (c: number) => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export type ContrastGrade = 'AAA' | 'AA' | 'AA Large' | 'Fail';

/** The badge Studio shows. Large text: 18.66px bold or 24px regular and up. */
export function contrastGrade(ratio: number): ContrastGrade {
  if (ratio >= 7) return 'AAA';
  if (ratio >= 4.5) return 'AA';
  if (ratio >= 3) return 'AA Large';
  return 'Fail';
}

/** What a pair must reach: body text 4.5, large display text and UI rules 3. */
export type ContrastTarget = 4.5 | 3 | 7;

export interface ContrastPair {
  /** The token used as the foreground. */
  fg: keyof Palette;
  /** The token used as the background. */
  bg: keyof Palette;
  /** Plain-language name of where this pair appears. */
  label: string;
  target: ContrastTarget;
}

/**
 * The pairs the renderer actually draws (event.css). Muted text is body-size
 * copy (times, captions), so it needs 4.5 too; the highlight token is used
 * for rules, labels in caps and display accents, so 3 (large/UI) applies.
 */
export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  { fg: 'text', bg: 'bg', label: 'Text on the page', target: 4.5 },
  { fg: 'text', bg: 'surface', label: 'Text on cards', target: 4.5 },
  { fg: 'text', bg: 'surfaceAlt', label: 'Text on alternate bands', target: 4.5 },
  { fg: 'muted', bg: 'bg', label: 'Secondary text on the page', target: 4.5 },
  { fg: 'muted', bg: 'surface', label: 'Secondary text on cards', target: 4.5 },
  { fg: 'accentFg', bg: 'accent', label: 'Button text', target: 4.5 },
  { fg: 'accent', bg: 'bg', label: 'Links and outline buttons on the page', target: 4.5 },
  { fg: 'accent', bg: 'surface', label: 'Links on cards', target: 3 },
  { fg: 'highlight', bg: 'bg', label: 'Labels and rules (highlight)', target: 3 },
];

export interface PairResult extends ContrastPair {
  ratio: number;
  grade: ContrastGrade;
  passes: boolean;
}

export function checkPalette(palette: Palette): PairResult[] {
  return CONTRAST_PAIRS.map((pair) => {
    const ratio = contrastRatio(palette[pair.fg], palette[pair.bg]);
    return { ...pair, ratio, grade: contrastGrade(ratio), passes: ratio >= pair.target };
  });
}

export function paletteFailures(palette: Palette): PairResult[] {
  return checkPalette(palette).filter((p) => !p.passes);
}

/**
 * The nearest colour to `fg` (same hue and chroma, moved in perceptual
 * lightness) that reaches `target` against `bg`. Tries the direction away
 * from the background first. Returns `fg` unchanged when it already passes,
 * and black or white when no tint of the hue can (rare: mid-grey grounds).
 */
export function fixContrast(fg: string, bg: string, target: number = 4.5): string {
  if (contrastRatio(fg, bg) >= target) return fg.toUpperCase();
  const base = hexToOklch(fg);
  const bgL = hexToOklch(bg).l;
  const directions = bgL > 0.6 ? [-1, 1] : bgL < 0.4 ? [1, -1] : [base.l < bgL ? -1 : 1, 1];
  for (const dir of directions) {
    for (let step = 1; step <= 100; step += 1) {
      const l = base.l + (dir * step) / 100;
      if (l < 0 || l > 1) break;
      const candidate = oklchToHex({ ...base, l });
      if (contrastRatio(candidate, bg) >= target) return candidate;
    }
  }
  return contrastRatio('#000000', bg) >= contrastRatio('#FFFFFF', bg) ? '#000000' : '#FFFFFF';
}

/** Black or white, whichever reads better on `bg` (auto-contrast for chips over media). */
export function readableOn(bg: string, light = '#FFFFFF', dark = '#111111'): string {
  return contrastRatio(light, bg) >= contrastRatio(dark, bg) ? light : dark;
}
