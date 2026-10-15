import { describe, expect, it } from 'vitest';
import {
  coerceCrmValue,
  crmFieldKey,
  crmNameKey,
  displayCrmValue,
  mergeCrmFields,
  normalizeCrmFields,
  normalizeCrmValue,
  statusFieldOf,
  validateCrmValue,
} from '@/lib/crm/fields';
import { applyOptions, matchesFilter } from '@/lib/db/filter';
import { isMissingColumnError, isMissingTableError } from '@/lib/db/missing-table';
import type { CrmField } from '@/lib/types/domain';

/** All names below are invented. */

describe('field keys', () => {
  it('slugs a column label into the narrow key alphabet', () => {
    expect(crmFieldKey('Time in Current Status')).toBe('time_in_current_status');
    expect(crmFieldKey('Fund (2026)')).toBe('fund_2026');
    expect(crmFieldKey('Café Owner')).toBe('cafe_owner');
    expect(crmFieldKey('***')).toBe('field');
  });

  it('never starts a key with a digit, so it cannot read as an array index', () => {
    expect(crmFieldKey('10x Score')).toBe('f_10x_score');
  });

  it('suffixes a key that is already taken', () => {
    const taken = new Set<string>();
    expect(crmFieldKey('Status', taken)).toBe('status');
    expect(crmFieldKey('status', taken)).toBe('status_2');
    expect(crmFieldKey('STATUS', taken)).toBe('status_3');
  });

  it('normalizes field definitions: drops unnamed, defaults the type, keeps options only where they mean something', () => {
    const fields = normalizeCrmFields([
      { name: 'Status', type: 'status', options: ['Lead', ' Lead ', 'Won', ''] },
      { name: '  ' },
      { name: 'Notes', type: 'nonsense', options: ['x'] },
      { name: 'Amount', type: 'money', key: 'amount' },
      { name: 'Amount again', type: 'money', key: 'amount' },
    ]);
    expect(fields).toEqual([
      { key: 'status', name: 'Status', type: 'status', options: ['Lead', 'Won'] },
      { key: 'notes', name: 'Notes', type: 'text' },
      { key: 'amount', name: 'Amount', type: 'money' },
      { key: 'amount_again', name: 'Amount again', type: 'money' },
    ]);
  });

  it('merges a re-imported list: keeps keys, unions options, appends new fields, keeps unmentioned ones', () => {
    const existing: CrmField[] = [
      { key: 'status', name: 'Status', type: 'status', options: ['1. Lead', '2. Call'] },
      { key: 'owner', name: 'Owner', type: 'person' },
    ];
    const merged = mergeCrmFields(
      existing,
      normalizeCrmFields([
        { name: 'status', type: 'status', options: ['2. Call', '3. Won'] },
        { name: 'Close Date', type: 'date' },
      ]),
    );
    expect(merged).toEqual([
      { key: 'status', name: 'status', type: 'status', options: ['1. Lead', '2. Call', '3. Won'] },
      { key: 'owner', name: 'Owner', type: 'person' },
      { key: 'close_date', name: 'Close Date', type: 'date' },
    ]);
  });

  it('finds the pipeline field', () => {
    const fields: CrmField[] = [
      { key: 'fund', name: 'Fund', type: 'status', options: [] },
      { key: 'stage_x', name: 'Status', type: 'status', options: [] },
    ];
    expect(statusFieldOf({ fields })?.key).toBe('stage_x');
    expect(statusFieldOf({ fields: [fields[0]!] })?.key).toBe('fund');
    expect(statusFieldOf({ fields: [] })).toBeNull();
  });

  it('computes name keys case- and whitespace-insensitively', () => {
    expect(crmNameKey('  Acme   Widgets ')).toBe('acme widgets');
  });
});

describe('coercing CSV cells', () => {
  it('splits multi-value cells on semicolons only', () => {
    expect(coerceCrmValue('multi', 'AI; Fintech;AI')).toEqual(['AI', 'Fintech']);
    expect(coerceCrmValue('company', 'Acme, Inc.')).toEqual(['Acme, Inc.']);
    expect(coerceCrmValue('person', ' ')).toBeNull();
  });

  it('parses money and numbers, keeping an unparseable cell as text', () => {
    expect(coerceCrmValue('money', '$1,500,000.00')).toBe(1_500_000);
    expect(coerceCrmValue('money', 'USD 250000')).toBe(250_000);
    expect(coerceCrmValue('money', '$2.3M')).toBe(2_300_000);
    expect(coerceCrmValue('number', '12%')).toBe(12);
    expect(coerceCrmValue('number', 'about ten')).toBe('about ten');
  });

  it('normalizes dates: ISO kept, US dates converted, others as ISO date-times', () => {
    expect(coerceCrmValue('date', '2026-03-14')).toBe('2026-03-14');
    expect(coerceCrmValue('date', '3/4/2026')).toBe('2026-03-04');
    expect(coerceCrmValue('date', '2026-03-14T15:00:00Z')).toBe('2026-03-14T15:00:00.000Z');
    expect(coerceCrmValue('date', 'sometime')).toBe('sometime');
  });

  it('accepts already-typed values', () => {
    expect(normalizeCrmValue('money', 5000)).toBe(5000);
    expect(normalizeCrmValue('text', 5000)).toBe('5000');
    expect(normalizeCrmValue('multi', ['a', ' b ', ''])).toEqual(['a', 'b']);
    expect(normalizeCrmValue('status', ['Won'])).toBe('Won');
    expect(normalizeCrmValue('text', { nested: true })).toBeNull();
  });

  it('formats for display', () => {
    expect(displayCrmValue({ type: 'money' }, 1_500_000)).toBe('$1,500,000');
    expect(displayCrmValue({ type: 'multi' }, ['AI', 'Fintech'])).toBe('AI, Fintech');
    expect(displayCrmValue({ type: 'text' }, null)).toBe('');
  });
});

describe('validating UI writes', () => {
  const status: CrmField = { key: 'status', name: 'Status', type: 'status', options: ['Open'] };

  it('holds a status to its options and lets null clear it', () => {
    expect(validateCrmValue(status, 'Open')).toEqual({ ok: true, value: 'Open' });
    expect(validateCrmValue(status, 'Closed').ok).toBe(false);
    expect(validateCrmValue(status, null)).toEqual({ ok: true, value: null });
  });

  it('requires numbers to be numbers and dates to be dates', () => {
    const amount: CrmField = { key: 'amount', name: 'Amount', type: 'money' };
    expect(validateCrmValue(amount, '$10,000')).toEqual({ ok: true, value: 10_000 });
    expect(validateCrmValue(amount, 'lots').ok).toBe(false);
    const date: CrmField = { key: 'd', name: 'Date', type: 'date' };
    expect(validateCrmValue(date, 'not a date').ok).toBe(false);
  });
});

describe('JSON paths and array overlap in the shared filter', () => {
  const rows = [
    { id: 'a', values: { status: 'Open', amount: 900 }, tags: ['x'] },
    { id: 'b', values: { status: 'Won', amount: 10_000 }, tags: ['y', 'z'] },
    { id: 'c', values: {}, tags: [] },
  ];

  it('filters on a value as text, like ->>', () => {
    expect(rows.filter((r) => matchesFilter(r, { eq: { 'values->>status': 'Won' } }))).toHaveLength(
      1,
    );
    expect(
      rows.filter((r) => matchesFilter(r, { in: { 'values->>amount': ['900'] } })).map((r) => r.id),
    ).toEqual(['a']);
  });

  it('orders on a value as jsonb, so numbers sort numerically', () => {
    const sorted = applyOptions(rows, {
      orderBy: [{ field: 'values->amount', direction: 'desc' }],
    });
    expect(sorted.map((r) => r.id)).toEqual(['b', 'a', 'c']);
  });

  it('matches arrays sharing any element', () => {
    const hit = rows.filter((r) => matchesFilter(r, { arrayOverlaps: { tags: ['z', 'q'] } }));
    expect(hit.map((r) => r.id)).toEqual(['b']);
  });
});

describe('isMissingTableError', () => {
  it('recognises Postgres and PostgREST missing-table errors, by code or message', () => {
    expect(isMissingTableError({ code: '42P01', message: 'x' })).toBe(true);
    expect(isMissingTableError({ code: 'PGRST205', message: 'x' })).toBe(true);
    expect(
      isMissingTableError(
        new Error(
          "[crm_lists] list failed: Could not find the table 'public.crm_lists' in the schema cache",
        ),
      ),
    ).toBe(true);
    expect(isMissingTableError(new Error('relation "public.crm_notes" does not exist'))).toBe(true);
  });

  it('does not mistake a missing column or anything else for a missing table', () => {
    expect(
      isMissingTableError(new Error('column "fields" of relation "crm_lists" does not exist')),
    ).toBe(false);
    expect(isMissingTableError(new Error('fetch failed'))).toBe(false);
    expect(isMissingTableError(null)).toBe(false);
  });
});

describe('isMissingColumnError', () => {
  it('recognises a column an earlier copy of a migration did not have', () => {
    expect(isMissingColumnError({ code: 'PGRST204', message: 'x' })).toBe(true);
    expect(isMissingColumnError({ code: '42703', message: 'x' })).toBe(true);
    expect(
      isMissingColumnError(
        new Error(
          "[crm_list_entries] update failed: Could not find the 'imported_values' column of 'crm_list_entries' in the schema cache",
        ),
      ),
    ).toBe(true);
    expect(
      isMissingColumnError(
        new Error('column "imported_values" of relation "crm_list_entries" does not exist'),
      ),
    ).toBe(true);
  });

  it('is not a missing table, or anything else', () => {
    expect(isMissingColumnError({ code: 'PGRST205', message: 'x' })).toBe(false);
    expect(isMissingColumnError(new Error('relation "public.crm_notes" does not exist'))).toBe(
      false,
    );
    expect(isMissingColumnError(new Error('fetch failed'))).toBe(false);
    expect(isMissingColumnError(undefined)).toBe(false);
  });
});
