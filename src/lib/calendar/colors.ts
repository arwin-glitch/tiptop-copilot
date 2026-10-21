import type { GCalColor, GCalColors, GCalListEntry } from './google-types';
import type { CalendarColor, EventPaletteEntry } from './range-types';

/**
 * Colours come from Google, never from Copilot: each calendar's colour from
 * the calendar list, each event's from its own colorId in Google's event
 * palette, and an event without one takes its calendar's. That is the rule
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

/** Black or white text, whichever reads better on the background. */
export function readableOn(background: string): string {
  if (!HEX.test(background)) return '#1d1d1d';
  const n = Number.parseInt(background.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  return luminance > 0.4 ? '#1d1d1d' : '#ffffff';
}

/** A calendar's colour: its own backgroundColor, else its colorId in the palette. */
export function calendarColor(entry: GCalListEntry, colors: GCalColors | null): CalendarColor {
  return (
    clean({ background: entry.backgroundColor, foreground: entry.foregroundColor }) ??
    clean(entry.colorId ? colors?.calendar?.[entry.colorId] : undefined) ??
    NO_GOOGLE_COLOR
  );
}

/** An event's colour: its colorId's in Google's event palette, else its calendar's. */
export function eventColor(
  colorId: string | null | undefined,
  calendar: CalendarColor,
  colors: GCalColors | null,
): CalendarColor {
  return (colorId ? clean(colors?.event?.[colorId]) : null) ?? calendar;
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
