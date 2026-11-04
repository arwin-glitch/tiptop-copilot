import { describe, expect, it } from 'vitest';
import {
  CONTACT_STATUS_LABELS,
  CONTACT_STATUS_THRESHOLDS,
  connectionsLabel,
  contactStatus,
  daysSinceContact,
  hasContactFilter,
  lastContactTone,
  matchesContactFilter,
  NO_CONTACT_FILTER,
  parseContactFilter,
  signalBars,
} from '@/lib/network/contact-status';

/**
 * The relationship status tag (Never contacted / Recently contacted / Losing
 * touch / Lost touch) and the last-contact filters. Pins the thresholds so a
 * change to them is a deliberate one.
 */

const NOW = new Date('2026-11-04T12:00:00.000Z');
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

describe('contact status thresholds', () => {
  it('are 30 and 120 days', () => {
    expect(CONTACT_STATUS_THRESHOLDS).toEqual({ recentMaxDays: 30, losingMaxDays: 120 });
  });

  it('says never with no contact, or an unreadable date', () => {
    expect(contactStatus(null, NOW)).toBe('never');
    expect(contactStatus(undefined, NOW)).toBe('never');
    expect(contactStatus('not a date', NOW)).toBe('never');
  });

  it('switches exactly at the boundaries', () => {
    expect(contactStatus(ago(0), NOW)).toBe('recent');
    expect(contactStatus(ago(30), NOW)).toBe('recent');
    expect(contactStatus(ago(31), NOW)).toBe('losing');
    expect(contactStatus(ago(120), NOW)).toBe('losing');
    expect(contactStatus(ago(121), NOW)).toBe('lost');
    expect(contactStatus(ago(900), NOW)).toBe('lost');
  });

  it('treats a time just ahead (clock skew) as today', () => {
    expect(daysSinceContact(ago(-0.5), NOW)).toBe(0);
    expect(contactStatus(ago(-0.5), NOW)).toBe('recent');
  });

  it('labels every status the way Affinity does', () => {
    expect(CONTACT_STATUS_LABELS).toEqual({
      recent: 'Recently contacted',
      losing: 'Losing touch',
      lost: 'Lost touch',
      never: 'Never contacted',
    });
    expect(lastContactTone('recent')).toBe('ok');
    expect(lastContactTone('losing')).toBe('warn');
    expect(lastContactTone('lost')).toBe('muted');
    expect(lastContactTone('never')).toBe('muted');
  });
});

describe('last-contact filters', () => {
  const parse = (q: string) => {
    const params = new URLSearchParams(q);
    return parseContactFilter((n) => params.get(n));
  };

  it('parses the URL and ignores junk', () => {
    expect(parse('')).toEqual(NO_CONTACT_FILTER);
    expect(hasContactFilter(parse(''))).toBe(false);
    expect(parse('status=losing&within=14&beyond=x')).toEqual({
      status: 'losing',
      withinDays: 14,
      beyondDays: null,
    });
    expect(parse('status=cold&within=-3').status).toBeNull();
  });

  it('"N days or fewer" excludes never-contacted', () => {
    const f = { ...NO_CONTACT_FILTER, withinDays: 14 };
    expect(matchesContactFilter(ago(14), f, NOW)).toBe(true);
    expect(matchesContactFilter(ago(15), f, NOW)).toBe(false);
    expect(matchesContactFilter(null, f, NOW)).toBe(false);
  });

  it('"more than N days" includes never-contacted', () => {
    const f = { ...NO_CONTACT_FILTER, beyondDays: 60 };
    expect(matchesContactFilter(ago(61), f, NOW)).toBe(true);
    expect(matchesContactFilter(ago(60), f, NOW)).toBe(false);
    expect(matchesContactFilter(null, f, NOW)).toBe(true);
  });

  it('never contacted is an empty last contact', () => {
    const f = { ...NO_CONTACT_FILTER, status: 'never' as const };
    expect(matchesContactFilter(null, f, NOW)).toBe(true);
    expect(matchesContactFilter(ago(400), f, NOW)).toBe(false);
  });
});

describe('connections and signal bars', () => {
  it('names the first teammate and counts the rest', () => {
    expect(connectionsLabel([])).toBeNull();
    expect(connectionsLabel(['Dana Example'])).toBe('Dana Example');
    expect(connectionsLabel(['Dana Example', 'Lee Sample'])).toBe('Dana Example & Lee Sample');
    expect(connectionsLabel(['Dana Example', 'Lee Sample', 'Kim Test'])).toBe(
      'Dana Example & 2 more',
    );
  });

  it('gives one bar per quarter, none with no evidence', () => {
    expect(signalBars(0)).toBe(0);
    expect(signalBars(Number.NaN)).toBe(0);
    expect(signalBars(1)).toBe(1);
    expect(signalBars(25)).toBe(2);
    expect(signalBars(50)).toBe(3);
    expect(signalBars(75)).toBe(4);
    expect(signalBars(100)).toBe(4);
  });
});
