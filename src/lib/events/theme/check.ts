import type { Palette } from '@/lib/events/schema';
import { mix } from './color';
import { checkPalette, contrastRatio, type ContrastGrade, contrastGrade } from './contrast';
import {
  activePalette,
  backdropTone,
  effectiveBackdrop,
  engineColorsForMode,
  heroPalettes,
  heroTextColors,
  heroTextScrim,
  type ThemeLike,
} from './readability';
import { accentBand } from './tokens';

/**
 * The ONE contrast check for a whole theme (D-075 design review): Studio's
 * Brand badges, the publish checklist and the tests all read this, so they
 * cannot disagree with what the renderer draws. For every palette the page
 * can show (light, dark, or both for Auto) it checks the palette pairs
 * (lib/events/theme/contrast.ts), the accent band (text and labels on it),
 * and the hero's text over the background engine as drawn, scrim included.
 */

export interface ThemeContrastResult {
  mode: 'light' | 'dark';
  label: string;
  fg: string;
  bg: string;
  ratio: number;
  target: number;
  grade: ContrastGrade;
  passes: boolean;
}

function result(
  mode: 'light' | 'dark',
  label: string,
  fg: string,
  bg: string,
  target: number,
): ThemeContrastResult {
  const ratio = contrastRatio(fg, bg);
  return {
    mode,
    label,
    fg,
    bg,
    ratio,
    target,
    grade: contrastGrade(ratio),
    passes: ratio >= target,
  };
}

function modesOf(theme: ThemeLike): ('light' | 'dark')[] {
  return theme.mode === 'auto' ? ['light', 'dark'] : [theme.mode];
}

function paletteFor(theme: ThemeLike, mode: 'light' | 'dark'): Palette {
  return mode === 'dark' ? theme.paletteDark : theme.palette;
}

export function checkTheme(theme: ThemeLike): ThemeContrastResult[] {
  const out: ThemeContrastResult[] = [];
  for (const mode of modesOf(theme)) {
    const palette = paletteFor(theme, mode);
    for (const p of checkPalette(palette)) {
      out.push(result(mode, p.label, p.fgColor, p.bgColor, p.target));
    }
    const band = accentBand(palette, mode === 'dark');
    out.push(result(mode, 'Text on accent bands', band.fg, band.bg, 4.5));
    out.push(result(mode, 'Labels on accent bands', band.highlight, band.bg, 4.5));
  }

  // The hero's text over the engine, as drawn (the band's palette, the scrim).
  const tone = backdropTone(theme);
  const strength = heroTextScrim(theme, tone);
  const colors = engineColorsForMode(theme, activePalette(theme));
  for (const palette of heroPalettes(theme, tone)) {
    const mode = palette === theme.paletteDark ? 'dark' : 'light';
    const backdrop = effectiveBackdrop(theme, colors, palette.bg).map((c) =>
      mix(c, palette.bg, strength),
    );
    if (!backdrop.length) continue;
    const labels = ['Hero text', 'Hero secondary text', 'Hero labels'];
    heroTextColors(palette).forEach((fg, i) => {
      const worst = backdrop.reduce(
        (w, b) => (contrastRatio(fg, b) < contrastRatio(fg, w) ? b : w),
        backdrop[0]!,
      );
      out.push(result(mode, `${labels[i]} over the background`, fg, worst, 4.5));
    });
  }
  return out;
}

/** Plain-language problems, for the publish checklist (empty: all AA). */
export function themeContrastProblems(theme: ThemeLike): string[] {
  const several = theme.mode === 'auto';
  return checkTheme(theme)
    .filter((r) => !r.passes)
    .map(
      (r) =>
        `${several ? `${r.mode}: ` : ''}${r.label} is ${r.ratio.toFixed(1)}:1 (needs ${r.target}:1)`,
    );
}
