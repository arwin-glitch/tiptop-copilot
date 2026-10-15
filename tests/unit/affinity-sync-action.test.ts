import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addSecondOrganization, createHarness, type Harness } from '../helpers/harness';
import { resetEnvCache } from '@/lib/config/env';
import type { AuthContext } from '@/lib/auth/session';

/**
 * "Sync now" on Knowledge → Affinity import: the server action is the
 * owner's, never runs in the demo, needs the key, and only fills the one
 * workspace the deployment's key belongs to. Affinity itself is a stubbed
 * fetch answering with one invented, empty list; the sync's own behaviour is
 * covered in affinity-sync.test.ts.
 */

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn() }));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  requireAuth: mocks.requireAuth,
}));

const { syncAffinityNowAction } = await import('@/app/actions/affinity-sync');

const KEY = 'test-affinity-key-not-a-real-one-0000';

/** One invented list with no entries, and no notes. */
const affinity = vi.fn(async (input: RequestInfo | URL) => {
  const path = new URL(String(input)).pathname;
  const data = path === '/v2/lists' ? [{ id: 7101, name: 'Example Scouts', type: 'person' }] : [];
  return new Response(JSON.stringify({ data, pagination: { nextUrl: null } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
});

let harness: Harness;
let owner: AuthContext;

beforeEach(async () => {
  harness = await createHarness();
  owner = { ...harness.auth, role: 'owner', isDemo: false };
  mocks.requireAuth.mockReset().mockResolvedValue(owner);
  affinity.mockClear();
  vi.stubGlobal('fetch', affinity);
  process.env.AFFINITY_API_KEY = KEY;
  resetEnvCache();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.AFFINITY_API_KEY;
  resetEnvCache();
  await harness.dispose();
});

describe('syncAffinityNowAction', () => {
  it('is the owner’s alone', async () => {
    mocks.requireAuth.mockResolvedValue({ ...owner, role: 'member' });
    const result = await syncAffinityNowAction();
    expect(result).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(affinity).not.toHaveBeenCalled();
  });

  it('never calls Affinity in the demo', async () => {
    mocks.requireAuth.mockResolvedValue({ ...owner, isDemo: true });
    const result = await syncAffinityNowAction();
    expect(result).toMatchObject({ ok: true, data: { done: true } });
    expect(affinity).not.toHaveBeenCalled();
  });

  it('says to add the key when there is none', async () => {
    delete process.env.AFFINITY_API_KEY;
    resetEnvCache();
    const result = await syncAffinityNowAction();
    expect(result).toMatchObject({ ok: false, error: { code: 'not_configured' } });
    expect(result.error?.message).toContain('AFFINITY_API_KEY');
  });

  it('runs the sync and answers with counts only', async () => {
    let result = await syncAffinityNowAction();
    for (let i = 0; i < 10 && result.ok && !result.data?.done; i++) {
      result = await syncAffinityNowAction();
    }
    expect(result).toMatchObject({ ok: true, data: { done: true, phase: 'done' } });
    expect(result.data?.counts).toMatchObject({ listsDone: 1, listsCreated: 1 });
    expect(JSON.stringify(result)).not.toContain('Example Scouts');
    expect(JSON.stringify(result)).not.toContain(KEY);
    const list = await harness.store.findOne('crm_lists', owner.organizationId, {
      eq: { source: 'affinity', external_id: '7101' },
    });
    expect(list?.name).toBe('Example Scouts');
  });

  it('refuses when the deployment has more than one workspace', async () => {
    await addSecondOrganization(harness);
    const result = await syncAffinityNowAction();
    expect(result).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(affinity).not.toHaveBeenCalled();
  });
});
