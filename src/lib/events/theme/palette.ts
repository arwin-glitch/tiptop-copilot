import type { Palette } from '@/lib/events/schema';
import { hexToOklch, mix, normalizeHex, oklchToHex, rgbToHex } from './color';
import { contrastRatio, fixContrast } from './contrast';

/**
 * Palettes from colours: "Pull from logo/cover" (top colours of an image),
 * "Theme from logo" (a whole light + dark palette from a few brand colours,
 * contrast fixed) and Remix's harmonious variations. Pure and isomorphic.
 */

/* ----------------------------------------------------------- extraction */

/**
 * The `count` most representative colours of an RGBA pixel buffer (from a
 * canvas or sharp's raw output), by a small median-cut. Transparent and
 * near-white/near-black pixels are down-weighted so a logo on white yields
 * the logo's colours. Deterministic.
 */
export function topColors(pixels: Uint8ClampedArray | Uint8Array, count = 5): string[] {
  type Px = [number, number, number];
  const samples: Px[] = [];
  const stride = Math.max(1, Math.floor(pixels.length / 4 / 6000)) * 4;
  for (let i = 0; i + 3 < pixels.length; i += stride) {
    const a = pixels[i + 3] ?? 255;
    if (a < 128) continue;
    const r = pixels[i] ?? 0;
    const g = pixels[i + 1] ?? 0;
    const b = pixels[i + 2] ?? 0;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    // Near-white and near-black grounds count once in four.
    if ((min > 242 || max < 14) && (i / stride) % 4 !== 0) continue;
    samples.push([r, g, b]);
  }
  if (!samples.length) return [];
  let boxes: Px[][] = [samples];
  while (boxes.length < count) {
    let widest = -1;
    let axis = 0;
    let index = -1;
    boxes.forEach((box, bi) => {
      if (box.length < 2) return;
      for (let ax = 0; ax < 3; ax += 1) {
        let lo = 255;
        let hi = 0;
        for (const p of box) {
          lo = Math.min(lo, p[ax] as number);
          hi = Math.max(hi, p[ax] as number);
        }
        if (hi - lo > widest) {
          widest = hi - lo;
          axis = ax;
          index = bi;
        }
      }
    });
    if (index < 0 || widest < 8) break;
    const box = [...(boxes[index] as Px[])].sort(
      (p, q) => (p[axis] as number) - (q[axis] as number),
    );
    const half = Math.floor(box.length / 2);
    boxes = [
      ...boxes.slice(0, index),
      box.slice(0, half),
      box.slice(half),
      ...boxes.slice(index + 1),
    ];
  }
  return boxes
    .filter((b) => b.length)
    .sort((a, b) => b.length - a.length)
    .map((box) => {
      const sum = box.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1], acc[2] + p[2]], [0, 0, 0]);
      return rgbToHex({ r: sum[0] / box.length, g: sum[1] / box.length, b: sum[2] / box.length });
    })
    .slice(0, count);
}

/* ------------------------------------------------------------ palettes */

/** The most saturated, mid-lightness colour: the brand accent of a set. */
export function pickAccent(colors: readonly string[]): string {
  let best = colors[0] ?? '#2B6D56';
  let score = -1;
  for (const c of colors) {
    const o = hexToOklch(c);
    const s = o.c * (1 - Math.abs(o.l - 0.55));
    if (s > score) {
      score = s;
      best = c;
    }
  }
  return normalizeHex(best);
}

/**
 * A full light palette and dark palette from brand colours ("Theme from
 * logo"). The accent keeps the brand hue; neutrals are tinted toward it; every
 * pair is contrast-fixed, because this one runs automatically.
 */
export function palettesFromColors(colors: readonly string[]): { light: Palette; dark: Palette } {
  const accent = pickAccent(colors.length ? colors : ['#2B6D56']);
  const a = hexToOklch(accent);
  const tint = (l: number, c: number) => oklchToHex({ l, c: Math.min(a.c, c), h: a.h });
  const highlightSource =
    colors
      .map((c) => normalizeHex(c))
      .find((c) => c !== accent && Math.abs(hexToOklch(c).h - a.h) > 40) ??
    oklchToHex({ l: 0.62, c: 0.12, h: (a.h + 40) % 360 });

  const lightBg = tint(0.975, 0.012);
  const light: Palette = {
    bg: lightBg,
    surface: tint(0.995, 0.006),
    surfaceAlt: tint(0.94, 0.02),
    text: tint(0.22, 0.03),
    muted: tint(0.45, 0.02),
    accent: fixContrast(accent, lightBg, 4.5),
    accentFg: '#FFFFFF',
    border: tint(0.88, 0.02),
    highlight: fixContrast(highlightSource, lightBg, 3),
  };
  light.accentFg = contrastRatio('#FFFFFF', light.accent) >= 4.5 ? '#FFFFFF' : light.text;
  light.muted = fixContrast(light.muted, light.surfaceAlt, 4.5);

  const darkBg = tint(0.16, 0.01);
  const darkAccent = fixContrast(oklchToHex({ ...a, l: Math.max(a.l, 0.7) }), darkBg, 4.5);
  const dark: Palette = {
    bg: darkBg,
    surface: tint(0.2, 0.012),
    surfaceAlt: tint(0.24, 0.014),
    text: tint(0.94, 0.012),
    muted: tint(0.74, 0.015),
    accent: darkAccent,
    accentFg: contrastRatio('#111111', darkAccent) >= 4.5 ? '#111111' : '#FFFFFF',
    border: tint(0.3, 0.015),
    highlight: fixContrast(highlightSource, darkBg, 3),
  };
  return { light, dark };
}

/** Gradient stops from a palette (mesh and gradient engines when `colors` is empty). */
export function gradientStopsFrom(palette: Palette, count = 3): string[] {
  const base = [palette.accent, palette.highlight, mix(palette.accent, palette.bg, 0.55)];
  const extra = [palette.surfaceAlt, mix(palette.highlight, palette.bg, 0.5), palette.text];
  return [...base, ...extra].slice(0, Math.min(6, Math.max(2, count)));
}

/**
 * Remix: `n` harmonious variations of a palette that keep its lightness
 * structure (and so its contrast) and rotate or nudge the hue family.
 * Deterministic for a seed, so Shuffle can step forward and back.
 */
export function remixPalette(palette: Palette, seed: number): Palette {
  const rotations = [0, 18, -18, 150, 180, -150, 32, -32, 120, -120];
  const rot = rotations[Math.abs(seed) % rotations.length] ?? 0;
  const out = { ...palette };
  for (const key of Object.keys(palette) as (keyof Palette)[]) {
    const o = hexToOklch(palette[key]);
    // Near-neutral tokens keep their hue so true black/ivory stay put.
    out[key] = o.c < 0.03 ? palette[key] : oklchToHex({ ...o, h: (o.h + rot + 360) % 360 });
  }
  out.accent = fixContrast(out.accent, out.bg, 4.5);
  out.highlight = fixContrast(out.highlight, out.bg, 3);
  out.accentFg = fixContrast(out.accentFg, out.accent, 4.5);
  return out;
}
