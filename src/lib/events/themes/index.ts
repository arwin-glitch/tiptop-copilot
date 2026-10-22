import type { ThemePreset } from '@/lib/events/contracts';

/**
 * CONTRACT STUB — owned by WS2 (Design system). Replace the body, keep the
 * exports: THEME_PRESETS, DEFAULT_THEME_PRESET_ID, getThemePreset.
 *
 * Holds only the default preset today, TipTop Signature (Emerald & Gold), so
 * createEvent and the demo work before the 33 presets land. Arwin's brand
 * rule: green dominates, gold only for rules, labels and display accents,
 * and dark mode is near-black, never green surfaces.
 */

export const DEFAULT_THEME_PRESET_ID = 'tiptop-signature';

const tiptopSignature: ThemePreset = {
  id: DEFAULT_THEME_PRESET_ID,
  name: 'TipTop Signature',
  vibes: ['formal'],
  wave: 'launch',
  description: 'Emerald and gold, editorial serif headlines. The TipTop default.',
  theme: {
    presetId: DEFAULT_THEME_PRESET_ID,
    mode: 'auto',
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
    gradient: null,
    typography: {
      display: 'cormorant-garamond',
      body: 'inter',
      mono: 'ibm-plex-mono',
      scale: 1.25,
      displayWeight: 600,
      displayCase: 'none',
      tracking: -0.01,
      lineHeight: 1.55,
      bodySize: 17,
      tabularNums: true,
    },
    shape: {
      radius: 14,
      alternateCorners: false,
      buttonShape: 'pill',
      buttonFill: 'outline',
      buttonHover: 'lift',
    },
    layout: {
      width: '880',
      density: 'comfortable',
      align: 'center',
      divider: 'hairline',
      rule: 'gold',
    },
    background: {
      engine: 'mesh',
      colors: ['#0E2720', '#14392D', '#2B6D56'],
      intensity: 0.35,
      speed: 0.15,
      scale: 1,
      cursorReactive: false,
      scope: 'hero',
      options: { distortion: 0.2 },
    },
    overlay: {
      kind: 'none',
      density: 0.3,
      speed: 0.5,
      colors: ['#D4AF37'],
      area: 'hero',
      mode: 'ambient',
      options: {},
    },
    finish: {
      grain: 0.05,
      paper: 0,
      halftone: 0,
      scanlines: 0,
      vignette: 0,
      foil: false,
      emboss: false,
    },
    intro: { kind: 'none', oncePerVisitor: true },
    motion: {
      master: 'subtle',
      headlineEffect: 'blur_in',
      headlineSpeed: 1,
      entrance: 'fade_up',
      staggerMs: 60,
      parallax: 0,
      scrollZoomHero: false,
      stickyHeadings: false,
      rsvpMoment: 'gold_dust',
      cursor: 'default',
      countdownStyle: 'minimal',
      pausePosition: 'bottom-right',
    },
    peoplePhotos: { treatment: 'none', mask: 'circle' },
    brand: {
      kitId: 'tiptop',
      logo: null,
      logoDark: null,
      lockup: [],
      locks: { logo: true, palette: true, fonts: true, intro: true },
    },
  },
};

export const THEME_PRESETS: readonly ThemePreset[] = [tiptopSignature];

export function getThemePreset(id: string | null | undefined): ThemePreset {
  return THEME_PRESETS.find((p) => p.id === id) ?? tiptopSignature;
}
