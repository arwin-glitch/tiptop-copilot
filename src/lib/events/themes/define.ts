import type { ThemePreset, ThemeVibe } from '@/lib/events/contracts';
import type { BlockType, EventTheme, Palette } from '@/lib/events/schema';

/**
 * Presets are DATA over the shared engines (D-075): a palette pair, type,
 * shape, layout, a background engine, an overlay, a finish, an intro and
 * motion. `definePreset` fills the defaults so each preset file states only
 * what makes it itself. Every preset must pass AA in light and dark
 * (tests/unit/events-contrast.test.ts) and validate against the schema and
 * the effect registry (tests/unit/events-theme.test.ts).
 */

type Theme = Omit<EventTheme, 'rev' | 'keyRevs'>;

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K] };

export interface PresetInput {
  id: string;
  name: string;
  vibes: ThemeVibe[];
  wave: 'launch' | 'wave2';
  description: string;
  palette: Palette;
  paletteDark: Palette;
  /** Section layouts the preset looks best with (Studio offers them on apply; starters use them). */
  variants?: Partial<Record<BlockType, string>>;
  theme: DeepPartial<Omit<Theme, 'palette' | 'paletteDark' | 'presetId'>> & {
    background?: Partial<Theme['background']>;
  };
}

const BASE: Omit<Theme, 'palette' | 'paletteDark' | 'presetId'> = {
  mode: 'auto',
  gradient: null,
  typography: {
    display: 'inter-tight',
    body: 'inter',
    mono: 'jetbrains-mono',
    scale: 1.25,
    displayWeight: 600,
    displayCase: 'none',
    tracking: -0.01,
    lineHeight: 1.55,
    bodySize: 17,
    tabularNums: true,
  },
  shape: {
    radius: 12,
    alternateCorners: false,
    buttonShape: 'pill',
    buttonFill: 'solid',
    buttonHover: 'lift',
  },
  layout: {
    width: '880',
    density: 'comfortable',
    align: 'center',
    divider: 'none',
    rule: 'accent',
  },
  background: {
    engine: 'solid',
    colors: [],
    intensity: 0.6,
    speed: 0.4,
    scale: 1,
    cursorReactive: false,
    scope: 'hero',
    options: {},
  },
  overlay: {
    kind: 'none',
    density: 0.3,
    speed: 0.5,
    colors: [],
    area: 'hero',
    mode: 'ambient',
    options: {},
  },
  finish: {
    grain: 0,
    paper: 0,
    halftone: 0,
    scanlines: 0,
    vignette: 0,
    foil: false,
    emboss: false,
  },
  intro: { kind: 'none', oncePerVisitor: true },
  motion: {
    master: 'lively',
    headlineEffect: 'none',
    headlineSpeed: 1,
    entrance: 'fade_up',
    staggerMs: 60,
    parallax: 0,
    scrollZoomHero: false,
    stickyHeadings: false,
    rsvpMoment: 'confetti',
    cursor: 'default',
    countdownStyle: 'minimal',
    pausePosition: 'bottom-right',
  },
  peoplePhotos: { treatment: 'none', mask: 'circle' },
  brand: {
    kitId: null,
    logo: null,
    logoDark: null,
    lockup: [],
    locks: { logo: false, palette: false, fonts: false, intro: false },
  },
};

export interface DefinedPreset extends ThemePreset {
  variants: Partial<Record<BlockType, string>>;
}

export function definePreset(input: PresetInput): DefinedPreset {
  const t = input.theme;
  const theme: Theme = {
    presetId: input.id,
    mode: t.mode ?? BASE.mode,
    palette: { ...input.palette },
    paletteDark: { ...input.paletteDark },
    gradient: t.gradient === undefined ? BASE.gradient : (t.gradient as Theme['gradient']),
    typography: { ...BASE.typography, ...t.typography },
    shape: { ...BASE.shape, ...t.shape },
    layout: { ...BASE.layout, ...t.layout },
    background: { ...BASE.background, ...t.background, options: { ...t.background?.options } },
    overlay: { ...BASE.overlay, ...t.overlay, options: { ...t.overlay?.options } },
    finish: { ...BASE.finish, ...t.finish },
    intro: { ...BASE.intro, ...t.intro } as Theme['intro'],
    motion: { ...BASE.motion, ...t.motion },
    peoplePhotos: { ...BASE.peoplePhotos, ...t.peoplePhotos },
    brand: {
      ...BASE.brand,
      ...t.brand,
      locks: { ...BASE.brand.locks, ...t.brand?.locks },
    } as Theme['brand'],
  };
  return {
    id: input.id,
    name: input.name,
    vibes: input.vibes,
    wave: input.wave,
    description: input.description,
    theme,
    variants: input.variants ?? {},
  };
}
