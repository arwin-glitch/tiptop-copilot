import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { assertScoped, scopeless } from '@/lib/db/store';
import { soleOrganizationId } from '@/lib/db/tenancy';
import type { Integration } from '@/lib/types/domain';

/**
 * Querying a scoped table without an organization.
 *
 * This is the shape of a bug that ran in production for months while every
 * suite passed. The Gmail push handler listed `integrations` with an empty
 * organization id, meaning "every tenant" — something this interface cannot
 * express. The two stores then disagreed about what it meant:
 *
 *   demo store  →  organization_id === ''  matches nothing  →  []
 *   Supabase    →  organization_id = ''    →  Postgres: invalid input syntax
 *                                              for type uuid: ""
 *
 * So the endpoint threw on every push notification in production, was caught,
 * logged, answered 2xx, and looked healthy — while the tests, which run on the
 * demo store, saw an empty list and were satisfied.
 *
 * The fix is not just the one call site. It is that both stores now refuse the
 * query identically, so the next person to write it finds out here rather than
 * in a log nobody reads.
 */

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.dispose();
});

describe('the empty-organization guard', () => {
  it('refuses to read a scoped table with no organization', async () => {
    await expect(harness.store.list('integrations', '', {})).rejects.toThrow(/organization id/i);
  });

  it('names the table, so the message points at the call site', async () => {
    await expect(harness.store.list('deals', '', {})).rejects.toThrow(/\[deals\]/);
  });

  it('covers every read that takes an organization, not just list', async () => {
    await expect(harness.store.get('deals', '', 'some-id')).rejects.toThrow(/organization id/i);
    await expect(harness.store.findOne('deals', '', { eq: { id: 'x' } })).rejects.toThrow(
      /organization id/i,
    );
    await expect(harness.store.count('deals', '')).rejects.toThrow(/organization id/i);
    await expect(harness.store.removeWhere('deals', '', { eq: { id: 'x' } })).rejects.toThrow(
      /organization id/i,
    );
  });

  it('still allows the scopeless tables, which have no organization column', async () => {
    // `organizations` is how a machine endpoint finds its tenant in the first
    // place. Guarding it would break the very lookup that fixes the bug.
    const organizations = await harness.store.list('organizations', '', {});
    expect(organizations.length).toBeGreaterThan(0);
  });

  it('agrees with itself about which tables are scopeless', () => {
    expect(scopeless('organizations')).toBe(true);
    expect(scopeless('organization_members')).toBe(true);
    expect(scopeless('user_profiles')).toBe(true);
    expect(scopeless('integrations')).toBe(false);
    expect(scopeless('meeting_notes')).toBe(false);

    // The guard is a pure function of those two things; assert it directly so
    // a change to `scopeless` cannot quietly widen what may go unscoped.
    expect(() => assertScoped('organizations', '')).not.toThrow();
    expect(() => assertScoped('integrations', '')).toThrow();
    expect(() => assertScoped('integrations', 'an-organization')).not.toThrow();
  });
});

describe('resolving the organization for a machine endpoint', () => {
  it('returns the only organization there is', async () => {
    const id = await soleOrganizationId('test');
    expect(id).toBe(harness.auth.organizationId);
  });

  it('is what makes a scoped read possible from an endpoint with no session', async () => {
    // The corrected shape of the Gmail push handler: resolve, then scope.
    const organizationId = await soleOrganizationId('test');
    expect(organizationId).toBeTruthy();

    const integrations = (await harness.store.list('integrations', organizationId!, {
      eq: { provider: 'google' },
    })) as Integration[];
    // Whether any exist depends on fixtures; not throwing is the assertion.
    expect(Array.isArray(integrations)).toBe(true);
  });
});
