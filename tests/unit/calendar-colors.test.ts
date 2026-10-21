import { describe, expect, it } from 'vitest';
import {
  calendarColor,
  eventColor,
  eventPalette,
  NO_GOOGLE_COLOR,
  readableOn,
} from '@/lib/calendar/colors';
import type { GCalColors } from '@/lib/calendar/google-types';

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
