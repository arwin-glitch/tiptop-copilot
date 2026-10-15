import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createHarness, type Harness } from '../helpers/harness';
import {
  affinityDate,
  affinityHtmlToText,
  affinityPlainValue,
  mapAffinityEntries,
  mapAffinityNote,
  planAffinityColumns,
  type AffinityApiFieldMeta,
  type AffinityApiListEntry,
  type AffinityApiNote,
} from '@/lib/crm/affinity-api';
import { resetEnvCache } from '@/lib/config/env';
import type { DataStore } from '@/lib/db/store';
import { affinityRetryAfterMs, createAffinityHttp } from '@/lib/services/affinity-client';
import { importAffinityList, importAffinityNotes } from '@/lib/services/crm-import';
import {
  AFFINITY_SYNC_ACTION,
  AFFINITY_SYNC_ENTITY,
  affinitySyncOrganization,
  getAffinitySyncStatus,
  readAffinitySyncState,
  runAffinitySyncStep,
  type AffinitySyncOptions,
  type AffinitySyncStep,
} from '@/lib/services/affinity-sync';
import type { AuditEvent, CrmList, CrmListEntry, CrmNote, CrmRecord } from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';

/**
 * The daily Affinity sync, against a fake Affinity: invented lists, entries
 * and notes served the way the v2 API pages them, through a mocked fetch. The
 * CRM side is the real service on the demo store, so what is asserted is what
 * the pages would read.
 */

const KEY = 'test-affinity-key-not-a-real-one-0000';
const ORIGIN = 'https://api.affinity.co';

/* ------------------------------------------------------------ fake world */

const person = (id: number, first: string, last: string, email: string, type = 'external') => ({
  id,
  firstName: first,
  lastName: last,
  primaryEmailAddress: email,
  type,
});

const QUILLFEATHER = { id: 7201, name: 'Quillfeather', domain: 'quillfeather.example' };
const BRINDLE = { id: 7202, name: 'Brindle Labs', domain: 'brindle.example' };
const AVERY = person(7301, 'Avery', 'Lark', 'avery@quillfeather.example');
const ROWAN = person(7302, 'Rowan', 'Pike', 'rowan@pike.example');
const TEAMMATE = person(1, 'Sam', 'Teammate', 'sam@fund.example', 'internal');

function world() {
  const lists = [
    { id: 7001, name: 'Example Deal Flow', type: 'opportunity' },
    { id: 7002, name: 'Example Founders', type: 'person' },
    { id: 7003, name: 'Example Watch List', type: 'company' },
  ];
  const fields: Record<number, AffinityApiFieldMeta[]> = {
    7001: [
      { id: 'field-11', name: 'Status', type: 'list', valueType: 'ranked-dropdown' },
      { id: 'field-12', name: 'Check Size', type: 'list', valueType: 'number' },
      { id: 'companies', name: 'Organizations', type: 'list', valueType: 'company-multi' },
      { id: 'persons', name: 'People', type: 'list', valueType: 'person-multi' },
      { id: 'time-in-current-status', name: 'Time in Current Status', type: 'enriched' },
      { id: 'affinity-data-description', name: 'Description', type: 'enriched' },
    ],
    7002: [
      { id: 'field-21', name: 'Intro Source', type: 'list', valueType: 'text' },
      { id: 'field-22', name: 'Industry', type: 'global', valueType: 'dropdown-multi' },
      {
        id: 'last-email',
        name: 'Last Email',
        type: 'relationship-intelligence',
        valueType: 'interaction',
      },
    ],
    7003: [
      { id: 'field-31', name: 'Priority', type: 'list', valueType: 'dropdown' },
      { id: 'field-32', name: 'Next Review', type: 'list', valueType: 'datetime' },
    ],
  };
  const status = (text: string, rank: number) => ({
    id: 'field-11',
    name: 'Status',
    type: 'list',
    value: { type: 'ranked-dropdown', data: { dropdownOptionId: rank, text, rank, color: null } },
  });
  const deal = (
    id: number,
    oppId: number,
    name: string,
    stage: [string, number],
    company: typeof QUILLFEATHER,
    check: number | null,
  ): AffinityApiListEntry => ({
    id,
    type: 'opportunity',
    listId: 7001,
    entity: {
      id: oppId,
      name,
      listId: 7001,
      fields: [
        status(...stage),
        { id: 'field-12', name: 'Check Size', value: { type: 'number', data: check } },
        {
          id: 'companies',
          name: 'Organizations',
          value: { type: 'company-multi', data: [company] },
        },
        { id: 'persons', name: 'People', value: { type: 'person-multi', data: [AVERY] } },
        {
          id: 'time-in-current-status',
          name: 'Time in Current Status',
          value: { type: 'number', data: 12 },
        },
        {
          id: 'affinity-data-description',
          name: 'Description',
          value: { type: 'text', data: 'Invented company.' },
        },
      ],
    },
  });
  const entries: Record<number, AffinityApiListEntry[]> = {
    7001: [
      deal(81001, 91001, 'Quillfeather Seed', ['3. First Meeting', 3], QUILLFEATHER, 250000),
      deal(81002, 91002, 'Brindle Labs Series A', ['5. Due Diligence', 5], BRINDLE, null),
      deal(81003, 91003, 'Quillfeather Bridge', ['3. First Meeting', 3], QUILLFEATHER, 100000),
    ],
    7002: [
      {
        id: 82001,
        type: 'person',
        listId: 7002,
        entity: {
          ...AVERY,
          emailAddresses: ['avery@quillfeather.example', 'a.lark@mail.example'],
          fields: [
            { id: 'field-21', name: 'Intro Source', value: { type: 'text', data: 'Conference' } },
            {
              id: 'field-22',
              name: 'Industry',
              value: {
                type: 'dropdown-multi',
                data: [
                  { dropdownOptionId: 1, text: 'Fintech' },
                  { dropdownOptionId: 2, text: 'AI' },
                ],
              },
            },
            {
              id: 'last-email',
              name: 'Last Email',
              value: {
                type: 'interaction',
                data: { type: 'email', sentAt: '2026-10-01T15:00:00Z' },
              },
            },
          ],
        },
      },
      {
        id: 82002,
        type: 'person',
        listId: 7002,
        entity: {
          ...ROWAN,
          emailAddresses: ['rowan@pike.example'],
          fields: [{ id: 'field-21', name: 'Intro Source', value: { type: 'text', data: null } }],
        },
      },
    ],
    7003: [
      {
        id: 83001,
        type: 'company',
        listId: 7003,
        entity: {
          id: 7203,
          name: 'Cindervale',
          domain: 'cindervale.example',
          domains: ['cindervale.example'],
          isGlobal: false,
          fields: [
            {
              id: 'field-31',
              name: 'Priority',
              value: { type: 'dropdown', data: { dropdownOptionId: 9, text: 'High' } },
            },
            {
              id: 'field-32',
              name: 'Next Review',
              // Midnight Pacific (PDT), which is how Affinity stores a date.
              value: { type: 'datetime', data: '2026-10-20T07:00:00Z' },
            },
          ],
        },
      } as AffinityApiListEntry,
    ],
  };
  const notes: (AffinityApiNote & { updatedAt: string | null })[] = [
    {
      id: 95001,
      type: 'entities',
      content: {
        html: '<p>Met the <b>Quillfeather</b> team &amp; liked it.</p><ul><li>Strong founder</li><li>Seed</li></ul>',
      },
      creator: TEAMMATE,
      createdAt: '2026-10-02T16:00:00Z',
      updatedAt: null,
      companiesPreview: { data: [QUILLFEATHER] },
      personsPreview: { data: [TEAMMATE, AVERY] },
      opportunitiesPreview: {
        data: [
          { id: 91001, name: 'Quillfeather Seed', listId: 7001, listName: 'Example Deal Flow' },
        ],
      },
    },
    {
      id: 95002,
      type: 'user-reply',
      parent: { id: 95001 },
      content: { html: 'Agreed.' },
      creator: TEAMMATE,
      createdAt: '2026-10-03T09:00:00Z',
      updatedAt: null,
    },
    {
      id: 95003,
      type: 'entities',
      content: { html: 'Intro call with a new fund.' },
      creator: TEAMMATE,
      createdAt: '2026-10-04T18:30:00Z',
      updatedAt: null,
      companiesPreview: {
        data: [{ id: 7299, name: 'Northwind Example', domain: 'northwind.example' }],
      },
    },
  ];
  return { lists, fields, entries, notes };
}

type World = ReturnType<typeof world>;

interface Fake {
  fetch: typeof fetch;
  /** Every request, as path + query. */
  calls: string[];
  /** The Authorization header of every request. */
  auth: string[];
  /** Answer the next n requests with 429. */
  throttle: (n: number, retryAfter?: string) => void;
  /** Answer requests `match` picks with `status`, the next `times` of them (every one by default). */
  reject: (match: (url: URL) => boolean, status: number, times?: number) => void;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Affinity's v2 API over `w`, two items a page, cursors in `nextUrl`. */
function fakeAffinity(w: World, pageSize = 2): Fake {
  const calls: string[] = [];
  const auth: string[] = [];
  let throttled = 0;
  let retryAfter = '1';
  const rejects: { match: (url: URL) => boolean; status: number; left: number }[] = [];

  const paged = <T>(items: readonly T[], url: URL) => {
    const offset = Number(url.searchParams.get('cursor') ?? 0);
    const next = offset + pageSize;
    return json({
      data: items.slice(offset, next),
      pagination: {
        prevUrl: null,
        nextUrl: next < items.length ? `${ORIGIN}${url.pathname}?cursor=${next}` : null,
      },
    });
  };

  const fake = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== ORIGIN) throw new Error(`request left Affinity: ${url.origin}`);
    calls.push(url.pathname + url.search);
    auth.push(new Headers(init?.headers).get('authorization') ?? '');
    if (throttled > 0) {
      throttled--;
      return json({ message: 'Too many requests' }, 429, { 'retry-after': retryAfter });
    }
    const rejected = rejects.find((r) => r.left > 0 && r.match(url));
    if (rejected) {
      rejected.left--;
      return json({ message: 'Refused' }, rejected.status);
    }
    const path = url.pathname;
    if (path === '/v2/lists') return paged(w.lists, url);
    let m = /^\/v2\/lists\/(\d+)\/fields$/.exec(path);
    if (m) return paged(w.fields[Number(m[1])] ?? [], url);
    m = /^\/v2\/lists\/(\d+)\/list-entries$/.exec(path);
    if (m) return paged(w.entries[Number(m[1])] ?? [], url);
    if (path === '/v2/notes') {
      // The filter the sync sends after its first run: created or changed since.
      const since = /createdAt>=([^|]+)/.exec(url.searchParams.get('filter') ?? '')?.[1];
      const notes = since
        ? w.notes.filter(
            (n) =>
              Date.parse(n.createdAt ?? '') >= Date.parse(since) ||
              (n.updatedAt !== null && Date.parse(n.updatedAt) >= Date.parse(since)),
          )
        : w.notes;
      return paged(notes, url);
    }
    return json({ message: 'not found' }, 404);
  };

  return {
    fetch: fake as typeof fetch,
    calls,
    auth,
    throttle: (n, after = '1') => {
      throttled = n;
      retryAfter = after;
    },
    reject: (match, status, times = Infinity) => {
      rejects.push({ match, status, left: times });
    },
  };
}

/* --------------------------------------------------------------- helpers */

let harness: Harness;
let store: DataStore;
let org: string;
let clock: number;
const sleeps: number[] = [];

beforeEach(async () => {
  harness = await createHarness();
  store = harness.store;
  org = harness.auth.organizationId;
  clock = Date.parse('2026-10-15T11:00:00Z');
  sleeps.length = 0;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.AFFINITY_API_KEY;
  delete process.env.CRON_SECRET;
  resetEnvCache();
  await harness.dispose();
});

function options(fake: Fake, extra: Partial<AffinitySyncOptions> = {}): AffinitySyncOptions {
  return {
    apiKey: KEY,
    fetch: fake.fetch,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    ...extra,
  };
}

function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.value;
}

/** Call the sync until its run is done, as the daily job does; the steps it took. */
async function syncToEnd(fake: Fake, extra: Partial<AffinitySyncOptions> = {}) {
  const steps: AffinitySyncStep[] = [];
  for (let i = 0; i < 100; i++) {
    const step = value(await runAffinitySyncStep(store, org, options(fake, extra)));
    steps.push(step);
    clock += 1000;
    if (step.done) return steps;
  }
  throw new Error('the sync never finished');
}

async function affinityList(externalId: string): Promise<CrmList> {
  const list = await store.findOne('crm_lists', org, {
    eq: { source: 'affinity', external_id: externalId },
  });
  if (!list) throw new Error(`no list ${externalId}`);
  return list;
}

const entriesOf = async (listId: string) =>
  (await store.list('crm_list_entries', org, { eq: { list_id: listId } })) as CrmListEntry[];

const recordBy = (kind: 'company' | 'person', externalId: string) =>
  store.findOne('crm_records', org, {
    eq: { kind, source: 'affinity', external_id: externalId },
  }) as Promise<CrmRecord | null>;

const noteBy = (externalId: string) =>
  store.findOne('crm_notes', org, {
    eq: { source: 'affinity', external_id: externalId },
  }) as Promise<CrmNote | null>;

async function counts() {
  return {
    lists: (await store.list('crm_lists', org, {})).length,
    records: (await store.list('crm_records', org, {})).length,
    entries: (await store.list('crm_list_entries', org, {})).length,
    notes: (await store.list('crm_notes', org, {})).length,
  };
}

/* ---------------------------------------------------------------- mapping */

describe('mapping Affinity onto the CRM', () => {
  it('turns note HTML into plain text', () => {
    expect(
      affinityHtmlToText(
        '<p>Met the <b>team</b> &amp; liked it.</p>\n<ul><li>One</li><li>Two&nbsp;&#8212; three</li></ul><script>x()</script>',
      ),
    ).toBe('Met the team & liked it.\n- One\n- Two — three');
    expect(affinityHtmlToText('Line one<br>Line two')).toBe('Line one\nLine two');
    expect(affinityHtmlToText(null)).toBe('');
  });

  it('keeps a date field as its calendar day, whichever midnight Affinity stored', () => {
    expect(affinityDate('2026-10-20T07:00:00Z')).toBe('2026-10-20'); // midnight PDT
    expect(affinityDate('2026-12-01T08:00:00Z')).toBe('2026-12-01'); // midnight PST
    expect(affinityDate('2025-06-01T00:00:00Z')).toBe('2025-06-01'); // midnight UTC
    expect(affinityDate('2026-10-20T15:30:00Z')).toBe('2026-10-20T15:30:00.000Z');
  });

  it('reads every kind of value as text, numbers, dates or names', () => {
    expect(affinityPlainValue({ type: 'text', data: ' Hello ' })).toBe('Hello');
    expect(affinityPlainValue({ type: 'number', data: 3.5 })).toBe(3.5);
    expect(affinityPlainValue({ type: 'formula-number', data: { calculatedValue: 7 } })).toBe(7);
    expect(affinityPlainValue({ type: 'dropdown', data: { text: 'High' } })).toBe('High');
    expect(
      affinityPlainValue({ type: 'ranked-dropdown', data: { text: '2. Intro', rank: 2 } }),
    ).toBe('2. Intro');
    expect(affinityPlainValue({ type: 'person-multi', data: [AVERY, ROWAN] })).toEqual([
      'Avery Lark',
      'Rowan Pike',
    ]);
    expect(affinityPlainValue({ type: 'company', data: BRINDLE })).toBe('Brindle Labs');
    expect(
      affinityPlainValue({
        type: 'location',
        data: { streetAddress: null, city: 'Austin', state: 'Texas', country: 'United States' },
      }),
    ).toBe('Austin, Texas, United States');
    expect(
      affinityPlainValue({
        type: 'interaction',
        data: { type: 'meeting', startTime: '2026-09-01T14:00:00Z' },
      }),
    ).toBe('2026-09-01T14:00:00.000Z');
    // Affinity sends an empty multi value as null, which clears the stored one.
    expect(affinityPlainValue({ type: 'company-multi', data: null })).toBeNull();
    expect(affinityPlainValue({ type: 'something-new', data: { nested: true } })).toBeNull();
  });

  it('makes list fields columns and keeps global fields on the record', () => {
    const w = world();
    const plan = planAffinityColumns(w.fields[7002]!, [], 'person');
    expect(plan.columns.map((c) => [c.key, c.type])).toEqual([['intro_source', 'text']]);
    expect(plan.recordFields.map((f) => f.name)).toEqual(['Industry', 'Last Email']);

    const deals = planAffinityColumns(w.fields[7001]!, [], 'deal');
    expect(deals.fields.map((f) => [f.key, f.type])).toEqual([
      ['status', 'status'],
      ['check_size', 'money'],
      ['organizations', 'company'],
      ['people', 'person'],
    ]);
    // Time in Current Status changes every day by itself; Description is the company's.
    expect(deals.recordFields.map((f) => f.name)).toEqual(['Description']);
  });

  it('keeps a column the CSV import made exactly as it is, whatever its kind of field', () => {
    const plan = planAffinityColumns(
      [
        { id: 'field-12', name: 'Check Size', type: 'list', valueType: 'number' },
        { id: 'field-22', name: 'Industry', type: 'global', valueType: 'dropdown-multi' },
      ],
      [
        { key: 'check_size_usd', name: 'check size', type: 'money' },
        { key: 'industry', name: 'Industry', type: 'multi', options: ['Fintech'] },
      ],
      'company',
    );
    expect(plan.columns.map((c) => [c.fieldId, c.key, c.type])).toEqual([
      ['field-12', 'check_size_usd', 'money'],
      ['field-22', 'industry', 'multi'],
    ]);
    expect(plan.recordFields).toEqual([]);
  });

  it('maps a page of deals to rows, with each company sent once', () => {
    const w = world();
    const plan = planAffinityColumns(w.fields[7001]!, [], 'deal');
    const page = mapAffinityEntries('deal', w.entries[7001]!, plan);
    expect(page.records).toEqual([
      { externalId: '7201', name: 'Quillfeather', domain: 'quillfeather.example' },
      { externalId: '7202', name: 'Brindle Labs', domain: 'brindle.example' },
    ]);
    expect(page.entries.map((e) => [e.externalId, e.title, e.record])).toEqual([
      ['81001', 'Quillfeather Seed', 0],
      ['81002', 'Brindle Labs Series A', 1],
      ['81003', 'Quillfeather Bridge', 0],
    ]);
    expect(page.entries[0]!.values).toEqual({
      status: '3. First Meeting',
      check_size: 250000,
      organizations: ['Quillfeather'],
      people: ['Avery Lark'],
    });
    expect(page.entries[1]!.values.check_size).toBeNull();
    expect(page.options.status).toEqual(['3. First Meeting', '5. Due Diligence']);
  });

  it('maps a note, leaving teammates out of what it is about', () => {
    const note = mapAffinityNote(world().notes[0]!);
    expect(note).toMatchObject({
      externalId: '95001',
      content: 'Met the Quillfeather team & liked it.\n- Strong founder\n- Seed',
      author: 'Sam Teammate',
      occurredAt: '2026-10-02T16:00:00.000Z',
      parentId: null,
      entityNames: ['Quillfeather', 'Avery Lark', 'Quillfeather Seed'],
    });
    expect(note?.persons.map((p) => p.id)).toEqual([7301]);
    expect(mapAffinityNote({ id: 1, content: { html: '<p> </p>' } })).toBeNull();
  });
});

/* ------------------------------------------------------------------ http */

describe('the Affinity client', () => {
  it('sends the key as a bearer token, pinned to one API version', async () => {
    const fake = fakeAffinity(world());
    let headers: Headers | null = null;
    const http = createAffinityHttp({
      apiKey: KEY,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        headers = new Headers(init?.headers);
        return fake.fetch(input, init);
      }) as typeof fetch,
    });
    value(await http.get('/v2/lists', { limit: 100 }));
    expect(headers!.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(headers!.get('x-affinity-api-version')).toBe('2024-01-01');
  });

  it('waits out a 429 for as long as Retry-After asks, then carries on', async () => {
    const fake = fakeAffinity(world());
    fake.throttle(2, '3');
    const http = createAffinityHttp({
      apiKey: KEY,
      fetch: fake.fetch,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    const page = value(await http.get<{ data: unknown[] }>('/v2/lists'));
    expect(page.data).toHaveLength(2);
    expect(sleeps).toEqual([3000, 3000]);
    expect(http.requests).toBe(3);
  });

  it('backs off exponentially when a 429 says nothing, and gives up past its deadline', async () => {
    const fake = fakeAffinity(world());
    fake.throttle(10, '');
    const http = createAffinityHttp({
      apiKey: KEY,
      fetch: fake.fetch,
      now: () => clock,
      deadline: clock + 10_000,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    const result = await http.get('/v2/lists');
    expect(!result.ok && result.error.code).toBe('rate_limited');
    expect(sleeps).toEqual([1000, 2000, 4000]);
  });

  it('reads Retry-After as seconds or a date, and falls back to the reset header', () => {
    const now = Date.parse('2026-10-15T11:00:00Z');
    expect(affinityRetryAfterMs(new Headers({ 'retry-after': '7' }), now)).toBe(7000);
    expect(
      affinityRetryAfterMs(new Headers({ 'retry-after': 'Thu, 15 Oct 2026 11:00:05 GMT' }), now),
    ).toBe(5000);
    expect(affinityRetryAfterMs(new Headers({ 'x-ratelimit-limit-user-reset': '12' }), now)).toBe(
      12000,
    );
    expect(affinityRetryAfterMs(new Headers(), now)).toBeNull();
  });

  it('follows a next page only on Affinity, so the key cannot be sent anywhere else', async () => {
    const send = vi.fn(async () => json({ data: [] }));
    const http = createAffinityHttp({ apiKey: KEY, fetch: send as unknown as typeof fetch });
    const result = await http.get('https://collector.example/v2/lists?cursor=1');
    expect(!result.ok && result.error.code).toBe('invalid_input');
    expect(send).not.toHaveBeenCalled();
  });

  it('reports a refused key without the key or the response body', async () => {
    const http = createAffinityHttp({
      apiKey: KEY,
      fetch: (async () => json({ secret: 'payload Quillfeather' }, 401)) as typeof fetch,
    });
    const result = await http.get('/v2/lists');
    expect(!result.ok && result.error.code).toBe('provider_unauthorized');
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(JSON.stringify(result)).not.toContain('Quillfeather');
  });
});

/* ------------------------------------------------------------------ sync */

describe('syncing Affinity into the CRM', () => {
  it('pulls every list, its rows and records, and the notes, page by page', async () => {
    const fake = fakeAffinity(world());
    const steps = await syncToEnd(fake);
    const last = steps.at(-1)!;
    expect(last).toMatchObject({ done: true, phase: 'done' });
    expect(last.counts).toMatchObject({
      listsDone: 3,
      listsCreated: 3,
      entries: { inserted: 6, updated: 0, errors: 0 },
      notes: { inserted: 3, errors: 0 },
    });

    // Pages were followed: two pages of lists, two of deals, two of notes.
    expect(fake.calls.filter((c) => c.startsWith('/v2/lists?'))).toHaveLength(2);
    expect(fake.calls.filter((c) => c.startsWith('/v2/lists/7001/list-entries'))).toHaveLength(2);
    expect(fake.calls.filter((c) => c.startsWith('/v2/notes'))).toHaveLength(2);
    expect(fake.calls.find((c) => c.startsWith('/v2/lists/7001/list-entries'))).toContain(
      'fieldTypes=list&fieldTypes=global&fieldTypes=enriched&fieldTypes=relationship-intelligence',
    );
    expect(new Set(fake.auth)).toEqual(new Set([`Bearer ${KEY}`]));

    // The deal list: Affinity's pipeline as a status field, in stage order.
    const deals = await affinityList('7001');
    expect(deals).toMatchObject({ name: 'Example Deal Flow', entity_type: 'deal' });
    expect(deals.fields).toEqual([
      {
        key: 'status',
        name: 'Status',
        type: 'status',
        options: ['3. First Meeting', '5. Due Diligence'],
      },
      { key: 'check_size', name: 'Check Size', type: 'money' },
      { key: 'organizations', name: 'Organizations', type: 'company' },
      { key: 'people', name: 'People', type: 'person' },
    ]);
    const rows = await entriesOf(deals.id);
    const seed = rows.find((r) => r.external_id === '81001')!;
    const bridge = rows.find((r) => r.external_id === '81003')!;
    expect(seed).toMatchObject({
      title: 'Quillfeather Seed',
      values: {
        status: '3. First Meeting',
        check_size: 250000,
        organizations: ['Quillfeather'],
        people: ['Avery Lark'],
      },
    });
    const quill = (await recordBy('company', '7201'))!;
    expect(quill).toMatchObject({ name: 'Quillfeather', domain: 'quillfeather.example' });
    // A company's two deals point at the one record.
    expect(seed.record_id).toBe(quill.id);
    expect(bridge.record_id).toBe(quill.id);

    // The person list: list fields as columns, global and relationship fields on the person.
    const founders = await affinityList('7002');
    expect(founders.fields.map((f) => f.key)).toEqual(['intro_source']);
    const avery = (await recordBy('person', '7301'))!;
    expect(avery.emails).toEqual(['avery@quillfeather.example', 'a.lark@mail.example']);
    expect(avery.fields).toEqual({
      Industry: ['Fintech', 'AI'],
      'Last Email': '2026-10-01T15:00:00.000Z',
    });
    const averyRow = (await entriesOf(founders.id)).find((r) => r.external_id === '82001')!;
    expect(averyRow).toMatchObject({ record_id: avery.id, values: { intro_source: 'Conference' } });

    // The company list: a dropdown and a date.
    const watch = await affinityList('7003');
    const [cinder] = await entriesOf(watch.id);
    expect(cinder).toMatchObject({
      title: 'Cindervale',
      values: { priority: 'High', next_review: '2026-10-20' },
    });

    // Notes, linked to what they are about — but never to a teammate.
    const met = (await noteBy('95001'))!;
    expect(met).toMatchObject({
      content: 'Met the Quillfeather team & liked it.\n- Strong founder\n- Seed',
      author: 'Sam Teammate',
      occurred_at: '2026-10-02T16:00:00.000Z',
    });
    expect(new Set(met.record_ids)).toEqual(new Set([quill.id, avery.id]));
    expect(met.entry_ids).toEqual([seed.id]);
    expect(met.entity_names).not.toContain('Sam Teammate');
    expect(await recordBy('person', '1')).toBeNull();
    // A reply sits where its note sits.
    const reply = (await noteBy('95002'))!;
    expect(reply).toMatchObject({ title: 'Reply', content: 'Agreed.' });
    expect(new Set(reply.record_ids)).toEqual(new Set(met.record_ids));
    // A company only a note mentions still gets a record for the note to sit on.
    const northwind = (await recordBy('company', '7299'))!;
    expect((await noteBy('95003'))!.record_ids).toEqual([northwind.id]);
  });

  it('changes nothing when run again, and reads only the notes changed since', async () => {
    const fake = fakeAffinity(world());
    await syncToEnd(fake);
    const before = await counts();
    const listsBefore = await store.list('crm_lists', org, {});

    fake.calls.length = 0;
    clock += 24 * 60 * 60_000;
    const again = (await syncToEnd(fake)).at(-1)!;
    expect(again.counts).toMatchObject({
      listsCreated: 0,
      records: { inserted: 0, updated: 0, errors: 0 },
      entries: { inserted: 0, updated: 0, errors: 0 },
      notes: { inserted: 0, updated: 0, errors: 0 },
    });
    expect(await counts()).toEqual(before);
    expect(await store.list('crm_lists', org, {})).toEqual(listsBefore);
    const notesCall = fake.calls.find((c) => c.startsWith('/v2/notes'))!;
    expect(decodeURIComponent(notesCall)).toContain('createdAt>=2026-10-15T10:00:00Z');
  });

  it('works in bounded steps that resume where the last one stopped', async () => {
    const fake = fakeAffinity(world());
    const steps = await syncToEnd(fake, { maxPages: 1 });
    expect(steps.length).toBeGreaterThan(5);
    expect(steps.slice(0, -1).every((s) => !s.done && s.pages <= 1)).toBe(true);
    expect(steps.at(-1)!.counts.entries.inserted).toBe(6);
    // Each list's first page was read once: no page was read twice.
    const firstPages = fake.calls.filter((c) => /list-entries\?limit=/.test(c));
    expect(firstPages).toHaveLength(3);

    const state = await readAffinitySyncState(store, org);
    expect(state?.run).toBeNull();
    expect(state?.last?.counts.listsDone).toBe(3);
    expect(state?.leaseUntil).toBeNull();
  });

  it('stops a step on a rate limit it cannot wait out, and resumes on the next', async () => {
    const fake = fakeAffinity(world());
    fake.throttle(20, '30');
    const first = value(await runAffinitySyncStep(store, org, options(fake, { budgetMs: 45_000 })));
    expect(first).toMatchObject({ done: false, rateLimited: true });
    clock += 60_000;
    const steps = await syncToEnd(fake);
    expect(steps.at(-1)!.counts.entries.inserted).toBe(6);
  });

  it('skips a page the CRM cannot take after three tries, so the rest still syncs', async () => {
    const fake = fakeAffinity(world());
    // Finding the target of one list fails every time, as a page of bad data would.
    const flaky = new Proxy(store, {
      get(target, prop, receiver) {
        const original = Reflect.get(target, prop, receiver);
        if (typeof original !== 'function') return original;
        return (...args: unknown[]) => {
          const filter = args[2] as { eq?: Record<string, unknown> } | undefined;
          if (prop === 'findOne' && args[0] === 'crm_lists' && filter?.eq?.external_id === '7002') {
            return Promise.reject(new Error('boom'));
          }
          return original.apply(target, args);
        };
      },
    });
    let failures = 0;
    let last: AffinitySyncStep | null = null;
    for (let i = 0; i < 20 && !last?.done; i++) {
      const result = await runAffinitySyncStep(flaky, org, options(fake));
      clock += 1000;
      if (result.ok) last = result.value;
      else failures++;
    }
    expect(failures).toBe(2);
    expect(last).toMatchObject({ done: true, counts: { pagesSkipped: 1 } });
    expect(await store.findOne('crm_lists', org, { eq: { external_id: '7002' } })).toBeNull();
    expect((await affinityList('7003')).name).toBe('Example Watch List');
    expect(await noteBy('95001')).not.toBeNull();
  });

  it('restarts a list from its first page when Affinity refuses a saved cursor', async () => {
    const fake = fakeAffinity(world());
    // A step that stops after one page leaves a cursor for the deal list's second page.
    const first = value(await runAffinitySyncStep(store, org, options(fake, { maxPages: 1 })));
    expect(first).toMatchObject({ done: false, phase: 'lists' });
    expect((await readAffinitySyncState(store, org))?.run?.entriesUrl).toContain('cursor=2');

    // By the next call Affinity no longer takes that cursor (expired, say).
    fake.reject(
      (url) =>
        url.pathname === '/v2/lists/7001/list-entries' && url.searchParams.get('cursor') === '2',
      400,
      1,
    );
    clock += 24 * 60 * 60_000;
    const steps = await syncToEnd(fake);
    expect(steps.at(-1)).toMatchObject({ done: true, counts: { refused: 1, pagesSkipped: 0 } });
    expect(await entriesOf((await affinityList('7001')).id)).toHaveLength(3);
    expect(await entriesOf((await affinityList('7003')).id)).toHaveLength(1);
    expect(await noteBy('95003')).not.toBeNull();
    // The list's first page was read again, and then its second.
    const deals = fake.calls.filter((c) => c.startsWith('/v2/lists/7001/list-entries'));
    expect(deals.filter((c) => !c.includes('cursor='))).toHaveLength(2);
    expect(deals.filter((c) => c.includes('cursor=2'))).toHaveLength(2);
  });

  it('skips a list Affinity refuses from its first page, and the run still finishes', async () => {
    const fake = fakeAffinity(world());
    fake.reject((url) => url.pathname === '/v2/lists/7002/list-entries', 422);
    const steps = await syncToEnd(fake);
    expect(steps.at(-1)).toMatchObject({ done: true, counts: { refused: 1, listsDone: 3 } });
    expect(await store.findOne('crm_lists', org, { eq: { external_id: '7002' } })).toBeNull();
    expect(await entriesOf((await affinityList('7003')).id)).toHaveLength(1);
    expect(await noteBy('95001')).not.toBeNull();
    // The next run starts afresh rather than retrying the refused list forever.
    expect((await readAffinitySyncState(store, org))?.run).toBeNull();
  });

  it('reads every note when Affinity refuses the changed-since filter', async () => {
    const fake = fakeAffinity(world());
    await syncToEnd(fake);
    await store.remove('crm_notes', org, (await noteBy('95003'))!.id);

    fake.calls.length = 0;
    fake.reject((url) => url.pathname === '/v2/notes' && url.searchParams.has('filter'), 400);
    clock += 24 * 60 * 60_000;
    const started = clock;
    const again = (await syncToEnd(fake)).at(-1)!;
    expect(again).toMatchObject({ done: true, counts: { refused: 1 } });
    const notesCalls = fake.calls.filter((c) => c.startsWith('/v2/notes'));
    expect(notesCalls[0]).toContain('filter=');
    expect(notesCalls.slice(1).every((c) => !c.includes('filter='))).toBe(true);
    // Read in full, so nothing changed since is missed, and the watermark moves on.
    expect(await noteBy('95003')).not.toBeNull();
    const state = await readAffinitySyncState(store, org);
    expect(state?.notesWatermark).toBe(new Date(started - 60 * 60_000).toISOString());
  });

  it('gives the notes up for the run when Affinity refuses them all, and keeps the watermark', async () => {
    const fake = fakeAffinity(world());
    await syncToEnd(fake);
    const before = (await readAffinitySyncState(store, org))?.notesWatermark;
    expect(before).not.toBeNull();

    fake.reject((url) => url.pathname === '/v2/notes', 400);
    clock += 24 * 60 * 60_000;
    const again = (await syncToEnd(fake)).at(-1)!;
    // The filtered read, then the full one, both refused: the lists still synced.
    expect(again).toMatchObject({ done: true, counts: { refused: 2, pagesSkipped: 1 } });
    expect(again.counts.entries.unchanged).toBe(6);
    expect((await readAffinitySyncState(store, org))?.notesWatermark).toBe(before);
  });

  it('moves past a page Affinity keeps failing to send on the third call running', async () => {
    const fake = fakeAffinity(world());
    value(await runAffinitySyncStep(store, org, options(fake, { maxPages: 1 })));
    fake.reject(
      (url) =>
        url.pathname === '/v2/lists/7001/list-entries' && url.searchParams.get('cursor') === '2',
      503,
      3,
    );
    let failures = 0;
    let last: AffinitySyncStep | null = null;
    for (let i = 0; i < 20 && !last?.done; i++) {
      const result = await runAffinitySyncStep(store, org, options(fake, { maxRetries: 0 }));
      clock += 1000;
      if (result.ok) last = result.value;
      else failures++;
    }
    // Two outages are waited out; the third restarts the list, which then reads in full.
    expect(failures).toBe(2);
    expect(last).toMatchObject({ done: true, counts: { refused: 1 } });
    expect(await entriesOf((await affinityList('7001')).id)).toHaveLength(3);
  });

  it('never stops at a rate limit or a refused key: those wait or need a person', async () => {
    const fake = fakeAffinity(world());
    fake.reject((url) => url.pathname === '/v2/lists/7001/fields', 401);
    for (let i = 0; i < 4; i++) {
      const result = await runAffinitySyncStep(store, org, options(fake));
      expect(!result.ok && result.error.code).toBe('provider_unauthorized');
      clock += 1000;
    }
    const run = (await readAffinitySyncState(store, org))?.run;
    expect(run).toMatchObject({ listIndex: 0, recoveries: 0, counts: { refused: 0 } });
  });

  it('keeps the notes watermark when a notes page was skipped, so the next run reads it', async () => {
    const fake = fakeAffinity(world());
    // Saving the page that holds note 95003 fails every time, as a database fault would.
    const flaky = new Proxy(store, {
      get(target, prop, receiver) {
        const original = Reflect.get(target, prop, receiver);
        if (typeof original !== 'function') return original;
        return (...args: unknown[]) => {
          const filter = args[2] as { in?: Record<string, unknown[]> } | undefined;
          if (
            prop === 'list' &&
            args[0] === 'crm_notes' &&
            filter?.in?.external_id?.includes('95003')
          ) {
            return Promise.reject(new Error('statement timeout'));
          }
          return original.apply(target, args);
        };
      },
    });
    let last: AffinitySyncStep | null = null;
    for (let i = 0; i < 20 && !last?.done; i++) {
      const result = await runAffinitySyncStep(flaky, org, options(fake));
      clock += 1000;
      if (result.ok) last = result.value;
    }
    expect(last).toMatchObject({ done: true, counts: { pagesSkipped: 1 } });
    expect(await noteBy('95001')).not.toBeNull();
    expect(await noteBy('95003')).toBeNull();
    // The first run read every note; the skipped page means the next must too.
    expect((await readAffinitySyncState(store, org))?.notesWatermark).toBeNull();

    fake.calls.length = 0;
    clock += 24 * 60 * 60_000;
    await syncToEnd(fake);
    expect(fake.calls.find((c) => c.startsWith('/v2/notes'))).not.toContain('filter=');
    expect(await noteBy('95003')).not.toBeNull();
    expect((await readAffinitySyncState(store, org))?.notesWatermark).not.toBeNull();
  });

  it('does nothing while another step holds the lease', async () => {
    const fake = fakeAffinity(world());
    const row: AuditEvent = {
      id: newId(),
      organization_id: org,
      user_id: null,
      action: AFFINITY_SYNC_ACTION,
      entity_type: AFFINITY_SYNC_ENTITY,
      entity_id: null,
      metadata: {
        state: {
          version: 1,
          run: null,
          last: null,
          notesWatermark: null,
          leaseUntil: new Date(clock + 60_000).toISOString(),
          lastError: null,
        },
      },
      ip_hash: null,
      created_at: new Date(clock).toISOString(),
    };
    await store.insert('audit_events', row);
    const step = value(await runAffinitySyncStep(store, org, options(fake)));
    expect(step).toMatchObject({ busy: true, done: false });
    expect(fake.calls).toEqual([]);
  });

  it('updates what the CSV import brought in rather than adding a second copy', async () => {
    // As the CSV import left it: the list under its name with no Affinity id,
    // the deal's row keyed by its opportunity id, its company by name only,
    // and a note keyed by a hash because the export had no note id.
    value(
      await importAffinityList(store, org, {
        kind: 'list',
        list: {
          name: 'Example Deal Flow',
          entityType: 'deal',
          fields: [
            { key: 'status', name: 'Status', type: 'status', options: ['3. First Meeting'] },
            { key: 'check_size', name: 'Check Size', type: 'money' },
          ],
        },
        records: [{ name: 'Quillfeather' }],
        entries: [
          {
            externalId: 'entity:91001',
            title: 'Quillfeather Seed',
            values: { status: '3. First Meeting', check_size: '$250,000' },
            record: 0,
          },
        ],
      }),
    );
    value(
      await importAffinityNotes(store, org, {
        kind: 'notes',
        notes: [
          {
            externalId: 'affinity-csv:0123456789abcdef',
            content: 'Met the Quillfeather team & liked it.\nStrong founder\nSeed',
            author: 'Sam Teammate',
            occurredAt: '2026-10-02T12:00:00.000Z',
            entityNames: ['Quillfeather'],
          },
        ],
      }),
    );
    const csvList = (await store.list('crm_lists', org, {})).find(
      (l) => l.name === 'Example Deal Flow',
    )!;
    expect(csvList.external_id).toBeNull();

    const last = (await syncToEnd(fakeAffinity(world()))).at(-1)!;
    expect(last.counts.notesAdopted).toBe(1);

    // One list, now keyed by its Affinity id, with its own columns kept.
    const named = (await store.list('crm_lists', org, {})).filter(
      (l) => l.name === 'Example Deal Flow',
    );
    expect(named.map((l) => [l.id, l.external_id])).toEqual([[csvList.id, '7001']]);
    expect(named[0]!.fields.find((f) => f.key === 'check_size')?.type).toBe('money');
    // The CSV's row is the synced row, re-keyed by its Affinity row id.
    const rows = await entriesOf(csvList.id);
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.title === 'Quillfeather Seed').map((r) => r.external_id)).toEqual([
      '81001',
    ]);
    // One Quillfeather, which now carries its Affinity id and domain.
    const quills = (await store.list('crm_records', org, { eq: { kind: 'company' } })).filter(
      (r) => r.name === 'Quillfeather',
    );
    expect(quills.map((r) => [r.external_id, r.domain])).toEqual([
      ['7201', 'quillfeather.example'],
    ]);
    // One copy of the note, under its Affinity id, attached to the deal too.
    const notes = (await store.list('crm_notes', org, {})).filter((n) =>
      n.content.startsWith('Met the Quillfeather team'),
    );
    expect(notes.map((n) => n.external_id)).toEqual(['95001']);
    expect(notes[0]!.entry_ids).toEqual([rows.find((r) => r.external_id === '81001')!.id]);
  });

  it('says the CRM is not set up, and touches nothing, before the migration', async () => {
    const fake = fakeAffinity(world());
    const missing = new Proxy(store, {
      get(target, prop, receiver) {
        const original = Reflect.get(target, prop, receiver);
        if (typeof original !== 'function') return original;
        return (...args: unknown[]) =>
          typeof args[0] === 'string' && args[0].startsWith('crm_')
            ? Promise.reject(
                Object.assign(new Error("Could not find the table 'public.crm_lists'"), {
                  code: 'PGRST205',
                }),
              )
            : original.apply(target, args);
      },
    });
    const result = await runAffinitySyncStep(missing, org, options(fake));
    expect(!result.ok && result.error.code).toBe('not_configured');
    expect(fake.calls).toEqual([]);
  });

  it('never writes the key into its saved progress', async () => {
    await syncToEnd(fakeAffinity(world()));
    const rows = await store.list('audit_events', org, {
      eq: { action: AFFINITY_SYNC_ACTION },
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain(KEY);
  });

  it('fills exactly one workspace, and refuses to guess between several', async () => {
    expect(value(await affinitySyncOrganization(store))).toBe(org);
    const { addSecondOrganization } = await import('../helpers/harness');
    await addSecondOrganization(harness);
    const result = await affinitySyncOrganization(store);
    expect(!result.ok && result.error.code).toBe('conflict');
  });
});

/* ----------------------------------------------------------------- route */

describe('POST /api/cron/affinity-sync', () => {
  const call = async (token: string) => {
    const { POST } = await import('@/app/api/cron/affinity-sync/route');
    return POST(
      new NextRequest('http://localhost/api/cron/affinity-sync', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      }),
    );
  };

  it('refuses a caller without the cron secret', async () => {
    process.env.CRON_SECRET = 'test-cron-secret-0000';
    resetEnvCache();
    expect((await call('wrong')).status).toBe(401);
  });

  it('answers configured:false and does nothing without AFFINITY_API_KEY', async () => {
    process.env.CRON_SECRET = 'test-cron-secret-0000';
    delete process.env.AFFINITY_API_KEY;
    resetEnvCache();
    const send = vi.fn();
    vi.stubGlobal('fetch', send);
    const response = await call('test-cron-secret-0000');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, configured: false, done: true });
    expect(send).not.toHaveBeenCalled();
    expect(await readAffinitySyncState(store, org)).toBeNull();
  });

  it('runs a step and answers with counts only', async () => {
    process.env.CRON_SECRET = 'test-cron-secret-0000';
    process.env.AFFINITY_API_KEY = KEY;
    resetEnvCache();
    vi.stubGlobal('fetch', fakeAffinity(world(), 100).fetch);
    const response = await call('test-cron-secret-0000');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, configured: true, done: true, phase: 'done' });
    expect(body.counts.entries.inserted).toBe(6);
    const text = JSON.stringify(body);
    for (const secret of [KEY, 'Quillfeather', 'Example Deal Flow', 'Avery', 'Met the']) {
      expect(text).not.toContain(secret);
    }
  });
});

/* ---------------------------------------------------------------- status */

describe('the status the Affinity import tab shows', () => {
  it('reports the last run with counts, and never the key', async () => {
    process.env.DEMO_MODE = 'false';
    process.env.AFFINITY_API_KEY = KEY;
    resetEnvCache();
    try {
      await syncToEnd(fakeAffinity(world()));
      const status = await getAffinitySyncStatus(store, org);
      expect(status).toMatchObject({
        configured: true,
        demo: false,
        running: false,
        lastRun: { lists: 3, rows: 6, notes: 3 },
        lastError: null,
      });
      expect(JSON.stringify(status)).not.toContain(KEY);
    } finally {
      process.env.DEMO_MODE = 'true';
    }
  });

  it('shows an invented example in the demo', async () => {
    const status = await getAffinitySyncStatus(store, org);
    expect(status).toMatchObject({ demo: true, configured: true });
    expect(status.lastRun?.lists).toBeGreaterThan(0);
  });
});
