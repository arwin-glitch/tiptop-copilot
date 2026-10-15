import { describe, expect, it } from 'vitest';
import {
  DAILY_CAP,
  DAY_MS,
  SEND_INTERVAL_MS,
  dailyCapState,
  describeMinutes,
  estimatedMinutes,
  formatBytes,
  waitBeforeNext,
} from '@/lib/campaigns/limits';
import { isEmail, parsePastedRecipients } from '@/lib/campaigns/recipients';

/** Pacing, the daily cap, and reading pasted addresses. */

const NOW = new Date('2026-10-15T15:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

describe('the 24-hour cap', () => {
  it('is 400 and counts only the last 24 hours', () => {
    expect(DAILY_CAP).toBe(400);
    const state = dailyCapState([ago(1000), ago(DAY_MS - 1000), ago(DAY_MS + 1000)], NOW);
    expect(state).toEqual({ used: 2, remaining: 398, resetsAt: null });
  });

  it('says when the next slot opens once full', () => {
    const times = [ago(3 * 3_600_000), ago(2 * 3_600_000), ago(3_600_000)];
    const state = dailyCapState(times, NOW, 3);
    expect(state.remaining).toBe(0);
    // The oldest send in the window turns a day old 21 hours from now.
    expect(state.resetsAt).toBe(new Date(NOW.getTime() + 21 * 3_600_000).toISOString());
  });

  it('waits for enough sends to age out when over the cap', () => {
    const times = [ago(4 * 3_600_000), ago(3 * 3_600_000), ago(2 * 3_600_000), ago(3_600_000)];
    const state = dailyCapState(times, NOW, 3);
    expect(state.remaining).toBe(0);
    expect(state.resetsAt).toBe(new Date(NOW.getTime() + 21 * 3_600_000).toISOString());
  });

  it('ignores unreadable times', () => {
    expect(dailyCapState(['not a date', ago(10)], NOW).used).toBe(1);
  });
});

describe('pacing', () => {
  it('is about one email every two seconds', () => {
    expect(SEND_INTERVAL_MS).toBe(2_000);
    const now = NOW.getTime();
    expect(waitBeforeNext(null, now)).toBe(0);
    expect(waitBeforeNext(ago(500), now)).toBe(1_500);
    expect(waitBeforeNext(ago(5_000), now)).toBe(0);
    // A clock skewed into the future never waits longer than the interval.
    expect(waitBeforeNext(new Date(now + 60_000).toISOString(), now)).toBe(2_000);
  });

  it('estimates the send time', () => {
    expect(estimatedMinutes(1)).toBe(1);
    expect(estimatedMinutes(90)).toBe(3);
    expect(describeMinutes(1)).toBe('about a minute');
    expect(describeMinutes(3)).toBe('about 3 minutes');
    expect(formatBytes(20 * 1024 * 1024)).toBe('20.0 MB');
  });
});

describe('pasted addresses', () => {
  it('reads lines, commas, names in angle brackets and spreadsheet rows', () => {
    const out = parsePastedRecipients(
      [
        'jane@example.com, sam@example.com',
        'Ada Brennan <ADA@brindle.example>',
        '"Lee, Kim" <kim@example.org>',
        'Owen Thistlewood\towen@thistlewood.example\tThistlewood LLC',
        'Priya Nandakumar, priya@hearthstone.example',
      ].join('\n'),
    );
    expect(out.recipients).toEqual([
      { email: 'jane@example.com', name: null },
      { email: 'sam@example.com', name: null },
      { email: 'ada@brindle.example', name: 'Ada Brennan' },
      { email: 'kim@example.org', name: 'Lee, Kim'.replace(',', ' ').replace(/\s+/g, ' ') },
      { email: 'owen@thistlewood.example', name: 'Owen Thistlewood' },
      { email: 'priya@hearthstone.example', name: 'Priya Nandakumar' },
    ]);
  });

  it('dedupes case-insensitively and reports what is not an address', () => {
    const out = parsePastedRecipients('a@example.com\nA@EXAMPLE.COM\nnot-an-address@\nb@x');
    expect(out.recipients.map((r) => r.email)).toEqual(['a@example.com']);
    expect(out.duplicates).toBe(1);
    expect(out.invalid).toEqual(['not-an-address@', 'b@x']);
  });

  it('knows an address', () => {
    expect(isEmail('a.b+c@d.example')).toBe(true);
    expect(isEmail('a@b')).toBe(false);
    expect(isEmail('a b@c.example')).toBe(false);
  });
});
