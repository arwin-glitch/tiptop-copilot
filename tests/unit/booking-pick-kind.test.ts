import { describe, expect, it } from 'vitest';
import { inferPickKind, resolvePickKind } from '@/lib/booking/picks';

/** Held times in person: the meal follows the hour, so 6 PM is dinner, not coffee. */

const windows = {
  coffee: [
    { from: '08:00', to: '11:00' },
    { from: '14:00', to: '17:00' },
  ],
  lunch: [{ from: '11:30', to: '13:00' }],
  dinner: [{ from: '18:00', to: '18:00' }],
};
const zone = 'America/Chicago';

describe('picked in-person kind', () => {
  it('reads the meal from the first start', () => {
    expect(inferPickKind('2026-11-18T00:00:00.000Z', windows, zone)).toBe('dinner'); // 6 PM CT
    expect(inferPickKind('2026-11-17T18:00:00.000Z', windows, zone)).toBe('lunch'); // noon
    expect(inferPickKind('2026-11-17T15:00:00.000Z', windows, zone)).toBe('coffee'); // 9 AM
    expect(inferPickKind('2026-11-18T01:30:00.000Z', windows, zone)).toBe('dinner'); // 7:30 PM, past the window
  });

  it('turns an old coffee default at dinner time into dinner, and keeps a real coffee', () => {
    expect(resolvePickKind('coffee', '2026-11-18T00:00:00.000Z', windows, zone)).toBe('dinner');
    expect(resolvePickKind('coffee', '2026-11-17T20:00:00.000Z', windows, zone)).toBe('coffee');
    expect(resolvePickKind('lunch', '2026-11-18T00:00:00.000Z', windows, zone)).toBe('lunch');
    expect(resolvePickKind(null, '2026-11-17T18:00:00.000Z', windows, zone)).toBe('lunch');
  });
});
