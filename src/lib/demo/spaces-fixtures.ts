import type { Space, SpaceMember, SpaceRule } from '@/lib/types/domain';
import { DEMO_IDS, demoSpaceId } from './ids';

/**
 * The demo's Spaces (fictional, like every fixture): one for Ledgerly, the
 * demo portfolio company with mail, a board-prep meeting and a meeting note,
 * so each tab has something in it. Its owner is the demo user; the demo
 * teammate is invited and has not answered yet, so the members tab shows an
 * invite waiting.
 *
 * And one for Stonebridge Ops that the teammate accepted, with their own
 * Google connected read-only (space-member-fixtures.ts): its Emails and
 * Meeting log show the teammate's matching mail and meetings beside the main
 * mailbox's, each labelled as theirs (D-081). Their Ledgerly mail stays out:
 * they have not accepted that one.
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
  const stonebridge = demoSpaceId('space', 1);
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
      {
        id: stonebridge,
        organization_id: org,
        name: 'Stonebridge Ops',
        description: 'Portfolio company: founding engineer search and warehouse pilots.',
        source_kind: 'company',
        source_ref: 'stonebridgeops.demo',
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
      {
        id: demoSpaceId('rule', 1),
        organization_id: org,
        space_id: stonebridge,
        kind: 'domain',
        value: 'stonebridgeops.demo',
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
      {
        id: demoSpaceId('member', 2),
        organization_id: org,
        space_id: stonebridge,
        user_id: DEMO_IDS.user,
        role: 'owner',
        status: 'accepted',
        invited_by: null,
        accepted_at: at,
        created_at: at,
        updated_at: at,
      },
      {
        id: demoSpaceId('member', 3),
        organization_id: org,
        space_id: stonebridge,
        user_id: DEMO_IDS.userTeammate,
        role: 'member',
        status: 'accepted',
        invited_by: DEMO_IDS.user,
        accepted_at: at,
        created_at: at,
        updated_at: at,
      },
    ],
    space_hidden_items: [],
  };
}
