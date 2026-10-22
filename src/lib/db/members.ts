import type { OrganizationMember } from '@/lib/types/domain';
import type { DataStore } from './store';

/**
 * One organization's members.
 *
 * `organization_members` is one of the scopeless tables (`scopeless` in
 * store.ts): the organization id `list` takes does not filter it, in either
 * store, so `list('organization_members', orgId, {})` returns every
 * organization's members. Read members through here, which filters on the
 * column itself; tests/unit/member-reads.test.ts keeps it the only way.
 */
export async function listOrganizationMembers(
  store: DataStore,
  organizationId: string,
): Promise<OrganizationMember[]> {
  if (!organizationId) {
    // The same programming error `assertScoped` refuses for scoped tables.
    throw new Error('[organization_members] read has no organization id.');
  }
  return (await store.list('organization_members', organizationId, {
    eq: { organization_id: organizationId },
  })) as OrganizationMember[];
}
