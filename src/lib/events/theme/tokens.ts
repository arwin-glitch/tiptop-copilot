import { fontStack } from '@/lib/events/fonts';
import type { EventTheme, Palette } from '@/lib/events/schema';
import { PALETTE_TOKENS } from '@/lib/events/schema';
import { hexToOklch, isHex, oklchToHex } from './color';
import { contrastRatio, fixContrast, readableHighlight } from './contrast';
import { CHROMES, type ThemeChrome } from './effects';
import { gradientStopsFrom } from './palette';

/**
 * Theme tokens → CSS custom properties (--ev-*) and data attributes.
 *
 * The renderer sets these as an inline `style` on [data-event-root]; every
 * rule in event.css reads only --ev-* variables and data attributes. Both
 * palettes ship as variables (--ev-l-*, --ev-d-*) so light/dark/auto and
 * per-section bands switch with CSS alone (no inline <style>, no script).
 *
 * Every value here comes from a validated theme: hex colours, enum ids and
 * bounded numbers. Nothing a person typed reaches CSS as text.
 */

const KEBAB: Record<keyof Palette, string> = {
  bg: 'bg',
  surface: 'surface',
  surfaceAlt: 'surface-alt',
  text: 'text',
  muted: 'muted',
  accent: 'accent',
  accentFg: 'accent-fg',
  border: 'border',
  highlight: 'highlight',
};

export const PALETTE_VAR_NAMES = PALETTE_TOKENS.map((t) => KEBAB[t]);

function safeHex(value: string, fallback: string): string {
  return isHex(value) ? value : fallback;
}

/**
 * `--ev-l-bg`, `--ev-d-accent`, … for one palette, plus the highlight's
 * reading tone (`--ev-l-highlight-text`): small labels in the highlight
 * colour reach 4.5:1 while rules keep the exact brand highlight.
 */
export function paletteVars(palette: Palette, prefix: 'l' | 'd'): Record<string, string> {
  const out: Record<string, string> = {};
  for (const token of PALETTE_TOKENS) {
    out[`--ev-${prefix}-${KEBAB[token]}`] = safeHex(palette[token], '#000000');
  }
  const safe = Object.fromEntries(
    PALETTE_TOKENS.map((t) => [t, safeHex(palette[t], '#000000')]),
  ) as Palette;
  out[`--ev-${prefix}-highlight-text`] = readableHighlight(safe);
  return out;
}

/**
 * The accent band (a section with background 'accent'): a DEEP tone of the
 * accent with the most readable of the palette's light colours on it, and a
 * highlight lifted to 4.5:1 on it (agenda times are small text). TipTop
 * Signature's emerald agenda band is
 * this. In a dark palette the band is the alternate surface instead (dark
 * mode stays near-black, never coloured surfaces).
 */
export function accentBand(
  palette: Palette,
  dark: boolean,
): { bg: string; fg: string; highlight: string } {
  if (dark) {
    return {
      bg: palette.surfaceAlt,
      fg: palette.text,
      highlight: fixContrast(palette.highlight, palette.surfaceAlt, 4.5),
    };
  }
  const a = hexToOklch(palette.accent);
  const bg = oklchToHex({ ...a, l: Math.min(a.l, 0.36) });
  const candidates = [palette.accentFg, palette.bg, palette.surface, '#FFFFFF'];
  const fg = candidates.reduce(
    (best, c) => (contrastRatio(c, bg) > contrastRatio(best, bg) ? c : best),
    candidates[0] as string,
  );
  return { bg, fg, highlight: fixContrast(palette.highlight, bg, 4.5) };
}

function bandVars(palette: Palette, prefix: 'l' | 'd'): Record<string, string> {
  const band = accentBand(palette, prefix === 'd');
  return {
    [`--ev-${prefix}-band-bg`]: band.bg,
    [`--ev-${prefix}-band-fg`]: band.fg,
    [`--ev-${prefix}-band-hl`]: band.highlight,
  };
}

export const CONTENT_WIDTH_PX: Record<EventTheme['layout']['width'], string> = {
  '640': '640px',
  '880': '880px',
  '1200': '1200px',
  full: '100%',
};

/** Section padding (block) and the gap between elements, per density. */
export const DENSITY: Record<
  EventTheme['layout']['density'],
  { section: string; gap: string; card: string }
> = {
  compact: { section: 'clamp(2.25rem, 5cqi, 3.5rem)', gap: '0.875rem', card: '1rem' },
  comfortable: { section: 'clamp(3rem, 8cqi, 6rem)', gap: '1.25rem', card: '1.5rem' },
  airy: { section: 'clamp(4rem, 11cqi, 8.5rem)', gap: '1.75rem', card: '2rem' },
};

const CASE: Record<EventTheme['typography']['displayCase'], string> = {
  none: 'none',
  title: 'capitalize',
  upper: 'uppercase',
  lower: 'lowercase',
};

const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * The type scale. Body is the theme's size; headings climb by the ratio and
 * are fluid against the CONTAINER (cqi), so Studio's phone frame renders
 * exactly like a phone.
 */
export function typeScale(theme: EventTheme): Record<string, string> {
  const { bodySize, scale, displayCase, tracking } = theme.typography;
  // Capitals with open tracking set wider: headings step down so they still fit.
  const wide = displayCase === 'upper' ? Math.max(0.72, 0.9 - Math.max(0, tracking) * 1.6) : 1;
  const step = (n: number) => bodySize * scale ** n * (n >= 2 ? wide : 1);
  const fluid = (minStep: number, maxStep: number, cqi: number) =>
    `clamp(${round(step(minStep) / 16)}rem, ${round(cqi, 2)}cqi + ${round(step(minStep) / 32)}rem, ${round(step(maxStep) / 16)}rem)`;
  return {
    '--ev-fs-body': `${round(bodySize / 16)}rem`,
    '--ev-fs-small': `${round(Math.max(14, bodySize / scale) / 16)}rem`,
    '--ev-fs-h4': `${round(step(1) / 16)}rem`,
    '--ev-fs-h3': fluid(1, 2, 1.2),
    '--ev-fs-h2': fluid(2, 3.5, 2.6),
    '--ev-fs-h1': fluid(3, 6, 5.2),
    '--ev-fs-mega': `clamp(${round(step(4) / 16)}rem, 13cqi, ${round(step(9) / 16)}rem)`,
  };
}

/** Background colours for gradient/mesh/particle engines: the theme's own, else from the palette. */
export function engineColors(theme: EventTheme, palette: Palette): string[] {
  const own = theme.background.colors.filter((c) => isHex(c));
  if (own.length >= 2) return own;
  if (own.length === 1) return [own[0] as string, palette.bg];
  return gradientStopsFrom(palette, 3);
}

/** The theme's CSS gradient (2–6 stops + angle), or a palette-derived one. */
export function gradientCss(theme: EventTheme, palette: Palette): string {
  const g = theme.gradient;
  const stops = g ? g.stops.filter((s) => isHex(s)) : gradientStopsFrom(palette, 3);
  const angle = g ? round(g.angle, 1) : 135;
  return `linear-gradient(${angle}deg, ${stops.join(', ')})`;
}

/** Every CSS variable the root needs, as a React style object. */
export function themeVars(theme: EventTheme): Record<string, string> {
  const t = theme.typography;
  const density = DENSITY[theme.layout.density];
  const radius = theme.shape.radius;
  const buttonRadius =
    theme.shape.buttonShape === 'pill'
      ? '999px'
      : theme.shape.buttonShape === 'square' || theme.shape.buttonShape === 'stamp'
        ? '0px'
        : `${Math.min(radius, 16)}px`;
  return {
    ...paletteVars(theme.palette, 'l'),
    ...paletteVars(theme.paletteDark, 'd'),
    ...bandVars(theme.palette, 'l'),
    ...bandVars(theme.paletteDark, 'd'),
    '--ev-font-display': fontStack(t.display),
    '--ev-font-body': fontStack(t.body),
    '--ev-font-mono': fontStack(t.mono),
    '--ev-display-weight': String(t.displayWeight),
    '--ev-display-case': CASE[t.displayCase],
    '--ev-tracking': `${round(t.tracking)}em`,
    '--ev-line': String(round(t.lineHeight, 2)),
    '--ev-nums': t.tabularNums ? 'tabular-nums' : 'normal',
    ...typeScale(theme),
    '--ev-radius': `${radius}px`,
    '--ev-radius-sm': `${Math.round(radius * 0.6)}px`,
    '--ev-radius-alt': theme.shape.alternateCorners ? '0px' : `${radius}px`,
    '--ev-btn-radius': buttonRadius,
    '--ev-width': CONTENT_WIDTH_PX[theme.layout.width],
    '--ev-section-pad': density.section,
    '--ev-gap': density.gap,
    '--ev-card-pad': density.card,
    '--ev-l-gradient': gradientCss(theme, theme.palette),
    '--ev-d-gradient': gradientCss(theme, theme.paletteDark),
    '--ev-headline-speed': String(round(theme.motion.headlineSpeed, 2)),
    '--ev-stagger': `${theme.motion.staggerMs}ms`,
    '--ev-parallax': String(round(theme.motion.parallax, 2)),
    '--ev-grain': String(round(theme.finish.grain, 2)),
    '--ev-paper': String(round(theme.finish.paper, 2)),
    '--ev-halftone': String(round(theme.finish.halftone, 2)),
    '--ev-scanlines': String(round(theme.finish.scanlines, 2)),
    '--ev-vignette': String(round(theme.finish.vignette, 2)),
  };
}

/** Data attributes the CSS keys off. All values are enum members. */
export function themeAttributes(theme: EventTheme): Record<string, string> {
  return {
    'data-theme-mode': theme.mode,
    'data-preset': theme.presetId,
    'data-rule': theme.layout.rule,
    'data-divider': theme.layout.divider,
    'data-density': theme.layout.density,
    'data-align': theme.layout.align,
    'data-width': theme.layout.width,
    'data-btn-shape': theme.shape.buttonShape,
    'data-btn-fill': theme.shape.buttonFill,
    'data-btn-hover': theme.shape.buttonHover,
    'data-alt-corners': theme.shape.alternateCorners ? 'true' : 'false',
    'data-headline': theme.motion.headlineEffect,
    'data-entrance': theme.motion.entrance,
    'data-sticky-headings': theme.motion.stickyHeadings ? 'true' : 'false',
    'data-scroll-zoom': theme.motion.scrollZoomHero ? 'true' : 'false',
    'data-people': theme.peoplePhotos.treatment,
    'data-people-mask': theme.peoplePhotos.mask,
    'data-foil': theme.finish.foil ? 'true' : 'false',
    'data-emboss': theme.finish.emboss ? 'true' : 'false',
    'data-chrome': chromeOf(theme),
    'data-bg-pattern':
      theme.background.engine === 'pattern' ? (theme.background.pattern ?? 'none') : 'none',
    'data-display-case': theme.typography.displayCase,
    // Grain animates only when it can be seen (a near-zero grain is still).
    'data-grain': theme.finish.grain >= 0.1 ? 'on' : 'off',
  };
}

/** The decorative chrome (frames, card treatment) a theme asks for, via background.options.chrome. */
export function chromeOf(theme: EventTheme): ThemeChrome {
  const value = theme.background.options.chrome;
  return typeof value === 'string' && (CHROMES as readonly string[]).includes(value)
    ? (value as ThemeChrome)
    : 'none';
}

/** Which palette a viewer sees first, for things that cannot follow CSS (OG card, thumbnails). */
export function primaryPalette(theme: EventTheme): Palette {
  return theme.mode === 'dark' ? theme.paletteDark : theme.palette;
}
