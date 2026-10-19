import { describe, expect, it } from 'vitest';
import { defaultDueDate, dueDateToInstant } from '@/lib/tasks/due';
import { PROCESS_ZONES, underProcessZone } from '../helpers/process-zone';

/**
 * The Create follow-up dialog's due date runs in the browser, which can be in
 * any zone; "today" and 5 PM on the picked day are the profile timezone's.
 */

const CENTRAL = 'America/Chicago';
// 9 PM Central on Sunday Oct 18: already Monday in UTC and further east.
const SUNDAY_EVENING = new Date('2026-10-19T02:00:00Z');

describe('the default due date', () => {
  it('is two days after today in the profile timezone, in any process zone', async () => {
    for (const tz of PROCESS_ZONES) {
      expect(await underProcessZone(tz, () => defaultDueDate(SUNDAY_EVENING, CENTRAL)), tz).toBe(
        '2026-10-20',
      );
    }
  });

  it('reads whichever timezone the profile has', () => {
    expect(defaultDueDate(SUNDAY_EVENING, 'UTC')).toBe('2026-10-21');
    expect(defaultDueDate(SUNDAY_EVENING, 'Asia/Tokyo')).toBe('2026-10-21');
  });

  it('crosses a month end', () => {
    expect(defaultDueDate(new Date('2026-10-30T15:00:00Z'), CENTRAL)).toBe('2026-11-01');
  });
});

describe('a picked due date', () => {
  it('falls due at 5 PM that day in the profile timezone, in any process zone', async () => {
    for (const tz of PROCESS_ZONES) {
      expect(await underProcessZone(tz, () => dueDateToInstant('2026-10-20', CENTRAL)), tz).toBe(
        '2026-10-20T22:00:00.000Z',
      );
    }
  });

  it('keeps 5 PM across the clock change', () => {
    // Central is UTC-5 until Nov 1 2026 and UTC-6 after.
    expect(dueDateToInstant('2026-10-31', CENTRAL)).toBe('2026-10-31T22:00:00.000Z');
    expect(dueDateToInstant('2026-11-02', CENTRAL)).toBe('2026-11-02T23:00:00.000Z');
  });

  it('gives no due time for a date that does not exist', () => {
    expect(dueDateToInstant('2026-02-30', CENTRAL)).toBeUndefined();
    expect(dueDateToInstant('', CENTRAL)).toBeUndefined();
  });
});
