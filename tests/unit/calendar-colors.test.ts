import { describe, expect, it } from 'vitest';
import {
  calendarColor,
  eventColor,
  eventPalette,
  NO_GOOGLE_COLOR,
  readableOn,
  TICK_ON_DARK,
  TICK_ON_LIGHT,
  tickOn,
} from '@/lib/calendar/colors';
import type { GCalColors } from '@/lib/calendar/google-types';
import { MOCK_COLORS } from '@/lib/calendar/mock-calendar';

/** Colours come from Google: an event's own colorId, else its calendar's. */

const COLORS: GCalColors = {
  calendar: { '14': { background: '#9FE1E7', foreground: '#1D1D1D' } },
  event: {
    '10': { background: '#51b749', foreground: '#1d1d1d' },
    '2': { background: '#7ae7bf', foreground: '#1d1d1d' },
    '11': { background: '#dc2127', foreground: '#ffffff' },
  },
};

describe('a calendar’s colour', () => {
  it('is its own backgroundColor from the calendar list', () => {
    expect(
      calendarColor(
        { id: 'a', backgroundColor: '#16a765', foregroundColor: '#000000', colorId: '14' },
        COLORS,
      ),
    ).toEqual({ background: '#16a765', foreground: '#000000' });
  });

  it('falls back to its colorId in Google’s calendar palette', () => {
    expect(calendarColor({ id: 'a', colorId: '14' }, COLORS)).toEqual({
      background: '#9fe1e7',
      foreground: '#1d1d1d',
    });
  });

  it('is a neutral grey only if Google sent nothing usable', () => {
    expect(calendarColor({ id: 'a', backgroundColor: 'teal' }, null)).toEqual(NO_GOOGLE_COLOR);
  });
});

describe('an event’s colour', () => {
  const calendar = { background: '#16a765', foreground: '#1d1d1d' };

  it('is its colorId’s colour in Google’s event palette', () => {
    expect(eventColor('10', calendar, COLORS)).toEqual({
      background: '#51b749',
      foreground: '#1d1d1d',
    });
  });

  it('is its calendar’s colour when it has no colorId, or one Google does not list', () => {
    expect(eventColor(null, calendar, COLORS)).toBe(calendar);
    expect(eventColor('99', calendar, COLORS)).toBe(calendar);
    expect(eventColor('10', calendar, null)).toBe(calendar);
  });

  it('picks readable text when Google sends no foreground', () => {
    expect(readableOn('#dc2127')).toBe('#ffffff');
    expect(readableOn('#fbd75b')).toBe('#1d1d1d');
  });
});

describe('the event palette', () => {
  it('lists Google’s colours in Google’s order, with the picker’s names', () => {
    expect(eventPalette(COLORS)).toEqual([
      { id: '2', name: 'Sage', background: '#7ae7bf', foreground: '#1d1d1d' },
      { id: '10', name: 'Basil', background: '#51b749', foreground: '#1d1d1d' },
      { id: '11', name: 'Tomato', background: '#dc2127', foreground: '#ffffff' },
    ]);
    expect(eventPalette(null)).toEqual([]);
  });
});

describe('the tick on the selected swatch', () => {
  /** WCAG contrast between two #rrggbb colours. */
  function contrast(a: string, b: string): number {
    const lum = (hex: string) => {
      const n = Number.parseInt(hex.slice(1), 16);
      const [r, g, bl] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
        const v = c / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
    };
    const [x, y] = [lum(a), lum(b)];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }

  it('is white on a dark swatch and dark on a light one', () => {
    // Dark swatches: Tomato, and the darker shades Google Calendar draws for
    // Blueberry, Basil, Graphite and Grape.
    for (const dark of ['#dc2127', '#d50000', '#3f51b5', '#0b8043', '#616161', '#8e24aa']) {
      expect(tickOn(dark), dark).toBe(TICK_ON_DARK);
    }
    // Light swatches: Banana, Sage, Lavender, Graphite's light grey.
    for (const light of ['#fbd75b', '#7ae7bf', '#a4bdfc', '#e1e1e1']) {
      expect(tickOn(light), light).toBe(TICK_ON_LIGHT);
    }
  });

  it('stands out on every colour of the palette (3:1 or better, as a graphic needs)', () => {
    const swatches = [
      ...Object.values(MOCK_COLORS.event ?? {}),
      ...Object.values(MOCK_COLORS.calendar ?? {}),
    ].map((c) => c.background);
    expect(swatches.length).toBeGreaterThan(20);
    for (const background of swatches) {
      expect(contrast(tickOn(background)!, background), background).toBeGreaterThanOrEqual(3);
    }
  });

  it('leaves a colour it cannot read to the theme', () => {
    expect(tickOn('tomato')).toBeNull();
    expect(tickOn('#fff')).toBeNull();
  });
});
