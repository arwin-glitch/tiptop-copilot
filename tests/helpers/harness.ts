import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { AuthContext } from '@/lib/auth/session';
import { DemoStore } from '@/lib/db/demo-store';
import type { DataStore } from '@/lib/db/store';
import { buildDemoDb } from '@/lib/demo/fixtures';
import { DEMO_IDS } from '@/lib/demo/ids';
import { resetRuntime, setStoreForTesting } from '@/lib/runtime';
import { resetLimiters } from '@/lib/security/limits';
import { resetEnvCache } from '@/lib/config/env';
import type { Organization, OrganizationMember, UserProfile } from '@/lib/types/domain';

/**
 * Integration harness.
 *
 * Each test gets an isolated on-disk store seeded from the same fixtures the
 * demo uses. Services are exercised through their real entry points — nothing
 * is stubbed except the model provider, which is the deterministic offline one.
 */

let counter = 0;

export interface Harness {
  store: DataStore;
  auth: AuthContext;
  dispose: () => Promise<void>;
}

export async function createHarness(options: { now?: Date } = {}): Promise<Harness> {
  const now = options.now ?? new Date();
  const dir = path.join('.demo-data', 'test', `run-${process.pid}-${++counter}`);

  resetEnvCache();
  resetRuntime();
  resetLimiters();

  const store = new DemoStore(() => buildDemoDb(now) as never, dir);
  await store.reset();
  setStoreForTesting(store);

  const organization = (await store.organizationById(DEMO_IDS.org)) as Organization;
  const profile = (await store.userProfileById(DEMO_IDS.user)) as UserProfile;
  const memberships = await store.membershipsForUser(DEMO_IDS.user);
  const membership = memberships[0] as OrganizationMember;

  return {
    store,
    auth: {
      userId: DEMO_IDS.user,
      organizationId: DEMO_IDS.org,
      role: membership.role,
      profile,
      organization,
      isDemo: true,
    },
    dispose: async () => {
      setStoreForTesting(null);
      resetRuntime();
      await rm(path.join(process.cwd(), dir), { recursive: true, force: true });
    },
  };
}

/**
 * A second organization sharing the same store, used to prove that a caller
 * from one organization cannot see another's records.
 */
export async function addSecondOrganization(harness: Harness): Promise<AuthContext> {
  const otherOrgId = '11111111-1111-4111-8111-111111111111';
  const otherUserId = '22222222-2222-4222-8222-222222222222';
  const now = new Date().toISOString();

  const organization: Organization = {
    id: otherOrgId,
    name: 'Other Fund',
    slug: 'other-fund',
    created_at: now,
    updated_at: now,
  };
  await harness.store.insert('organizations', organization);

  const profile: UserProfile = {
    id: otherUserId,
    email: 'other@otherfund.demo',
    full_name: 'Other Partner',
    avatar_url: null,
    timezone: 'America/New_York',
    theme: 'system',
    created_at: now,
    updated_at: now,
  };
  await harness.store.upsertUserProfile(profile);

  await harness.store.insert('organization_members', {
    id: 'member-other',
    organization_id: otherOrgId,
    user_id: otherUserId,
    role: 'owner',
    created_at: now,
  });

  return {
    userId: otherUserId,
    organizationId: otherOrgId,
    role: 'owner',
    profile,
    organization,
    isDemo: true,
  };
}
