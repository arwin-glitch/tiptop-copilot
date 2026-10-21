import { describe, expect, it } from 'vitest';
import {
  applyLabelPlan,
  applyPending,
  isNumberedLabel,
  labelChoices,
  labelNamesFor,
  planLabelChange,
  type MailLabel,
  type PendingChange,
} from '@/lib/email/inbox-actions';
import { userLabelIds } from '@/lib/services/inbox-live';

/** Fictional labels: a numbered family and two plain ones. */
const LABELS: MailLabel[] = [
  { id: 'Label_7101', name: '1: Reply today' },
  { id: 'Label_7102', name: '2: This week' },
  { id: 'Label_7103', name: '3: Waiting on them' },
  { id: 'Label_7201', name: 'Portfolio' },
  { id: 'Label_7202', name: '2025: taxes' },
];

describe('numbered labels', () => {
  it('are one or two digits and a colon, not a year', () => {
    expect(isNumberedLabel('1: Reply today')).toBe(true);
    expect(isNumberedLabel('12: Someday')).toBe(true);
    expect(isNumberedLabel(' 3 : Spaced')).toBe(true);
    expect(isNumberedLabel('2025: taxes')).toBe(false);
    expect(isNumberedLabel('Q1: board')).toBe(false);
    expect(isNumberedLabel('Portfolio')).toBe(false);
  });
});

describe('labelChoices', () => {
  it("keeps the person's own labels only, sorted the way Gmail lists them", () => {
    const names = new Map([
      ['INBOX', 'INBOX'],
      ['CATEGORY_UPDATES', 'CATEGORY_UPDATES'],
      ['Label_9', '10: Later'],
      ['Label_8', '2: This week'],
      ['Label_7', 'Portfolio'],
      ['Label_6', '  '],
    ]);
    expect(labelChoices(names).map((l) => l.name)).toEqual([
      '2: This week',
      '10: Later',
      'Portfolio',
    ]);
  });

  it('reads label ids off a thread without system labels or a cap', () => {
    expect(
      userLabelIds(['INBOX', 'UNREAD', 'Label_1', 'Label_2', 'Label_3', 'Label_4', 'Label_5']),
    ).toEqual(['Label_1', 'Label_2', 'Label_3', 'Label_4', 'Label_5']);
  });
});

describe('planLabelChange', () => {
  it('puts a plain label on and takes it off as asked', () => {
    expect(planLabelChange(LABELS, { add: ['Label_7201'], remove: [] })).toEqual({
      ok: true,
      add: ['Label_7201'],
      remove: [],
    });
    expect(planLabelChange(LABELS, { add: [], remove: ['Label_7201'] })).toEqual({
      ok: true,
      add: [],
      remove: ['Label_7201'],
    });
  });

  it('makes picking a numbered label a move out of the rest of the family', () => {
    const plan = planLabelChange(LABELS, { add: ['Label_7102'], remove: [] });
    expect(plan).toEqual({ ok: true, add: ['Label_7102'], remove: ['Label_7101', 'Label_7103'] });
  });

  it('leaves a year label alone when moving between numbered ones', () => {
    const plan = planLabelChange(LABELS, { add: ['Label_7101'], remove: [] });
    expect(plan.ok && plan.remove).not.toContain('Label_7202');
  });

  it('refuses two numbered labels at once and a numbered label taken off alone', () => {
    const two = planLabelChange(LABELS, { add: ['Label_7101', 'Label_7102'], remove: [] });
    expect(two).toMatchObject({ ok: false, reason: 'conflict' });
    const bare = planLabelChange(LABELS, { add: [], remove: ['Label_7103'] });
    expect(bare).toMatchObject({ ok: false, reason: 'conflict' });
    // Swapping explicitly is fine.
    expect(planLabelChange(LABELS, { add: ['Label_7102'], remove: ['Label_7103'] })).toMatchObject({
      ok: true,
      remove: ['Label_7103', 'Label_7101'],
    });
  });

  it('refuses system labels, labels not in Gmail, an empty change and on-and-off', () => {
    expect(planLabelChange(LABELS, { add: ['INBOX'], remove: [] })).toMatchObject({
      ok: false,
      reason: 'unknown',
    });
    expect(planLabelChange(LABELS, { add: ['Label_404'], remove: [] })).toMatchObject({
      ok: false,
      reason: 'unknown',
    });
    expect(planLabelChange(LABELS, { add: [], remove: [] })).toMatchObject({
      ok: false,
      reason: 'nothing',
    });
    expect(planLabelChange(LABELS, { add: ['Label_7201'], remove: ['Label_7201'] })).toMatchObject({
      ok: false,
      reason: 'conflict',
    });
  });
});

describe('applying a plan on screen', () => {
  it('swaps the numbered label and keeps the rest in order', () => {
    const plan = { add: ['Label_7102'], remove: ['Label_7101', 'Label_7103'] };
    expect(applyLabelPlan(['Label_7201', 'Label_7101'], plan)).toEqual([
      'Label_7201',
      'Label_7102',
    ]);
    expect(applyLabelPlan(['Label_7102'], plan)).toEqual(['Label_7102']);
  });

  it('names labels for display and skips ones Gmail no longer has', () => {
    expect(labelNamesFor(['Label_7102', 'Label_404', 'Label_7201'], LABELS)).toEqual([
      '2: This week',
      'Portfolio',
    ]);
  });
});

describe('applyPending', () => {
  type Row = { id: string; unread: boolean; labels: string[] };
  const rows: Row[] = [
    { id: 'a', unread: true, labels: [] },
    { id: 'b', unread: true, labels: [] },
    { id: 'c', unread: false, labels: [] },
  ];

  it('lays a change made here over a list that has not caught up', () => {
    const pending = new Map<string, PendingChange<Row>>([
      ['a', { patch: { unread: false }, until: 2_000 }],
      ['b', { patch: { labels: ['Portfolio'] }, removedFrom: 'primary|', until: 2_000 }],
    ]);
    expect(applyPending(rows, pending, 'primary|', 1_000)).toEqual([
      { id: 'a', unread: false, labels: [] },
      { id: 'c', unread: false, labels: [] },
    ]);
    // A thread archived from the inbox still shows, changed, in another view.
    expect(applyPending(rows, pending, 'starred|', 1_000).map((r) => r.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it("lets Gmail's list win once a change is old enough, and forgets it", () => {
    const pending = new Map<string, PendingChange<Row>>([
      ['a', { patch: { unread: false }, until: 2_000 }],
    ]);
    expect(applyPending(rows, pending, 'primary|', 2_000)).toEqual(rows);
    expect(pending.size).toBe(0);
  });
});
