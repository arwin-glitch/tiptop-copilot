import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '@/lib/config/env';
import { resetLimiters } from '@/lib/security/limits';
import type { UpdatesSnapshot } from '@/lib/updates/types';

/**
 * The Refresh button's server action: it signs the caller in before anything
 * else, is limited per user, and reads nothing while the tab is closed. The
 * reader itself is replaced; the service tests cover it.
 */

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  readUpdates: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  requireAuth: mocks.requireAuth,
}));
vi.mock('@/lib/services/updates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/updates')>()),
  readUpdates: mocks.readUpdates,
}));

const { refreshUpdatesAction } = await import('@/app/actions');

const SNAPSHOT: UpdatesSnapshot = {
  sources: [],
  workspace: { botHandle: null, url: null },
  setup: null,
  throttled: false,
  checkedAt: '2026-09-23T15:00:00.000Z',
};
const SAVED = { ...process.env };

beforeEach(() => {
  resetLimiters();
  mocks.requireAuth.mockReset().mockResolvedValue({ userId: 'user-invented-1' });
  mocks.readUpdates.mockReset().mockResolvedValue(SNAPSHOT);
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in SAVED)) delete process.env[key];
  }
  Object.assign(process.env, SAVED);
  resetEnvCache();
});

describe('refreshUpdatesAction', () => {
  it('reads nothing for a caller who is not signed in', async () => {
    mocks.requireAuth.mockRejectedValue(new Error('NEXT_REDIRECT'));
    await expect(refreshUpdatesAction()).rejects.toThrow('NEXT_REDIRECT');
    expect(mocks.readUpdates).not.toHaveBeenCalled();
  });

  it('forces a read, and stops a seventh press inside a minute', async () => {
    for (let i = 0; i < 6; i++) {
      expect((await refreshUpdatesAction()).ok).toBe(true);
    }
    expect(mocks.readUpdates).toHaveBeenCalledTimes(6);
    expect(mocks.readUpdates.mock.calls[0]?.[1]).toEqual({ force: true });

    const seventh = await refreshUpdatesAction();
    expect(seventh.ok).toBe(false);
    expect(seventh.error?.code).toBe('rate_limited');
    expect(mocks.readUpdates).toHaveBeenCalledTimes(6);
  });

  it('reads nothing while sign-in is unrestricted', async () => {
    process.env.DEMO_MODE = 'false';
    delete process.env.AUTH_ALLOWED_EMAIL_DOMAINS;
    resetEnvCache();
    const result = await refreshUpdatesAction();
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('not_configured');
    expect(mocks.readUpdates).not.toHaveBeenCalled();
  });

  it('reads the live channels once sign-in is limited', async () => {
    process.env.DEMO_MODE = 'false';
    process.env.AUTH_ALLOWED_EMAIL_DOMAINS = 'example.com';
    resetEnvCache();
    expect((await refreshUpdatesAction()).ok).toBe(true);
    const feed = mocks.readUpdates.mock.calls[0]?.[0] as { sources: { key: string }[] };
    expect(feed.sources.map((s) => s.key)).toEqual(['pef', 'openvc', 'referral', 'digest']);
  });
});
