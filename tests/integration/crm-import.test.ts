import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createHarness, type Harness } from '../helpers/harness';
import type { AuthContext } from '@/lib/auth/session';
import {
  addCounts,
  buildListImport,
  buildNotesImport,
  detectAffinityMapping,
  NO_COUNTS,
  parseAffinityCsv,
  suggestTargetList,
  type AffinityCounts,
  type AffinityListMapping,
  type AffinityListImportResult,
  type AffinityNotesImportResult,
} from '@/lib/crm/affinity-csv';
import type { DataStore } from '@/lib/db/store';
import { setStoreForTesting } from '@/lib/runtime';
import { CRM_TABLES, updateEntryValues, upsertList, upsertRecords } from '@/lib/services/crm';
import { importAffinityList, importAffinityNotes } from '@/lib/services/crm-import';
import type { CrmList, CrmListEntry, CrmNote, CrmRecord } from '@/lib/types/domain';
import { err, ok, type Result } from '@/lib/util/result';

/**
 * The Affinity import end to end, from CSV text through the parser, the
 * import service and the route, against the demo store. Every company,
 * person, address and amount here is invented, on .example domains.
 */

let harness: Harness;
let store: DataStore;
let org: string;
let signedIn: () => Result<AuthContext> = () => ok(harness.auth);

vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  authOrError: async () => signedIn(),
}));

const { POST } = await import('@/app/api/crm/import/route');

beforeEach(async () => {
  harness = await createHarness();
  store = harness.store;
  org = harness.auth.organizationId;
  signedIn = () => ok(harness.auth);
});

afterEach(async () => {
  await harness.dispose();
});

const DEALS = `Affinity Row ID,Opportunity ID,Opportunity Name,Organizations,Status,Amount,Owners,Date Added,Close Date,Fund
9001,7001,Lumenfold Seed,Lumenfold Labs,3. First Meeting,"$1,500,000",Avery Quill; Rowan Pike,10/01/2026,2026-11-30,Fund II
9002,7002,Quarrystone Pre-Seed,Quarrystone,5. Due Diligence,$750K,Avery Quill,10/03/2026,,Fund II
9003,7003,Lumenfold Series A,Lumenfold Labs,8.2 Passed - Too Early,2000000,Rowan Pike,09/12/2026,,Fund I
9004,7004,Tidewell Seed,Tidewell,10. Won / Signed,"$500,000",Avery Quill,08/20/2026,2026-09-15,Fund II
9005,7005,Brackenridge Seed,Brackenridge Energy,3. First Meeting,,Rowan Pike,10/10/2026,,Fund II
`;

const ORGS = `Organization ID,Organization Name,Website,Industry
3101,Harborlight Analytics,https://www.harborlight.example/about,AI; Data
3102,"Fernhollow, Inc.",fernhollow.example,Fintech
3103,Gildcrest Robotics,linkedin.com/company/gildcrest-robotics,Robotics
`;

const PEOPLE = `Person ID,Full Name,Primary Email,Email Addresses,Status
5201,Juniper Okafor,juniper@ashgrove-capital.example,juniper@ashgrove-capital.example; j.okafor@mail.example,Committed
5202,Theo Marchetti,,theo@marchetti-fo.example,Interested
`;

const NOTES = `Entity Name,Creator,Date Created,Note Content,Associated Organizations,Associated People
Lumenfold Seed,Avery Quill,2026-10-02 14:05:00,"First call with the founders.
- Strong technical team",Lumenfold Labs,Juniper Okafor
Harborlight Analytics,Rowan Pike,10/05/2026,Quick intro; follow up in Q1.,,
Nobody Known,Rowan Pike,10/06/2026,A note about someone not on any list.,,
`;

interface ListTotals {
  list: AffinityListImportResult['list'] | null;
  records: AffinityCounts;
  entries: AffinityCounts;
  keptEdits: number;
  problems: { row: number; message: string }[];
}

/**
 * Parse, map and import a list export the way the page does, chunk by chunk.
 * `into` is the existing list chosen on the page, if one is.
 */
async function importListCsv(
  filename: string,
  text: string,
  rowsPerChunk?: number,
  into?: CrmList,
) {
  const csv = parseAffinityCsv(text);
  let mapping = detectAffinityMapping(filename, csv);
  if (mapping.kind !== 'list') throw new Error('expected a list export');
  if (into) mapping = { ...mapping, targetListId: into.id, listName: into.name };
  const plan = buildListImport(mapping, csv, { rowsPerChunk });
  const totals: ListTotals = {
    list: null,
    records: NO_COUNTS,
    entries: NO_COUNTS,
    keptEdits: 0,
    problems: [],
  };
  for (const request of plan.requests) {
    const result = await importAffinityList(store, org, request);
    if (!result.ok) throw new Error(result.error.message);
    totals.list ??= result.value.list;
    totals.records = addCounts(totals.records, result.value.records);
    totals.entries = addCounts(totals.entries, result.value.entries);
    totals.keptEdits += result.value.keptEdits;
    totals.problems.push(...result.value.problems);
  }
  return totals;
}

async function importNotesCsv(text: string) {
  const csv = parseAffinityCsv(text);
  const mapping = detectAffinityMapping('notes.csv', csv);
  if (mapping.kind !== 'notes') throw new Error('expected a notes export');
  const results: AffinityNotesImportResult[] = [];
  for (const request of buildNotesImport(mapping, csv).requests) {
    const result = await importAffinityNotes(store, org, request);
    if (!result.ok) throw new Error(result.error.message);
    results.push(result.value);
  }
  return results;
}

async function listNamed(name: string): Promise<CrmList> {
  const lists = (await store.list('crm_lists', org, {})) as CrmList[];
  const list = lists.find((l) => l.name === name);
  if (!list) throw new Error(`no list ${name}`);
  return list;
}

async function entriesOf(listId: string): Promise<CrmListEntry[]> {
  return (await store.list(
    'crm_list_entries',
    org,
    { eq: { list_id: listId } },
    { orderBy: [{ field: 'position', direction: 'asc' }] },
  )) as CrmListEntry[];
}

async function recordNamed(name: string): Promise<CrmRecord> {
  const rows = (await store.list('crm_records', org, {})) as CrmRecord[];
  const found = rows.filter((r) => r.name === name);
  if (found.length !== 1) throw new Error(`expected one record named ${name}, got ${found.length}`);
  return found[0] as CrmRecord;
}

async function snapshot() {
  const out: Record<string, unknown[]> = {};
  for (const table of CRM_TABLES) {
    out[table] = await store.list(table, org, {}, { orderBy: [{ field: 'id', direction: 'asc' }] });
  }
  return out;
}

describe('importing a list export', () => {
  it('creates the list with its fields, the deals, and one company per name', async () => {
    const totals = await importListCsv('Startup Deal Pipeline - All deals.csv', DEALS);
    expect(totals.list).toMatchObject({ name: 'Startup Deal Pipeline', created: true });
    expect(totals.entries).toMatchObject({ inserted: 5, errors: 0, skipped: 0 });
    expect(totals.records).toMatchObject({ inserted: 4 });
    expect(totals.problems).toEqual([]);

    const list = await listNamed('Startup Deal Pipeline');
    expect(list.entity_type).toBe('deal');
    expect(list.source).toBe('affinity');
    expect(list.fields[0]).toEqual({
      key: 'status',
      name: 'Status',
      type: 'status',
      options: [
        '3. First Meeting',
        '5. Due Diligence',
        '8.2 Passed - Too Early',
        '10. Won / Signed',
      ],
    });

    const entries = await entriesOf(list.id);
    expect(entries.map((e) => [e.external_id, e.title])).toEqual([
      ['9001', 'Lumenfold Seed'],
      ['9002', 'Quarrystone Pre-Seed'],
      ['9003', 'Lumenfold Series A'],
      ['9004', 'Tidewell Seed'],
      ['9005', 'Brackenridge Seed'],
    ]);
    const [seed, preSeed, seriesA] = entries as [CrmListEntry, CrmListEntry, CrmListEntry];
    expect(seed.values).toEqual({
      status: '3. First Meeting',
      organizations: ['Lumenfold Labs'],
      amount: 1_500_000,
      owners: ['Avery Quill', 'Rowan Pike'],
      date_added: '2026-10-01',
      close_date: '2026-11-30',
      fund: 'Fund II',
    });
    expect(preSeed.values.amount).toBe(750_000);
    expect(preSeed.values).not.toHaveProperty('close_date');

    // Both Lumenfold deals sit on the one Lumenfold company.
    const lumenfold = await recordNamed('Lumenfold Labs');
    expect(lumenfold.kind).toBe('company');
    expect(seed.record_id).toBe(lumenfold.id);
    expect(seriesA.record_id).toBe(lumenfold.id);
  });

  it('changes nothing when the same file is imported again, in different chunks', async () => {
    await importListCsv('Startup Deal Pipeline.csv', DEALS);
    const before = await snapshot();
    const again = await importListCsv('Startup Deal Pipeline.csv', DEALS, 2);
    expect(again.list).toMatchObject({ created: false, updated: false });
    expect(again.entries).toEqual({ ...NO_COUNTS, unchanged: 5 });
    expect(again.records.inserted).toBe(0);
    const after = await snapshot();
    // The only new rows anywhere are audit events, which live elsewhere.
    expect(after).toEqual(before);
  });

  it('updates rows that changed and clears cells that were emptied', async () => {
    await importListCsv('Startup Deal Pipeline.csv', DEALS);
    const edited = DEALS.replace('5. Due Diligence', '10. Won / Signed').replace(
      '"$1,500,000"',
      '',
    );
    const totals = await importListCsv('Startup Deal Pipeline.csv', edited);
    expect(totals.entries).toMatchObject({ inserted: 0, updated: 2, unchanged: 3 });
    const entries = await entriesOf((await listNamed('Startup Deal Pipeline')).id);
    expect(entries[0]?.values).not.toHaveProperty('amount');
    expect(entries[1]?.values.status).toBe('10. Won / Signed');
  });

  it('stores values under the keys the list already has', async () => {
    const existing = await upsertList(store, org, {
      name: 'Startup Deal Pipeline',
      entityType: 'deal',
      fields: [{ key: 'fund_name', name: 'Fund', type: 'status', options: ['Fund I'] }],
    });
    expect(existing.ok).toBe(true);
    await importListCsv('Startup Deal Pipeline.csv', DEALS);
    const list = await listNamed('Startup Deal Pipeline');
    expect(list.fields.filter((f) => f.name === 'Fund')).toEqual([
      { key: 'fund_name', name: 'Fund', type: 'status', options: ['Fund I', 'Fund II'] },
    ]);
    const [first] = await entriesOf(list.id);
    expect(first?.values.fund_name).toBe('Fund II');
    expect(first?.values).not.toHaveProperty('fund');
  });

  it('keeps a status changed in Kraken when the same file is imported again', async () => {
    await importListCsv('Startup Deal Pipeline.csv', DEALS);
    const list = await listNamed('Startup Deal Pipeline');
    const [seed] = await entriesOf(list.id);
    expect(seed?.values.status).toBe('3. First Meeting');
    const moved = await updateEntryValues(store, org, seed!.id, { status: '5. Due Diligence' });
    expect(moved.ok).toBe(true);

    const again = await importListCsv('Startup Deal Pipeline.csv', DEALS);
    expect(again.entries).toMatchObject({ inserted: 0, unchanged: 5 });
    expect(again.keptEdits).toBe(1);
    expect(again.problems).toEqual([
      {
        row: 0,
        message:
          'Kept Status as set in Kraken (“5. Due Diligence”) rather than the file’s “3. First Meeting”.',
      },
    ]);
    expect((await entriesOf(list.id))[0]?.values.status).toBe('5. Due Diligence');
  });

  it('imports another saved view of a list into the list chosen for it, not a new one', async () => {
    await importListCsv('Startup Deal Pipeline - All deals.csv', DEALS);
    const list = await listNamed('Startup Deal Pipeline');
    const file = 'Startup Deal Pipeline - Active Pipeline.csv';
    const mapping = detectAffinityMapping(file, parseAffinityCsv(DEALS)) as AffinityListMapping;
    // On its own the file would name a new list; the page offers the existing one.
    expect(mapping.listName).toBe('Startup Deal Pipeline - Active Pipeline');
    const existing = [
      {
        id: list.id,
        name: list.name,
        entityType: list.entity_type,
        archived: false,
        entryCount: 5,
      },
    ];
    expect(suggestTargetList(file, mapping.listName, mapping.entityType, existing)?.id).toBe(
      list.id,
    );

    const again = await importListCsv(file, DEALS, undefined, list);
    expect(again.list).toMatchObject({
      id: list.id,
      name: 'Startup Deal Pipeline',
      created: false,
    });
    expect(again.entries).toEqual({ ...NO_COUNTS, unchanged: 5 });
    const lists = (await store.list('crm_lists', org, {})) as CrmList[];
    expect(lists.filter((l) => l.name.startsWith('Startup Deal Pipeline'))).toHaveLength(1);
  });

  it('refuses a chosen list of another kind, or one that no longer exists, saving nothing', async () => {
    await importListCsv('LP Pipeline.csv', PEOPLE);
    const people = await listNamed('LP Pipeline');
    const csv = parseAffinityCsv(DEALS);
    const mapping = detectAffinityMapping('Deals.csv', csv) as AffinityListMapping;
    const before = await snapshot();
    for (const [targetListId, code] of [
      [people.id, 'invalid_input'],
      ['00000000-0000-4000-8000-00000000beef', 'not_found'],
    ] as const) {
      const [request] = buildListImport({ ...mapping, targetListId }, csv).requests;
      const result = await importAffinityList(store, org, request!);
      expect(!result.ok && result.error.code).toBe(code);
    }
    expect(await snapshot()).toEqual(before);
  });

  it('imports companies with their ids and domains, and people with their emails', async () => {
    await importListCsv('Portfolio.csv', ORGS);
    expect(await recordNamed('Harborlight Analytics')).toMatchObject({
      external_id: '3101',
      domain: 'harborlight.example',
    });
    expect((await recordNamed('Gildcrest Robotics')).domain).toBeNull();
    expect((await recordNamed('Fernhollow, Inc.')).domain).toBe('fernhollow.example');

    const totals = await importListCsv('LP Pipeline.csv', PEOPLE);
    expect(totals.entries.inserted).toBe(2);
    expect(await recordNamed('Juniper Okafor')).toMatchObject({
      kind: 'person',
      external_id: '5201',
      primary_email: 'juniper@ashgrove-capital.example',
      emails: ['juniper@ashgrove-capital.example', 'j.okafor@mail.example'],
    });
    expect((await listNamed('LP Pipeline')).entity_type).toBe('person');
  });
});

describe('importing notes', () => {
  async function importEverything() {
    await importListCsv('Portfolio.csv', ORGS);
    await importListCsv('LP Pipeline.csv', PEOPLE);
    await importListCsv('Startup Deal Pipeline.csv', DEALS);
  }

  it('links notes to the companies, people and deals their names match', async () => {
    await importEverything();
    const [result] = await importNotesCsv(NOTES);
    expect(result).toMatchObject({
      notes: { inserted: 3, updated: 0, unchanged: 0, skipped: 0, errors: 0 },
      linked: 2,
      unmatchedNames: 1,
      ambiguousNames: 0,
    });

    const notes = (await store.list('crm_notes', org, { eq: { source: 'affinity' } })) as CrmNote[];
    const call = notes.find((n) => n.content.startsWith('First call'));
    const deal = (await entriesOf((await listNamed('Startup Deal Pipeline')).id))[0];
    expect(call).toMatchObject({
      content: 'First call with the founders.\n- Strong technical team',
      author: 'Avery Quill',
      occurred_at: '2026-10-02T14:05:00.000Z',
      entity_names: ['Lumenfold Seed', 'Lumenfold Labs', 'Juniper Okafor'],
      entry_ids: [deal?.id],
    });
    expect(new Set(call?.record_ids)).toEqual(
      new Set([(await recordNamed('Lumenfold Labs')).id, (await recordNamed('Juniper Okafor')).id]),
    );
    const orphan = notes.find((n) => n.entity_names.includes('Nobody Known'));
    expect(orphan).toMatchObject({ record_ids: [], entry_ids: [] });
  });

  it('changes nothing when the same notes are imported again', async () => {
    await importEverything();
    await importNotesCsv(NOTES);
    const before = await snapshot();
    const [again] = await importNotesCsv(NOTES);
    expect(again?.notes).toEqual({ ...NO_COUNTS, unchanged: 3 });
    expect(await snapshot()).toEqual(before);
  });

  it('links notes imported before their lists once the notes are imported again', async () => {
    const [first] = await importNotesCsv(NOTES);
    expect(first?.linked).toBe(0);
    await importEverything();
    const [second] = await importNotesCsv(NOTES);
    expect(second).toMatchObject({ linked: 2, notes: { inserted: 0, updated: 2, unchanged: 1 } });
  });

  it('stores a note exported from two lists, under two names, once and attached to both', async () => {
    await importListCsv('Startup Deal Pipeline.csv', DEALS);
    const header = 'Entity Name,Creator,Date Created,Note Content';
    const body = 'Avery Quill,2026-10-02 14:05:00,Reference calls with two pilot customers.';
    // From the deal pipeline under the opportunity; from the company list under the company.
    const [first] = await importNotesCsv(`${header}\nLumenfold Seed,${body}\n`);
    expect(first?.notes).toMatchObject({ inserted: 1 });
    const [second] = await importNotesCsv(`${header}\nLumenfold Labs,${body}\n`);
    expect(second?.notes).toMatchObject({ inserted: 0, updated: 1 });

    const notes = ((await store.list('crm_notes', org, {})) as CrmNote[]).filter((n) =>
      n.content.startsWith('Reference calls'),
    );
    expect(notes).toHaveLength(1);
    const seed = (await entriesOf((await listNamed('Startup Deal Pipeline')).id))[0];
    expect(notes[0]).toMatchObject({
      entity_names: ['Lumenfold Seed', 'Lumenfold Labs'],
      record_ids: [(await recordNamed('Lumenfold Labs')).id],
      entry_ids: [seed?.id],
    });
    // A third export of it changes nothing.
    const [third] = await importNotesCsv(`${header}\nLumenfold Seed,${body}\n`);
    expect(third?.notes).toEqual({ ...NO_COUNTS, unchanged: 1 });
  });

  it('does not guess between two records with the same name', async () => {
    // Two people who share a name: distinct Affinity ids keep them apart.
    await upsertRecords(store, org, 'person', [
      { externalId: '8801', name: 'Sam Ellery', primaryEmail: 'sam@first.example' },
      { externalId: '8802', name: 'Sam Ellery', primaryEmail: 'sam@second.example' },
    ]);
    const [result] = await importNotesCsv('Entity Name,Content\nSam Ellery,Coffee chat\n');
    expect(result).toMatchObject({ linked: 0, ambiguousNames: 1, unmatchedNames: 0 });
    const notes = (await store.list('crm_notes', org, {})) as CrmNote[];
    expect(notes.find((n) => n.content === 'Coffee chat')).toMatchObject({
      record_ids: [],
      entity_names: ['Sam Ellery'],
    });
  });

  it('splits comma-joined names only when every part matches', async () => {
    await importEverything();
    const [result] = await importNotesCsv(
      'Entity Name,Content\n"Harborlight Analytics, Tidewell",Joint call\n"Fernhollow, Inc.",Board deck\n',
    );
    expect(result?.linked).toBe(2);
    const notes = (await store.list('crm_notes', org, { eq: { source: 'affinity' } })) as CrmNote[];
    const joint = notes.find((n) => n.content === 'Joint call');
    expect(joint?.entity_names).toEqual(['Harborlight Analytics', 'Tidewell']);
    expect(new Set(joint?.record_ids)).toEqual(
      new Set([
        (await recordNamed('Harborlight Analytics')).id,
        (await recordNamed('Tidewell')).id,
      ]),
    );
    const board = notes.find((n) => n.content === 'Board deck');
    expect(board?.entity_names).toEqual(['Fernhollow, Inc.']);
    expect(board?.record_ids).toEqual([(await recordNamed('Fernhollow, Inc.')).id]);
  });
});

/** The demo store, except that every CRM table is missing — as in production before the migration. */
function storeWithoutCrmTables(inner: DataStore): DataStore {
  const missing = () =>
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
      return (...args: unknown[]) =>
        typeof args[0] === 'string' && args[0].startsWith('crm_')
          ? Promise.reject(missing())
          : original.apply(target, args);
    },
  });
}

describe('before the CRM migration has been applied', () => {
  it('saves nothing and says why, without throwing', async () => {
    const missing = storeWithoutCrmTables(store);
    const csv = parseAffinityCsv(DEALS);
    const mapping = detectAffinityMapping('Deals.csv', csv);
    if (mapping.kind !== 'list') throw new Error('expected a list');
    const [listRequest] = buildListImport(mapping, csv).requests;
    const notesCsv = parseAffinityCsv(NOTES);
    const notesMapping = detectAffinityMapping('notes.csv', notesCsv);
    if (notesMapping.kind !== 'notes') throw new Error('expected notes');
    const [notesRequest] = buildNotesImport(notesMapping, notesCsv).requests;

    for (const result of [
      await importAffinityList(missing, org, listRequest!),
      await importAffinityNotes(missing, org, notesRequest!),
    ]) {
      expect(!result.ok && result.error.code).toBe('not_configured');
      expect(!result.ok && result.error.message).toMatch(/^Nothing was saved/);
      expect(!result.ok && result.error.message).toContain('20261015000000_crm.sql');
    }
  });
});

/* ------------------------------------------------------------------ route */

function post(body: unknown) {
  return new NextRequest('http://localhost/api/crm/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function listBody() {
  const csv = parseAffinityCsv(DEALS);
  const mapping = detectAffinityMapping('Startup Deal Pipeline.csv', csv);
  if (mapping.kind !== 'list') throw new Error('expected a list');
  return buildListImport(mapping, csv).requests[0]!;
}

describe('POST /api/crm/import', () => {
  it('imports a list chunk for a signed-in member and returns the counts', async () => {
    const res = await POST(post(listBody()));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const json = await res.json();
    expect(json).toMatchObject({
      ok: true,
      kind: 'list',
      list: { name: 'Startup Deal Pipeline', created: true },
      entries: { inserted: 5 },
      records: { inserted: 4 },
      problems: [],
    });

    const again = await (await POST(post(listBody()))).json();
    expect(again.entries).toEqual({ ...NO_COUNTS, unchanged: 5 });

    const audit = await store.list('audit_events', org, { eq: { action: 'crm.imported' } });
    expect(audit).toHaveLength(2);
  });

  it('imports a notes chunk', async () => {
    const csv = parseAffinityCsv(NOTES);
    const mapping = detectAffinityMapping('notes.csv', csv);
    if (mapping.kind !== 'notes') throw new Error('expected notes');
    const res = await POST(post(buildNotesImport(mapping, csv).requests[0]));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, kind: 'notes', notes: { inserted: 3 } });
  });

  it('refuses the signed-out and viewers', async () => {
    signedIn = () => err('unauthenticated', 'Sign in to continue.');
    expect((await POST(post(listBody()))).status).toBe(401);
    signedIn = () => ok({ ...harness.auth, role: 'viewer' });
    const res = await POST(post(listBody()));
    expect(res.status).toBe(403);
    expect(await store.list('crm_lists', org, { eq: { name: 'Startup Deal Pipeline' } })).toEqual(
      [],
    );
  });

  it('rejects a body that is not an import', async () => {
    for (const body of [
      'not json',
      { kind: 'list' },
      { kind: 'notes', notes: [] },
      { kind: 'other', rows: [] },
      { ...listBody(), entries: Array.from({ length: 501 }, () => ({ title: 'Too many' })) },
      {
        ...listBody(),
        list: { ...listBody().list, fields: [{ key: 'Bad Key', name: 'Bad', type: 'text' }] },
      },
      { ...listBody(), list: { ...listBody().list, id: 'not-a-list-id' } },
    ]) {
      const res = await POST(post(body));
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('invalid_input');
    }
  });

  it('answers 503 with a plain explanation before the migration', async () => {
    setStoreForTesting(storeWithoutCrmTables(store));
    const res = await POST(post(listBody()));
    expect(res.status).toBe(503);
    expect((await res.json()).error.message).toMatch(/^Nothing was saved/);
  });
});
