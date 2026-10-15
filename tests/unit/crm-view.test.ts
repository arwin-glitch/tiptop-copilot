import { describe, expect, it } from 'vitest';
import {
  boardCardFields,
  crmColumnsKey,
  crmListHref,
  crmListQuery,
  defaultSortDir,
  formatCrmValue,
  isNumberedStage,
  moveStage,
  parseCrmListParams,
  parseHiddenColumns,
  readHiddenColumnsRaw,
  serializeHiddenColumns,
  sortStatusOptions,
  statusTone,
  withPendingStatus,
  writeHiddenColumns,
  type CrmListParams,
} from '@/lib/crm/view';
import { gmailSearchUrl } from '@/lib/deals/links';
import type { CrmField } from '@/lib/types/domain';

/** Pure helpers behind the Lists pages. Every name below is invented. */

describe('moving stages', () => {
  const stages = ['1. Sourced', '3. Met', 'Prospect', 'Soft Circle', 'Committed'];

  it('moves an unnumbered stage past its unnumbered neighbours', () => {
    expect(moveStage(stages, 4, -1)).toEqual([
      '1. Sourced',
      '3. Met',
      'Prospect',
      'Committed',
      'Soft Circle',
    ]);
    expect(moveStage(stages, 2, 1)).toEqual([
      '1. Sourced',
      '3. Met',
      'Soft Circle',
      'Prospect',
      'Committed',
    ]);
  });

  it('never moves a numbered stage, or a stage past one, or off either end', () => {
    expect(moveStage(stages, 1, 1)).toEqual(stages);
    expect(moveStage(stages, 2, -1)).toEqual(stages);
    expect(moveStage(stages, 4, 1)).toEqual(stages);
    expect(isNumberedStage('8.2 Passed - Too early')).toBe(true);
    expect(isNumberedStage('Soft Circle')).toBe(false);
  });
});

describe('status options in pipeline order', () => {
  it('orders numbered stages by number, not as strings', () => {
    expect(
      sortStatusOptions(['10. Invested', '3. First Meeting', '1. Sourced', '5. Diligence']),
    ).toEqual(['1. Sourced', '3. First Meeting', '5. Diligence', '10. Invested']);
  });

  it('reads dotted numbers as parts, so 8.2 sorts before 8.10 and after 8', () => {
    expect(
      sortStatusOptions([
        '8.10 Passed - Other',
        '10. Won / Signed',
        '8.2 Passed - Too early',
        '8. Passed',
        '9. Closing',
      ]),
    ).toEqual([
      '8. Passed',
      '8.2 Passed - Too early',
      '8.10 Passed - Other',
      '9. Closing',
      '10. Won / Signed',
    ]);
  });

  it('keeps unnumbered options in their stored order, after the numbered ones', () => {
    expect(sortStatusOptions(['Passed', '3. First Meeting', 'On Hold', '1. Sourced'])).toEqual([
      '1. Sourced',
      '3. First Meeting',
      'Passed',
      'On Hold',
    ]);
    // An LP pipeline has no numbers at all: its stored order is the order.
    const lp = ['Prospect', 'Contacted', 'Soft Circle', 'Committed', 'Declined'];
    expect(sortStatusOptions(lp)).toEqual(lp);
  });

  it('does not treat a word starting with a digit as a stage number', () => {
    expect(sortStatusOptions(['3rd Meeting', '2. Intro'])).toEqual(['2. Intro', '3rd Meeting']);
  });

  it('colours closed-won green and closed-lost grey, and everything else as in flight', () => {
    expect(statusTone('10. Won / Signed')).toBe('ok');
    expect(statusTone('Committed')).toBe('ok');
    expect(statusTone('8.2 Passed - Too early')).toBe('neutral');
    expect(statusTone('Declined')).toBe('neutral');
    expect(statusTone('Closed Lost')).toBe('neutral');
    expect(statusTone('5. Due Diligence')).toBe('info');
    expect(statusTone(null)).toBe('neutral');
  });
});

describe('list page URL state', () => {
  const base: CrmListParams = {
    q: '',
    sort: '',
    dir: 'asc',
    statuses: [],
    page: 1,
    view: 'table',
  };

  it('reads and checks every param', () => {
    expect(
      parseCrmListParams({
        q: '  brindle ',
        sort: 'amount',
        dir: 'desc',
        status: ['3. First Meeting', '8.2 Passed, revisit later', '3. First Meeting', ''],
        page: '4',
        view: 'board',
      }),
    ).toEqual({
      q: 'brindle',
      sort: 'amount',
      dir: 'desc',
      statuses: ['3. First Meeting', '8.2 Passed, revisit later'],
      page: 4,
      view: 'board',
    });
  });

  it('falls back to defaults for anything malformed', () => {
    expect(
      parseCrmListParams({ sort: 'amount; drop table', dir: 'sideways', page: '-3', view: 'grid' }),
    ).toEqual(base);
    expect(parseCrmListParams({ page: 'abc' }).page).toBe(1);
  });

  it('writes only what differs from the defaults, repeating status for labels with commas', () => {
    expect(crmListQuery(base, {})).toBe('');
    const qs = crmListQuery(base, {
      q: 'cobalt',
      statuses: ['5. Diligence', '8.2 Passed, revisit later'],
      sort: 'amount',
      dir: 'desc',
      view: 'board',
    });
    const parsed = new URLSearchParams(qs);
    expect(parsed.get('view')).toBe('board');
    expect(parsed.get('q')).toBe('cobalt');
    expect(parsed.getAll('status')).toEqual(['5. Diligence', '8.2 Passed, revisit later']);
    expect(parsed.get('sort')).toBe('amount');
    expect(parsed.get('dir')).toBe('desc');
    // And it reads back to the same state.
    expect(parseCrmListParams(Object.fromEntries(groupParams(parsed)))).toMatchObject({
      q: 'cobalt',
      statuses: ['5. Diligence', '8.2 Passed, revisit later'],
      view: 'board',
    });
  });

  it('goes back to page one when anything but the page changes', () => {
    const onPage3 = { ...base, page: 3 };
    expect(crmListQuery(onPage3, { page: 4 })).toBe('page=4');
    expect(crmListQuery(onPage3, { q: 'x' })).toBe('q=x');
    expect(crmListHref('abc', onPage3)).toBe('/lists/abc');
  });

  it('starts figures and dates highest first, names and stages A–Z', () => {
    expect(defaultSortDir('money')).toBe('desc');
    expect(defaultSortDir('date')).toBe('desc');
    expect(defaultSortDir('title')).toBe('asc');
    expect(defaultSortDir('status')).toBe('asc');
  });
});

function groupParams(params: URLSearchParams): [string, string | string[]][] {
  const out = new Map<string, string[]>();
  for (const [k, v] of params) out.set(k, [...(out.get(k) ?? []), v]);
  return [...out].map(([k, v]) => [k, v.length === 1 ? (v[0] as string) : v]);
}

describe('hidden columns, per list and per browser', () => {
  const fields = [{ key: 'status' }, { key: 'amount' }, { key: 'owners' }];

  /** A Storage stand-in; `broken` throws on every call, like a blocked one. */
  function memoryStorage(broken = false) {
    const data = new Map<string, string>();
    const guard = () => {
      if (broken) throw new Error('SecurityError: storage is disabled');
    };
    return {
      data,
      getItem: (k: string) => (guard(), data.get(k) ?? null),
      setItem: (k: string, v: string) => (guard(), void data.set(k, v)),
      removeItem: (k: string) => (guard(), void data.delete(k)),
    };
  }

  it('round-trips through storage under a per-list key', () => {
    const storage = memoryStorage();
    expect(writeHiddenColumns(() => storage, 'list-1', new Set(['owners', 'amount']))).toBe(true);
    expect(storage.data.get(crmColumnsKey('list-1'))).toBe('["amount","owners"]');
    const raw = readHiddenColumnsRaw(() => storage, 'list-1');
    expect([...parseHiddenColumns(raw, fields)].sort()).toEqual(['amount', 'owners']);
    expect(readHiddenColumnsRaw(() => storage, 'list-2')).toBeNull();
  });

  it('removes the key when nothing is hidden', () => {
    const storage = memoryStorage();
    writeHiddenColumns(() => storage, 'list-1', ['amount']);
    writeHiddenColumns(() => storage, 'list-1', []);
    expect(storage.data.has(crmColumnsKey('list-1'))).toBe(false);
  });

  it('never throws when storage is blocked, and reports the write as not kept', () => {
    const storage = memoryStorage(true);
    expect(readHiddenColumnsRaw(() => storage, 'list-1')).toBeNull();
    expect(writeHiddenColumns(() => storage, 'list-1', ['amount'])).toBe(false);
    // Even reaching for localStorage can throw in a sandboxed frame.
    const unreachable = () => {
      throw new Error('SecurityError');
    };
    expect(readHiddenColumnsRaw(unreachable, 'list-1')).toBeNull();
    expect(writeHiddenColumns(unreachable, 'list-1', ['amount'])).toBe(false);
    expect(writeHiddenColumns(() => null, 'list-1', ['amount'])).toBe(false);
  });

  it('ignores garbage and keys of fields the list no longer has', () => {
    expect(parseHiddenColumns('not json', fields).size).toBe(0);
    expect(parseHiddenColumns('{"amount":true}', fields).size).toBe(0);
    expect([...parseHiddenColumns('["amount", 3, "gone"]', fields)]).toEqual(['amount']);
    expect(serializeHiddenColumns(['b', 'a', 'b'])).toBe('["a","b"]');
  });
});

describe('board helpers', () => {
  const field = (key: string, type: CrmField['type'] = 'text'): CrmField => ({
    key,
    name: key,
    type,
  });

  it('shows the first visible fields besides the status on a card', () => {
    const fields = [
      field('status', 'status'),
      field('amount', 'money'),
      field('owners', 'person'),
      field('channel'),
      field('industry', 'multi'),
    ];
    expect(boardCardFields(fields, 'status').map((f) => f.key)).toEqual([
      'amount',
      'owners',
      'channel',
    ]);
    expect(boardCardFields(fields, 'status', new Set(['owners'])).map((f) => f.key)).toEqual([
      'amount',
      'channel',
      'industry',
    ]);
  });

  it('moves a card being changed to its new column, counts and all', () => {
    const columns = [
      { status: '1. Sourced', entries: [{ id: 'a' }, { id: 'b' }], total: 9 },
      { status: '3. First Meeting', entries: [{ id: 'c' }], total: 1 },
      { status: null, entries: [], total: 0 },
    ];
    const moved = withPendingStatus(columns, { b: { value: '3. First Meeting' } });
    expect(moved.map((c) => [c.status, c.entries.map((e) => e.id), c.total])).toEqual([
      ['1. Sourced', ['a'], 8],
      ['3. First Meeting', ['b', 'c'], 2],
      [null, [], 0],
    ]);
    // The input is left alone: dropping the change puts the card back.
    expect(columns[0]!.entries.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('lets a card leave for a column the board is not showing, and ignores no-op changes', () => {
    const columns = [{ status: '1. Sourced', entries: [{ id: 'a' }], total: 1 }];
    expect(withPendingStatus(columns, { a: { value: 'Passed' } })[0]).toMatchObject({
      entries: [],
      total: 0,
    });
    expect(withPendingStatus(columns, { a: { value: '1. Sourced' } })[0]?.entries).toHaveLength(1);
  });
});

describe('values and links', () => {
  it('formats a calendar date without slipping a day, and leaves unparsed text alone', () => {
    expect(formatCrmValue({ type: 'date' }, '2026-03-01', 'America/Los_Angeles')).toBe(
      'Mar 1, 2026',
    );
    expect(formatCrmValue({ type: 'date' }, 'sometime in Q3', 'America/Chicago')).toBe(
      'sometime in Q3',
    );
    expect(formatCrmValue({ type: 'money' }, 1_250_000, 'UTC')).toBe('$1,250,000');
    expect(formatCrmValue({ type: 'person' }, ['Morgan Ellery', 'Dana Whitcombe'], 'UTC')).toBe(
      'Morgan Ellery, Dana Whitcombe',
    );
    expect(formatCrmValue({ type: 'text' }, undefined, 'UTC')).toBe('');
  });

  it('builds a Gmail search only from a valid domain or plain addresses', () => {
    const company = gmailSearchUrl({ domain: 'brindlehealth.example' }, 'nick@tiptop.demo');
    expect(company).toBe(
      `https://mail.google.com/mail/?authuser=nick%40tiptop.demo#search/${encodeURIComponent(
        'from:brindlehealth.example OR to:brindlehealth.example',
      )}`,
    );
    const person = gmailSearchUrl({ emails: ['ada@brindlehealth.example', 'not an email'] }, null);
    expect(person).toBe(
      `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(
        'from:ada@brindlehealth.example OR to:ada@brindlehealth.example',
      )}`,
    );
    expect(gmailSearchUrl({ domain: 'good.example@evil.example' }, null)).toBeNull();
    expect(gmailSearchUrl({ emails: [] }, null)).toBeNull();
  });
});
