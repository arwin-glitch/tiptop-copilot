import type { Task } from '@/lib/types/domain';
import { choosePrincipal, type MailboxRow, type TeamMember } from './principal';

/**
 * What supabase/data-fixes/20261021002000_tasks_to_principal.sql moves, said
 * in TypeScript so tests can pin it (the repo has no Postgres to run SQL
 * against). The file is the one-off fix for tasks filed under the
 * organization's owner before tasks went to the principal by default; the
 * app never runs this.
 *
 * A task moves to its organization's principal when it is assigned to an
 * owner-role member who is not the principal, was not added by a person
 * (`source` is not 'human'), nobody ever chose its assignee (no
 * `task.assigned` audit row), and it is open or snoozed. Each move writes a
 * `task.assigned` audit row as the app's own assign does, which is also why
 * a second run moves nothing.
 */

/**
 * The statuses the fix moves. A done task stays: it is history, and moving
 * it would set the proof check judging work someone else already did from
 * their own mailbox. A deleted (cancelled) one stays too.
 */
export const DEFAULT_OWNER_FIX_STATUSES = ['open', 'snoozed'] as const;

/** The `reason` on each move's audit row. */
export const DEFAULT_OWNER_FIX_REASON = 'default owner fix';

export interface DefaultOwnerFixOrganization {
  id: string;
  members: readonly TeamMember[];
  integrations: readonly MailboxRow[];
}

export interface DefaultOwnerFixMove {
  taskId: string;
  organizationId: string;
  from: string;
  to: string;
  /** The audit row the move writes, as `recordAudit` would. */
  audit: {
    organization_id: string;
    user_id: null;
    action: 'task.assigned';
    entity_type: 'task';
    entity_id: string;
    metadata: { from: string; to: string; reason: typeof DEFAULT_OWNER_FIX_REASON };
  };
}

export function planDefaultOwnerFix(input: {
  organizations: readonly DefaultOwnerFixOrganization[];
  tasks: readonly Pick<Task, 'id' | 'organization_id' | 'assigned_to' | 'source' | 'status'>[];
  /** Ids of the tasks that have a `task.assigned` audit row. */
  assigned: ReadonlySet<string>;
}): DefaultOwnerFixMove[] {
  const byOrg = new Map(
    input.organizations.map((org) => {
      const principal = choosePrincipal(org.members, org.integrations)?.userId ?? null;
      const owners = new Set(org.members.filter((m) => m.role === 'owner').map((m) => m.userId));
      return [org.id, { principal, owners }] as const;
    }),
  );
  const statuses: readonly string[] = DEFAULT_OWNER_FIX_STATUSES;
  const moves: DefaultOwnerFixMove[] = [];
  for (const task of input.tasks) {
    const org = byOrg.get(task.organization_id);
    const from = task.assigned_to;
    if (!org?.principal || !from) continue;
    if (!org.owners.has(from) || from === org.principal) continue;
    if (task.source === 'human' || !statuses.includes(task.status)) continue;
    if (input.assigned.has(task.id)) continue;
    moves.push({
      taskId: task.id,
      organizationId: task.organization_id,
      from,
      to: org.principal,
      audit: {
        organization_id: task.organization_id,
        user_id: null,
        action: 'task.assigned',
        entity_type: 'task',
        entity_id: task.id,
        metadata: { from, to: org.principal, reason: DEFAULT_OWNER_FIX_REASON },
      },
    });
  }
  return moves;
}
