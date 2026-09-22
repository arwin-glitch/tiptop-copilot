import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '@/lib/config/env';
import { getStore, resetRuntime } from '@/lib/runtime';
import type { RoutineBriefing } from '@/lib/types/domain';

/**
 * Next memoizes identical GET fetches for the length of one server render,
 * and the only opt-out is an AbortSignal on the request. Without one, the
 * Today page's pull-then-read ran two identical PostgREST GETs and the read
 * got the pre-write rows back — the page showed the briefing it had just
 * replaced, and the pull's own unchanged-check compared against stale rows.
 * So every request the real store sends must carry a signal.
 */

const SAVED = { ...process.env };
const ORG = '00000000-0000-4000-8000-000000000001';

let calls: Array<RequestInit | undefined>;

beforeEach(() => {
  delete process.env.DEMO_MODE;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abcdefgh.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_example';
  resetEnvCache();
  resetRuntime();
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init);
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

describe('the Supabase store opts out of per-render fetch memoization', () => {
  it('sends every read and write with its own abort signal', async () => {
    const store = getStore();
    const now = new Date().toISOString();
    const row: RoutineBriefing = {
      id: '00000000-0000-4000-8000-000000000002',
      organization_id: ORG,
      kind: 'morning',
      date_key: '2026-09-22',
      title: 'Morning Brief',
      summary: 'Nothing new.',
      source_url: null,
      posted_at: now,
      updated_at: now,
    };

    await store.findOne('routine_briefings', ORG, { eq: { kind: 'morning' } });
    await store.list('routine_briefings', ORG, {});
    await store.upsert('routine_briefings', row, ['organization_id', 'kind']);

    // findOne, list, and upsert's own probe + write.
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const init of calls) {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    // One shared signal would couple unrelated requests' lifetimes.
    expect(new Set(calls.map((init) => init?.signal)).size).toBe(calls.length);
  });
});
