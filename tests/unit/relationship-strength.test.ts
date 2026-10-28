import { describe, expect, it } from 'vitest';
import {
  affinitySmartValues,
  DEFAULT_GOING_COLD_DAYS,
  evidenceSummary,
  formatSmartValue,
  goingColdDays,
  isGoingCold,
  NO_EVIDENCE,
  peakLabel,
  recencyFactor,
  recencyText,
  scoreRelationship,
  smartFieldForHeader,
  smartFields,
  STRENGTH_MODEL,
  type RelationshipEvidence,
} from '@/lib/network/strength';

/**
 * The strength score exists to be audited, so these pin the arithmetic: the
 * same evidence always scores the same, every point is accounted for in the
 * parts, recency halves the score on schedule, and the "why" text says what
 * was counted. All people and dates are invented.
 */

const NOW = new Date('2026-10-15T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function evidence(over: Partial<RelationshipEvidence>): RelationshipEvidence {
  return { ...NO_EVIDENCE, ...over };
}

const STRONG = evidence({
  threads: 12,
  twoWayThreads: 9,
  outboundOnlyThreads: 2,
  inboundOnlyThreads: 1,
  weStarted: 5,
  theyStarted: 7,
  emailsIn: 20,
  emailsOut: 18,
  meetingsHeld: 2,
  firstEmailAt: daysAgo(400),
  lastEmailAt: daysAgo(12),
  lastMeetingAt: daysAgo(30),
  lastContactAt: daysAgo(12),
});

describe('scoring', () => {
  it('is deterministic for the same evidence and the same now', () => {
    const a = scoreRelationship(STRONG, NOW);
    const b = scoreRelationship({ ...STRONG }, new Date(NOW));
    expect(b).toEqual(a);
  });

  it('accounts for every point in its parts, before recency', () => {
    const s = scoreRelationship(STRONG, NOW);
    // 9 two-way x 8 = 72, capped at 45; 2 meetings x 15 = 30; both sides start = 15.
    expect(s.parts.map((p) => [p.key, p.points])).toEqual([
      ['email', 45],
      ['meetings', 30],
      ['reciprocity', 15],
    ]);
    expect(s.parts.map((p) => p.label)).toEqual([
      '9 two-way threads, 3 one-way',
      '2 meetings held',
      'Both sides start conversations',
    ]);
    expect(s.base).toBe(90);
    expect(s.recency).toBe(0.93);
    expect(s.score).toBe(Math.round(90 * 0.93));
    expect(s.label).toBe('strong');
  });

  it('caps email and meetings so volume alone cannot max the score', () => {
    const s = scoreRelationship(
      evidence({
        threads: 200,
        twoWayThreads: 200,
        meetingsHeld: 30,
        weStarted: 100,
        theyStarted: 100,
        lastContactAt: daysAgo(0),
      }),
      NOW,
    );
    expect(s.parts.find((p) => p.key === 'email')?.points).toBe(STRENGTH_MODEL.email.max);
    expect(s.parts.find((p) => p.key === 'meetings')?.points).toBe(STRENGTH_MODEL.meetings.max);
    expect(s.score).toBe(100);
  });

  it('scores an unanswered pitch as cold, never as nothing', () => {
    const s = scoreRelationship(
      evidence({
        threads: 1,
        inboundOnlyThreads: 1,
        theyStarted: 1,
        emailsIn: 1,
        lastEmailAt: daysAgo(200),
        lastContactAt: daysAgo(200),
      }),
      NOW,
    );
    expect(s.label).toBe('cold');
    expect(s.score).toBe(1);
    expect(s.parts.find((p) => p.key === 'reciprocity')?.label).toBe('No reply either way yet');
  });

  it('says None, with a zero, only when nothing ever happened', () => {
    const s = scoreRelationship(evidence({ nextMeetingAt: daysAgo(-3) }), NOW);
    expect(s).toMatchObject({ score: 0, label: 'none', daysSinceContact: null, recency: 0 });
  });

  it('rewards relationships where they reach out, not only where Nick chases', () => {
    const base = { threads: 3, twoWayThreads: 3, lastContactAt: daysAgo(0) };
    const they = scoreRelationship(evidence({ ...base, theyStarted: 3 }), NOW);
    const we = scoreRelationship(evidence({ ...base, weStarted: 3 }), NOW);
    const both = scoreRelationship(evidence({ ...base, weStarted: 1, theyStarted: 2 }), NOW);
    expect(both.score).toBeGreaterThan(they.score);
    expect(they.score).toBeGreaterThan(we.score);
  });

  it('labels by threshold', () => {
    const at = (twoWay: number) =>
      scoreRelationship(
        evidence({ threads: twoWay, twoWayThreads: twoWay, lastContactAt: daysAgo(0) }),
        NOW,
      );
    expect(at(3).label).toBe('cold'); // 24
    expect(at(4).label).toBe('warm'); // 32
    const strong = scoreRelationship(
      evidence({ threads: 6, twoWayThreads: 6, meetingsHeld: 1, lastContactAt: daysAgo(0) }),
      NOW,
    );
    expect(strong.score).toBe(60);
    expect(strong.label).toBe('strong');
  });
});

describe('recency decay', () => {
  it('halves every 120 days without contact', () => {
    expect(recencyFactor(0)).toBe(1);
    expect(recencyFactor(STRENGTH_MODEL.halfLifeDays)).toBe(0.5);
    expect(recencyFactor(STRENGTH_MODEL.halfLifeDays * 2)).toBe(0.25);
    expect(recencyFactor(null)).toBe(0);
  });

  it('lets a strong relationship fade to warm, then cold, as the silence grows', () => {
    const at = (days: number) =>
      scoreRelationship({ ...STRONG, lastContactAt: daysAgo(days) }, NOW).label;
    expect(at(10)).toBe('strong');
    expect(at(150)).toBe('warm');
    expect(at(400)).toBe('cold');
  });

  it('never counts a booking still ahead as contact', () => {
    const s = scoreRelationship(
      { ...STRONG, lastContactAt: daysAgo(90), nextMeetingAt: daysAgo(-2) },
      NOW,
    );
    expect(s.daysSinceContact).toBe(90);
  });

  it('explains the multiplier in words', () => {
    expect(recencyText(scoreRelationship(STRONG, NOW))).toBe(
      '×0.93 for 12 days since the last contact',
    );
  });
});

describe('evidence text', () => {
  it('reads like the evidence: threads, meetings and the next booking', () => {
    const text = evidenceSummary(
      { ...STRONG, nextMeetingAt: '2026-10-20T15:00:00.000Z' },
      NOW,
      'UTC',
    );
    expect(text).toBe('12 threads, last Oct 3; 2 meetings, last Sep 15; next meeting Oct 20');
  });

  it('adds the year to dates outside this one, and uses the reader’s time zone', () => {
    const e = evidence({
      threads: 1,
      twoWayThreads: 1,
      lastEmailAt: '2025-12-31T23:30:00.000Z',
      lastContactAt: '2025-12-31T23:30:00.000Z',
    });
    expect(evidenceSummary(e, NOW, 'UTC')).toBe('1 thread, last Dec 31, 2025');
    expect(evidenceSummary(e, NOW, 'Asia/Manila')).toBe('1 thread, last Jan 1');
  });

  it('says so plainly when there is nothing', () => {
    expect(evidenceSummary(NO_EVIDENCE, NOW)).toBe('No mail or meetings on record');
  });
});

describe('going cold', () => {
  const warmQuiet = scoreRelationship({ ...STRONG, lastContactAt: daysAgo(75) }, NOW);

  it('flags Strong or Warm relationships quiet for the window', () => {
    expect(isGoingCold(warmQuiet, NO_EVIDENCE)).toBe(true);
    expect(isGoingCold(warmQuiet, NO_EVIDENCE, 90)).toBe(false);
    expect(isGoingCold(scoreRelationship(STRONG, NOW), NO_EVIDENCE)).toBe(false);
  });

  it('leaves out anyone already booked, and anyone who was never more than cold', () => {
    expect(isGoingCold(warmQuiet, { nextMeetingAt: daysAgo(-5) })).toBe(false);
    const pitch = scoreRelationship(
      evidence({ threads: 1, inboundOnlyThreads: 1, theyStarted: 1, lastContactAt: daysAgo(90) }),
      NOW,
    );
    expect(peakLabel(pitch)).toBe('cold');
    expect(isGoingCold(pitch, NO_EVIDENCE)).toBe(false);
    expect(isGoingCold(scoreRelationship(NO_EVIDENCE, NOW), NO_EVIDENCE)).toBe(false);
  });

  it('keeps a strong history on the list however long the silence, at any window', () => {
    // Recency has already faded these to Cold; what they were is what counts.
    for (const days of [250, 500]) {
      const faded = scoreRelationship({ ...STRONG, lastContactAt: daysAgo(days) }, NOW);
      expect(faded.label).toBe('cold');
      expect(peakLabel(faded)).toBe('strong');
      expect(isGoingCold(faded, NO_EVIDENCE)).toBe(true);
      expect(isGoingCold(faded, NO_EVIDENCE, 180)).toBe(true);
    }
    const quietFor200 = scoreRelationship({ ...STRONG, lastContactAt: daysAgo(200) }, NOW);
    expect(isGoingCold(quietFor200, NO_EVIDENCE, 180)).toBe(true);
  });

  it('reads the window from the URL within bounds', () => {
    expect(goingColdDays('90')).toBe(90);
    expect(goingColdDays(undefined)).toBe(DEFAULT_GOING_COLD_DAYS);
    expect(goingColdDays('2')).toBe(DEFAULT_GOING_COLD_DAYS);
    expect(goingColdDays('9999')).toBe(DEFAULT_GOING_COLD_DAYS);
    expect(goingColdDays('soon')).toBe(DEFAULT_GOING_COLD_DAYS);
  });
});

describe('smart fields', () => {
  it('recognises Affinity’s column names, and nothing else', () => {
    expect(smartFieldForHeader('Last Contact')).toBe('last_contact');
    expect(smartFieldForHeader('Last Email (auto)')).toBe('last_email');
    expect(smartFieldForHeader('first email')).toBe('first_email');
    expect(smartFieldForHeader('Next Meeting Date')).toBe('next_meeting');
    expect(smartFieldForHeader('Last  meeting')).toBe('last_meeting');
    expect(smartFieldForHeader('Last Contact Owner')).toBeNull();
    expect(smartFieldForHeader('Amount')).toBeNull();
  });

  it('takes Affinity values from list entries and record fields', () => {
    const values = affinitySmartValues(
      [
        {
          fields: [
            { key: 'last_contact', name: 'Last Contact' },
            { key: 'amount', name: 'Amount' },
          ],
          values: { last_contact: '2026-07-01', amount: 5 },
        },
        {
          fields: [{ key: 'lc', name: 'Last contact' }],
          values: { lc: '2026-08-10' },
        },
      ],
      { 'First Email': '2024-02-03', 'Next Meeting': 'sometime soon' },
    );
    expect(values).toEqual({
      last_contact: '2026-08-10',
      first_email: '2024-02-03',
      next_meeting: 'sometime soon',
    });
  });

  it('prefers Kraken’s own evidence and marks the Affinity fallback', () => {
    const fields = smartFields(evidence({ lastEmailAt: daysAgo(3), lastContactAt: daysAgo(3) }), {
      last_contact: '2026-01-01',
      last_meeting: '2026-02-02',
    });
    expect(fields.last_contact).toEqual({ at: daysAgo(3), source: 'copilot' });
    expect(fields.last_meeting).toEqual({ at: '2026-02-02', source: 'affinity' });
    expect(fields.next_meeting).toEqual({ at: null, source: null });
  });

  it('takes the earlier first email, since Kraken only sees the newest synced mail', () => {
    const recent = evidence({ firstEmailAt: '2026-08-12T15:00:00.000Z' });
    const older = smartFields(recent, { first_email: '2021-03-04' }, { scannedFrom: daysAgo(90) });
    expect(older.first_email).toEqual({ at: '2021-03-04', source: 'affinity' });
    const later = smartFields(recent, { first_email: '2026-09-01' }, { scannedFrom: daysAgo(90) });
    expect(later.first_email).toEqual({
      at: '2026-08-12T15:00:00.000Z',
      source: 'copilot',
      scannedFrom: daysAgo(90),
    });
    // An unreadable Affinity cell never beats a real date.
    expect(smartFields(recent, { first_email: 'years ago' }).first_email.source).toBe('copilot');
  });

  it('formats a day as that calendar day and keeps an unreadable cell as written', () => {
    expect(formatSmartValue({ at: '2026-07-01', source: 'affinity' }, 'America/Chicago')).toBe(
      'Jul 1, 2026',
    );
    expect(formatSmartValue({ at: 'last spring', source: 'affinity' }, 'UTC')).toBe('last spring');
    expect(formatSmartValue({ at: null, source: null }, 'UTC')).toBe('—');
  });
});
