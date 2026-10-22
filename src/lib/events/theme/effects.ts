import type { BackgroundEngine, EventTheme } from '@/lib/events/schema';

/**
 * The knobs each background engine and overlay accepts in its `options`
 * (schema.ts effectOptions: bounded primitives). The registry's
 * validateTheme rejects an unknown key, a wrong type or a value out of
 * range, so an outside editor can only ever set what an engine reads.
 */

/** Decorative chrome a theme can ask for (background.options.chrome). */
export const CHROMES = [
  'none',
  'deco',
  'terminal',
  'blueprint',
  'glass',
  'ticket',
  'scorecard',
  'menu',
  'polaroid',
] as const;
export type ThemeChrome = (typeof CHROMES)[number];

type OptionSpec =
  | { kind: 'number'; min: number; max: number }
  | { kind: 'boolean' }
  | { kind: 'enum'; values: readonly string[] };

const num = (min: number, max: number): OptionSpec => ({ kind: 'number', min, max });
const bool: OptionSpec = { kind: 'boolean' };
const oneOf = (values: readonly string[]): OptionSpec => ({ kind: 'enum', values });

export const GRAIN_SHAPES = [
  'wave',
  'dots',
  'truchet',
  'corners',
  'ripple',
  'blob',
  'sphere',
] as const;
export const DITHER_SHAPES = [
  'simplex',
  'warp',
  'dots',
  'wave',
  'ripple',
  'swirl',
  'sphere',
] as const;
export const DITHER_TYPES = ['random', '2x2', '4x4', '8x8'] as const;
export const MESH_VARIANTS = ['mesh', 'metaballs', 'warp', 'swirl'] as const;

/** Options every engine understands. */
const COMMON: Record<string, OptionSpec> = {
  /** Decorative chrome around the hero and cards (tokens.ts CHROMES). */
  chrome: oneOf(CHROMES),
  /** A soft wash behind hero text over busy backgrounds, 0–1. */
  veil: num(0, 1),
  /** A pulsing glow ring around the cover card. */
  glow: bool,
  /** A slow vignette "breath". */
  breath: bool,
  /** A warm candle flicker on the vignette (low frequency, never a flash). */
  flicker: bool,
};

export const BACKGROUND_OPTIONS: Record<BackgroundEngine, Record<string, OptionSpec>> = {
  solid: {},
  linear: {},
  radial: { x: num(0, 1), y: num(0, 1) },
  conic: {},
  mesh: {
    distortion: num(0, 1),
    swirl: num(0, 1),
    grain: num(0, 1),
    variant: oneOf(MESH_VARIANTS),
  },
  grain: { shape: oneOf(GRAIN_SHAPES), softness: num(0, 1), noise: num(0, 1) },
  dither: { shape: oneOf(DITHER_SHAPES), type: oneOf(DITHER_TYPES), size: num(1, 12) },
  waves: {
    frequency: num(0, 2),
    amplitude: num(0, 1),
    spacing: num(0, 2),
    rotation: num(0, 360),
  },
  smoke: { thickness: num(0, 1), radius: num(0, 1), noiseScale: num(0, 5) },
  god_rays: { density: num(0, 1), spotty: num(0, 1), bloom: num(0, 1), midSize: num(0, 1) },
  particles: { shootingStars: bool, depth: num(0, 1), twinkle: bool },
  pattern: { animate: bool, lineOpacity: num(0, 1), size: num(4, 200) },
  image: {},
  video: {},
};

export const OVERLAY_OPTIONS: Record<string, OptionSpec> = {
  sizeScale: num(0.25, 3),
  glow: bool,
};

function checkOptions(
  where: string,
  options: Record<string, unknown>,
  specs: Record<string, OptionSpec>,
): string[] {
  const issues: string[] = [];
  for (const [key, value] of Object.entries(options)) {
    const spec = specs[key];
    if (!spec) {
      issues.push(`${where}: "${key}" is not a setting of this effect.`);
      continue;
    }
    if (spec.kind === 'number') {
      if (typeof value !== 'number' || value < spec.min || value > spec.max) {
        issues.push(`${where}: ${key} must be a number from ${spec.min} to ${spec.max}.`);
      }
    } else if (spec.kind === 'boolean') {
      if (typeof value !== 'boolean') issues.push(`${where}: ${key} must be on or off.`);
    } else if (typeof value !== 'string' || !spec.values.includes(value)) {
      issues.push(`${where}: ${key} must be one of ${spec.values.join(', ')}.`);
    }
  }
  return issues;
}

/** Per-engine theme checks for the registry's validateTheme; [] when valid. */
export function validateThemeEffects(theme: EventTheme): string[] {
  const issues: string[] = [];
  const bg = theme.background;
  issues.push(
    ...checkOptions(`background (${bg.engine})`, bg.options, {
      ...COMMON,
      ...BACKGROUND_OPTIONS[bg.engine],
    }),
  );
  if (bg.engine === 'pattern' && !bg.pattern) {
    issues.push('background: a pattern background needs a pattern.');
  }
  if (bg.engine === 'particles' && !bg.particles) {
    issues.push('background: a particle background needs a particle kind.');
  }
  if (bg.engine === 'video' && bg.video && bg.video.poster.mediaId === bg.video.media.mediaId) {
    issues.push('background: the video poster must be an image, not the video itself.');
  }
  issues.push(
    ...checkOptions(`overlay (${theme.overlay.kind})`, theme.overlay.options, OVERLAY_OPTIONS),
  );
  if (theme.overlay.kind === 'custom' && !theme.overlay.custom) {
    issues.push('overlay: a custom overlay needs an uploaded emoji, logo or sticker.');
  }
  if (theme.intro.kind === 'envelope' && !theme.intro.envelope) {
    issues.push('intro: the envelope intro needs its envelope settings.');
  }
  return issues;
}

/** Read a numeric option with a default (renderers never trust shape). */
export function numOption(options: Record<string, unknown>, key: string, fallback: number): number {
  const v = options[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function boolOption(
  options: Record<string, unknown>,
  key: string,
  fallback = false,
): boolean {
  const v = options[key];
  return typeof v === 'boolean' ? v : fallback;
}

export function enumOption<T extends string>(
  options: Record<string, unknown>,
  key: string,
  values: readonly T[],
  fallback: T,
): T {
  const v = options[key];
  return typeof v === 'string' && (values as readonly string[]).includes(v) ? (v as T) : fallback;
}
