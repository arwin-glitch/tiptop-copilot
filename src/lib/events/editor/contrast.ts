import type { Palette } from '@/lib/events/schema';

/**
 * WCAG 2.x contrast for Studio's live badges and the publish checklist.
 * (WS2's lib/events/theme/contrast.ts is the renderer's copy; this one is
 * kept small and pure for the editor.) Fix changes a colour only when the
 * host clicks it, keeping its hue and moving its lightness.
 */

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function rgbToHex([r, g, b]: [number, number, number]): string {
  const to = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`.toUpperCase();
}

export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export type ContrastGrade = 'AAA' | 'AA' | 'AA large' | 'Fail';

export function grade(ratio: number): ContrastGrade {
  if (ratio >= 7) return 'AAA';
  if (ratio >= 4.5) return 'AA';
  if (ratio >= 3) return 'AA large';
  return 'Fail';
}

/** The text/background pairs every page uses, each needing 4.5:1. */
export const CONTRAST_PAIRS: { fg: keyof Palette; bg: keyof Palette; label: string }[] = [
  { fg: 'text', bg: 'bg', label: 'Text on page' },
  { fg: 'muted', bg: 'bg', label: 'Muted text on page' },
  { fg: 'text', bg: 'surface', label: 'Text on cards' },
  { fg: 'text', bg: 'surfaceAlt', label: 'Text on alternate bands' },
  { fg: 'accentFg', bg: 'accent', label: 'Button text' },
];

export interface PairResult {
  fg: keyof Palette;
  bg: keyof Palette;
  label: string;
  ratio: number;
  grade: ContrastGrade;
}

export function checkPalette(palette: Palette): PairResult[] {
  return CONTRAST_PAIRS.map((pair) => {
    const ratio = contrastRatio(palette[pair.fg], palette[pair.bg]);
    return { ...pair, ratio, grade: grade(ratio) };
  });
}

function rgbToHsl([r, g, b]: [number, number, number]): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb([h, s, l]: [number, number, number]): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const hue = (p: number, q: number, t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255];
}

/**
 * The nearest colour to `fg` (same hue and saturation) that reaches `target`
 * against `bg`: darker on a light background, lighter on a dark one.
 */
export function fixContrast(fg: string, bg: string, target = 4.5): string {
  if (contrastRatio(fg, bg) >= target) return fg.toUpperCase();
  const [h, s, l] = rgbToHsl(hexToRgb(fg));
  const darker = luminance(bg) > 0.18;
  for (let step = 1; step <= 100; step++) {
    const next = darker ? Math.max(0, l - step / 100) : Math.min(1, l + step / 100);
    const candidate = rgbToHex(hslToRgb([h, s, next]));
    if (contrastRatio(candidate, bg) >= target) return candidate;
  }
  return darker ? '#000000' : '#FFFFFF';
}

/**
 * Tokens from a logo's extracted colours ("Theme from logo"): the most
 * saturated colour as the accent, a near-white page, readable text, and
 * contrast fixed throughout.
 */
export function paletteFromColors(colors: readonly string[], base: Palette): Palette {
  const valid = colors.filter((c) => /^#[0-9a-fA-F]{6}$/.test(c));
  if (!valid.length) return base;
  const bySaturation = [...valid].sort(
    (a, b) => rgbToHsl(hexToRgb(b))[1] - rgbToHsl(hexToRgb(a))[1],
  );
  const accentRaw = bySaturation[0]!;
  const [h, s] = rgbToHsl(hexToRgb(accentRaw));
  const bg = rgbToHex(hslToRgb([h, Math.min(s, 0.3), 0.97]));
  const surface = rgbToHex(hslToRgb([h, Math.min(s, 0.2), 0.99]));
  const surfaceAlt = rgbToHex(hslToRgb([h, Math.min(s, 0.25), 0.93]));
  const accent = fixContrast(accentRaw, bg, 4.5);
  const text = fixContrast(rgbToHex(hslToRgb([h, Math.min(s, 0.4), 0.15])), bg, 7);
  const muted = fixContrast(rgbToHex(hslToRgb([h, Math.min(s, 0.15), 0.38])), bg, 4.5);
  const accentFg = contrastRatio('#FFFFFF', accent) >= 4.5 ? '#FFFFFF' : '#000000';
  const border = rgbToHex(hslToRgb([h, Math.min(s, 0.2), 0.85]));
  const highlight = fixContrast(bySaturation[1] ?? accentRaw, bg, 3);
  return { bg, surface, surfaceAlt, text, muted, accent, accentFg, border, highlight };
}
