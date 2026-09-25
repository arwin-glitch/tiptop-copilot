import { describe, expect, it } from 'vitest';
import { formatTime } from '@/lib/util/time';
import {
  COMPLETED_PAGE,
  completedAt,
  completedGroup,
  completedLabel,
  completedSections,
  groupRuns,
  readTasksView,
  sortCompleted,
  taskHref,
  withTasksView,
  type CompletedGroupKey,
} from '@/lib/tasks/tasks-view';

/**
 * The Tasks page's Completed tab groups by calendar day in the user's own
 * timezone, so a task ticked off late in the evening in Chicago is not filed
 * under the next day just because it is already tomorrow in UTC.
 */

const CHICAGO = 'America/Chicago';

// Thursday 24 September 2026, 10:00 in Chicago (15:00 UTC).
const THURSDAY_MORNING = new Date('2026-09-24T15:00:00.000Z');

function done(id: string, completed: string | null, updated = '2026-01-01T00:00:00.000Z') {
  return { id, completed_at: completed, updated_at: updated };
}

describe('completedGroup', () => {
  it('files a completion under Today, Yesterday, Earlier this week or Earlier', () => {
    const cases: [string, CompletedGroupKey][] = [
      ['2026-09-24T14:59:00.000Z', 'today'], // 09:59 Thursday
      ['2026-09-24T05:00:00.000Z', 'today'], // 00:00 Thursday, the first minute
      ['2026-09-24T04:59:00.000Z', 'yesterday'], // 23:59 Wednesday
      ['2026-09-23T05:00:00.000Z', 'yesterday'], // 00:00 Wednesday
      ['2026-09-23T04:59:00.000Z', 'this_week'], // 23:59 Tuesday
      ['2026-09-21T05:00:00.000Z', 'this_week'], // 00:00 Monday
      ['2026-09-21T04:59:00.000Z', 'earlier'], // 23:59 Sunday
      ['2025-12-31T18:00:00.000Z', 'earlier'],
    ];
    for (const [at, group] of cases) {
      expect(completedGroup(at, THURSDAY_MORNING, CHICAGO), at).toBe(group);
    }
  });

  it('uses the profile timezone, not UTC, at the day boundary', () => {
    // 21:30 Wednesday in Chicago is already 02:30 Thursday in UTC.
    const lateWednesday = '2026-09-24T02:30:00.000Z';
    expect(completedGroup(lateWednesday, THURSDAY_MORNING, CHICAGO)).toBe('yesterday');
    expect(completedGroup(lateWednesday, THURSDAY_MORNING, 'UTC')).toBe('today');

    // Just after midnight UTC, "now" is still the evening before in Chicago.
    const now = new Date('2026-09-25T00:30:00.000Z'); // 19:30 Thursday in Chicago
    expect(completedGroup('2026-09-24T16:00:00.000Z', now, CHICAGO)).toBe('today');
    expect(completedGroup('2026-09-24T16:00:00.000Z', now, 'UTC')).toBe('yesterday');
  });

  it('starts the week on Monday, so on a Monday Sunday is Yesterday and Saturday is Earlier', () => {
    const mondayMorning = new Date('2026-09-21T14:00:00.000Z');
    expect(completedGroup('2026-09-20T18:00:00.000Z', mondayMorning, CHICAGO)).toBe('yesterday');
    expect(completedGroup('2026-09-19T18:00:00.000Z', mondayMorning, CHICAGO)).toBe('earlier');

    const sundayEvening = new Date('2026-09-28T01:00:00.000Z'); // 20:00 Sunday 27th
    expect(completedGroup('2026-09-22T18:00:00.000Z', sundayEvening, CHICAGO)).toBe('this_week');
    expect(completedGroup('2026-09-20T18:00:00.000Z', sundayEvening, CHICAGO)).toBe('earlier');
  });

  it('counts a completion after now as Today, and an unreadable one as Earlier', () => {
    expect(completedGroup('2026-09-24T18:00:00.000Z', THURSDAY_MORNING, CHICAGO)).toBe('today');
    // 01:00 Friday in Chicago: a later day, still Today rather than a heading above it.
    expect(completedGroup('2026-09-25T06:00:00.000Z', THURSDAY_MORNING, CHICAGO)).toBe('today');
    expect(completedGroup('not a date', THURSDAY_MORNING, CHICAGO)).toBe('earlier');
  });
});

describe('completedLabel', () => {
  const label = (at: string, now: Date) =>
    completedLabel(at, completedGroup(at, now, CHICAGO), now, CHICAGO);

  it('reads relative within today', () => {
    expect(label('2026-09-24T14:59:40.000Z', THURSDAY_MORNING)).toBe('Completed just now');
    expect(label('2026-09-24T12:00:00.000Z', THURSDAY_MORNING)).toBe('Completed 3h ago');
  });

  it('never contradicts its heading at a day boundary', () => {
    // 23:55 Friday: 00:05 Thursday is under Yesterday, though nearly two days ago.
    const lateFriday = new Date('2026-09-26T04:55:00.000Z');
    const earlyThursday = '2026-09-24T05:05:00.000Z';
    expect(completedGroup(earlyThursday, lateFriday, CHICAGO)).toBe('yesterday');
    expect(label(earlyThursday, lateFriday)).toBe(
      `Completed at ${formatTime(earlyThursday, CHICAGO)}`,
    );

    // 08:00 Monday: 23:00 Saturday is under Earlier, though only a day and a half ago.
    const mondayMorning = new Date('2026-09-28T13:00:00.000Z');
    const lateSaturday = '2026-09-27T04:00:00.000Z';
    expect(completedGroup(lateSaturday, mondayMorning, CHICAGO)).toBe('earlier');
    expect(label(lateSaturday, mondayMorning)).toBe('Completed Sep 26, 2026');
  });

  it('names the weekday this week, and gives a time rather than a future', () => {
    expect(label('2026-09-22T20:05:00.000Z', THURSDAY_MORNING)).toMatch(/^Completed Tue 3:05\sPM$/);
    expect(label('2026-09-24T18:00:00.000Z', THURSDAY_MORNING)).toMatch(/^Completed at 1:00\sPM$/);
  });

  it('says only "Completed" for an unreadable date', () => {
    expect(completedLabel('not a date', 'earlier', THURSDAY_MORNING, CHICAGO)).toBe('Completed');
  });
});

describe('completedSections', () => {
  const items = (count: number, group: CompletedGroupKey, prefix: string) =>
    Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}`, group }));

  it('shows the first page, and counts hidden rows in their headings', () => {
    const all = [...items(30, 'today', 't'), ...items(120, 'earlier', 'e')];
    const { sections, hidden } = completedSections(all, COMPLETED_PAGE);
    expect(COMPLETED_PAGE).toBe(100);
    expect(hidden).toBe(50);
    expect(sections.map((s) => [s.key, s.items.length, s.total])).toEqual([
      ['today', 30, 30],
      ['earlier', 70, 120],
    ]);
  });

  it('leaves out a group whose rows are all hidden, and hides nothing once all are shown', () => {
    const all = [...items(100, 'today', 't'), ...items(5, 'yesterday', 'y')];
    expect(completedSections(all, 100).sections.map((s) => s.key)).toEqual(['today']);
    const everything = completedSections(all, all.length);
    expect(everything.hidden).toBe(0);
    expect(everything.sections.map((s) => [s.key, s.items.length, s.total])).toEqual([
      ['today', 100, 100],
      ['yesterday', 5, 5],
    ]);
  });
});

describe('completedAt and sortCompleted', () => {
  it('falls back to updated_at when completed_at is missing', () => {
    expect(completedAt(done('a', '2026-09-20T10:00:00.000Z'))).toBe('2026-09-20T10:00:00.000Z');
    expect(completedAt(done('b', null, '2026-09-22T10:00:00.000Z'))).toBe(
      '2026-09-22T10:00:00.000Z',
    );
  });

  it('puts the newest completion first, using updated_at where completed_at is missing', () => {
    const sorted = sortCompleted([
      done('older', '2026-09-20T10:00:00.000Z'),
      done('no-date', null, '2026-09-23T10:00:00.000Z'),
      done('newest', '2026-09-24T10:00:00.000Z'),
      done('broken', null, 'garbage'),
    ]);
    expect(sorted.map((t) => t.id)).toEqual(['newest', 'no-date', 'older', 'broken']);
  });

  it('does not reorder its input', () => {
    const input = [done('a', '2026-09-20T10:00:00.000Z'), done('b', '2026-09-24T10:00:00.000Z')];
    sortCompleted(input);
    expect(input.map((t) => t.id)).toEqual(['a', 'b']);
  });
});

describe('groupRuns', () => {
  it('gives one labelled heading per group, in order, for a newest-first list', () => {
    const items = sortCompleted([
      done('t1', '2026-09-24T14:00:00.000Z'),
      done('y1', '2026-09-23T20:00:00.000Z'),
      done('t2', '2026-09-24T13:00:00.000Z'),
      done('e1', '2026-08-01T12:00:00.000Z'),
      done('w1', '2026-09-22T12:00:00.000Z'),
    ]).map((task) => ({
      ...task,
      group: completedGroup(completedAt(task), THURSDAY_MORNING, CHICAGO),
    }));

    const groups = groupRuns(items);
    expect(groups.map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ['Today', ['t1', 't2']],
      ['Yesterday', ['y1']],
      ['Earlier this week', ['w1']],
      ['Earlier', ['e1']],
    ]);
  });

  it('returns nothing for nothing', () => {
    expect(groupRuns([])).toEqual([]);
  });
});

describe('the view in the URL', () => {
  it('reads only view=completed as Completed', () => {
    expect(readTasksView('completed')).toBe('completed');
    expect(readTasksView(null)).toBe('todo');
    expect(readTasksView('')).toBe('todo');
    expect(readTasksView('todo')).toBe('todo');
    expect(readTasksView('COMPLETED')).toBe('todo');
  });

  it('writes Completed as view=completed and To do as no parameter, keeping other keys', () => {
    expect(withTasksView('', 'completed').toString()).toBe('view=completed');
    expect(withTasksView('?view=completed', 'todo').toString()).toBe('');
    expect(withTasksView('?a=1&view=completed', 'todo').toString()).toBe('a=1');
    expect(withTasksView('?a=1', 'completed').toString()).toBe('a=1&view=completed');
  });
});

describe('taskHref', () => {
  it('links a deal first, then a portfolio company, else nothing', () => {
    expect(taskHref({ deal_id: 'd1', portfolio_company_id: 'p1' })).toBe('/deals/d1');
    expect(taskHref({ deal_id: null, portfolio_company_id: 'p1' })).toBe('/portfolio/p1');
    expect(taskHref({ deal_id: null, portfolio_company_id: null })).toBeNull();
  });
});
