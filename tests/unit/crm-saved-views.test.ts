import { describe, expect, it } from 'vitest';
import { matchesFilter } from '@/lib/db/filter';
import {
  CRM_TIME_IN_STATUS_KEY,
  DEFAULT_VIEW_STATE,
  addToTotals,
  compileEntryFilter,
  conditionOps,
  csvCell,
  decodeCondition,
  defaultHiddenColumns,
  emptyTotals,
  encodeCondition,
  formatDuration,
  importedDurationMs,
  importedTimeInStatusField,
  normalizeCondition,
  normalizeConditions,
  normalizeViewState,
  parseSavedViews,
  roundTotals,
  sameViewState,
  summableFields,
  timeInStatusText,
  toCsv,
  visibleColumnKeys,
  type CrmViewCondition,
} from '@/lib/crm/saved-views';
import {
  crmListHref,
  crmListQuery,
  crmViewExportHref,
  crmViewParams,
  parseCrmListParams,
  resolveListParams,
  type CrmListParams,
} from '@/lib/crm/view';
import type { CrmField, CrmValue } from '@/lib/types/domain';

/**
 * Saved views, pure parts: what a condition may be on each field type, how
 * conditions become one database filter (and that the filter means the same
 * thing in memory), how a view travels in the URL, which state a page shows,
 * totals, time in status and CSV escaping. Invented fields and rows only.
 */

const FIELDS: CrmField[] = [
  {
    key: 'status',
    name: 'Status',
    type: 'status',
    options: ['1. Sourced', '3. Meeting', 'Passed'],
  },
  { key: 'amount', name: 'Amount', type: 'money' },
  { key: 'owners', name: 'Owners', type: 'person' },
  { key: 'channel', name: 'Channel', type: 'status', options: ['Inbound', 'Referral'] },
  { key: 'industry', name: 'Industry', type: 'multi', options: ['AI', 'Climate', 'Fintech'] },
  { key: 'added', name: 'Date Added', type: 'date' },
  { key: 'notes', name: 'Notes', type: 'text' },
  { key: 'contact', name: 'Contact', type: 'email' },
];

const BASE = { eq: { list_id: 'list-1' } };

function row(values: Record<string, CrmValue>, extra: Record<string, unknown> = {}) {
  return { id: `e-${JSON.stringify(values)}`, list_id: 'list-1', title: 'Row', values, ...extra };
}

const ROWS = [
  row({
    status: '1. Sourced',
    amount: 250_000,
    owners: ['Ada Quill'],
    channel: 'Inbound',
    industry: ['AI'],
    added: '2026-03-01',
  }),
  row({
    status: '3. Meeting',
    amount: 1_000_000,
    owners: ['Ada Quill', 'Bo Ferrant'],
    channel: 'Referral',
    industry: ['Climate', 'AI'],
    added: '2026-03-31T18:30:00.000Z',
    notes: 'Warm intro via a scout',
  }),
  row({
    status: '3. Meeting',
    amount: 2_500_000,
    owners: ['Bo Ferrant'],
    channel: 'Inbound',
    industry: ['Fintech'],
    added: '2026-04-02',
  }),
  row({ status: 'Passed', owners: ['Cy Ostrander'], industry: ['Air Quality'] }),
  row({}),
];

const matching = (conditions: CrmViewCondition[], statuses: string[] = []) =>
  ROWS.filter((r) =>
    matchesFilter(
      r,
      compileEntryFilter(BASE, FIELDS, { statusKey: 'status', statuses, conditions }),
    ),
  ).length;

describe('conditions by field type', () => {
  it('offers each type only the conditions that make sense for it', () => {
    expect(conditionOps('status')).toEqual(['in', 'empty', 'not_empty']);
    expect(conditionOps('money')).toContain('gte');
    expect(conditionOps('money')).not.toContain('contains');
    expect(conditionOps('text')).toContain('contains');
    expect(conditionOps('date')).toEqual(['gte', 'lte', 'is', 'empty', 'not_empty']);
  });

  it('normalizes values against the field, and drops what cannot apply', () => {
    expect(normalizeCondition({ key: 'amount', op: 'gte', value: '$1.5M' }, FIELDS)).toEqual({
      key: 'amount',
      op: 'gte',
      value: 1_500_000,
    });
    expect(normalizeCondition({ key: 'amount', op: 'gte', value: 'lots' }, FIELDS)).toBeNull();
    expect(normalizeCondition({ key: 'amount', op: 'contains', value: '5' }, FIELDS)).toBeNull();
    expect(normalizeCondition({ key: 'gone', op: 'empty' }, FIELDS)).toBeNull();
    expect(
      normalizeCondition({ key: 'added', op: 'is', value: '2026-03-31T10:00:00Z' }, FIELDS),
    ).toEqual({ key: 'added', op: 'is', value: '2026-03-31' });
    expect(normalizeCondition({ key: 'added', op: 'is', value: 'March' }, FIELDS)).toBeNull();
    expect(
      normalizeCondition({ key: 'contact', op: 'is', value: ' Ada@Example.TEST ' }, FIELDS),
    ).toEqual({ key: 'contact', op: 'is', value: 'ada@example.test' });
    expect(
      normalizeCondition({ key: 'status', op: 'in', values: ['Passed', 'Passed', ' ', 7] }, FIELDS),
    ).toEqual({ key: 'status', op: 'in', values: ['Passed'] });
    expect(normalizeCondition({ key: 'status', op: 'in', values: [] }, FIELDS)).toBeNull();
    expect(normalizeCondition({ key: 'notes', op: 'empty', value: 'ignored' }, FIELDS)).toEqual({
      key: 'notes',
      op: 'empty',
    });
  });

  it('keeps one condition per field and operator, the later winning', () => {
    const out = normalizeConditions(
      [
        { key: 'amount', op: 'gte', value: 1 },
        { key: 'amount', op: 'lte', value: 9 },
        { key: 'amount', op: 'gte', value: 5 },
        // On a list-valued field "includes" and "contains" share one slot.
        { key: 'industry', op: 'is', value: 'AI' },
        { key: 'industry', op: 'contains', value: 'clim' },
      ],
      FIELDS,
    );
    expect(out).toEqual([
      { key: 'amount', op: 'lte', value: 9 },
      { key: 'amount', op: 'gte', value: 5 },
      { key: 'industry', op: 'contains', value: 'clim' },
    ]);
  });
});

describe('conditions as one filter', () => {
  it('spells each condition the way both stores read it', () => {
    const filter = compileEntryFilter(BASE, FIELDS, {
      statusKey: 'status',
      statuses: ['3. Meeting'],
      conditions: [
        { key: 'amount', op: 'gte', value: 500_000 },
        { key: 'added', op: 'lte', value: '2026-03-31' },
        { key: 'owners', op: 'contains', value: 'ada' },
        { key: 'industry', op: 'is', value: 'AI' },
        { key: 'notes', op: 'not_empty' },
        { key: 'channel', op: 'empty' },
      ],
    });
    expect(filter).toEqual({
      eq: { list_id: 'list-1' },
      in: { 'values->>status': ['3. Meeting'] },
      gte: { 'values->amount': 500_000 },
      lt: { 'values->>added': '2026-04-01' },
      textContains: { 'values->>owners': 'ada', 'values->>industry': '"AI"' },
      notNull: ['values->>notes'],
      isNull: ['values->>channel'],
    });
  });

  it('combines conditions on one column instead of overwriting them', () => {
    const filter = compileEntryFilter(BASE, FIELDS, {
      statusKey: 'status',
      statuses: ['1. Sourced', '3. Meeting'],
      conditions: [
        { key: 'status', op: 'in', values: ['3. Meeting', 'Passed'] },
        { key: 'amount', op: 'gte', value: 100 },
        { key: 'amount', op: 'is', value: 2_500_000 },
        { key: 'amount', op: 'lte', value: 3_000_000 },
      ],
    });
    expect(filter.in).toEqual({ 'values->>status': ['3. Meeting'] });
    expect(filter.gte).toEqual({ 'values->amount': 2_500_000 });
    expect(filter.lte).toEqual({ 'values->amount': 2_500_000 });
  });

  it('matches nothing when two exact values contradict', () => {
    const filter = compileEntryFilter(BASE, FIELDS, {
      conditions: [{ key: 'notes', op: 'is', value: 'a' }],
    });
    const contradiction = compileEntryFilter(filter, FIELDS, {
      conditions: [{ key: 'notes', op: 'is', value: 'b' }],
    });
    expect(contradiction.in).toEqual({ id: [] });
    expect(ROWS.filter((r) => matchesFilter(r, contradiction))).toHaveLength(0);
  });

  it('means the same in memory: every condition must hold', () => {
    expect(matching([])).toBe(5);
    expect(matching([{ key: 'amount', op: 'gte', value: 1_000_000 }])).toBe(2);
    expect(matching([{ key: 'amount', op: 'lte', value: 1_000_000 }])).toBe(2);
    expect(matching([{ key: 'amount', op: 'is', value: 1_000_000 }])).toBe(1);
    expect(matching([{ key: 'amount', op: 'empty' }])).toBe(2);
    expect(matching([{ key: 'owners', op: 'contains', value: 'BO F' }])).toBe(2);
    // "includes" is a whole element: AI, not Air Quality.
    expect(matching([{ key: 'industry', op: 'is', value: 'ai' }])).toBe(2);
    expect(matching([{ key: 'industry', op: 'contains', value: 'ai' }])).toBe(3);
    // A date-time on the last day counts as on or before it.
    expect(matching([{ key: 'added', op: 'lte', value: '2026-03-31' }])).toBe(2);
    expect(matching([{ key: 'added', op: 'is', value: '2026-03-31' }])).toBe(1);
    expect(matching([{ key: 'added', op: 'gte', value: '2026-04-01' }])).toBe(1);
    expect(matching([{ key: 'notes', op: 'contains', value: 'SCOUT' }])).toBe(1);
    expect(matching([{ key: 'channel', op: 'in', values: ['Inbound'] }], ['3. Meeting'])).toBe(1);
    expect(
      matching([
        { key: 'amount', op: 'gte', value: 200_000 },
        { key: 'owners', op: 'contains', value: 'ada' },
        { key: 'channel', op: 'in', values: ['Inbound'] },
      ]),
    ).toBe(1);
  });
});

describe('a view in the URL', () => {
  it('round-trips conditions, labels with any character included', () => {
    const conditions: CrmViewCondition[] = [
      { key: 'amount', op: 'gte', value: 1_000_000 },
      { key: 'status', op: 'in', values: ['8.2 Passed: "too early", maybe', 'Won'] },
      { key: 'notes', op: 'contains', value: 'a:b:c' },
      { key: 'channel', op: 'empty' },
    ];
    for (const c of conditions) {
      const decoded = decodeCondition(encodeCondition(c));
      expect(normalizeCondition(decoded, FIELDS)).toEqual(c);
    }
    expect(decodeCondition('amount')).toBeNull();
    expect(decodeCondition('amount:explode:1')).toBeNull();
    expect(decodeCondition('status:in:not json')).toBeNull();
    expect(decodeCondition('notes:contains:')).toBeNull();
  });

  const all = parseCrmListParams({});

  it('reads a saved view, its changes, columns, conditions and grouping', () => {
    const params = parseCrmListParams({
      v: 'abc123def456',
      mod: '1',
      cols: 'amount,_time_in_status,BAD KEY,amount',
      f: ['amount:gte:1000000', 'nonsense'],
      group: 'channel',
    });
    expect(params).toMatchObject({
      viewId: 'abc123def456',
      modified: true,
      columns: ['amount', '_time_in_status'],
      conditions: [{ key: 'amount', op: 'gte', value: '1000000' }],
      groupBy: 'channel',
    });
    expect(parseCrmListParams({ v: 'all' }).viewId).toBe('');
    expect(parseCrmListParams({ v: '../x' }).viewId).toBe('');
    expect(all.columns).toBeNull();
  });

  it('writes a saved view as saved as its id alone, and a changed one in full', () => {
    const saved: CrmListParams = { ...crmViewParams({ q: 'robot' }, 'abc123def456') };
    expect(crmListQuery(saved, {})).toBe('v=abc123def456&q=robot');
    expect(crmListQuery(saved, { page: 3 })).toBe('v=abc123def456&q=robot&page=3');

    const changed = new URLSearchParams(
      crmListQuery(
        { ...saved, statuses: ['Passed'] },
        { conditions: [{ key: 'notes', op: 'empty' }] },
      ),
    );
    expect(changed.get('v')).toBe('abc123def456');
    expect(changed.get('mod')).toBe('1');
    expect(changed.getAll('status')).toEqual(['Passed']);
    expect(changed.getAll('f')).toEqual(['notes:empty']);

    // All always spells itself out, and stays plain when nothing is set.
    expect(crmListQuery(all, {})).toBe('');
    const board = new URLSearchParams(
      crmListQuery(all, { view: 'board', groupBy: 'channel', columns: ['amount'] }),
    );
    expect(board.get('view')).toBe('board');
    expect(board.get('group')).toBe('channel');
    expect(board.get('cols')).toBe('amount');
    expect(board.get('mod')).toBeNull();
    expect(crmListHref('l1', saved, { viewId: '', modified: false })).toBe('/lists/l1?q=robot');
  });

  it('exports with the columns as this browser shows them', () => {
    const href = crmViewExportHref('l1', all, ['amount', CRM_TIME_IN_STATUS_KEY]);
    expect(href).toBe('/api/crm/lists/l1/export?cols=amount%2C_time_in_status');
  });
});

describe('which state a page shows', () => {
  const view = {
    id: 'bigchecks001',
    name: 'Big checks',
    ...DEFAULT_VIEW_STATE,
    columns: ['amount', 'status'],
    sort: 'amount',
    dir: 'desc' as const,
    conditions: [{ key: 'amount', op: 'gte' as const, value: 1_000_000 }],
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
  };

  it('applies a saved view as saved, and keeps the search and page', () => {
    const r = resolveListParams(
      parseCrmListParams({ v: view.id, q: 'acme', page: '2', sort: 'title' }),
      FIELDS,
      [view],
    );
    expect(r.active?.id).toBe(view.id);
    expect(r.dirty).toBe(false);
    expect(r.params).toMatchObject({
      q: 'acme',
      page: 2,
      sort: 'amount',
      dir: 'desc',
      columns: ['amount', 'status'],
    });
  });

  it('takes a changed view from the URL and says it is changed', () => {
    const r = resolveListParams(
      parseCrmListParams({
        v: view.id,
        mod: '1',
        sort: 'amount',
        dir: 'desc',
        cols: 'amount,status',
        f: 'amount:gte:2000000',
      }),
      FIELDS,
      [view],
    );
    expect(r.dirty).toBe(true);
    expect(r.params.conditions).toEqual([{ key: 'amount', op: 'gte', value: 2_000_000 }]);
    // Changed back to what is saved: not changed any more.
    const back = resolveListParams(
      parseCrmListParams({
        v: view.id,
        mod: '1',
        sort: 'amount',
        dir: 'desc',
        cols: 'amount,status',
        f: 'amount:gte:1000000',
      }),
      FIELDS,
      [view],
    );
    expect(back.dirty).toBe(false);
  });

  it('falls back to All for a view that no longer exists, and drops what the list lacks', () => {
    const r = resolveListParams(
      parseCrmListParams({
        v: 'deleted00000',
        cols: 'amount,gone',
        f: ['gone:empty', 'amount:gte:5'],
        group: 'notes',
      }),
      FIELDS,
      [view],
    );
    expect(r.missingView).toBe(true);
    expect(r.active).toBeNull();
    expect(r.params.viewId).toBe('');
    expect(r.params.columns).toEqual(['amount']);
    expect(r.params.conditions).toEqual([{ key: 'amount', op: 'gte', value: 5 }]);
    expect(r.params.groupBy).toBe('');
    expect(r.dirty).toBe(true);
  });

  it('compares states as sets where order means nothing', () => {
    const a = {
      ...DEFAULT_VIEW_STATE,
      statuses: ['A', 'B'],
      conditions: [
        { key: 'x', op: 'empty' as const },
        { key: 'y', op: 'empty' as const },
      ],
    };
    const b = {
      ...DEFAULT_VIEW_STATE,
      statuses: ['B', 'A'],
      conditions: [
        { key: 'y', op: 'empty' as const },
        { key: 'x', op: 'empty' as const },
      ],
    };
    expect(sameViewState(a, b)).toBe(true);
    expect(sameViewState({ ...a, columns: ['p', 'q'] }, { ...a, columns: ['q', 'p'] })).toBe(false);
    // A direction without a sort, or a grouping on a table, changes nothing.
    expect(sameViewState({ ...DEFAULT_VIEW_STATE, dir: 'desc' }, DEFAULT_VIEW_STATE)).toBe(true);
    expect(sameViewState({ ...DEFAULT_VIEW_STATE, groupBy: 'channel' }, DEFAULT_VIEW_STATE)).toBe(
      true,
    );
  });
});

describe('stored views', () => {
  it('keeps only well-formed views, cleaned against the list', () => {
    const views = parseSavedViews(
      [
        {
          id: 'goodview0001',
          name: '  Active   deals ',
          view: 'board',
          groupBy: 'channel',
          columns: ['amount', 'gone'],
          conditions: [
            { key: 'gone', op: 'empty' },
            { key: 'amount', op: 'gte', value: 10 },
          ],
          created_at: '2026-10-01T00:00:00.000Z',
        },
        { id: 'goodview0001', name: 'Duplicate id' },
        { id: 'all', name: 'Not allowed' },
        { id: 'short', name: 'Bad id' },
        { id: 'noname000001' },
        'not an object',
        null,
      ],
      FIELDS,
    );
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      id: 'goodview0001',
      name: 'Active deals',
      view: 'board',
      groupBy: 'channel',
      columns: ['amount'],
      conditions: [{ key: 'amount', op: 'gte', value: 10 }],
      updated_at: '2026-10-01T00:00:00.000Z',
    });
    expect(parseSavedViews(undefined, FIELDS)).toEqual([]);
    expect(parseSavedViews({ views: [] }, FIELDS)).toEqual([]);
  });

  it('normalizes a state from anywhere', () => {
    expect(
      normalizeViewState({ view: 'grid', sort: 'nope', dir: 'up', statuses: 'x' }, FIELDS),
    ).toEqual(DEFAULT_VIEW_STATE);
    expect(
      normalizeViewState({ sort: 'title', dir: 'desc', groupBy: 'amount' }, FIELDS),
    ).toMatchObject({ sort: 'title', dir: 'desc', groupBy: '' });
  });
});

describe('columns', () => {
  it('puts the time in status right after the pipeline field by default', () => {
    expect(visibleColumnKeys(FIELDS, null)).toEqual([
      'status',
      CRM_TIME_IN_STATUS_KEY,
      'amount',
      'owners',
      'channel',
      'industry',
      'added',
      'notes',
      'contact',
    ]);
    expect(
      visibleColumnKeys(FIELDS, null, new Set(['owners', CRM_TIME_IN_STATUS_KEY])),
    ).not.toContain('owners');
    expect(visibleColumnKeys(FIELDS, ['notes', 'gone', 'amount'])).toEqual(['notes', 'amount']);
    // No status field, no timer.
    expect(visibleColumnKeys([{ key: 'notes', name: 'Notes', type: 'text' }], null)).toEqual([
      'notes',
    ]);
  });

  it('hides at first a Time in Stage with nothing to count from, or the frozen imported timer', () => {
    const tics: CrmField = { key: 'tics', name: 'Time in Current Status', type: 'number' };
    // Imported from Affinity without its timer: blank for every imported entry, so offered.
    expect(defaultHiddenColumns({ source: 'affinity', fields: FIELDS })).toEqual([
      CRM_TIME_IN_STATUS_KEY,
    ]);
    // With Affinity's timer: Time in Stage counts on from it and takes its place.
    expect(defaultHiddenColumns({ source: 'affinity', fields: [...FIELDS, tics] })).toEqual([
      'tics',
    ]);
    // Made in Kraken: every entry counts from when it was added.
    expect(defaultHiddenColumns({ source: 'copilot', fields: FIELDS })).toEqual([]);
    // No status field: nothing to time, nothing hidden.
    expect(defaultHiddenColumns({ source: 'affinity', fields: [tics] })).toEqual([]);
  });
});

describe('totals', () => {
  it('totals numbers and money, never the amounts on an LP list', () => {
    const lpFields: CrmField[] = [
      { key: 'status', name: 'Status', type: 'status', options: ['Committed'] },
      { key: 'commitment', name: 'Commitment', type: 'money' },
      { key: 'target', name: 'Target', type: 'money' },
      { key: 'check_size', name: 'Check Size', type: 'number' },
      { key: 'meetings', name: 'Meetings', type: 'number' },
    ];
    expect(summableFields({ name: 'Deal Pipeline' }, FIELDS).map((f) => f.key)).toEqual(['amount']);
    // On an LP list money is never summed, nor a number that reads as an amount.
    expect(summableFields({ name: 'Fund II LPs' }, lpFields).map((f) => f.key)).toEqual([
      'meetings',
    ]);
    expect(summableFields({ name: 'LP Pipeline' }, lpFields).map((f) => f.key)).toEqual([
      'meetings',
    ]);
    // The same columns on a list that is not an LP list are summed.
    expect(summableFields({ name: 'Portfolio' }, lpFields).map((f) => f.key)).toEqual([
      'commitment',
      'target',
      'check_size',
      'meetings',
    ]);
  });

  it('sums figures overall and per board column, counting only real numbers', () => {
    const totals = addToTotals(
      emptyTotals(),
      [
        { values: { status: 'A', amount: 0.1, check: 5 } },
        { values: { status: 'A', amount: 0.2 } },
        { values: { status: 'B', amount: 'TBD' } },
        { values: {} },
      ],
      ['amount', 'check'],
      'status',
    );
    const rounded = roundTotals(totals);
    expect(rounded.count).toBe(4);
    expect(rounded.sums.amount).toEqual({ sum: 0.3, count: 2 });
    expect(rounded.sums.check).toEqual({ sum: 5, count: 1 });
    expect(rounded.groups.A).toEqual({
      count: 2,
      sums: { amount: { sum: 0.3, count: 2 }, check: { sum: 5, count: 1 } },
    });
    expect(rounded.groups.B?.count).toBe(1);
    expect(rounded.groups['']?.count).toBe(1);
  });
});

describe('time in status', () => {
  const now = Date.parse('2026-10-15T12:00:00.000Z');

  it('reads in days, from a known change or from Affinity', () => {
    expect(formatDuration(30 * 60_000)).toBe('<1h');
    expect(formatDuration(5 * 3_600_000)).toBe('5h');
    expect(formatDuration(12 * 86_400_000 + 1)).toBe('12d');
    expect(
      timeInStatusText(
        { since: '2026-10-03T12:00:00.000Z', imported: null, source: 'copilot' },
        now,
      ),
    ).toBe('12d');
    expect(timeInStatusText({ since: null, imported: '45', source: 'affinity' }, now)).toBe('45d');
    expect(timeInStatusText({ since: null, imported: '3 weeks', source: 'affinity' }, now)).toBe(
      '3 weeks',
    );
    expect(timeInStatusText({ since: null, imported: null, source: 'unknown' }, now)).toBe('');
  });

  it('marks an estimate from Affinity’s figure with a visible "~"', () => {
    expect(
      timeInStatusText(
        {
          since: '2026-09-09T12:00:00.000Z',
          imported: '12',
          source: 'affinity',
          importedAt: '2026-09-21T12:00:00.000Z',
        },
        now,
      ),
    ).toBe('~36d');
  });

  it('reads an imported figure as a duration: bare numbers are days', () => {
    const day = 86_400_000;
    expect(importedDurationMs('12')).toBe(12 * day);
    expect(importedDurationMs(' 12.5 ')).toBe(12.5 * day);
    expect(importedDurationMs('12d')).toBe(12 * day);
    expect(importedDurationMs('12 days')).toBe(12 * day);
    expect(importedDurationMs('3 weeks')).toBe(21 * day);
    expect(importedDurationMs('5h')).toBe(5 * 3_600_000);
    expect(importedDurationMs('2 months')).toBe(60 * day);
    expect(importedDurationMs('1 year')).toBe(365 * day);
    expect(importedDurationMs('about a month')).toBeNull();
    expect(importedDurationMs('')).toBeNull();
  });

  it('finds an imported Time in Current Status column by its label', () => {
    expect(
      importedTimeInStatusField([
        ...FIELDS,
        { key: 'tics', name: 'Time in Current Status', type: 'number' },
      ])?.key,
    ).toBe('tics');
    expect(importedTimeInStatusField(FIELDS)).toBeNull();
  });
});

describe('CSV', () => {
  it('quotes what needs quoting and doubles quotes', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('Acme, Inc.')).toBe('"Acme, Inc."');
    expect(csvCell('She said "hi"')).toBe('"She said ""hi"""');
    expect(csvCell('line one\nline two')).toBe('"line one\nline two"');
    expect(csvCell(' padded ')).toBe('" padded "');
    expect(csvCell(null)).toBe('');
    expect(csvCell(1250000)).toBe('1250000');
    expect(csvCell(Number.NaN)).toBe('');
    expect(csvCell(true)).toBe('true');
  });

  it('defuses text a spreadsheet would run as a formula, but not numbers', () => {
    expect(csvCell('=HYPERLINK("http://bad.example","x")')).toBe(
      '"\'=HYPERLINK(""http://bad.example"",""x"")"',
    );
    expect(csvCell('+1 555 0100')).toBe("'+1 555 0100");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('-cmd')).toBe("'-cmd");
    expect(csvCell('-42.5')).toBe('-42.5');
    expect(csvCell(-42.5)).toBe('-42.5');
  });

  it('writes a document Excel reads as UTF-8, with CRLF lines', () => {
    const csv = toCsv([
      ['Name', 'Amount'],
      ['Café Ølund', 1000],
    ]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toBe('﻿Name,Amount\r\nCafé Ølund,1000\r\n');
    expect(toCsv([], { bom: false })).toBe('');
  });
});
