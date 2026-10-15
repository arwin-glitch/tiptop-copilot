import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '@/lib/config/env';
import { isMissingTableError } from '@/lib/db/missing-table';
import { getStore, resetRuntime } from '@/lib/runtime';
import { getCrmSetup } from '@/lib/services/crm';

/**
 * What the CRM's filters look like on the wire. The demo store evaluates the
 * same Filter in memory, so these pin the Supabase half of the contract: JSON
 * paths reach PostgREST in its own syntax, values containing quotes are
 * escaped rather than breaking the request, and a missing table's PostgREST
 * code survives onto the thrown error.
 */

const SAVED = { ...process.env };
const ORG = '00000000-0000-4000-8000-000000000001';

let urls: URL[];
let respond: (init?: RequestInit) => Response;

beforeEach(() => {
  delete process.env.DEMO_MODE;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abcdefgh.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_example';
  resetEnvCache();
  resetRuntime();
  urls = [];
  respond = () =>
    new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(new URL(typeof input === 'string' ? input : input.toString()));
      return respond(init);
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

describe('CRM filters through PostgREST', () => {
  it('filters and orders on JSON paths', async () => {
    await getStore().list(
      'crm_list_entries',
      ORG,
      { eq: { list_id: 'list-1' }, in: { 'values->>status': ['Open', 'Won'] } },
      { orderBy: [{ field: 'values->amount', direction: 'desc' }], limit: 50 },
    );
    const url = urls[0]!;
    expect(url.searchParams.get('values->>status')).toBe('in.(Open,Won)');
    expect(url.searchParams.get('order')).toBe('values->amount.desc.nullslast');
  });

  it('escapes a quote inside an `in` value instead of breaking the list', async () => {
    await getStore().list('crm_list_entries', ORG, {
      in: { 'values->>status': ['Passed - "too early"', 'Won'] },
    });
    expect(urls[0]!.searchParams.get('values->>status')).toBe(
      'in.("Passed - \\"too early\\"","Won")',
    );
  });

  it('sends a prefix search as a trailing wildcard only', async () => {
    await getStore().list('crm_records', ORG, {
      textSearch: { columns: ['name'], query: 'Kin', mode: 'prefix' },
    });
    await getStore().list('crm_records', ORG, {
      textSearch: { columns: ['name', 'domain'], query: 'Kin' },
    });
    expect(urls[0]!.searchParams.get('or')).toBe('(name.ilike.Kin%)');
    expect(urls[1]!.searchParams.get('or')).toBe('(name.ilike.%Kin%,domain.ilike.%Kin%)');
  });

  it('sends array overlap as a quoted array literal', async () => {
    await getStore().list('crm_records', ORG, {
      arrayOverlaps: { emails: ['a@one.example', 'b,c@two.example'] },
    });
    expect(urls[0]!.searchParams.get('emails')).toBe('ov.{"a@one.example","b,c@two.example"}');
  });

  it('keeps the PostgREST code on the error a missing table throws', async () => {
    respond = () =>
      new Response(
        JSON.stringify({
          code: 'PGRST205',
          message: "Could not find the table 'public.crm_lists' in the schema cache",
          details: null,
          hint: null,
        }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      );
    const error = await getStore()
      .list('crm_lists', ORG, {})
      .catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe('PGRST205');
    expect(isMissingTableError(error)).toBe(true);
  });

  it('probes setup with a read, because a count of a missing table reads as zero', async () => {
    // PostgREST answers a missing table with 404 + PGRST205; a HEAD response
    // has no body, and postgrest-js turns a bodiless 404 into an empty success.
    respond = (init) =>
      init?.method === 'HEAD'
        ? new Response(null, { status: 404 })
        : new Response(
            JSON.stringify({
              code: 'PGRST205',
              message: "Could not find the table 'public.crm_notes' in the schema cache",
            }),
            { status: 404, headers: { 'content-type': 'application/json' } },
          );
    expect(await getStore().count('crm_notes', ORG)).toBe(0);
    expect(await getCrmSetup(getStore(), ORG)).toEqual({
      ready: false,
      missing: ['crm_lists', 'crm_records', 'crm_list_entries', 'crm_notes'],
    });
  });
});
