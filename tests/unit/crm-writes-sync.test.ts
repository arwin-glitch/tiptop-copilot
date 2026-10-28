import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import type { AffinityApiFieldMeta, AffinityApiListEntry } from '@/lib/crm/affinity-api';
import type { DataStore } from '@/lib/db/store';
import { DEMO_IDS } from '@/lib/demo/ids';
import {
  runAffinitySyncStep,
  type AffinitySyncOptions,
  type AffinitySyncStep,
} from '@/lib/services/affinity-sync';
import {
  addListField,
  addNote,
  createRecord,
  removeEntry,
  restoreEntry,
  updateEntryValues,
  type CrmActor,
} from '@/lib/services/crm';
import type { CrmList, CrmListEntry, CrmRecord } from '@/lib/types/domain';

/**
 * CRM writes made in Kraken against the daily Affinity sync that still runs
 * until the subscription ends: a fake Affinity (one person list, served the
 * way the v2 API pages it) and the real sync and CRM service on the demo
 * store. Every name and address is invented.
 */

const KEY = 'test-affinity-key-not-a-real-one-0000';
const ORIGIN = 'https://api.affinity.co';
const actor: CrmActor = { userId: DEMO_IDS.user, name: 'Morgan Ellery' };

const person = (id: number, first: string, last: string, email: string) => ({
  id,
  firstName: first,
  lastName: last,
  primaryEmailAddress: email,
  type: 'external',
});

const AVERY = person(7301, 'Avery', 'Lark', 'avery@quillfeather.example');
const ROWAN = person(7302, 'Rowan', 'Pike', 'rowan@pike.example');

const FIELDS: AffinityApiFieldMeta[] = [
  { id: 'field-21', name: 'Intro Source', type: 'list', valueType: 'text' },
  { id: 'field-22', name: 'Industry', type: 'global', valueType: 'dropdown-multi' },
];

const row = (id: number, who: typeof AVERY, source: string, industry: string) =>
  ({
    id,
    type: 'person',
    listId: 7002,
    entity: {
      ...who,
      emailAddresses: [who.primaryEmailAddress],
      fields: [
        { id: 'field-21', name: 'Intro Source', value: { type: 'text', data: source } },
        {
          id: 'field-22',
          name: 'Industry',
          value: { type: 'dropdown-multi', data: [{ dropdownOptionId: 1, text: industry }] },
        },
      ],
    },
  }) as unknown as AffinityApiListEntry;

const ENTRIES = [row(82001, AVERY, 'Conference', 'Fintech'), row(82002, ROWAN, 'Referral', 'AI')];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Affinity's v2 API with one person list and no notes. */
const fakeFetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  if (url.origin !== ORIGIN) throw new Error(`request left Affinity: ${url.origin}`);
  const page = (data: unknown[]) => json({ data, pagination: { prevUrl: null, nextUrl: null } });
  if (url.pathname === '/v2/lists') {
    return page([{ id: 7002, name: 'Example Founders', type: 'person' }]);
  }
  if (url.pathname === '/v2/lists/7002/fields') return page(FIELDS);
  if (url.pathname === '/v2/lists/7002/list-entries') return page(ENTRIES);
  if (url.pathname === '/v2/notes') return page([]);
  return json({ message: 'not found' }, 404);
}) as typeof fetch;

let harness: Harness;
let store: DataStore;
let org: string;
let clock: number;

beforeEach(async () => {
  harness = await createHarness();
  store = harness.store;
  org = harness.auth.organizationId;
  clock = Date.parse('2026-10-21T11:00:00Z');
});

afterEach(async () => {
  await harness.dispose();
});

function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.value;
}

/** One morning's sync, to the end of its run. */
async function sync(): Promise<AffinitySyncStep> {
  const options: AffinitySyncOptions = {
    apiKey: KEY,
    fetch: fakeFetch,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  };
  for (let i = 0; i < 50; i++) {
    const step = value(await runAffinitySyncStep(store, org, options));
    clock += 1000;
    if (step.done) {
      clock += 24 * 60 * 60_000;
      return step;
    }
  }
  throw new Error('the sync never finished');
}

async function founders(): Promise<CrmList> {
  const list = await store.findOne('crm_lists', org, {
    eq: { source: 'affinity', external_id: '7002' },
  });
  if (!list) throw new Error('no list');
  return list;
}

const rowsOf = async (listId: string) =>
  (await store.list('crm_list_entries', org, { eq: { list_id: listId } })) as CrmListEntry[];

describe('Kraken writes and the daily Affinity sync', () => {
  it('adopts a person made in Kraken instead of adding a second one', async () => {
    const made = value(
      await createRecord(
        store,
        org,
        { kind: 'person', name: 'Rowan P.', email: 'rowan@pike.example', location: 'Austin, TX' },
        actor,
      ),
    ).record;
    await sync();
    const withEmail = (await store.list('crm_records', org, {
      eq: { kind: 'person' },
      arrayContains: { emails: 'rowan@pike.example' },
    })) as CrmRecord[];
    expect(withEmail).toHaveLength(1);
    expect(withEmail[0]).toMatchObject({
      id: made.id,
      source: 'affinity',
      external_id: '7302',
      name: 'Rowan Pike',
    });
    const rowan = (await rowsOf((await founders()).id)).find((r) => r.external_id === '82002');
    expect(rowan?.record_id).toBe(made.id);
  });

  it('never brings back a row taken off the list, until Undo puts it back', async () => {
    await sync();
    const list = await founders();
    const avery = (await rowsOf(list.id)).find((r) => r.external_id === '82001')!;
    const note = value(
      await addNote(store, org, { content: 'Met at demo day.', entryIds: [avery.id] }, actor),
    );
    const removed = value(await removeEntry(store, org, avery.id, actor));

    const next = await sync();
    expect(next.counts.entries).toMatchObject({ inserted: 0, skipped: 1 });
    expect((await rowsOf(list.id)).map((r) => r.external_id)).toEqual(['82002']);

    value(await restoreEntry(store, org, removed.tombstoneId, actor));
    const after = await sync();
    expect(after.counts.entries).toMatchObject({ inserted: 0, skipped: 0 });
    const back = (await rowsOf(list.id)).find((r) => r.external_id === '82001')!;
    // The same row as before, so the note on it is on it again.
    expect(back.id).toBe(avery.id);
    expect((await store.get('crm_notes', org, note.id))?.entry_ids).toEqual([avery.id]);
  });

  it('leaves a Kraken column alone, even one named like an Affinity field', async () => {
    await sync();
    const list = await founders();
    const { field } = value(
      await addListField(store, org, list.id, { name: 'Industry', type: 'text' }, actor),
    );
    const avery = (await rowsOf(list.id)).find((r) => r.external_id === '82001')!;
    value(await updateEntryValues(store, org, avery.id, { [field.key]: 'Our own label' }));

    const next = await sync();
    expect(next.counts.entries).toMatchObject({ inserted: 0, updated: 0 });
    const after = await founders();
    expect(after.fields.filter((f) => f.name === 'Industry')).toEqual([
      { key: field.key, name: 'Industry', type: 'text', origin: 'copilot' },
    ]);
    const row = (await store.get('crm_list_entries', org, avery.id))!;
    expect(row.values[field.key]).toBe('Our own label');
    // Affinity's Industry stays on the person, where the sync keeps it.
    const record = (await store.get('crm_records', org, avery.record_id!))!;
    expect(record.fields.Industry).toEqual(['Fintech']);
  });
});
