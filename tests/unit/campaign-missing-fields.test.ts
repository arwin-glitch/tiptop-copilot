import { describe, expect, it } from 'vitest';
import {
  MAX_MERGE_VALUE,
  cleanMergeValue,
  contactReplacements,
  fillMerge,
  mergeValuesProblem,
  missingByField,
  peopleMissingFields,
} from '@/lib/campaigns/missing-fields';
import { mergeFieldsUsed, missingMergeFields, renderSubject } from '@/lib/campaigns/template';
import { personCompanyOf } from '@/lib/crm/fields';

/**
 * The review's "who is missing a merge field" lists and filling them in:
 * the grouping must match the counts (and so the send), a fill only fills
 * what is empty, and a contact value is never replaced without being named.
 * Every person here is invented.
 */

const people = [
  // Everything on file.
  {
    id: 'r1',
    email: 'ines@fernhollow.example',
    merge: { name: 'Ines Varga', first_name: 'Ines', company: 'Fernhollow' },
  },
  // A name, no company.
  { id: 'r2', email: 'theo@mail.example', merge: { name: 'Theo Marsh' } },
  // Nothing at all: a pasted address.
  { id: 'r3', email: 'pat@quarry.example', merge: {} },
  // A "name" that is really the address reads as no name.
  { id: 'r4', email: 'kit@quarry.example', merge: { name: 'kit@quarry.example' } },
];

describe('who is missing what', () => {
  it('lists people lacking a used field, with every field they lack, in order', () => {
    const used = mergeFieldsUsed('Hi {{first_name|there}}', 'From {{company}}');
    const missing = peopleMissingFields(used, people);
    expect(missing.map((p) => p.id)).toEqual(['r2', 'r3', 'r4']);
    expect(missing[0]).toEqual({
      id: 'r2',
      email: 'theo@mail.example',
      name: 'Theo Marsh',
      lacks: ['company'],
      contact: null,
    });
    expect(missing[1]?.lacks).toEqual(['first_name', 'name', 'company']);
    // An address is never shown as the name.
    expect(missing[2]?.name).toBeNull();
  });

  it('leaves out people who lack only fields the email does not use', () => {
    const used = mergeFieldsUsed('Hi {{first_name}}');
    expect(peopleMissingFields(used, people).map((p) => p.id)).toEqual(['r3', 'r4']);
    expect(peopleMissingFields([], people)).toEqual([]);
  });

  it('groups match the counts the review shows, field by field', () => {
    const used = mergeFieldsUsed('{{first_name}} {{name}} {{company}}');
    const groups = missingByField(used, peopleMissingFields(used, people));
    for (const field of used) {
      const count = people.filter((p) => missingMergeFields([field], p.merge).length).length;
      const group = groups.find((g) => g.field === field);
      expect(group?.people.length ?? 0, field).toBe(count);
    }
    expect(groups.map((g) => [g.field, g.people.map((p) => p.id)])).toEqual([
      ['first_name', ['r3', 'r4']],
      ['name', ['r3', 'r4']],
      ['company', ['r2', 'r3', 'r4']],
    ]);
  });

  it('drops a field nobody lacks, so a line disappears once everyone is filled', () => {
    const used = mergeFieldsUsed('{{first_name}} {{company}}');
    const filled = people.map((p) => ({ ...p, merge: { ...p.merge, company: 'Acme Demo' } }));
    expect(missingByField(used, peopleMissingFields(used, filled)).map((g) => g.field)).toEqual([
      'first_name',
    ]);
  });
});

describe('typed values', () => {
  it('are one trimmed line without control characters, capped', () => {
    expect(cleanMergeValue('  Dana \n\t Reyes\u0000 ')).toBe('Dana Reyes');
    expect(cleanMergeValue(42)).toBe('');
    expect(cleanMergeValue(undefined)).toBe('');
    expect(cleanMergeValue('x'.repeat(500))).toHaveLength(MAX_MERGE_VALUE);
  });

  it('must have something in them, and a name is never an address', () => {
    expect(mergeValuesProblem({})).toBe('Type at least one value to save.');
    expect(mergeValuesProblem({ first_name: '   ' })).toBe('Type at least one value to save.');
    expect(mergeValuesProblem({ name: 'dana@quarry.example' })).toBe(
      'A name cannot be an email address.',
    );
    expect(mergeValuesProblem({ company: 'Quarry @ Home' })).toBeNull();
    expect(mergeValuesProblem({ first_name: 'Dana' })).toBeNull();
  });
});

describe('filling in', () => {
  it('fills only what is empty, and keeps the rest of the merge', () => {
    const stored = { name: 'Theo Marsh' };
    const out = fillMerge(stored, stored, {
      first_name: 'Teddy',
      name: 'Theodore Marsh',
      company: '  Lindenfold  ',
    });
    // Theo already has a first name (from his name) and a name: only the company is new.
    expect(out).toEqual({
      merge: { name: 'Theo Marsh', company: 'Lindenfold' },
      filled: ['company'],
    });
    expect(stored).toEqual({ name: 'Theo Marsh' });
  });

  it('a full name fills the first name too, for this campaign’s emails', () => {
    const out = fillMerge({}, {}, { name: 'Pat Quill' });
    expect(out).toEqual({ merge: { name: 'Pat Quill' }, filled: ['name'] });
    expect(renderSubject('Hi {{first_name}}', out.merge)).toBe('Hi Pat');
    expect(missingMergeFields(['first_name', 'name'], out.merge)).toEqual([]);
  });

  it('replaces a name that was really an address', () => {
    const stored = { name: 'kit@quarry.example' };
    const out = fillMerge(stored, stored, { name: 'Kit Arden' });
    expect(out.merge).toEqual({ name: 'Kit Arden' });
    expect(out.filled).toEqual(['name']);
  });

  it('reads the row’s name as the email does: it counts as on file', () => {
    // The merge column lacks the name, but the recipient row has one.
    const out = fillMerge({}, { name: 'Ines Varga' }, { name: 'Someone Else', company: 'Fern' });
    expect(out).toEqual({ merge: { company: 'Fern' }, filled: ['company'] });
  });

  it('fills nothing when everything typed is already there', () => {
    const merge = { name: 'Ines Varga', company: 'Fernhollow' };
    expect(fillMerge(merge, merge, { company: 'Other' })).toEqual({ merge, filled: [] });
  });
});

describe('the CRM contact', () => {
  it('names each value a save would replace, and only those', () => {
    const contact = { name: 'Theo Marsh', company: 'Old Co' };
    expect(contactReplacements(contact, { name: 'Theo Marsh', company: 'New Co' })).toEqual([
      { field: 'company', from: 'Old Co' },
    ]);
    // Empty on the contact: filled, nothing replaced.
    expect(
      contactReplacements({ name: null, company: null }, { name: 'A B', company: 'C' }),
    ).toEqual([]);
    // A first name never goes to the contact.
    expect(contactReplacements(contact, { first_name: 'Ted' })).toEqual([]);
    expect(contactReplacements(null, { company: 'New Co' })).toEqual([]);
  });

  it('finds a person’s company where exports keep it, first value of a list', () => {
    expect(personCompanyOf({ 'Job Title': 'CEO' })).toBeNull();
    expect(personCompanyOf({ Organizations: ['', ' Brightwell ', 'Second'] })).toEqual({
      key: 'Organizations',
      value: 'Brightwell',
    });
    expect(personCompanyOf({ Company: 'Fernhollow', Organization: '  ' })).toEqual({
      key: 'Company',
      value: 'Fernhollow',
    });
    expect(personCompanyOf(null)).toBeNull();
  });
});
