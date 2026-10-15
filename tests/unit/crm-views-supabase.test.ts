import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '@/lib/config/env';
import { compileEntryFilter } from '@/lib/crm/saved-views';
import { getStore, resetRuntime } from '@/lib/runtime';
import type { CrmField } from '@/lib/types/domain';

/**
 * A saved view's conditions on the wire: what PostgREST receives for each
 * kind of condition, so the Supabase half of the filter contract is pinned
 * the way the demo half is by the in-memory tests.
 */

const SAVED = { ...process.env };
const ORG = '00000000-0000-4000-8000-000000000001';
let urls: URL[];

beforeEach(() => {
  delete process.env.DEMO_MODE;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abcdefgh.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_example';
  resetEnvCache();
  resetRuntime();
  urls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      urls.push(new URL(typeof input === 'string' ? input : input.toString()));
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of Object.keys(process.env)) {
    if (!(key in SAVED)) delete process.env[key];
  }
  Object.assign(process.env, SAVED);
  resetEnvCache();
  resetRuntime();
});

const FIELDS: CrmField[] = [
  { key: 'status', name: 'Status', type: 'status', options: ['Open', 'Won'] },
  { key: 'amount', name: 'Amount', type: 'money' },
  { key: 'owners', name: 'Owners', type: 'person' },
  { key: 'industry', name: 'Industry', type: 'multi' },
  { key: 'added', name: 'Added', type: 'date' },
  { key: 'notes', name: 'Notes', type: 'text' },
];

describe('saved-view conditions through PostgREST', () => {
  it('sends ranges, substrings, element matches and emptiness on JSON paths', async () => {
    const filter = compileEntryFilter({ eq: { list_id: 'list-1' } }, FIELDS, {
      statusKey: 'status',
      statuses: ['Open'],
      conditions: [
        { key: 'amount', op: 'gte', value: 1_000_000 },
        { key: 'added', op: 'lte', value: '2026-03-31' },
        { key: 'owners', op: 'contains', value: 'ada' },
        { key: 'industry', op: 'is', value: 'AI' },
        { key: 'notes', op: 'empty' },
      ],
    });
    await getStore().list('crm_list_entries', ORG, filter);
    const params = urls[0]!.searchParams;
    expect(params.get('values->>status')).toBe('in.(Open)');
    expect(params.get('values->amount')).toBe('gte.1000000');
    expect(params.get('values->>added')).toBe('lt.2026-04-01');
    expect(params.get('values->>owners')).toBe('ilike.%ada%');
    expect(params.get('values->>industry')).toBe('ilike.%"AI"%');
    expect(params.get('values->>notes')).toBe('is.null');
  });

  it('keeps a substring literal: LIKE wildcards escaped, a star matching one character', async () => {
    await getStore().list('crm_list_entries', ORG, {
      textContains: { 'values->>notes': '50%_off\\now*' },
    });
    expect(urls[0]!.searchParams.get('values->>notes')).toBe('ilike.%50\\%\\_off\\\\now_%');
  });

  it('sends nothing for an empty substring', async () => {
    await getStore().list('crm_list_entries', ORG, { textContains: { 'values->>notes': '' } });
    expect(urls[0]!.searchParams.has('values->>notes')).toBe(false);
  });
});
