import { describe, expect, it } from 'vitest';
import { THEME_PRESETS, getThemePreset } from '@/lib/events/themes';
import { checkTheme } from '@/lib/events/theme/check';
import {
  backdropTone,
  engineColorsForMode,
  heroTextScrim,
  quietStops,
} from '@/lib/events/theme/readability';
import { accentBand, themeVars } from '@/lib/events/theme/tokens';
import {
  checkPalette,
  CONTRAST_PAIRS,
  contrastGrade,
  contrastRatio,
  fixContrast,
  luminance,
  readableHighlight,
  readableOn,
} from '@/lib/events/theme/contrast';
import { hexToOklch, mix, oklchToHex, rgbToHex, hexToRgb } from '@/lib/events/theme/color';

describe('WCAG contrast', () => {
  it('matches the reference values', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
    expect(contrastRatio('#767676', '#FFFFFF')).toBeCloseTo(4.54, 2);
    expect(luminance('#FFFFFF')).toBeCloseTo(1, 5);
    expect(contrastRatio('#2B6D56', '#F6F1E4')).toBeGreaterThan(5);
  });

  it('grades like Studio’s badges', () => {
    expect(contrastGrade(7.2)).toBe('AAA');
    expect(contrastGrade(4.6)).toBe('AA');
    expect(contrastGrade(3.1)).toBe('AA Large');
    expect(contrastGrade(2)).toBe('Fail');
  });

  it('fixes a colour only by moving its lightness, and leaves passing colours alone', () => {
    expect(fixContrast('#2B6D56', '#F6F1E4')).toBe('#2B6D56');
    const fixed = fixContrast('#FFB38A', '#FFFFFF', 4.5);
    expect(contrastRatio(fixed, '#FFFFFF')).toBeGreaterThanOrEqual(4.5);
    const before = hexToOklch('#FFB38A');
    const after = hexToOklch(fixed);
    expect(Math.abs(after.h - before.h)).toBeLessThan(12);
    const onDark = fixContrast('#4C181A', '#0E0F12', 4.5);
    expect(contrastRatio(onDark, '#0E0F12')).toBeGreaterThanOrEqual(4.5);
    expect(readableOn('#0E2720')).toBe('#FFFFFF');
    expect(readableOn('#F6F1E4')).toBe('#111111');
  });

  it('round-trips colours', () => {
    expect(rgbToHex(hexToRgb('#2b6d56'))).toBe('#2B6D56');
    expect(oklchToHex(hexToOklch('#9A7420'))).toBe('#9A7420');
    expect(mix('#000000', '#FFFFFF', 0.5)).toBe('#808080');
  });
});

describe('every preset is AA in light AND dark', () => {
  const rows = THEME_PRESETS.flatMap((p) => [
    [p.id, 'light', p.theme.palette] as const,
    [p.id, 'dark', p.theme.paletteDark] as const,
  ]);

  it.each(rows)('%s (%s)', (_id, _mode, palette) => {
    const failures = checkPalette(palette)
      .filter((r) => !r.passes)
      .map((r) => `${r.label}: ${r.fg} on ${r.bg} = ${r.ratio.toFixed(2)} (needs ${r.target})`);
    expect(failures).toEqual([]);
  });

  it('checks body text, links and small labels at 4.5, and only rules at 3', () => {
    const textOnBg = CONTRAST_PAIRS.find((p) => p.fg === 'text' && p.bg === 'bg');
    expect(textOnBg?.target).toBe(4.5);
    // Small labels in the highlight colour use its reading tone, at 4.5.
    const labels = CONTRAST_PAIRS.filter((p) => p.fg === 'highlight' && p.reading);
    expect(labels.map((p) => p.target)).toEqual([4.5, 4.5]);
    expect(CONTRAST_PAIRS.find((p) => p.fg === 'accent' && p.bg === 'surface')?.target).toBe(4.5);
    // The highlight itself only as rules and large accents.
    const rules = CONTRAST_PAIRS.filter((p) => p.fg === 'highlight' && !p.reading);
    expect(rules.map((p) => p.target)).toEqual([3]);
  });
});

describe('the whole-theme check (design review: one source of truth)', () => {
  // Every preset as shipped, and as a host would switch it in the Brand panel.
  const rows = THEME_PRESETS.flatMap((p) =>
    (['as shipped', 'light', 'dark'] as const).map(
      (mode) => [p.id, mode, mode === 'as shipped' ? p.theme : { ...p.theme, mode }] as const,
    ),
  );

  it.each(rows)('%s (%s) is AA everywhere the page draws text', (_id, _mode, theme) => {
    const failures = checkTheme(theme as never)
      .filter((r) => !r.passes)
      .map((r) => `${r.mode} ${r.label}: ${r.fg} on ${r.bg} = ${r.ratio.toFixed(2)}`);
    expect(failures).toEqual([]);
  });

  it('small labels use a reading tone of the highlight; the brand gold stays for rules', () => {
    const signature = getThemePreset('tiptop-signature').theme;
    const reading = readableHighlight(signature.palette);
    expect(contrastRatio(reading, signature.palette.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(reading, signature.palette.surface)).toBeGreaterThanOrEqual(4.5);
    expect(reading).not.toBe(signature.palette.highlight.toUpperCase());
    // Agenda times on the emerald band.
    const band = accentBand(signature.palette, false);
    expect(contrastRatio(band.highlight, band.bg)).toBeGreaterThanOrEqual(4.5);
    expect(themeVars(signature as never)['--ev-l-highlight-text']).toBe(reading);
  });

  it('puts a scrim behind hero text that would fail over a gradient engine', () => {
    for (const id of ['botanical-garden-party', 'hill-country-golden-hour', 'quantum-mesh']) {
      const theme = getThemePreset(id).theme;
      const tone = backdropTone(theme);
      expect(heroTextScrim(theme, tone), id).toBeGreaterThan(0);
    }
    // A solid page needs none.
    expect(heroTextScrim(getThemePreset('annual-letter').theme, null)).toBe(0);
  });

  it('a dark-native page switched to Light draws the light palette’s own tints', () => {
    const noir = getThemePreset('boardroom-noir').theme;
    const light = { ...noir, mode: 'light' as const };
    expect(engineColorsForMode(light, light.palette)).toEqual(quietStops(light.palette));
    expect(backdropTone(light)).toBe('light');
    // As shipped (dark) it keeps its own colours.
    expect(engineColorsForMode(noir, noir.paletteDark)).toEqual(noir.background.colors);
  });
});
