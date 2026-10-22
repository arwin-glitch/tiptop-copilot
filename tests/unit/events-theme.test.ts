import { describe, expect, it } from 'vitest';
import { blockRegistry } from '@/lib/events/blocks';
import { themeSchema, type EventTheme } from '@/lib/events/schema';
import {
  DEFAULT_THEME_PRESET_ID,
  getThemePreset,
  isThemePresetId,
  LAUNCH_PRESETS,
  presetsByVibe,
  presetVariants,
  THEME_PRESETS,
  WAVE2_THEME_PRESETS,
} from '@/lib/events/themes';
import {
  accentBand,
  CHROMES,
  checkPalette,
  contrastRatio,
  ENTRANCE_CAP_MS,
  entranceMs,
  hasLoopingMotion,
  liveScale,
  motionLevel,
  palettesFromColors,
  remixPalette,
  themeAttributes,
  themeVars,
  topColors,
  validateThemeEffects,
} from '@/lib/events/theme';

const withRevs = (theme: Omit<EventTheme, 'rev' | 'keyRevs'>): EventTheme => ({
  ...structuredClone(theme),
  rev: 0,
  keyRevs: {},
});

describe('theme presets', () => {
  it('ships 24 launch presets and 9 wave-2 presets with unique ids', () => {
    expect(THEME_PRESETS).toHaveLength(33);
    expect(LAUNCH_PRESETS).toHaveLength(24);
    expect(WAVE2_THEME_PRESETS).toHaveLength(9);
    expect(new Set(THEME_PRESETS.map((p) => p.id)).size).toBe(33);
  });

  it('lists the AGM-critical presets first', () => {
    expect(THEME_PRESETS.slice(0, 4).map((p) => p.id)).toEqual([
      'tiptop-signature',
      'annual-letter',
      'boardroom-noir',
      'envelope-wax-seal',
    ]);
    expect(DEFAULT_THEME_PRESET_ID).toBe('tiptop-signature');
  });

  it.each(THEME_PRESETS.map((p) => [p.id, p] as const))(
    '%s validates against the schema and the effect registry',
    (_id, preset) => {
      const theme = withRevs(preset.theme);
      expect(themeSchema.safeParse(theme).success).toBe(true);
      expect(theme.presetId).toBe(preset.id);
      expect(blockRegistry.validateTheme(theme)).toEqual([]);
      expect(preset.vibes.length).toBeGreaterThan(0);
      expect(preset.description.length).toBeGreaterThan(10);
    },
  );

  it('keeps TipTop Signature on Arwin’s brand rule (green dominates, near-black dark mode)', () => {
    const t = getThemePreset('tiptop-signature').theme;
    expect(t.palette.accent).toBe('#2B6D56');
    expect(t.palette.highlight).toBe('#9A7420');
    expect(t.paletteDark.bg).toBe('#0E0F0F');
    expect(t.typography.display).toBe('cormorant-garamond');
    expect(t.motion.master).toBe('subtle');
    expect(t.brand.locks).toEqual({ logo: true, palette: true, fonts: true, intro: true });
  });

  it('defaults formal presets to the Subtle motion master', () => {
    for (const p of presetsByVibe('formal').filter((x) => x.wave === 'launch')) {
      expect(['subtle', 'off']).toContain(p.theme.motion.master);
    }
  });

  it('falls back to the default preset for an unknown id', () => {
    expect(getThemePreset('nope').id).toBe('tiptop-signature');
    expect(getThemePreset(null).id).toBe('tiptop-signature');
    expect(isThemePresetId('starfield')).toBe(true);
    expect(isThemePresetId('starfield2')).toBe(false);
  });

  it('suggests only real layouts for each preset', () => {
    for (const p of THEME_PRESETS) {
      for (const [type, variant] of Object.entries(presetVariants(p.id))) {
        const def = blockRegistry.get(type as never);
        expect(def?.variants).toContain(variant);
      }
    }
  });
});

describe('tokens → CSS variables', () => {
  const theme = withRevs(getThemePreset('tiptop-signature').theme);
  const vars = themeVars(theme);

  it('emits both palettes, fonts and the type scale', () => {
    expect(vars['--ev-l-bg']).toBe('#F6F1E4');
    expect(vars['--ev-d-bg']).toBe('#0E0F0F');
    expect(vars['--ev-l-highlight']).toBe('#9A7420');
    expect(vars['--ev-font-display']).toMatch(/^'ev-cormorant-garamond', /);
    expect(vars['--ev-font-body']).toMatch(/^'ev-inter', /);
    expect(vars['--ev-fs-h1']).toMatch(/^clamp\(/);
    expect(vars['--ev-width']).toBe('880px');
    expect(vars['--ev-btn-radius']).toBe('999px');
  });

  it('emits only values built from validated tokens (no markup, no stray CSS)', () => {
    for (const p of THEME_PRESETS) {
      for (const [key, value] of Object.entries(themeVars(withRevs(p.theme)))) {
        expect(key).toMatch(/^--ev-[a-z0-9-]+$/);
        expect(value).not.toMatch(/[<>;{}]|url\(|expression|javascript:/i);
      }
    }
  });

  it('maps theme enums to data attributes', () => {
    const attrs = themeAttributes(theme);
    expect(attrs['data-theme-mode']).toBe('auto');
    expect(attrs['data-rule']).toBe('gold');
    expect(attrs['data-btn-fill']).toBe('outline');
    expect(CHROMES).toContain(attrs['data-chrome']);
  });

  it('builds a deep, readable accent band for every light palette', () => {
    for (const p of THEME_PRESETS) {
      const band = accentBand(p.theme.palette, false);
      expect(contrastRatio(band.fg, band.bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(band.highlight, band.bg)).toBeGreaterThanOrEqual(3);
      const dark = accentBand(p.theme.paletteDark, true);
      expect(dark.bg).toBe(p.theme.paletteDark.surfaceAlt);
    }
  });
});

describe('effect options', () => {
  const base = withRevs(getThemePreset('quantum-mesh').theme);

  it('rejects unknown keys, wrong types and out-of-range values', () => {
    const bad = structuredClone(base);
    bad.background.options = { distortion: 7, sparkle: true, variant: 'lava' };
    const issues = validateThemeEffects(bad);
    expect(issues.join(' ')).toMatch(/distortion must be a number from 0 to 1/);
    expect(issues.join(' ')).toMatch(/"sparkle" is not a setting/);
    expect(issues.join(' ')).toMatch(/variant must be one of/);
  });

  it('requires the parts an engine needs', () => {
    const pattern = structuredClone(base);
    pattern.background = { ...pattern.background, engine: 'pattern', options: {} };
    delete pattern.background.pattern;
    expect(validateThemeEffects(pattern).join(' ')).toMatch(/needs a pattern/);
    const custom = structuredClone(base);
    custom.overlay = { ...custom.overlay, kind: 'custom' };
    expect(validateThemeEffects(custom).join(' ')).toMatch(/custom overlay needs/);
  });
});

describe('motion master', () => {
  const theme = withRevs(getThemePreset('starfield').theme);

  it('resolves the level from the master and Studio’s preview', () => {
    expect(motionLevel(theme)).toBe('full');
    expect(motionLevel(theme, 'reduced')).toBe('reduced');
    expect(motionLevel(theme, 'off')).toBe('off');
    const off = structuredClone(theme);
    off.motion.master = 'off';
    expect(motionLevel(off, 'full')).toBe('off');
  });

  it('stops for reduced motion and Pause unless Studio forces full', () => {
    const base = { master: 'lively' as const, level: 'full' as const, forced: false };
    expect(liveScale({ ...base, reducedMotion: false, paused: false })).toBe(0.75);
    expect(liveScale({ ...base, reducedMotion: true, paused: false })).toBe(0);
    expect(liveScale({ ...base, reducedMotion: false, paused: true })).toBe(0);
    expect(liveScale({ ...base, forced: true, reducedMotion: true, paused: false })).toBe(0.75);
  });

  it('caps entrances near 600 ms at every master', () => {
    for (const master of ['subtle', 'lively', 'party'] as const) {
      expect(entranceMs(master, 0.5)).toBeLessThanOrEqual(ENTRANCE_CAP_MS);
    }
    expect(entranceMs('off')).toBe(0);
  });

  it('knows which presets loop (the Pause control appears for them)', () => {
    expect(hasLoopingMotion(theme)).toBe(true);
    expect(hasLoopingMotion(withRevs(getThemePreset('monochrome-gallery').theme))).toBe(false);
  });
});

describe('palettes from colours', () => {
  it('extracts the dominant colours of a pixel buffer', () => {
    const px = new Uint8ClampedArray(4 * 1000);
    for (let i = 0; i < 1000; i += 1) {
      const green = i < 700;
      px.set(green ? [43, 109, 86, 255] : [212, 175, 55, 255], i * 4);
    }
    const colors = topColors(px, 3);
    expect(colors[0]).toBe('#2B6D56');
    expect(colors).toContain('#D4AF37');
  });

  it('builds AA light and dark palettes from a logo’s colours (Theme from logo)', () => {
    for (const brand of [['#E4572E'], ['#1F3BFF', '#FFC93C'], ['#0B3D2E', '#F2C230', '#FFFFFF']]) {
      const { light, dark } = palettesFromColors(brand);
      expect(checkPalette(light).filter((r) => !r.passes)).toEqual([]);
      expect(checkPalette(dark).filter((r) => !r.passes)).toEqual([]);
    }
  });

  it('remixes a palette without breaking its contrast', () => {
    const palette = getThemePreset('tiptop-signature').theme.palette;
    for (let seed = 0; seed < 10; seed += 1) {
      const remixed = remixPalette(palette, seed);
      expect(contrastRatio(remixed.accentFg, remixed.accent)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(remixed.accent, remixed.bg)).toBeGreaterThanOrEqual(4.5);
      expect(remixed.bg).toBe(palette.bg);
    }
  });
});
