import { describe, expect, it } from 'vitest';
import { weeklyCounts } from '@/lib/network/activity';

/** The weekly bars on a profile's Activity tab. */

const NOW = new Date('2026-11-04T12:00:00.000Z');
const ago = (days: number) => ({ at: new Date(NOW.getTime() - days * 86_400_000).toISOString() });

describe('weeklyCounts', () => {
  it('buckets the last twelve weeks, oldest first, this week last', () => {
    const counts = weeklyCounts([ago(0), ago(6.9), ago(7), ago(83), ago(84), ago(-2)], NOW);
    expect(counts).toHaveLength(12);
    expect(counts[11]).toBe(2); // today and 6.9 days ago
    expect(counts[10]).toBe(1); // a week ago
    expect(counts[0]).toBe(1); // 83 days ago; 84 is past the window, -2 is ahead
    expect(counts.reduce((a, b) => a + b, 0)).toBe(4);
  });

  it('ignores unreadable dates', () => {
    expect(weeklyCounts([{ at: 'nope' }], NOW, 4)).toEqual([0, 0, 0, 0]);
  });
});
