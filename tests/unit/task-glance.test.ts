import { describe, expect, it } from 'vitest';
import {
  buildGlance,
  classifyGlance,
  clipLabel,
  countWords,
  displayLabel,
  foldGlanceMeta,
  glanceDueLabel,
  glanceIsEmpty,
  isIntroTitle,
  localDayDiff,
  shortLabel,
  type FoldedGlance,
  type GlanceRow,
} from '@/lib/tasks/glance';
import { normalizeDueAt, TASK_INGEST_SCHEMA } from '@/lib/services/task-ingest';
import { wallTimeToUtc } from '@/lib/util/time';
import type { Task } from '@/lib/types/domain';

/**
 * Today's "At a glance" cards: which card a task lands on, its short label,
 * and how the routine's and a person's glance rows fold. Every name and
 * title here is invented.
 */

const CHICAGO = 'America/Chicago';
// Thursday 15 October 2026, 10:00 in Chicago (15:00 UTC).
const NOW = new Date('2026-10-15T15:00:00.000Z');
const clock = { now: NOW, timeZone: CHICAGO };

let seq = 0;
function task(overrides: Partial<Task> = {}): Task {
  seq += 1;
  return {
    id: `t-${String(seq).padStart(3, '0')}`,
    organization_id: 'org',
    title: 'Write the quarterly note',
    detail: null,
    status: 'open',
    due_at: null,
    snoozed_until: null,
    deal_id: null,
    portfolio_company_id: null,
    email_message_id: null,
    assigned_to: 'user',
    created_by: 'user',
    source: 'suggested',
    completed_at: null,
    created_at: '2026-10-10T15:00:00.000Z',
    updated_at: '2026-10-10T15:00:00.000Z',
    ...overrides,
  };
}

function row(metadata: unknown, createdAt: string, userId: string | null = null): GlanceRow {
  return { user_id: userId, created_at: createdAt, metadata };
}

describe('isIntroTitle', () => {
  it('reads intros Nick owes, and not an intro call', () => {
    const intros = [
      'Intro Priya to Omar',
      'Introduce Elena Marsh to Ben Adeyemi',
      'Introduction: Kit and the Northwind team',
      'Make an intro for Sam',
      'Send the intro to Ivy',
      'Connect Ivy with Sam about hiring',
      'Priya → Omar',
      'Priya -> Omar',
      'Priya <> Omar',
      'Priya ↔ Omar',
      'Send Ledgerly Series A intros',
      'send the two fintech intros this week',
    ];
    for (const title of intros) expect(isIntroTitle(title), title).toBe(true);

    const not = [
      'Intro call with Halyard',
      'Prep for the intro call with Kit',
      'Introspection notes from the offsite',
      'Reply to Halyard about the follow-on',
      'Priya<>Omar notes',
      'Sign the vendor statement of work',
    ];
    for (const title of not) expect(isIntroTitle(title), title).toBe(false);
  });
});

describe('classifyGlance by date (local days in Chicago)', () => {
  const due = (iso: string | null) => classifyGlance(task({ due_at: iso }), undefined, clock);

  it('puts undated, overdue and due-within-two-days on Do now', () => {
    expect(due(null)).toBe('now');
    expect(due('2026-10-01T15:00:00.000Z')).toBe('now'); // overdue
    expect(due('2026-10-15T23:00:00.000Z')).toBe('now'); // today
    // 23:30 Saturday the 17th in Chicago is already the 18th in UTC: still day +2.
    expect(due('2026-10-18T04:30:00.000Z')).toBe('now');
  });

  it('puts day +3 to +30 on Coming up, and hides anything later', () => {
    // 00:30 Sunday the 18th in Chicago: day +3.
    expect(due('2026-10-18T05:30:00.000Z')).toBe('upcoming');
    expect(due('2026-11-14T17:00:00.000Z')).toBe('upcoming'); // day +30
    expect(due('2026-11-15T17:00:00.000Z')).toBeNull(); // day +31
  });

  it('counts calendar days across the Nov 1 clock change', () => {
    // Friday 30 October, 10:00 CDT.
    const friday = { now: new Date('2026-10-30T15:00:00.000Z'), timeZone: CHICAGO };
    const at = (iso: string) => classifyGlance(task({ due_at: iso }), undefined, friday);
    // 23:30 CST Sunday 1 November: day +2.
    expect(at('2026-11-02T05:30:00.000Z')).toBe('now');
    // 00:30 CST Monday 2 November: day +3.
    expect(at('2026-11-02T06:30:00.000Z')).toBe('upcoming');
    expect(localDayDiff(new Date('2026-11-02T06:30:00.000Z'), friday.now, CHICAGO)).toBe(3);

    // 23:30 CDT Saturday 31 October, the last hour before the change.
    const late = new Date('2026-11-01T04:30:00.000Z');
    expect(localDayDiff(new Date('2026-11-03T05:59:00.000Z'), late, CHICAGO)).toBe(2);
    expect(localDayDiff(new Date('2026-11-03T06:30:00.000Z'), late, CHICAGO)).toBe(3);
  });
});

describe('classifyGlance precedence', () => {
  const tomorrow = '2026-10-16T17:00:00.000Z';
  const tenDays = '2026-10-25T17:00:00.000Z';

  it("a person's bucket always wins", () => {
    const overdue = task({ due_at: '2026-10-01T15:00:00.000Z' });
    expect(classifyGlance(overdue, { bucket: 'upcoming', bucketBy: 'person' }, clock)).toBe(
      'upcoming',
    );
    const intro = task({ title: 'Intro Priya to Omar' });
    expect(classifyGlance(intro, { bucket: 'now', bucketBy: 'person' }, clock)).toBe('now');
    const farOut = task({ due_at: '2027-03-01T17:00:00.000Z' });
    expect(classifyGlance(farOut, { bucket: 'now', bucketBy: 'person' }, clock)).toBe('now');
  });

  it("the routine's intro sticks, whatever the date or title", () => {
    const notes = task({
      title: 'Send Grace and Tom the notes from their intro call',
      due_at: tomorrow,
    });
    expect(classifyGlance(notes, undefined, clock)).toBe('now');
    expect(classifyGlance(notes, { bucket: 'intro', bucketBy: 'routine' }, clock)).toBe('intro');
  });

  it("the routine's now and upcoming are hints a due date overrules", () => {
    const soon = task({ due_at: tomorrow });
    // Coming up turns into Do now once its date arrives.
    expect(classifyGlance(soon, { bucket: 'upcoming', bucketBy: 'routine' }, clock)).toBe('now');
    const later = task({ due_at: tenDays });
    expect(classifyGlance(later, { bucket: 'now', bucketBy: 'routine' }, clock)).toBe('upcoming');
    // Undated, the hint decides.
    const undated = task();
    expect(classifyGlance(undated, { bucket: 'upcoming', bucketBy: 'routine' }, clock)).toBe(
      'upcoming',
    );
  });

  it('an intro title beats the date rule', () => {
    const intro = task({ title: 'Introduce Elena to Ben', due_at: '2027-03-01T17:00:00.000Z' });
    expect(classifyGlance(intro, undefined, clock)).toBe('intro');
  });
});

describe('shortLabel', () => {
  it('makes intro pairs from first names', () => {
    expect(shortLabel('Intro Priya Raman to Omar Haddad (from the board call)')).toBe(
      'Priya → Omar',
    );
    expect(shortLabel('Intro Chris Dalton to Ivy Lin and Sam Park')).toBe('Chris → Ivy + Sam');
    expect(shortLabel('Introduce Elena Marsh with Ben Adeyemi, Kit Moss')).toBe(
      'Elena → Ben + Kit',
    );
    expect(shortLabel('Introduce Dev to a founding-engineer recruiter')).toBe(
      'Dev → founding-engineer recruiter',
    );
  });

  it('reads "Reply to X …" as "X: reply"', () => {
    expect(shortLabel('Reply to Halyard about the follow-on question')).toBe('Halyard: reply');
    expect(shortLabel('Reply to Pat Moss: Q3 numbers')).toBe('Pat Moss: reply');
  });

  it('leads with a linked or known company and drops articles and generic verbs', () => {
    expect(shortLabel('Send LoomStack pass note', 'LoomStack')).toBe('LoomStack: pass note');
    expect(shortLabel('Read the Vetrix corpus licensing agreement', null, ['Vetrix'])).toBe(
      'Vetrix: corpus licensing agreement',
    );
    expect(shortLabel('Run Girder AI reference calls (Arborworks + 2)', 'Girder AI')).toBe(
      'Girder AI: reference calls',
    );
    // A known name inside another word is not that company.
    expect(shortLabel('Plan the Illumenation launch party', null, ['Lumen'])).toBe(
      'Plan the Illumenation launch party',
    );
    expect(
      shortLabel('Marlow Foods: send the SOW and book the kickoff', null, ['Marlow Foods']),
    ).toBe('Marlow Foods: SOW + book kickoff');
  });

  it('otherwise keeps the first five words', () => {
    expect(shortLabel('Schedule the quarterly portfolio review with the partners')).toBe(
      'Schedule the quarterly portfolio review…',
    );
    expect(shortLabel('Sign the vendor contract')).toBe('Sign the vendor contract');
  });

  it('never runs past 40 characters', () => {
    const long = shortLabel(
      'Reconcile extraordinarily-long-hyphenated-vendor-statements quarterly please',
    );
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith('…')).toBe(true);
    expect(clipLabel('a'.repeat(60))).toHaveLength(40);
  });

  it('shows every arrow as one arrow', () => {
    expect(displayLabel('Priya -> Omar')).toBe('Priya → Omar');
    expect(displayLabel('Priya<>Omar')).toBe('Priya → Omar');
    expect(displayLabel('Priya  =>  Omar + Sam')).toBe('Priya → Omar + Sam');
  });

  it('counts words, not symbols', () => {
    expect(countWords('Chris → Ivy + Sam P.')).toBe(4);
  });
});

describe('glanceDueLabel', () => {
  it('is a month and day, with "wk" for a week-level deadline', () => {
    expect(glanceDueLabel('2026-10-19T14:00:00.000Z', 'week', CHICAGO)).toBe('Oct 19 wk');
    expect(glanceDueLabel('2026-10-19T14:00:00.000Z', 'day', CHICAGO)).toBe('Oct 19');
    expect(glanceDueLabel('2026-10-19T14:00:00.000Z', undefined, CHICAGO)).toBe('Oct 19');
  });
});

describe('foldGlanceMeta', () => {
  it("takes the newest person's value over the newest routine value, field by field", () => {
    const folded = foldGlanceMeta([
      row({ v: 1, by: 'routine', short: 'Old label', bucket: 'now' }, '2026-10-10T10:00:00Z'),
      row({ v: 1, by: 'person', bucket: 'upcoming' }, '2026-10-11T10:00:00Z', 'user'),
      row(
        { v: 1, by: 'routine', short: 'New label', bucket: 'intro', due_precision: 'week' },
        '2026-10-12T10:00:00Z',
      ),
    ]);
    // The routine's newer label stands (no person set one); the person's bucket wins.
    expect(folded).toEqual({
      short: 'New label',
      bucket: 'upcoming',
      bucketBy: 'person',
      due_precision: 'week',
    });
  });

  it('orders by time, not by the order rows arrive in', () => {
    const folded = foldGlanceMeta([
      row({ v: 1, short: 'Newest' }, '2026-10-12T10:00:00Z'),
      row({ v: 1, short: 'Oldest' }, '2026-10-10T10:00:00Z'),
    ]);
    expect(folded.short).toBe('Newest');
  });

  it('knows a person by the user id, not by what the metadata claims', () => {
    const folded = foldGlanceMeta([
      row({ v: 1, by: 'person', bucket: 'upcoming' }, '2026-10-12T10:00:00Z'),
    ]);
    expect(folded).toEqual({ bucket: 'upcoming', bucketBy: 'routine' });
  });

  it('ignores malformed rows and keeps the good fields of an odd one', () => {
    const folded = foldGlanceMeta([
      row({ v: 1, short: 'Halyard: reply', bucket: 'now' }, '2026-10-10T10:00:00Z'),
      row('not an object', '2026-10-11T10:00:00Z'),
      row(null, '2026-10-11T10:00:00Z'),
      row({ v: 2, short: 'Wrong version' }, '2026-10-11T10:00:00Z'),
      row(
        { v: 1, short: 'x'.repeat(80), bucket: 'someday', due_precision: 'month' },
        '2026-10-12T10:00:00Z',
      ),
      row({ v: 1, short: 'Line\nbreak' }, '2026-10-12T11:00:00Z'),
      row({ v: 1, short: 'one two three four five six seven' }, '2026-10-12T12:00:00Z'),
    ]);
    expect(folded).toEqual({ short: 'Halyard: reply', bucket: 'now', bucketBy: 'routine' });
    expect(foldGlanceMeta([])).toEqual({});
  });
});

describe('buildGlance', () => {
  it('sorts, caps each card at four and counts the rest', () => {
    const overdueOld = task({ title: 'Oldest overdue item', due_at: '2026-10-05T15:00:00Z' });
    const overdueNew = task({ title: 'Newer overdue item', due_at: '2026-10-14T15:00:00Z' });
    const today = task({ title: 'Due later today', due_at: '2026-10-15T20:00:00Z' });
    const undatedOld = task({ title: 'Undated older', created_at: '2026-10-01T10:00:00Z' });
    const undatedNew = task({ title: 'Undated newer', created_at: '2026-10-14T10:00:00Z' });
    const tomorrow = task({ title: 'Due tomorrow', due_at: '2026-10-16T17:00:00Z' });
    const farOut = task({ title: 'Far out', due_at: '2027-01-30T17:00:00Z' });
    const snoozed = task({
      title: 'Still asleep',
      status: 'snoozed',
      snoozed_until: '2026-10-20T15:00:00Z',
    });
    const awake = task({
      title: 'Woke this morning',
      status: 'snoozed',
      snoozed_until: '2026-10-15T12:00:00Z',
      created_at: '2026-09-01T00:00:00Z',
    });
    const completed = task({ title: 'Already done', status: 'complete' });
    const introA = task({ title: 'Intro Priya to Omar', created_at: '2026-10-12T00:00:00Z' });
    const introB = task({ title: 'Introduce Elena to Ben', created_at: '2026-10-02T00:00:00Z' });
    const weekNote = task({ title: 'Northwind LP note', due_at: '2026-10-19T14:00:00Z' });
    const later = task({ title: 'Lumen walkthrough', due_at: '2026-10-28T17:00:00Z' });

    const meta = new Map<string, FoldedGlance>([
      [weekNote.id, { short: 'Northwind note', bucket: 'upcoming', due_precision: 'week' }],
      [introA.id, { short: 'Priya -> Omar', bucket: 'intro', bucketBy: 'routine' }],
    ]);
    const glance = buildGlance(
      [
        later,
        undatedOld,
        introA,
        farOut,
        today,
        completed,
        overdueNew,
        snoozed,
        weekNote,
        undatedNew,
        tomorrow,
        introB,
        awake,
        overdueOld,
      ],
      meta,
      clock,
    );

    expect(glance.now.total).toBe(7);
    expect(glance.now.items.map((i) => i.fullTitle)).toEqual([
      'Oldest overdue item',
      'Newer overdue item',
      'Due later today',
      'Due tomorrow',
    ]);
    expect(glance.now.items.map((i) => [i.when, i.overdue])).toEqual([
      ['Oct 5', true],
      ['Oct 14', true],
      ['Today', false],
      ['Tomorrow', false],
    ]);

    const all = buildGlance([overdueOld, today, undatedOld, undatedNew, awake], new Map(), {
      ...clock,
      limit: 10,
    });
    // Undated last, newest first.
    expect(all.now.items.map((i) => i.fullTitle)).toEqual([
      'Oldest overdue item',
      'Due later today',
      'Undated newer',
      'Undated older',
      'Woke this morning',
    ]);

    expect(glance.intro.items.map((i) => i.label)).toEqual(['Elena → Ben', 'Priya → Omar']);
    expect(glance.intro.total).toBe(2);
    expect(glance.upcoming.items.map((i) => [i.label, i.when])).toEqual([
      ['Northwind note', 'Oct 19 wk'],
      ['Lumen walkthrough', 'Oct 28'],
    ]);
    expect(glanceIsEmpty(glance)).toBe(false);
  });

  it('labels with a linked company name, in the title or not', () => {
    const companyNames = new Map([
      ['deal-1', 'LoomStack'],
      ['pc-1', 'Ledgerly'],
    ]);
    const linked = task({ title: 'Send pass note', deal_id: 'deal-1' });
    const named = task({ title: 'Send LoomStack pass note', deal_id: 'deal-1' });
    const portfolio = task({ title: 'Sign the board consent', portfolio_company_id: 'pc-1' });
    // Known, not linked: a name from the list still leads.
    const known = task({ title: 'Book the Ledgerly offsite venue' });
    const glance = buildGlance([linked, named, portfolio, known], new Map(), {
      ...clock,
      companyNames,
    });
    expect(glance.now.items.map((i) => i.label).sort()).toEqual([
      'Ledgerly: book offsite venue',
      'Ledgerly: sign board consent',
      'LoomStack: pass note',
      'LoomStack: pass note',
    ]);
  });

  it('is empty with no open tasks', () => {
    const glance = buildGlance([task({ status: 'complete' })], new Map(), clock);
    expect(glanceIsEmpty(glance)).toBe(true);
    expect(glance.now).toEqual({ items: [], total: 0 });
  });
});

describe('TASK_INGEST_SCHEMA glance fields', () => {
  const base = { source: 'task-auto-suggest' };

  it('parses short, bucket and due_precision', () => {
    const parsed = TASK_INGEST_SCHEMA.parse({
      ...base,
      tasks: [
        {
          title: 'Intro Chris Dalton to Ivy Lin and Sam Park',
          short: 'Chris → Ivy + Sam P.',
          bucket: 'intro',
        },
        {
          title: 'Northwind: write the quarterly LP note',
          short: 'Northwind note',
          bucket: 'upcoming',
          due_at: '2026-10-19T14:00:00Z',
          due_precision: 'week',
        },
      ],
    });
    expect(parsed.tasks[0]).toMatchObject({ short: 'Chris → Ivy + Sam P.', bucket: 'intro' });
    expect(parsed.tasks[1]).toMatchObject({ bucket: 'upcoming', due_precision: 'week' });
  });

  it('keeps the task when a glance field is bad', () => {
    const parsed = TASK_INGEST_SCHEMA.parse({
      ...base,
      tasks: [
        {
          title: 'Reply to Halyard this week',
          short: 'one two three four five six seven eight',
          bucket: 'someday',
          due_precision: 'month',
        },
        { title: 'Second task', short: 'Has a `backtick`' },
        { title: 'Third task', short: 'x'.repeat(41) },
      ],
    });
    expect(parsed.tasks).toHaveLength(3);
    expect(parsed.tasks[0]).toMatchObject({ short: null, bucket: null, due_precision: null });
    expect(parsed.tasks[1]?.short).toBeNull();
    expect(parsed.tasks[2]?.short).toBeNull();
  });

  it('still parses the old payload, and accepts a due date with an offset', () => {
    const old = TASK_INGEST_SCHEMA.safeParse({
      ...base,
      tasks: [{ title: 'Old shape', detail: 'From a call.', due_at: '2026-10-19T14:00:00Z' }],
    });
    expect(old.success).toBe(true);
    const offset = TASK_INGEST_SCHEMA.safeParse({
      ...base,
      tasks: [{ title: 'Offset', due_at: '2026-10-19T09:00:00-05:00' }],
    });
    expect(offset.success).toBe(true);
    const bad = TASK_INGEST_SCHEMA.safeParse({
      ...base,
      tasks: [{ title: 'Bad date', due_at: 'next Monday' }],
    });
    expect(bad.success).toBe(false);
  });

  it('takes a bare date as 09:00 Central and a time with no offset as Central', () => {
    const parsed = TASK_INGEST_SCHEMA.parse({
      ...base,
      tasks: [
        { title: 'Bare date', due_at: '2026-10-26' },
        { title: 'No offset', due_at: '2026-10-26T09:00' },
        { title: 'No offset, seconds', due_at: '2026-10-26 17:45:30' },
      ],
    });
    expect(parsed.tasks.map((t) => t.due_at)).toEqual([
      '2026-10-26T14:00:00.000Z',
      '2026-10-26T14:00:00.000Z',
      '2026-10-26T22:45:30.000Z',
    ]);
  });
});

describe('normalizeDueAt and wallTimeToUtc', () => {
  it('leaves a value with an offset, and anything it cannot read, alone', () => {
    expect(normalizeDueAt('2026-10-19T14:00:00Z')).toBe('2026-10-19T14:00:00Z');
    expect(normalizeDueAt('2026-10-19T09:00:00-05:00')).toBe('2026-10-19T09:00:00-05:00');
    expect(normalizeDueAt('next Monday')).toBe('next Monday');
    expect(normalizeDueAt('2026-02-30')).toBe('2026-02-30');
    expect(normalizeDueAt(null)).toBeNull();
    expect(normalizeDueAt(undefined)).toBeUndefined();
  });

  it('follows the clock change in Chicago', () => {
    // Daylight time until Sunday 1 November 2026, standard time after.
    expect(wallTimeToUtc('2026-10-31', 9, 0, CHICAGO)?.toISOString()).toBe(
      '2026-10-31T14:00:00.000Z',
    );
    expect(wallTimeToUtc('2026-11-02', 9, 0, CHICAGO)?.toISOString()).toBe(
      '2026-11-02T15:00:00.000Z',
    );
    expect(wallTimeToUtc('2026-11-01', 9, 0, CHICAGO)?.toISOString()).toBe(
      '2026-11-01T15:00:00.000Z',
    );
  });

  it('refuses a date or time that is not on a calendar', () => {
    expect(wallTimeToUtc('2026-02-30', 9, 0, CHICAGO)).toBeNull();
    expect(wallTimeToUtc('2026-13-01', 9, 0, CHICAGO)).toBeNull();
    expect(wallTimeToUtc('2026-10-26', 24, 0, CHICAGO)).toBeNull();
    expect(wallTimeToUtc('2026-10-26', 9, 60, CHICAGO)).toBeNull();
  });
});
