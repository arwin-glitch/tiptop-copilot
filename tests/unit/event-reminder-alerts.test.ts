import { describe, expect, it } from 'vitest';
import { reminderSlots } from '@/lib/events/tab-view';
import { alertsFromInputs, computeEventReminderAlerts } from '@/lib/services/push-alerts';

/**
 * A due event reminder becomes one phone/desktop alert that says it is ready
 * to review and send (D-075). The alert never sends anything; quiet hours
 * hold, and each slot alerts once.
 */

const DAYTIME = new Date('2026-11-02T16:00:00Z'); // 10:00 in Chicago
const NIGHT = new Date('2026-11-02T06:00:00Z'); // 00:00 in Chicago
const ZONE = 'America/Chicago';

const slot = reminderSlots(
  [{ id: 's1', name: 'Evening Reception', starts_at: '2026-11-03T00:00:00Z' }],
  [1_440],
  [],
  DAYTIME,
)[0]!;
const due = [{ eventId: 'e1', title: 'Harborview Annual Meeting', slot }];

describe('event reminder alerts', () => {
  it('says a reminder is ready and opens the event’s reminders', () => {
    expect(slot.state).toBe('due');
    expect(computeEventReminderAlerts(due, new Set(), DAYTIME, ZONE)).toEqual([
      {
        keys: ['event-reminder:e1:s1:1440'],
        title: 'Event reminder ready',
        body: 'Harborview Annual Meeting: 1 day before Evening Reception. Review and send.',
        url: '/events/e1?tab=messages&view=reminders',
        tag: 'event-reminder',
      },
    ]);
  });

  it('alerts once, and never in quiet hours', () => {
    expect(
      computeEventReminderAlerts(due, new Set(['event-reminder:e1:s1:1440']), DAYTIME, ZONE),
    ).toEqual([]);
    expect(computeEventReminderAlerts(due, new Set(), NIGHT, ZONE)).toEqual([]);
  });

  it('rides along with the other alerts, and is absent when there are none', () => {
    const inputs = { followUps: null, readers: [], finished: [] };
    expect(alertsFromInputs(inputs, new Set(), DAYTIME, ZONE)).toEqual([]);
    expect(
      alertsFromInputs({ ...inputs, eventReminders: due }, new Set(), DAYTIME, ZONE).map(
        (a) => a.tag,
      ),
    ).toEqual(['event-reminder']);
  });
});
