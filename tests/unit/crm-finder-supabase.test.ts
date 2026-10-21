import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '@/lib/config/env';
import { normalizeFinderCriteria } from '@/lib/crm/finder';
import { getStore, resetRuntime } from '@/lib/runtime';
import { findCrmRecords } from '@/lib/services/crm-finder';

/**
 * Find & save on the wire: the place narrows the read in PostgREST itself,
 * as an OR of case-insensitive matches on the record's place-like fields, so
 * "people in Austin" never reads every person in the CRM. The demo store
 * evaluates the same filter in memory (crm-finder.test.ts).
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

describe('Find & save through PostgREST', () => {
  it('narrows people by place on JSON paths, by the longest part of the place', async () => {
    const result = await findCrmRecords(
      getStore(),
      ORG,
      normalizeFinderCriteria({ kind: 'person', place: 'Austin, TX', years: 3 }),
    );
    expect(result.ok && result.value.total).toBe(0);
    const url = urls[0]!;
    expect(url.pathname).toBe('/rest/v1/crm_records');
    expect(url.searchParams.get('kind')).toBe('eq.person');
    expect(url.searchParams.get('or')).toBe(
      '(fields->>Location.ilike.%Austin%,fields->>Locations.ilike.%Austin%,fields->>City.ilike.%Austin%,fields->>Headquarters.ilike.%Austin%,fields->>HQ.ilike.%Austin%,fields->>Metro.ilike.%Austin%,fields->>Region.ilike.%Austin%)',
    );
  });

  it('narrows by name, email or domain when one is typed', async () => {
    await findCrmRecords(
      getStore(),
      ORG,
      normalizeFinderCriteria({ kind: 'company', q: 'tallgrass', place: 'Austin' }),
    );
    const url = urls[0]!;
    expect(url.searchParams.get('kind')).toBe('eq.company');
    expect(url.searchParams.get('or')).toBe(
      '(name.ilike.%tallgrass%,domain.ilike.%tallgrass%,primary_email.ilike.%tallgrass%)',
    );
  });
});
