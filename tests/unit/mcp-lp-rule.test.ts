import { describe, expect, it } from 'vitest';
import {
  fieldAllowed,
  isAmountLabel,
  isLpList,
  maskAmounts,
  visibleFields,
  visibleValues,
} from '@/lib/crm/lp-rule';
import type { CrmField } from '@/lib/types/domain';

/** The Fund II rule as the MCP server applies it: LP stages, never LP amounts. */

const LP_FIELDS: CrmField[] = [
  { key: 'status', name: 'Status', type: 'status', options: ['Prospect', 'Committed'] },
  { key: 'commitment', name: 'Commitment', type: 'money' },
  { key: 'target_check', name: 'Target Check', type: 'number' },
  { key: 'organization', name: 'Organization', type: 'company' },
  { key: 'last_contact', name: 'Last Contact', type: 'date' },
];

describe('which lists are LP lists', () => {
  it.each(['LP Pipeline', 'Fund II LPs', 'Limited Partners', 'Fund II', 'Prospective investors'])(
    '%s is one',
    (name) => expect(isLpList({ name })).toBe(true),
  );

  it.each(['Deal Pipeline', 'Portfolio', 'Help wanted', 'Helpers'])('%s is not', (name) =>
    expect(isLpList({ name })).toBe(false),
  );
});

describe('fields and values on an LP list', () => {
  const lpList = { name: 'LP Pipeline', fields: LP_FIELDS };
  const dealList = { name: 'Deal Pipeline', fields: LP_FIELDS };

  it('drops money fields and amount-like fields, keeps the stage', () => {
    expect(visibleFields(lpList).map((f) => f.key)).toEqual([
      'status',
      'organization',
      'last_contact',
    ]);
    expect(fieldAllowed(lpList, LP_FIELDS[1] as CrmField)).toBe(false);
  });

  it('keeps every field on a list that is not an LP list', () => {
    expect(visibleFields(dealList)).toHaveLength(LP_FIELDS.length);
  });

  it('removes the hidden values, and any key no field names', () => {
    expect(
      visibleValues(lpList, {
        status: 'Committed',
        commitment: 2_000_000,
        target_check: 500_000,
        organization: ['Oakhaven Capital'],
        stray: 'x',
      }),
    ).toEqual({ status: 'Committed', organization: ['Oakhaven Capital'] });
  });

  it('recognises amount labels in free-form record columns', () => {
    expect(isAmountLabel('Commitment Amount')).toBe(true);
    expect(isAmountLabel('Job Title')).toBe(false);
  });
});

describe('masking amounts in LP free text', () => {
  it.each([
    ['Soft circle at $2M.', 'Soft circle at [amount].'],
    ['Wants $ 250,000 allocation', 'Wants [amount] allocation'],
    ['Re-up of 1.5 million confirmed', 'Re-up of [amount] confirmed'],
    ['Likely 500k this close', 'Likely [amount] this close'],
    ['Wire 100,000 USD by Friday', 'Wire [amount] by Friday'],
    ['US$3.25 bn fund of funds', '[amount] fund of funds'],
  ])('%s', (input, expected) => expect(maskAmounts(input)).toBe(expected));

  it('leaves dates, counts and months alone', () => {
    const text = 'Meeting on 2026-10-12; 3 partners; follow up in 6m; 14 clinics';
    expect(maskAmounts(text)).toBe(text);
  });
});
