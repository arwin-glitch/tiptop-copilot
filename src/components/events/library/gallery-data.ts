import { blockRegistry } from '@/lib/events/blocks';
import type { ThemeVibe } from '@/lib/events/contracts';
import { HEX_COLOR_RE } from '@/lib/events/schema';
import { STARTERS } from '@/lib/events/starters';
import { THEME_PRESETS } from '@/lib/events/themes';

/**
 * What the new-event dialog and the empty library show of WS2's starters and
 * theme presets: names, a line each, and a few colours. Built on the server
 * so the 33 full theme documents never travel to the browser.
 */

export interface StarterCard {
  id: string;
  name: string;
  description: string;
  themePresetId: string;
  sessions: string[];
  /** Minutes from the first session's start to the last one's end; null with no sessions. */
  spanMinutes: number | null;
  /** The local start the starter suggests ("13:00" for the AGM); null for none. */
  startTime: string | null;
  /** Block labels, in page order: "Cover", "Agenda", "RSVP". */
  sections: string[];
}

export interface ThemeSwatch {
  bg: string;
  surface: string;
  text: string;
  accent: string;
  highlight: string;
}

export interface ThemeCard {
  id: string;
  name: string;
  description: string;
  vibes: ThemeVibe[];
  wave: 'launch' | 'wave2';
  light: ThemeSwatch;
  dark: ThemeSwatch;
  /** The display font, as a name: "Cormorant Garamond". */
  display: string;
}

const hex = (value: unknown, fallback: string) =>
  typeof value === 'string' && HEX_COLOR_RE.test(value) ? value : fallback;

function swatchOf(palette: Record<string, unknown> | undefined, dark: boolean): ThemeSwatch {
  return {
    bg: hex(palette?.bg, dark ? '#0E0F0F' : '#F6F1E4'),
    surface: hex(palette?.surface, dark ? '#161817' : '#FFFDF7'),
    text: hex(palette?.text, dark ? '#EEE8D6' : '#0E2720'),
    accent: hex(palette?.accent, dark ? '#0DB376' : '#2B6D56'),
    highlight: hex(palette?.highlight, dark ? '#D4AF37' : '#9A7420'),
  };
}

/** "cormorant-garamond" → "Cormorant Garamond". */
export function fontName(id: unknown): string {
  if (typeof id !== 'string' || !id) return 'Serif';
  return (
    id
      .split('-')
      // Short parts are initials: "ibm-plex-mono" → "IBM Plex Mono", "dm-sans" → "DM Sans".
      .map((part) =>
        part.length <= 2 || part === 'ibm'
          ? part.toUpperCase()
          : part[0]!.toUpperCase() + part.slice(1),
      )
      .join(' ')
  );
}

export function starterCards(): StarterCard[] {
  return STARTERS.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    themePresetId: s.themePresetId,
    sessions: s.sessions.map((x) => x.name),
    spanMinutes: s.sessions.length
      ? Math.max(...s.sessions.map((x) => x.offsetMinutes + x.durationMinutes))
      : null,
    startTime: s.startTime ?? null,
    sections: s.sections.map((section) => blockRegistry.get(section.type)?.label ?? section.type),
  }));
}

export function themeCards(): ThemeCard[] {
  return THEME_PRESETS.map((p) => {
    const theme = p.theme as unknown as {
      palette?: Record<string, unknown>;
      paletteDark?: Record<string, unknown>;
      typography?: { display?: unknown };
    };
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      vibes: [...p.vibes],
      wave: p.wave,
      light: swatchOf(theme.palette, false),
      dark: swatchOf(theme.paletteDark ?? theme.palette, true),
      display: fontName(theme.typography?.display),
    };
  });
}
