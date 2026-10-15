import JSZip from 'jszip';
import Papa from 'papaparse';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { CRM_TIME_IN_STATUS_KEY } from '@/lib/crm/saved-views';
import type { DataStore } from '@/lib/db/store';
import { demoCrmId, DEMO_IDS } from '@/lib/demo/ids';
import {
  addEntry,
  countEntriesByStatus,
  listBoard,
  listEntries,
  updateEntryValues,
  updateList,
  type CrmActor,
} from '@/lib/services/crm';
import {
  CRM_VIEWS_MIGRATION_FILE,
  deleteView,
  exportEverything,
  exportRecordNotesCsv,
  exportViewCsv,
  listSavedViews,
  saveView,
  summarizeEntries,
  timeInStatus,
} from '@/lib/services/crm-views';
import type { CrmListEntry } from '@/lib/types/domain';

/**
 * Saved views, totals, time in status and exports, through the real service
 * entry points against the demo store's invented fixtures (the Deal
 * Pipeline: eleven deals, nine with an amount, $5.9M in all).
 */

let harness: Harness;
let store: DataStore;
let org: string;
const actor: CrmActor = { userId: DEMO_IDS.user, name: 'Dana Whitcombe' };
const DEALS = DEMO_IDS.crmListDeals;
const ent = (n: number) => demoCrmId('entry', n);
const rec = (n: number) => demoCrmId('record', n);

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

function parseCsv(csv: string): string[][] {
  expect(csv.startsWith('﻿')).toBe(true);
  return Papa.parse<string[]>(csv.slice(1), { skipEmptyLines: true }).data;
}

describe('saved views', () => {
  it('start empty, save, persist on the list, rename, re-save and delete', async () => {
    expect(value(await listSavedViews(store, org, DEALS))).toEqual([]);

    const created = value(
      await saveView(
        store,
        org,
        DEALS,
        {
          name: 'Big checks',
          state: {
            view: 'table',
            columns: ['amount', 'status', 'nope'],
            sort: 'amount',
            dir: 'desc',
            statuses: [],
            conditions: [
              { key: 'amount', op: 'gte', value: '$1M' },
              { key: 'missing', op: 'empty' },
            ],
            groupBy: '',
          },
        },
        actor,
      ),
    );
    // Normalized on the server, whatever the page sent.
    expect(created.view).toMatchObject({
      name: 'Big checks',
      columns: ['amount', 'status'],
      conditions: [{ key: 'amount', op: 'gte', value: 1_000_000 }],
    });
    expect(created.view.id).toMatch(/^[a-z0-9]{16}$/);

    // Stored on the list row: a fresh read finds it.
    const stored = value(await listSavedViews(store, org, DEALS));
    expect(stored.map((v) => v.name)).toEqual(['Big checks']);

    const renamed = value(
      await saveView(store, org, DEALS, { id: created.view.id, name: 'Large rounds' }, actor),
    );
    expect(renamed.view.name).toBe('Large rounds');
    expect(renamed.view.conditions).toEqual(created.view.conditions);

    const resaved = value(
      await saveView(
        store,
        org,
        DEALS,
        { id: created.view.id, state: { view: 'board', groupBy: 'source_channel' } },
        actor,
      ),
    );
    expect(resaved.view).toMatchObject({
      name: 'Large rounds',
      view: 'board',
      groupBy: 'source_channel',
      conditions: [],
    });

    const audits = await store.list('audit_events', org, { eq: { action: 'crm.view_saved' } });
    expect(audits).toHaveLength(3);
    // Keys and counts, never values.
    expect(JSON.stringify(audits.map((a) => a.metadata))).not.toContain('1000000');

    value(await deleteView(store, org, DEALS, created.view.id, actor));
    expect(value(await listSavedViews(store, org, DEALS))).toEqual([]);
    const gone = await deleteView(store, org, DEALS, created.view.id, actor);
    expect(!gone.ok && gone.error.code).toBe('not_found');
  });

  it('keeps names unique per list and the All view built in', async () => {
    value(await saveView(store, org, DEALS, { name: 'Pipeline' }, actor));
    const duplicate = await saveView(store, org, DEALS, { name: '  pipeline ' }, actor);
    expect(!duplicate.ok && duplicate.error.code).toBe('conflict');
    const all = await saveView(store, org, DEALS, { name: 'All' }, actor);
    expect(!all.ok && all.error.code).toBe('invalid_input');
    const overAll = await saveView(store, org, DEALS, { id: 'all', state: {} }, actor);
    expect(!overAll.ok && overAll.error.code).toBe('invalid_input');
    const noName = await saveView(store, org, DEALS, { name: '   ' }, actor);
    expect(!noName.ok && noName.error.code).toBe('invalid_input');
    const missing = await saveView(store, org, DEALS, { id: 'doesnotexist01', name: 'X' }, actor);
    expect(!missing.ok && missing.error.code).toBe('not_found');
    // The same name on another list is fine.
    value(await saveView(store, org, DEMO_IDS.crmListLps, { name: 'Pipeline' }, actor));
  });

  it('says which migration to run when the views column does not exist yet', async () => {
    const original = store.update.bind(store);
    store.update = (async (
      table: string,
      o: string,
      id: string,
      patch: Record<string, unknown>,
    ) => {
      if (table === 'crm_lists' && 'views' in patch) {
        throw Object.assign(new Error("Could not find the 'views' column of 'crm_lists'"), {
          code: 'PGRST204',
        });
      }
      return original(table as never, o, id, patch as never);
    }) as DataStore['update'];
    const result = await saveView(store, org, DEALS, { name: 'Anything' }, actor);
    expect(!result.ok && result.error.code).toBe('not_configured');
    expect(!result.ok && result.error.message).toContain(CRM_VIEWS_MIGRATION_FILE);
    // Reads never needed the column.
    expect(value(await listSavedViews(store, org, DEALS))).toEqual([]);
  });
});

describe('views filter the list in the database', () => {
  it('narrows a page, the status chips and the board by conditions', async () => {
    const conditions = [{ key: 'amount', op: 'gte' as const, value: 750_000 }];
    const page = value(
      await listEntries(store, org, DEALS, { conditions, sortKey: 'amount', sortDir: 'desc' }),
    );
    expect(page.entries.map((e) => e.title)).toEqual([
      'Marrowgate Software',
      'Cobaltline',
      'Saltmarsh Labs',
      'Brindle Health',
    ]);
    expect(page.total).toBe(4);

    const counts = value(await countEntriesByStatus(store, org, DEALS, { conditions }));
    expect(counts.total).toBe(4);
    expect(counts.counts).toMatchObject({ '3. First Meeting': 2, '5. Diligence': 2, Passed: 0 });

    const board = value(await listBoard(store, org, DEALS, { conditions }));
    expect(board.columns.map((c) => [c.status, c.total])).toEqual([
      ['1. Sourced', 0],
      ['3. First Meeting', 2],
      ['5. Diligence', 2],
      ['10. Invested', 0],
      ['Passed', 0],
    ]);
  });

  it('groups a board by another status field, the chips then narrowing every column', async () => {
    const board = value(
      await listBoard(store, org, DEALS, { groupKey: 'source_channel', statusIn: ['Passed'] }),
    );
    expect(board.statusField.key).toBe('source_channel');
    expect(board.columns.map((c) => [c.status, c.total])).toEqual([
      ['Inbound', 1],
      ['Referral', 0],
      ['Scout', 0],
      ['Event', 1],
    ]);
  });
});

describe('totals', () => {
  it('sum every matching entry, overall and per board column', async () => {
    const all = value(await summarizeEntries(store, org, DEALS, { groupKey: 'status' }));
    expect(all.count).toBe(11);
    expect(all.sums.amount).toEqual({ sum: 5_900_000, count: 9 });
    expect(all.groups['5. Diligence']?.sums.amount).toEqual({ sum: 2_250_000, count: 2 });
    expect(all.groups['1. Sourced']).toEqual({
      count: 3,
      sums: { amount: { sum: 150_000, count: 1 } },
    });
    expect(all.complete).toBe(true);

    const filtered = value(
      await summarizeEntries(store, org, DEALS, {
        statusIn: ['3. First Meeting', 'Passed'],
        conditions: [{ key: 'owners', op: 'contains', value: 'morgan' }],
      }),
    );
    // Brindle (750k), Saltmarsh (900k) and Gullwing (500k) are Morgan's.
    expect(filtered.count).toBe(3);
    expect(filtered.sums.amount).toEqual({ sum: 2_150_000, count: 3 });
    expect(filtered.groups).toEqual({});
  });

  it('never add up the amounts on an LP list (stages only)', async () => {
    const lps = value(
      await summarizeEntries(store, org, DEMO_IDS.crmListLps, { groupKey: 'status' }),
    );
    expect(lps.count).toBe(5);
    expect(lps.sums).toEqual({});
    for (const group of Object.values(lps.groups)) expect(group.sums).toEqual({});
  });

  it('count a list with nothing to sum without reading it', async () => {
    const lps = value(await summarizeEntries(store, org, DEMO_IDS.crmListPortfolio));
    expect(lps.count).toBe(4);
    await updateList(store, org, DEMO_IDS.crmListPortfolio, {
      fields: [{ key: 'stage', name: 'Stage', type: 'status', options: ['Seed'] }],
    });
    const none = value(await summarizeEntries(store, org, DEMO_IDS.crmListPortfolio));
    expect(none).toMatchObject({ count: 4, sums: {} });
  });
});

/** A list longer than one page of the store (1,000 rows), to prove exports and totals read them all. */
async function bigList(rows: number): Promise<string> {
  const list = await store.insert('crm_lists', {
    id: '00000000-0000-4000-8000-00000000b16b',
    organization_id: org,
    source: 'copilot',
    external_id: null,
    name: 'Scout Pipeline',
    entity_type: 'deal',
    fields: [
      { key: 'status', name: 'Status', type: 'status', options: ['Open', 'Closed'] },
      { key: 'amount', name: 'Amount', type: 'money' },
      { key: 'notes', name: 'Notes', type: 'text' },
    ],
    position: 9,
    archived: false,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
  });
  const entries: CrmListEntry[] = Array.from({ length: rows }, (_, i) => ({
    id: `00000000-0000-4000-9000-${String(i).padStart(12, '0')}`,
    organization_id: org,
    list_id: list.id,
    record_id: null,
    title: i === 0 ? '=cmd|"/c calc"!A1, "quoted"' : `Deal ${String(i).padStart(4, '0')}`,
    external_id: `row-${i}`,
    values: {
      status: i % 2 ? 'Open' : 'Closed',
      amount: 1000,
      ...(i === 1 ? { notes: 'Line one\nline two' } : {}),
    },
    imported_values: null,
    position: i,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
  }));
  await store.insertMany('crm_list_entries', entries);
  return list.id;
}

describe('exports', () => {
  it('export the view on screen: every page, its columns, its filters, safely escaped', async () => {
    const listId = await bigList(1_250);
    const totals = value(await summarizeEntries(store, org, listId, { statusIn: ['Open'] }));
    expect(totals).toMatchObject({ count: 625, sums: { amount: { sum: 625_000, count: 625 } } });

    const all = value(
      await exportViewCsv(
        store,
        org,
        listId,
        { columns: ['notes', 'amount'], sortKey: 'title' },
        actor,
      ),
    );
    expect(all.rows).toBe(1_250);
    expect(all.filename).toBe('Scout-Pipeline.csv');
    const rows = parseCsv(all.csv);
    expect(rows[0]).toEqual(['Name', 'Notes', 'Amount']);
    expect(rows).toHaveLength(1_251);
    // Sorted by name, the formula-looking title defused, the line break kept.
    expect(rows[1]?.[0]).toBe('\'=cmd|"/c calc"!A1, "quoted"');
    expect(rows[2]).toEqual(['Deal 0001', 'Line one\nline two', '1000']);
    expect(rows.at(-1)?.[0]).toBe('Deal 1249');

    const open = value(
      await exportViewCsv(
        store,
        org,
        listId,
        { statusIn: ['Open'], viewName: 'Open deals' },
        actor,
      ),
    );
    expect(open.rows).toBe(625);
    expect(open.filename).toBe('Scout-Pipeline-Open-deals.csv');
    // No columns chosen: every column, the time in status after the pipeline field.
    expect(parseCsv(open.csv)[0]).toEqual([
      'Name',
      'Status',
      'Time in Stage (days)',
      'Amount',
      'Notes',
    ]);

    const audits = await store.list('audit_events', org, { eq: { action: 'crm.exported' } });
    expect(audits.map((a) => a.metadata.rows)).toEqual(expect.arrayContaining([1_250, 625]));
  });

  it('export a company’s notes, from the record and from its entries', async () => {
    const hearthstone = rec(4);
    const result = value(await exportRecordNotesCsv(store, org, hearthstone, actor));
    const rows = parseCsv(result.csv);
    expect(rows[0]).toEqual([
      'Date',
      'Title',
      'Author',
      'Content',
      'Attached to',
      'Source',
      'Flagged',
    ]);
    expect(rows.length - 1).toBe(result.rows);
    expect(result.rows).toBeGreaterThan(0);
    expect(rows.some((r) => r[1] === 'Board update')).toBe(true);
    const missing = await exportRecordNotesCsv(store, org, '00000000-0000-4000-8000-00000000dead');
    expect(!missing.ok && missing.error.code).toBe('not_found');
  });

  it('export everything as a ZIP of CSVs', async () => {
    const result = value(await exportEverything(store, org, actor));
    expect(result.filename).toMatch(/^copilot-crm-export-\d{4}-\d{2}-\d{2}\.zip$/);
    expect(result.counts).toMatchObject({ lists: 3, entries: 20 });
    const zip = await JSZip.loadAsync(result.data);
    const names = Object.keys(zip.files).sort();
    expect(names).toEqual(
      expect.arrayContaining([
        'README.txt',
        'lists.csv',
        'notes.csv',
        'records.csv',
        'lists/01-Deal-Pipeline.csv',
        'lists/02-LP-Pipeline.csv',
        'lists/03-Portfolio.csv',
      ]),
    );
    const deals = parseCsv(await zip.file('lists/01-Deal-Pipeline.csv')!.async('string'));
    expect(deals[0]?.slice(0, 5)).toEqual(['Entry ID', 'Name', 'Record ID', 'Record', 'Status']);
    expect(deals).toHaveLength(12);
    const lists = parseCsv(await zip.file('lists.csv')!.async('string'));
    expect(lists.map((r) => r[1])).toEqual(['Name', 'Deal Pipeline', 'LP Pipeline', 'Portfolio']);
    const records = parseCsv(await zip.file('records.csv')!.async('string'));
    expect(records.length - 1).toBe(result.counts.records);
    const audit = await store.list('audit_events', org, { eq: { action: 'crm.exported' } });
    expect(audit.at(-1)?.metadata).toMatchObject({ scope: 'everything', lists: 3 });
  });
});

describe('time in current status', () => {
  it('comes from the latest status change, Affinity’s column, or when the entry was added', async () => {
    value(await updateEntryValues(store, org, ent(1), { status: '10. Invested' }, actor));
    // A change to another field is not a status change.
    value(await updateEntryValues(store, org, ent(3), { amount: 525_000 }, actor));
    const list = (await store.get('crm_lists', org, DEALS))!;
    await store.update('crm_lists', org, DEALS, {
      fields: [...list.fields, { key: 'tics', name: 'Time in Current Status', type: 'number' }],
    });
    const brindle = (await store.get('crm_list_entries', org, ent(0)))!;
    await store.update('crm_list_entries', org, ent(0), {
      values: { ...brindle.values, tics: 41 },
    });
    const added = value(
      await addEntry(
        store,
        org,
        DEALS,
        { title: 'Tern Analytics — Seed', values: { status: '1. Sourced' } },
        actor,
      ),
    );

    const fresh = (await store.get('crm_lists', org, DEALS))!;
    const entries = await Promise.all(
      [ent(0), ent(1), ent(3), added.id].map(
        async (id) => (await store.get('crm_list_entries', org, id))!,
      ),
    );
    const timers = await timeInStatus(store, org, fresh, entries);
    expect(timers[ent(1)]).toMatchObject({ source: 'copilot' });
    expect(Date.now() - Date.parse(timers[ent(1)]!.since!)).toBeLessThan(60_000);
    // Affinity's figure counts on from when it was taken (here, when the
    // entry arrived: the demo list has no import on record), not frozen.
    expect(timers[ent(0)]).toEqual({
      since: new Date(Date.parse(brindle.created_at) - 41 * 86_400_000).toISOString(),
      imported: '41',
      source: 'affinity',
      importedAt: brindle.created_at,
    });
    expect(timers[ent(3)]).toEqual({ since: null, imported: null, source: 'unknown' });
    expect(timers[added.id]).toMatchObject({ source: 'added', since: added.created_at });
  });

  it('counts Affinity’s figure on from the list’s latest import', async () => {
    const list = (await store.get('crm_lists', org, DEALS))!;
    await store.update('crm_lists', org, DEALS, {
      fields: [...list.fields, { key: 'tics', name: 'Time in Current Status', type: 'text' }],
    });
    const brindle = (await store.get('crm_list_entries', org, ent(0)))!;
    await store.update('crm_list_entries', org, ent(0), {
      values: { ...brindle.values, tics: '12 days' },
    });
    const gullwing = (await store.get('crm_list_entries', org, ent(2)))!;
    await store.update('crm_list_entries', org, ent(2), {
      values: { ...gullwing.values, tics: 'a while' },
    });
    const importedAt = new Date(Date.now() - 24 * 86_400_000).toISOString();
    await store.insert('audit_events', {
      id: '00000000-0000-4000-8000-0000000a0d17',
      organization_id: org,
      user_id: null,
      action: 'crm.imported',
      entity_type: 'crm_list',
      entity_id: DEALS,
      metadata: { kind: 'list' },
      ip_hash: null,
      created_at: importedAt,
    });
    const fresh = (await store.get('crm_lists', org, DEALS))!;
    const entries = await Promise.all(
      [ent(0), ent(2)].map(async (id) => (await store.get('crm_list_entries', org, id))!),
    );
    const timers = await timeInStatus(store, org, fresh, entries);
    // "12 days" at an import 24 days ago: about 36 days now, an estimate.
    expect(timers[ent(0)]).toMatchObject({ source: 'affinity', importedAt });
    expect(timers[ent(0)]!.since).toBe(
      new Date(Date.parse(importedAt) - 12 * 86_400_000).toISOString(),
    );
    // A figure that does not read as a duration is shown as written, uncounted.
    expect(timers[ent(2)]).toMatchObject({ since: null, imported: 'a while', source: 'affinity' });
  });

  it('reads a long list’s changes in one pass and shows them in the export', async () => {
    const listId = await bigList(400);
    const first = `00000000-0000-4000-9000-${'5'.padStart(12, '0')}`;
    value(await updateEntryValues(store, org, first, { status: 'Closed' }, actor));
    const csv = value(
      await exportViewCsv(
        store,
        org,
        listId,
        { columns: ['status', CRM_TIME_IN_STATUS_KEY], sortKey: 'title' },
        actor,
      ),
    );
    const rows = parseCsv(csv.csv);
    expect(rows[0]).toEqual(['Name', 'Status', 'Time in Stage (days)']);
    expect(rows.find((r) => r[0] === 'Deal 0005')).toEqual(['Deal 0005', 'Closed', '0']);
    expect(rows.find((r) => r[0] === 'Deal 0006')).toEqual(['Deal 0006', 'Closed', '']);
  });
});
