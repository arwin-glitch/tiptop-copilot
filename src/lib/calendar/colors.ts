import type { GCalColor, GCalColors, GCalListEntry } from './google-types';
import type { CalendarColor, EventLabel, EventPaletteEntry } from './range-types';

/**
 * Colours come from Google, never from Kraken: each calendar's colour from
 * the calendar list, each event's from its label (the calendar's named colour
 * labels, lib/calendar/labels.ts), else its own colorId in Google's event
 * palette, and an event with neither takes its calendar's. That is the rule
 * Google Calendar itself follows, so an event looks the same in both.
 */

/**
 * The names Google Calendar's colour picker gives the eleven event colours.
 * Only the names: the colours themselves are read from the colors endpoint.
 */
export const GOOGLE_EVENT_COLOR_NAMES: Readonly<Record<string, string>> = {
  '1': 'Lavender',
  '2': 'Sage',
  '3': 'Grape',
  '4': 'Flamingo',
  '5': 'Banana',
  '6': 'Tangerine',
  '7': 'Peacock',
  '8': 'Graphite',
  '9': 'Blueberry',
  '10': 'Basil',
  '11': 'Tomato',
};

/**
 * Used only if Google sent no colour at all for a calendar (it always does):
 * a neutral grey, so nothing is drawn in a colour Google never chose.
 */
export const NO_GOOGLE_COLOR: CalendarColor = { background: '#9e9e9e', foreground: '#1d1d1d' };

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * Google Calendar's names for the colours its labels come in, by `#rrggbb`:
 * the eleven event colours in their modern shades (the ones labels use) and
 * in the classic shades the colors endpoint returns, and the newer calendar
 * colours (Radicchio to Birch). A colour not listed has no name here.
 */
const GOOGLE_COLOR_NAMES: Readonly<Record<string, string>> = {
  // The eleven, modern shades.
  '#d50000': 'Tomato',
  '#e67c73': 'Flamingo',
  '#f4511e': 'Tangerine',
  '#f6bf26': 'Banana',
  '#33b679': 'Sage',
  '#0b8043': 'Basil',
  '#039be5': 'Peacock',
  '#3f51b5': 'Blueberry',
  '#7986cb': 'Lavender',
  '#8e24aa': 'Grape',
  '#616161': 'Graphite',
  // The same eleven, classic shades (the colors endpoint's event palette).
  '#dc2127': 'Tomato',
  '#ff887c': 'Flamingo',
  '#ffb878': 'Tangerine',
  '#fbd75b': 'Banana',
  '#7ae7bf': 'Sage',
  '#51b749': 'Basil',
  '#46d6db': 'Peacock',
  '#5484ed': 'Blueberry',
  '#a4bdfc': 'Lavender',
  '#dbadff': 'Grape',
  '#e1e1e1': 'Graphite',
  // The newer calendar colours.
  '#ad1457': 'Radicchio',
  '#d81b60': 'Cherry blossom',
  '#ef6c00': 'Pumpkin',
  '#f09300': 'Mango',
  '#e4c441': 'Citron',
  '#c0ca33': 'Avocado',
  '#7cb342': 'Pistachio',
  '#009688': 'Eucalyptus',
  '#4285f4': 'Cobalt',
  '#b39ddb': 'Wisteria',
  '#9e69af': 'Amethyst',
  '#795548': 'Cocoa',
  '#a79b8e': 'Birch',
};

/** Google's name for a colour ("Tomato"), or null when it is not one of Google's. */
export function googleColorName(background: string | null | undefined): string | null {
  return background ? (GOOGLE_COLOR_NAMES[background.toLowerCase()] ?? null) : null;
}

/** What a colour is called on screen: Google's name for it, else "Colour #rrggbb". */
export function colorWords(background: string): string {
  return googleColorName(background) ?? `Colour ${background.toLowerCase()}`;
}

/**
 * Below this chroma (CIE LCh, 0 to about 130) a colour reads as grey or
 * neutral: Graphite is 0, Birch about 9, while Cocoa, the dullest of Google's
 * real colours, is about 19.
 */
export const NEUTRAL_CHROMA = 10;

/** A #rrggbb colour's CIE LCh(ab) hue (0 to 360) and chroma, D65. */
export function lchOf(hex: string): { hue: number; chroma: number } | null {
  if (!HEX.test(hex)) return null;
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const fx = f((0.4124 * r! + 0.3576 * g! + 0.1805 * b!) / 0.95047);
  const fy = f(0.2126 * r! + 0.7152 * g! + 0.0722 * b!);
  const fz = f((0.0193 * r! + 0.1192 * g! + 0.9505 * b!) / 1.08883);
  const a = 500 * (fx - fy);
  const bb = 200 * (fy - fz);
  const hue = (Math.atan2(bb, a) * 180) / Math.PI;
  return { hue: hue < 0 ? hue + 360 : hue, chroma: Math.hypot(a, bb) };
}

/**
 * Google's order for colours in its label picker: round the colour wheel,
 * red, orange, yellow, green, blue, purple, then greys and neutrals last;
 * the same colour (or two neutrals) by name. The hue is CIE LCh's, the
 * perceptual one: it puts the ten colours of Google's own picker in exactly
 * the order Google shows them (Flamingo before Tomato, Basil before Sage,
 * Lavender before Blueberry), which the plain HSV hue does not.
 */
export function compareColors(
  a: { background: string; name?: string | null },
  b: { background: string; name?: string | null },
): number {
  const rank = (c: { background: string }) => {
    const lch = lchOf(c.background);
    return !lch || lch.chroma < NEUTRAL_CHROMA ? 1000 : lch.hue;
  };
  return (
    rank(a) - rank(b) ||
    (a.name ?? '').localeCompare(b.name ?? '', 'en', { sensitivity: 'base' }) ||
    a.background.localeCompare(b.background)
  );
}

function clean(color: Partial<GCalColor> | undefined): CalendarColor | null {
  if (!color?.background || !HEX.test(color.background)) return null;
  return {
    background: color.background.toLowerCase(),
    foreground:
      color.foreground && HEX.test(color.foreground)
        ? color.foreground.toLowerCase()
        : readableOn(color.background),
  };
}

/** A #rrggbb colour's relative luminance (WCAG), 0 for black to 1 for white. */
function luminanceOf(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** Black or white text, whichever reads better on the background. */
export function readableOn(background: string): string {
  if (!HEX.test(background)) return '#1d1d1d';
  return luminanceOf(background) > 0.4 ? '#1d1d1d' : '#ffffff';
}

/** The tick on a light swatch (Google's own dark text colour), and on a dark one. */
export const TICK_ON_LIGHT = '#1d1d1d';
export const TICK_ON_DARK = '#ffffff';

/**
 * The tick on the selected colour swatch: white on a dark swatch, dark on a
 * light one, whichever stands out more against that swatch (Tomato, Grape or
 * Graphite take white; Banana or Sage take dark). Null for a colour that is
 * not #rrggbb, where the tick takes the theme's text colour.
 */
export function tickOn(background: string): string | null {
  if (!HEX.test(background)) return null;
  const swatch = luminanceOf(background);
  const contrast = (tick: string) => {
    const other = luminanceOf(tick);
    return (Math.max(swatch, other) + 0.05) / (Math.min(swatch, other) + 0.05);
  };
  return contrast(TICK_ON_DARK) > contrast(TICK_ON_LIGHT) ? TICK_ON_DARK : TICK_ON_LIGHT;
}

/** A calendar's colour: its own backgroundColor, else its colorId in the palette. */
export function calendarColor(entry: GCalListEntry, colors: GCalColors | null): CalendarColor {
  return (
    clean({ background: entry.backgroundColor, foreground: entry.foregroundColor }) ??
    clean(entry.colorId ? colors?.calendar?.[entry.colorId] : undefined) ??
    NO_GOOGLE_COLOR
  );
}

/**
 * An event's colour: its label's when it has one its calendar defines, else
 * its colorId's in Google's event palette, else its calendar's.
 */
export function eventColor(
  colorId: string | null | undefined,
  calendar: CalendarColor,
  colors: GCalColors | null,
  label: Pick<EventLabel, 'color'> | null = null,
): CalendarColor {
  return label?.color ?? (colorId ? clean(colors?.event?.[colorId]) : null) ?? calendar;
}

/** A label's `#rrggbb` as a colour with readable text on it; null if it is not one. */
export function labelColor(backgroundColor: string | null | undefined): CalendarColor | null {
  return clean(backgroundColor ? { background: backgroundColor } : undefined);
}

/** Google's event palette in its own order (1 to 11), with the picker's names. */
export function eventPalette(colors: GCalColors | null): EventPaletteEntry[] {
  const entries = Object.entries(colors?.event ?? {});
  return entries
    .map(([id, color]) => ({ id, color: clean(color) }))
    .filter((e): e is { id: string; color: CalendarColor } => e.color !== null)
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map(({ id, color }) => ({
      id,
      name: GOOGLE_EVENT_COLOR_NAMES[id] ?? `Color ${id}`,
      ...color,
    }));
}
