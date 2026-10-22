import { describe, expect, it } from 'vitest';
import { THEME_PRESETS } from '@/lib/events/themes';
import {
  checkPalette,
  CONTRAST_PAIRS,
  contrastGrade,
  contrastRatio,
  fixContrast,
  luminance,
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

  it('checks body text at 4.5 and display accents at 3', () => {
    const textOnBg = CONTRAST_PAIRS.find((p) => p.fg === 'text' && p.bg === 'bg');
    const highlight = CONTRAST_PAIRS.find((p) => p.fg === 'highlight');
    expect(textOnBg?.target).toBe(4.5);
    expect(highlight?.target).toBe(3);
  });
});
