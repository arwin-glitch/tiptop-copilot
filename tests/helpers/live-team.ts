import type { AuthContext } from '@/lib/auth/session';
import type { DataStore } from '@/lib/db/store';
import { DEMO_TEAMMATE } from '@/lib/demo/fixtures';
import { DEMO_IDS } from '@/lib/demo/ids';
import type { OrganizationMember, UserProfile } from '@/lib/types/domain';

/**
 * The demo store in the shape of a real team: the teammate set the
 * organization up, so is its only owner, and connected the mailbox, which is
 * the demo user's; the demo user is a member. The organization's work is the
 * demo user's all the same: they are the principal, by the mailbox address.
 * Returns the two people to act as.
 */
export async function makeLiveTeam(
  store: DataStore,
  auth: AuthContext,
): Promise<{ principal: AuthContext; assistant: AuthContext }> {
  const org = auth.organizationId;
  const members = (await store.list('organization_members', org, {
    eq: { organization_id: org },
  })) as OrganizationMember[];
  for (const member of members) {
    await store.update('organization_members', org, member.id, {
      role: member.user_id === DEMO_TEAMMATE.id ? 'owner' : 'member',
    });
  }
  await store.update('integrations', org, DEMO_IDS.integrationGoogle, {
    user_id: DEMO_TEAMMATE.id,
  });
  const profile = (await store.userProfileById(DEMO_TEAMMATE.id)) as UserProfile;
  return {
    principal: { ...auth, role: 'member' },
    assistant: { ...auth, userId: DEMO_TEAMMATE.id, role: 'owner', profile },
  };
}
