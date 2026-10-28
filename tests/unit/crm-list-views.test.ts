import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import type { DataStore } from '@/lib/db/store';
import { demoCrmId, DEMO_IDS } from '@/lib/demo/ids';
import {
  addNote,
  countEntriesByStatus,
  findCopilotLinks,
  getEntry,
  isCrmNotSetUp,
  listActivity,
  listBoard,
  listCrmLists,
  listEntries,
  updateEntryValues,
  type CrmActor,
} from '@/lib/services/crm';
import { searchEverything } from '@/lib/services/search';

/**
 * The reads behind the Lists pages — status counts, the board, an entry's
 * side panel, list activity, a profile's links into Deals and Portfolio — and
 * the Ctrl+K "Lists" group, against the demo store's invented fixtures
 * (demoCrm in lib/demo/fixtures.ts).
 */

let harness: Harness;
let store: DataStore;
let org: string;
const actor: CrmActor = { userId: DEMO_IDS.user, name: 'Dana Whitcombe' };

const rec = (n: number) => demoCrmId('record', n);
const ent = (n: number) => demoCrmId('entry', n);
const COBALTLINE = rec(1);
const LEDGERLY = rec(28);

beforeEach(async () => {
  harness = await createHarness();
  store = harness.store;
  org = harness.auth.organizationId;
});

afterEach(async () => {
  await harness.dispose();
});

function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.value;
}

describe('status counts for the filter chips', () => {
  it('counts every option of the pipeline field, with the entries that have none', async () => {
    const counts = value(await countEntriesByStatus(store, org, DEMO_IDS.crmListDeals));
    expect(counts.field?.key).toBe('status');
    expect(counts.counts).toEqual({
      '1. Sourced': 3,
      '3. First Meeting': 3,
      '5. Diligence': 2,
      '10. Invested': 1,
      Passed: 2,
    });
    expect(counts).toMatchObject({ none: 0, other: 0, total: 11 });
  });

  it('agrees with the page search', async () => {
    const counts = value(
      await countEntriesByStatus(store, org, DEMO_IDS.crmListDeals, { query: 'hearth' }),
    );
    expect(counts.total).toBe(2);
    expect(counts.counts['10. Invested']).toBe(1);
    expect(counts.counts['1. Sourced']).toBe(1);
    expect(counts.counts['5. Diligence']).toBe(0);
  });

  it('counts a cleared status as none', async () => {
    value(await updateEntryValues(store, org, ent(2), { status: null }, actor));
    const counts = value(await countEntriesByStatus(store, org, DEMO_IDS.crmListDeals));
    expect(counts.none).toBe(1);
    expect(counts.counts['1. Sourced']).toBe(2);
  });

  it('says not_found for an unknown list', async () => {
    const missing = await countEntriesByStatus(store, org, '00000000-0000-4000-8000-00000000dead');
    expect(!missing.ok && missing.error.code).toBe('not_found');
  });
});

describe('the board', () => {
  it('lays a pipeline out as status columns in stage order, each capped with its true count', async () => {
    const board = value(await listBoard(store, org, DEMO_IDS.crmListDeals, { perColumn: 2 }));
    expect(board.columns.map((c) => [c.status, c.total, c.entries.length])).toEqual([
      ['1. Sourced', 3, 2],
      ['3. First Meeting', 3, 2],
      ['5. Diligence', 2, 2],
      ['10. Invested', 1, 1],
      ['Passed', 2, 2],
    ]);
    expect(board.unplaced).toBe(0);
    expect(board.statusField.key).toBe('status');
    // The records the cards point at come along, like a table page's.
    expect(board.records[COBALTLINE]).toMatchObject({ name: 'Cobaltline' });
  });

  it('adds a "no status" column only when an entry has none', async () => {
    value(await updateEntryValues(store, org, ent(6), { status: null }, actor));
    const board = value(await listBoard(store, org, DEMO_IDS.crmListDeals));
    const last = board.columns.at(-1);
    expect(last?.status).toBeNull();
    expect(last?.entries.map((e) => e.title)).toEqual(['Juniper Robotics']);
  });

  it('keeps only the chosen columns and applies the search and sort within them', async () => {
    const board = value(
      await listBoard(store, org, DEMO_IDS.crmListDeals, {
        statusIn: ['3. First Meeting', 'Passed'],
        sortKey: 'amount',
        sortDir: 'desc',
      }),
    );
    expect(board.columns.map((c) => c.status)).toEqual(['3. First Meeting', 'Passed']);
    expect(board.columns[0]?.entries.map((e) => e.title)).toEqual([
      'Saltmarsh Labs',
      'Brindle Health',
      'Inkwell Legal',
    ]);
    expect(board.sort).toEqual({ key: 'amount', dir: 'desc' });
  });

  it('refuses a list with no status field rather than drawing an empty board', async () => {
    const lists = value(await listCrmLists(store, org));
    const portfolio = lists.find((l) => l.id === DEMO_IDS.crmListPortfolio)!;
    // The portfolio list's pipeline is its Stage field.
    expect(value(await listBoard(store, org, portfolio.id)).statusField.key).toBe('stage');
    await store.update('crm_lists', org, portfolio.id, {
      fields: portfolio.fields.filter((f) => f.type !== 'status'),
    });
    const none = await listBoard(store, org, portfolio.id);
    expect(!none.ok && none.error.code).toBe('invalid_input');
  });
});

describe('one entry for the side panel', () => {
  it('brings the entry, its list, its record and the notes on either, newest first', async () => {
    const detail = value(await getEntry(store, org, ent(1)));
    expect(detail.entry.title).toBe('Cobaltline');
    expect(detail.list).toMatchObject({ id: DEMO_IDS.crmListDeals, name: 'Deal Pipeline' });
    expect(detail.record).toMatchObject({ id: COBALTLINE, kind: 'company' });
    expect(detail.notes.map((n) => n.title)).toEqual(['Diligence call', 'Customer reference']);
  });

  it('includes a note added to the entry alone', async () => {
    value(
      await addNote(
        store,
        org,
        { content: 'Term sheet questions sent.', entryIds: [ent(1)] },
        actor,
      ),
    );
    const detail = value(await getEntry(store, org, ent(1)));
    expect(detail.notes[0]).toMatchObject({ content: 'Term sheet questions sent.' });
    expect(detail.notes[0]?.author).toBe('Dana Whitcombe');
  });

  it('says not_found for an unknown or malformed id', async () => {
    for (const id of ['00000000-0000-4000-8000-00000000dead', 'nope']) {
      const missing = await getEntry(store, org, id);
      expect(!missing.ok && missing.error.code).toBe('not_found');
    }
  });
});

describe('list activity', () => {
  it('is the newest of the list row and its entries', async () => {
    const lists = value(await listCrmLists(store, org));
    const before = value(await listActivity(store, org, lists));
    const deals = lists.find((l) => l.id === DEMO_IDS.crmListDeals)!;
    expect(before[deals.id]! >= deals.updated_at).toBe(true);

    value(await updateEntryValues(store, org, ent(0), { status: '5. Diligence' }, actor));
    const after = value(await listActivity(store, org, lists));
    expect(after[deals.id]! > before[deals.id]!).toBe(true);
    // The other lists did not move.
    expect(after[DEMO_IDS.crmListLps]).toBe(before[DEMO_IDS.crmListLps]);
  });
});

describe('links into Kraken’s own Deals and Portfolio', () => {
  it('finds a portfolio company with the same domain', async () => {
    const record = (await store.get('crm_records', org, LEDGERLY))!;
    const links = value(await findCopilotLinks(store, org, record));
    expect(links).toEqual([
      expect.objectContaining({
        kind: 'portfolio',
        id: DEMO_IDS.pcLedgerly,
        name: 'Ledgerly',
        matchedBy: 'domain',
      }),
    ]);
  });

  it('falls back to the normalized name when no row shares the domain', async () => {
    const links = value(
      await findCopilotLinks(store, org, {
        kind: 'company',
        name: 'Ledgerly, Inc.',
        domain: 'ledgerly-elsewhere.example',
      }),
    );
    expect(links.map((l) => [l.kind, l.name, l.matchedBy])).toEqual([
      ['portfolio', 'Ledgerly', 'name'],
    ]);
  });

  it('finds a deal by domain, and nothing for a person or a stranger', async () => {
    const deals = await store.list('deals', org, { notNull: ['domain'] }, { limit: 1 });
    const deal = deals[0]!;
    const links = value(
      await findCopilotLinks(store, org, {
        kind: 'company',
        name: 'Anything',
        domain: deal.domain,
      }),
    );
    expect(links).toContainEqual(
      expect.objectContaining({ kind: 'deal', id: deal.id, matchedBy: 'domain' }),
    );
    expect(
      value(await findCopilotLinks(store, org, { kind: 'person', name: 'Ledgerly', domain: null })),
    ).toEqual([]);
    expect(
      value(
        await findCopilotLinks(store, org, {
          kind: 'company',
          name: 'Nobody Anywhere',
          domain: 'nobody.example',
        }),
      ),
    ).toEqual([]);
  });
});

describe('Ctrl+K search', () => {
  it('returns CRM lists and records, last, linking to list pages and profiles', async () => {
    const results = await searchEverything(store, org, 'cobalt');
    const company = results.find((r) => r.kind === 'crm_company');
    expect(company).toMatchObject({
      label: 'Cobaltline',
      sub: 'cobaltline.example',
      href: `/lists/records/${COBALTLINE}`,
    });
    const lists = await searchEverything(store, org, 'pipeline');
    expect(lists.filter((r) => r.kind === 'crm_list').map((r) => [r.label, r.href])).toEqual([
      ['Deal Pipeline', `/lists/${DEMO_IDS.crmListDeals}`],
      ['LP Pipeline', `/lists/${DEMO_IDS.crmListLps}`],
      ['Family Office LP Pipeline', `/lists/${DEMO_IDS.crmListHnwi}`],
    ]);
    // The palette draws the CRM's results as one group at the end.
    const firstCrm = results.findIndex((r) => r.kind.startsWith('crm_'));
    expect(results.slice(firstCrm).every((r) => r.kind.startsWith('crm_'))).toBe(true);
  });

  it('finds a person by email', async () => {
    const results = await searchEverything(store, org, 'maren@oakhaven');
    expect(results).toContainEqual(
      expect.objectContaining({ kind: 'crm_person', label: 'Maren Solberg' }),
    );
  });
});

/** The demo store, with every CRM table missing — production before the migration. */
function storeWithoutCrmTables(inner: DataStore): DataStore {
  const failure = () =>
    Object.assign(
      new Error(
        "[crm_lists] list failed: Could not find the table 'public.crm_lists' in the schema cache",
      ),
      { code: 'PGRST205' },
    );
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const original = Reflect.get(target, prop, receiver);
      if (typeof original !== 'function') return original;
      return (...args: unknown[]) => {
        if (typeof args[0] === 'string' && args[0].startsWith('crm_')) {
          return Promise.reject(failure());
        }
        return original.apply(target, args);
      };
    },
  });
}

describe('before the migration has been applied', () => {
  it('every list-page read degrades to "not set up yet"', async () => {
    const missing = storeWithoutCrmTables(store);
    const reads = [
      await countEntriesByStatus(missing, org, DEMO_IDS.crmListDeals),
      await listBoard(missing, org, DEMO_IDS.crmListDeals),
      await getEntry(missing, org, ent(1)),
      await listActivity(missing, org, [{ id: DEMO_IDS.crmListDeals, updated_at: '' }]),
    ];
    for (const result of reads) {
      expect(isCrmNotSetUp(result)).toBe(true);
      expect(!result.ok && result.error.message).toMatch(/not set up yet/);
    }
    // A table page still reads the same way it always did.
    expect(isCrmNotSetUp(await listEntries(missing, org, DEMO_IDS.crmListDeals))).toBe(true);
  });

  it('search leaves the CRM out instead of failing', async () => {
    const missing = storeWithoutCrmTables(store);
    const results = await searchEverything(missing, org, 'cobalt');
    expect(results.some((r) => r.kind.startsWith('crm_'))).toBe(false);
  });

  it('profile links do not depend on the CRM tables', async () => {
    const missing = storeWithoutCrmTables(store);
    const links = value(
      await findCopilotLinks(missing, org, {
        kind: 'company',
        name: 'Ledgerly',
        domain: 'ledgerly.demo',
      }),
    );
    expect(links).toHaveLength(1);
  });
});
