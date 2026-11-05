import type { Space, SpaceMember, SpaceRule } from '@/lib/types/domain';
import { DEMO_IDS, demoSpaceId } from './ids';

/**
 * The demo's Spaces (fictional, like every fixture): one for Ledgerly, the
 * demo portfolio company with mail, a board-prep meeting and a meeting note,
 * so each tab has something in it. Its owner is the demo user; the demo
 * teammate is invited and has not answered yet, so the members tab shows an
 * invite waiting.
 */
export function demoSpaces(now: Date): {
  spaces: Space[];
  space_rules: SpaceRule[];
  space_members: SpaceMember[];
  space_hidden_items: never[];
} {
  const at = new Date(now.getTime() - 3 * 24 * 60 * 60_000).toISOString();
  const org = DEMO_IDS.org;
  const space = demoSpaceId('space', 0);
  return {
    spaces: [
      {
        id: space,
        organization_id: org,
        name: 'Ledgerly',
        description: 'Portfolio company: Series A prep, board and hiring.',
        source_kind: 'suggested',
        source_ref: 'ledgerly.demo',
        created_by: DEMO_IDS.user,
        archived_at: null,
        created_at: at,
        updated_at: at,
      },
    ],
    space_rules: [
      {
        id: demoSpaceId('rule', 0),
        organization_id: org,
        space_id: space,
        kind: 'domain',
        value: 'ledgerly.demo',
        created_at: at,
      },
    ],
    space_members: [
      {
        id: demoSpaceId('member', 0),
        organization_id: org,
        space_id: space,
        user_id: DEMO_IDS.user,
        role: 'owner',
        status: 'accepted',
        invited_by: null,
        accepted_at: at,
        created_at: at,
        updated_at: at,
      },
      {
        id: demoSpaceId('member', 1),
        organization_id: org,
        space_id: space,
        user_id: DEMO_IDS.userTeammate,
        role: 'member',
        status: 'invited',
        invited_by: DEMO_IDS.user,
        accepted_at: null,
        created_at: at,
        updated_at: at,
      },
    ],
    space_hidden_items: [],
  };
}
