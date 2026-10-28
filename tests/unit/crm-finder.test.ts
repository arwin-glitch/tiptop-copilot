import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import {
  contactedWithin,
  describeFinder,
  finderHref,
  finderIsNarrowed,
  lastContactOf,
  normalizeFinderCriteria,
  parseFinderParams,
  placeMatches,
  placeSearchTerm,
  recordLocation,
  type CrmFinderCriteria,
} from '@/lib/crm/finder';
import type { DataStore } from '@/lib/db/store';
import { demoCrmId, DEMO_IDS } from '@/lib/demo/ids';
import { createList, createRecord, addRecordsToList } from '@/lib/services/crm';
import { findCrmRecords } from '@/lib/services/crm-finder';

/**
 * Knowledge → Find & save: "people in Austin I talked to in the last three
 * years". The rules in lib/crm/finder.ts, then the search against the demo
 * store, whose people 37–39 carry a place and an Affinity last contact (all
 * invented).
 */

const NOW = new Date('2026-10-21T12:00:00Z');

describe('what the finder reads', () => {
  it('round-trips its criteria through the URL, dropping what it cannot use', () => {
    const criteria: CrmFinderCriteria = {
      kind: 'company',
      q: 'robot',
      place: 'Austin, TX',
      years: 3,
      listId: DEMO_IDS.crmListPortfolio,
    };
    const href = finderHref(criteria);
    expect(href.startsWith('/knowledge?tab=find')).toBe(true);
    const params = Object.fromEntries(new URL(href, 'https://app.example').searchParams);
    expect(parseFinderParams(params)).toEqual(criteria);
    expect(finderHref({ kind: 'person' })).toBe('/knowledge?tab=find');
    expect(
      normalizeFinderCriteria({ kind: 'robot', q: '  a   b ', years: '99', listId: 'not-an-id' }),
    ).toEqual({ kind: 'person', q: 'a b', place: '', years: null, listId: null });
  });

  it('needs a name, a place or a list before it searches', () => {
    const base = normalizeFinderCriteria({ years: 3 });
    expect(finderIsNarrowed(base)).toBe(false);
    expect(finderIsNarrowed({ ...base, place: 'Austin' })).toBe(true);
    expect(describeFinder({ ...base, place: 'Austin' })).toBe(
      'People in Austin, in touch within 3 years',
    );
    expect(describeFinder({ ...base, kind: 'company', q: 'labs', years: 1 }, 'Watch')).toBe(
      'Companies matching “labs”, on Watch, in touch within 1 year',
    );
  });

  it('finds where a record is under the labels exports use, and matches a place loosely', () => {
    expect(recordLocation({ Industry: ['AI'], Location: 'Austin, Texas, United States' })).toBe(
      'Austin, Texas, United States',
    );
    expect(recordLocation({ 'HQ Location': ['Denver, CO'] })).toBe('Denver, CO');
    expect(recordLocation({ 'Job Title': 'CEO' })).toBeNull();
    expect(placeMatches('Austin, Texas, United States', 'austin')).toBe(true);
    expect(placeMatches('Austin, TX', 'Austin, TX')).toBe(true);
    expect(placeMatches('Austin, Texas', 'Austin, TX')).toBe(false);
    expect(placeMatches(null, 'Austin')).toBe(false);
    expect(placeSearchTerm('Austin, TX')).toBe('Austin');
  });

  it('takes the later of Kraken’s and Affinity’s last contact, and counts years from now', () => {
    const affinity = lastContactOf({
      recordFields: { 'Last Email': '2025-01-05', 'Last Contact': '2024-06-01' },
      entries: [
        {
          fields: [{ key: 'last_meeting', name: 'Last Meeting' }],
          values: { last_meeting: '2025-03-01' },
        },
      ],
    });
    // The latest of Affinity's dates, wherever it sits: here a list's last meeting.
    expect(affinity).toEqual({ at: '2025-03-01', source: 'affinity' });
    const ours = lastContactOf({
      recordFields: { 'Last Contact': '2024-06-01' },
      copilotAt: '2026-09-30T15:00:00.000Z',
    });
    expect(ours).toEqual({ at: '2026-09-30T15:00:00.000Z', source: 'copilot' });
    expect(lastContactOf({ recordFields: { 'Last Contact': 'sometime' } })).toBeNull();

    expect(contactedWithin({ at: '2023-11-01', source: 'affinity' }, 3, NOW)).toBe(true);
    expect(contactedWithin({ at: '2023-10-01', source: 'affinity' }, 3, NOW)).toBe(false);
    expect(contactedWithin(null, 3, NOW)).toBe(false);
  });
});

describe('finding people and companies', () => {
  let harness: Harness;
  let store: DataStore;
  let org: string;

  beforeEach(async () => {
    harness = await createHarness({ now: NOW });
    store = harness.store;
    org = harness.auth.organizationId;
  });

  afterEach(async () => {
    await harness.dispose();
  });

  const find = async (criteria: Partial<CrmFinderCriteria>) => {
    const result = await findCrmRecords(
      store,
      org,
      normalizeFinderCriteria({ kind: 'person', ...criteria }),
      { now: NOW },
    );
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  };

  it('finds the people in a place, newest contact first', async () => {
    const found = await find({ place: 'Austin' });
    expect(found.rows.map((r) => r.name)).toEqual(['Wren Calloway', 'Jonah Pelletier']);
    expect(found.rows[0]).toMatchObject({
      location: 'Austin, Texas, United States',
      lastContact: { source: 'affinity' },
    });
    expect(found).toMatchObject({ total: 2, truncated: false, mail: 'unused' });
    expect(found.ids).toEqual([demoCrmId('record', 37), demoCrmId('record', 38)]);
  });

  it('narrows to those in touch within the years asked', async () => {
    const found = await find({ place: 'austin', years: 3 });
    expect(found.rows.map((r) => r.name)).toEqual(['Wren Calloway']);
    expect(found.total).toBe(1);
  });

  it('finds companies by place, and anyone by part of a name or email', async () => {
    const companies = await find({ kind: 'company', place: 'Austin, TX' });
    expect(companies.rows.map((r) => r.name).sort()).toEqual([
      'Brindle Health',
      'Hearthstone Payroll',
    ]);
    const byEmail = await find({ q: 'fernway' });
    expect(byEmail.rows.map((r) => r.name)).toEqual(['Ines Marquardt']);
    const both = await find({ q: 'wren', place: 'Denver' });
    expect(both.total).toBe(0);
  });

  it('searches one list’s members, with that list’s own last-contact column', async () => {
    const found = await find({ listId: DEMO_IDS.crmListLps });
    expect(found.list).toMatchObject({ id: DEMO_IDS.crmListLps, name: 'LP Pipeline' });
    expect(found.total).toBeGreaterThan(0);
    // The LP Pipeline's "Last Contact" column counts as Affinity's date.
    expect(found.rows.some((r) => r.lastContact?.source === 'affinity')).toBe(true);
    const missing = await findCrmRecords(
      store,
      org,
      normalizeFinderCriteria({ listId: '00000000-0000-4000-8000-00000000dead' }),
    );
    expect(!missing.ok && missing.error.code).toBe('not_found');
  });

  it('asks for something to narrow by rather than reading the whole CRM', async () => {
    const found = await find({ years: 3 });
    expect(found).toMatchObject({ needsNarrowing: true, total: 0, scanned: 0 });
  });

  it('finds people made in Kraken, and saved as a list they are ready for a campaign', async () => {
    value(
      await createRecord(store, org, {
        kind: 'person',
        name: 'Tess Okafor',
        email: 'tess@okafor.example',
        location: 'Austin, TX',
      }),
    );
    const found = await find({ place: 'Austin' });
    expect(found.rows.map((r) => r.name)).toContain('Tess Okafor');
    const list = value(
      await createList(store, org, { name: 'Austin people', entityType: 'person' }),
    );
    const added = value(await addRecordsToList(store, org, list.id, found.ids));
    expect(added.added).toBe(found.total);
  });
});

function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.value;
}
