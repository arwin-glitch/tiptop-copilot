import type { EventTheme, Palette } from '@/lib/events/schema';
import { isHex, mix } from './color';
import { contrastRatio, luminance, readableHighlight } from './contrast';
import { engineColors } from './tokens';

/**
 * Readability of text over a theme's background engine (D-075 design review).
 * Pure, so the renderer, Studio's badges, the publish checklist and the tests
 * all reach the same answer.
 *
 *   - toneOfColors: whether an engine's colours read as a dark or a light
 *     ground (the hero then takes the matching palette as a band).
 *   - engineColorsForMode: a page-wide background keeps a preset's own
 *     colours, except in an explicit mode that fights them (Boardroom Noir
 *     switched to Light): then pale tints of that palette, so Light is light.
 *   - heroTextScrim: when the hero's text would fall below AA over the
 *     engine's colours (gradients, meshes, patterns, particle grounds), how
 *     strong a scrim of the band's own background goes behind the text. The
 *     strength is the smallest that brings every text colour to 4.5:1 over
 *     every colour of the backdrop, so the guarantee holds by construction.
 */

export type Tone = 'dark' | 'light';

/** A theme as stored or as a preset ships it (revisions don't matter here). */
export type ThemeLike = Omit<EventTheme, 'rev' | 'keyRevs'>;

/** Engines drawn over their first colour (grain, dither, waves, ...): that colour dominates. */
function drawnOverBack(theme: ThemeLike): boolean {
  const bg = theme.background;
  const variant = bg.options.variant;
  if (bg.engine === 'mesh') return variant === 'metaballs' || variant === 'swirl';
  return !['linear', 'radial', 'conic'].includes(bg.engine);
}

/** Whether these engine colours read as a dark or light ground (null: no ground of their own). */
export function toneOfColors(theme: ThemeLike, colors: readonly string[]): Tone | null {
  const bg = theme.background;
  if (bg.engine === 'image' || bg.engine === 'video') return 'dark';
  if (bg.engine === 'solid') return null;
  if (bg.engine === 'pattern') {
    // A hero pattern paints its ground (the first colour); a page pattern sits on the page.
    const ground = colors[0];
    if (bg.scope !== 'hero' || !ground) return null;
    const l = luminance(ground);
    return l < 0.25 ? 'dark' : l > 0.6 ? 'light' : null;
  }
  if (bg.engine === 'particles') {
    const ground = colors[0];
    return ground && luminance(ground) < 0.2 ? 'dark' : null;
  }
  const avg = colors.reduce((sum, c) => sum + luminance(c), 0) / Math.max(1, colors.length);
  const rest = colors.slice(1);
  const restAvg = rest.length ? rest.reduce((sum, c) => sum + luminance(c), 0) / rest.length : avg;
  const tone = drawnOverBack(theme) ? 0.6 * luminance(colors[0] ?? '#000000') + 0.4 * restAvg : avg;
  return tone < 0.3 ? 'dark' : 'light';
}

export function paletteTone(palette: Palette): Tone {
  return luminance(palette.bg) < 0.3 ? 'dark' : 'light';
}

/** Pale tints of a palette in its own tone: a quiet backdrop for any engine. */
export function quietStops(palette: Palette): string[] {
  return [
    palette.bg,
    mix(palette.surfaceAlt, palette.bg, 0.5),
    mix(palette.accent, palette.bg, 0.84),
    mix(palette.highlight, palette.bg, 0.86),
  ];
}

/** The palette a page is first shown in (light for 'auto'). */
export function activePalette(theme: ThemeLike): Palette {
  return theme.mode === 'dark' ? theme.paletteDark : theme.palette;
}

/**
 * The colours an engine draws with for the palette it is shown in. Hero
 * backgrounds always keep their own colours (TipTop Signature's emerald hero
 * on an ivory page is the design); a page-wide one in an explicit Light or
 * Dark mode that fights its colours uses pale tints of that palette.
 */
export function engineColorsForMode(theme: ThemeLike, palette: Palette): string[] {
  const own = engineColors(theme as EventTheme, palette);
  if (theme.background.scope !== 'page' || theme.mode === 'auto') return own;
  if (!theme.background.colors.some((c) => isHex(c))) return own;
  const tone = toneOfColors(theme, own);
  if (!tone || tone === paletteTone(palette)) return own;
  if (theme.background.engine === 'particles') {
    // Particles keep visible colours of the palette (no dark ground of their own).
    return [
      mix(palette.accent, palette.bg, 0.35),
      mix(palette.highlight, palette.bg, 0.35),
      mix(palette.text, palette.bg, 0.55),
    ];
  }
  return quietStops(palette);
}

/** The tone of the backdrop as rendered for this theme, or null (no ground of its own). */
export function backdropTone(theme: ThemeLike): Tone | null {
  const palette = activePalette(theme);
  return toneOfColors(theme, engineColorsForMode(theme, palette));
}

/** The opacity the CSS/poster layers of an engine are drawn at (background-layer.tsx). */
export function layerOpacity(theme: ThemeLike): number {
  const intensity = Math.max(0.15, Math.min(1, theme.background.intensity));
  return 0.35 + 0.65 * intensity;
}

/**
 * The colours text can land on: the engine's colours as drawn over the
 * section's own background (layer opacity, pattern line opacity, the veil).
 */
export function effectiveBackdrop(
  theme: ThemeLike,
  colors: readonly string[],
  ground: string,
): string[] {
  const bg = theme.background;
  const valid = colors.filter((c) => isHex(c));
  if (!valid.length || bg.engine === 'solid' || bg.engine === 'image' || bg.engine === 'video') {
    return [];
  }
  let out: string[];
  if (bg.engine === 'pattern') {
    const base = bg.scope === 'hero' ? (valid[0] ?? ground) : ground;
    const line = Number(bg.options.lineOpacity ?? 0.12);
    out = [base, mix(base, valid[1] ?? base, Math.max(0, Math.min(1, line)))];
  } else if (bg.engine === 'particles') {
    // Leading dark colours are the ground; the particles themselves are sparse.
    const grounds = valid.filter((c) => luminance(c) < 0.12).slice(0, 2);
    out = grounds.length ? grounds : [ground];
  } else {
    const a = layerOpacity(theme);
    out = valid.map((c) => mix(ground, c, a));
  }
  const veil = Number(bg.options.veil ?? 0);
  if (veil > 0) out = out.map((c) => mix(c, ground, Math.min(0.85, veil) * 0.6));
  return out;
}

const SCRIM_STEPS = [0.5, 0.6, 0.7, 0.8, 0.88, 0.94, 1] as const;

/** The weakest scrim (fraction of `scrim` over the backdrop) that brings every text colour to `target`. */
export function scrimStrength(
  text: readonly string[],
  backdrop: readonly string[],
  scrim: string,
  target = 4.5,
): number {
  const worst = (alpha: number) =>
    Math.min(...backdrop.flatMap((b) => text.map((t) => contrastRatio(t, mix(b, scrim, alpha)))));
  if (!backdrop.length || worst(0) >= target) return 0;
  for (const step of SCRIM_STEPS) if (worst(step) >= target) return step;
  return 1;
}

/** The text colours a palette draws in the hero: body, secondary and small labels. */
export function heroTextColors(palette: Palette): string[] {
  return [palette.text, palette.muted, readableHighlight(palette)];
}

/**
 * The palettes the hero's text can be drawn in: the band's (tone), else the
 * page's, both of them for 'auto' (the visitor's setting picks).
 */
export function heroPalettes(theme: ThemeLike, tone: Tone | null): Palette[] {
  if (tone === 'dark') return [theme.paletteDark];
  if (tone === 'light') return [theme.palette];
  if (theme.mode === 'auto') return [theme.palette, theme.paletteDark];
  return [activePalette(theme)];
}

/** How strong the scrim behind the hero's text is (0: none needed). */
export function heroTextScrim(theme: ThemeLike, tone: Tone | null): number {
  const bg = theme.background;
  if (['solid', 'image', 'video'].includes(bg.engine)) return 0;
  let strength = 0;
  for (const palette of heroPalettes(theme, tone)) {
    const colors = engineColorsForMode(theme, activePalette(theme));
    const backdrop = effectiveBackdrop(theme, colors, palette.bg);
    strength = Math.max(strength, scrimStrength(heroTextColors(palette), backdrop, palette.bg));
  }
  return strength;
}
