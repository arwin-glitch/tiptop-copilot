'use client';

import * as React from 'react';
import { RotateCcw, Shuffle, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import type { ThemePreset, ThemeVibe } from '@/lib/events/contracts';
import { paletteFromColors } from '@/lib/events/editor/contrast';
import { THEME_PRESETS, getThemePreset } from '@/lib/events/themes';
import type { EventTheme, FontId, ThemeKey } from '@/lib/events/schema';
import { cn } from '@/lib/util/cn';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/form';
import { ThemeThumbnail } from '@/components/events/render/theme-thumbnail';
import { Denied } from './inspector';
import { useStudio } from './studio-context';

const VIBES: { id: ThemeVibe | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'formal', label: 'Formal' },
  { id: 'modern', label: 'Modern' },
  { id: 'playful', label: 'Playful' },
  { id: 'golf', label: 'Golf' },
  { id: 'night', label: 'Night' },
  { id: 'seasonal', label: 'Seasonal' },
];

/** Curated display/body pairings Remix steps through. */
const PAIRINGS: [FontId, FontId][] = [
  ['cormorant-garamond', 'inter'],
  ['playfair-display', 'dm-sans'],
  ['fraunces', 'instrument-sans'],
  ['dm-serif-display', 'manrope'],
  ['instrument-serif', 'geist'],
  ['bodoni-moda', 'karla'],
  ['syne', 'inter-tight'],
  ['space-grotesk', 'ibm-plex-mono'],
  ['bricolage-grotesque', 'figtree'],
  ['young-serif', 'work-sans'],
];

const REMIX_ENGINES: EventTheme['background']['engine'][] = [
  'mesh',
  'grain',
  'linear',
  'radial',
  'waves',
  'pattern',
  'particles',
];

/** The keys a preset sets (never the brand kit or its locks). */
const PRESET_KEYS: ThemeKey[] = [
  'presetId',
  'mode',
  'palette',
  'paletteDark',
  'gradient',
  'typography',
  'shape',
  'layout',
  'background',
  'overlay',
  'finish',
  'intro',
  'motion',
  'peoplePhotos',
];

function pick<T>(list: readonly T[], avoid?: T): T {
  const pool =
    list.length > 1 ? list.filter((x) => JSON.stringify(x) !== JSON.stringify(avoid)) : list;
  return pool[Math.floor(Math.random() * pool.length)]!;
}

/**
 * Theme: presets (WS2's library, filtered by vibe), Remix (a harmonious
 * shuffle of palette, font pairing and background within the vibe, one
 * undo step), Reset to the preset, and Theme from logo (tokens from the
 * logo's extracted colours, contrast fixed). Locked parts stay as they are
 * for outside editors and the panel says so.
 */
export function ThemePanel() {
  const studio = useStudio();
  const theme = studio.doc.theme;
  const [vibe, setVibe] = React.useState<ThemeVibe | 'all'>('all');
  const [query, setQuery] = React.useState('');
  const presets = THEME_PRESETS.filter(
    (p) =>
      (vibe === 'all' || p.vibes.includes(vibe)) &&
      (!query.trim() || p.name.toLowerCase().includes(query.trim().toLowerCase())),
  );
  const denied = PRESET_KEYS.filter((k) => studio.themeDenied(k));
  const designDenied = studio.themeDenied('background');

  function applyPreset(preset: ThemePreset, label: string) {
    const set: Partial<Record<ThemeKey, unknown>> = {};
    for (const key of PRESET_KEYS) {
      if (!studio.themeDenied(key))
        set[key] = structuredClone(preset.theme[key as keyof ThemePreset['theme']]);
    }
    studio.updateTheme(set, label);
    if (denied.length) toast.message(`Kept as they were (brand locked): ${denied.join(', ')}.`);
  }

  function remix() {
    const current = getThemePreset(theme.presetId);
    const sameVibe = THEME_PRESETS.filter((p) => p.vibes.some((v) => current.vibes.includes(v)));
    const palettes = sameVibe.map((p) => ({ palette: p.theme.palette, dark: p.theme.paletteDark }));
    const palette = pick(palettes, { palette: theme.palette, dark: theme.paletteDark });
    const [display, body] = pick(PAIRINGS, [theme.typography.display, theme.typography.body]);
    const engine = pick(REMIX_ENGINES, theme.background.engine);
    studio.updateTheme(
      {
        palette: palette.palette,
        paletteDark: palette.dark,
        typography: { ...theme.typography, display, body },
        background: {
          ...theme.background,
          engine,
          ...(engine === 'pattern' ? { pattern: theme.background.pattern ?? 'dots' } : {}),
          ...(engine === 'particles' ? { particles: theme.background.particles ?? 'dust' } : {}),
        },
      },
      'Remix theme',
    );
  }

  function fromLogo() {
    const logoId = theme.brand.logo?.mediaId;
    const logo = logoId ? studio.mediaItems.find((m) => m.id === logoId) : undefined;
    if (!logo || !logo.colors.length) {
      toast.message('Add a logo in Brand first; its colours become the theme.');
      return;
    }
    studio.updateTheme(
      { palette: paletteFromColors(logo.colors, theme.palette) },
      'Theme from logo',
    );
  }

  return (
    <div className="space-y-3 p-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Theme</h2>
        {designDenied ? <Denied text={designDenied} /> : null}
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" disabled={Boolean(designDenied)} onClick={remix}>
          <Shuffle aria-hidden="true" />
          Remix
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={Boolean(designDenied)}
          onClick={() => applyPreset(getThemePreset(theme.presetId), 'Reset theme')}
        >
          <RotateCcw aria-hidden="true" />
          Reset
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={Boolean(studio.themeDenied('palette'))}
          onClick={fromLogo}
        >
          <Wand2 aria-hidden="true" />
          From logo
        </Button>
      </div>
      <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by vibe">
        {VIBES.map((v) => (
          <button
            key={v.id}
            type="button"
            aria-pressed={vibe === v.id}
            onClick={() => setVibe(v.id)}
            className={cn(
              'rounded-full border px-2 py-0.5 text-[11px]',
              vibe === v.id
                ? 'border-[var(--primary)] bg-[var(--accent-soft)] font-semibold'
                : 'border-[var(--border)] text-[var(--fg-muted)]',
            )}
          >
            {v.label}
          </button>
        ))}
      </div>
      <label className="sr-only" htmlFor="theme-search">
        Search themes
      </label>
      <Input
        id="theme-search"
        placeholder="Search themes"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {/* One column of real previews (background, display font, accent):
          two colour pills could not tell the themes apart. */}
      <ul aria-label="Theme presets" className="grid grid-cols-1 gap-2">
        {presets.map((preset) => {
          const current = theme.presetId === preset.id;
          return (
            <li key={preset.id}>
              <button
                type="button"
                aria-pressed={current}
                disabled={Boolean(designDenied)}
                onClick={() => applyPreset(preset, `Theme: ${preset.name}`)}
                className={cn(
                  'w-full overflow-hidden rounded-md border text-left disabled:opacity-60',
                  current
                    ? 'border-[var(--primary)] ring-1 ring-[var(--primary)]'
                    : 'border-[var(--border)]',
                )}
              >
                <ThemeThumbnail
                  theme={preset.theme}
                  title={preset.name}
                  className="ev-theme-thumb--wide"
                />
                <span className="block truncate px-1.5 py-1 text-[11px] font-medium">
                  {preset.name}
                </span>
              </button>
              {studio.boot.actor.owner ? (
                <a
                  href={`/e/theme_preview/${preset.id}`}
                  target="_blank"
                  rel="noopener"
                  className="mt-0.5 inline-block text-[11px] text-[var(--accent)] underline-offset-2 hover:underline"
                >
                  Open full preview
                </a>
              ) : null}
            </li>
          );
        })}
      </ul>
      {presets.length === 0 ? (
        <p className="text-xs text-[var(--fg-muted)]">No themes match.</p>
      ) : null}
    </div>
  );
}
