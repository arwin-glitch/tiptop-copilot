import 'server-only';
import { listOrganizationMembers } from '@/lib/db/members';
import type { DataStore } from '@/lib/db/store';
import type { Integration, IntegrationStatus, OrgRole, UserProfile } from '@/lib/types/domain';

/**
 * Whose work is this organization's work: the PRINCIPAL.
 *
 * The app reads one person's mailbox, calendar and meetings, and the tasks it
 * finds there (a routine's suggestion, a keep-in-touch check-in, an imported
 * reminder, a follow-up added with no one chosen) are that person's. That is
 * not always the organization's `owner`: the owner role is whoever set the
 * organization up, an assistant, say, and keeps its meaning for permissions.
 * Nobody is named in code; the answer comes from the data:
 *
 *   (a) the member whose profile (sign-in) address is the address of the
 *       organization's mailbox: the oldest Google integration that reads
 *       Gmail, a connected one first, then one that needs reconnecting, then
 *       a disconnected one;
 *   (b) else the member who connected that mailbox, while still a member;
 *   (c) else the member with the `owner` role;
 *   (d) else the first member.
 *
 * Members are taken oldest membership first, then by user id, so the answer
 * never depends on the order a store returns rows in. Addresses compare
 * without case or surrounding spaces. A mailbox whose Google grant lapsed
 * (`needs_reauth`, `error`) or was disconnected is still that person's
 * mailbox: the routines go on reading their mail, so their tasks must not
 * fall back to the owner until someone reconnects it. The backfill for tasks already filed
 * under the owner (supabase/data-fixes/20261021002000_tasks_to_principal.sql)
 * applies the same rule in SQL.
 */

export interface TeamMember {
  userId: string;
  role: OrgRole;
  /** The sign-in address on their profile. */
  email: string | null;
  fullName: string | null;
  /** When they joined the organization. */
  createdAt: string;
}

export type MailboxRow = Pick<
  Integration,
  'id' | 'user_id' | 'provider' | 'kinds' | 'account_email' | 'status' | 'created_at'
>;

/** Which step of the rule decided. */
export type PrincipalBasis = 'mailbox_address' | 'mailbox_connector' | 'owner' | 'first_member';

export interface Principal {
  userId: string;
  basis: PrincipalBasis;
}

function address(value: string | null | undefined): string | null {
  const text = value?.trim().toLowerCase();
  return text ? text : null;
}

/** Oldest first (an unreadable time last), then by id. */
function byTime<T>(time: (row: T) => string, id: (row: T) => string) {
  const ms = (row: T) => {
    const value = Date.parse(time(row));
    return Number.isNaN(value) ? Number.POSITIVE_INFINITY : value;
  };
  return (a: T, b: T) => {
    if (ms(a) !== ms(b)) return ms(a) < ms(b) ? -1 : 1;
    return id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0;
  };
}

/** Oldest membership first, then by user id: the order the rule reads members in. */
export function inTeamOrder<T extends Pick<TeamMember, 'userId' | 'createdAt'>>(
  members: readonly T[],
): T[] {
  return [...members].sort(
    byTime(
      (m) => m.createdAt,
      (m) => m.userId,
    ),
  );
}

/** Connected first, then a grant that needs renewing, then a disconnected mailbox. */
const MAILBOX_STATUS_RANK: Record<IntegrationStatus, number> = {
  connected: 0,
  needs_reauth: 1,
  error: 1,
  disconnected: 2,
};

/**
 * The organization's mailbox: the oldest Google integration that reads
 * Gmail, a connected one before one that needs reconnecting, before a
 * disconnected one.
 */
export function principalMailbox(integrations: readonly MailboxRow[]): MailboxRow | null {
  const rank = (row: MailboxRow) => MAILBOX_STATUS_RANK[row.status] ?? 1;
  const oldest = byTime<MailboxRow>(
    (row) => row.created_at,
    (row) => row.id,
  );
  const gmail = integrations.filter(
    (row) => row.provider === 'google' && (row.kinds ?? []).includes('gmail'),
  );
  return gmail.sort((a, b) => rank(a) - rank(b) || oldest(a, b))[0] ?? null;
}

/**
 * The member a mailbox belongs to: whose profile address is the mailbox's
 * (a), else whoever connected it, while still a member (b). Null when
 * neither is on the team.
 */
export function mailboxMember(
  members: readonly TeamMember[],
  mailbox: Pick<MailboxRow, 'user_id' | 'account_email'> | null,
): Principal | null {
  if (!mailbox) return null;
  const ordered = inTeamOrder(members);
  const target = address(mailbox.account_email);
  if (target) {
    const owner = ordered.find((m) => address(m.email) === target);
    if (owner) return { userId: owner.userId, basis: 'mailbox_address' };
  }
  const connector = ordered.find((m) => m.userId === mailbox.user_id);
  return connector ? { userId: connector.userId, basis: 'mailbox_connector' } : null;
}

/** The principal by the rule above, or null for an organization with no members. */
export function choosePrincipal(
  members: readonly TeamMember[],
  integrations: readonly MailboxRow[],
): Principal | null {
  const byMailbox = mailboxMember(members, principalMailbox(integrations));
  if (byMailbox) return byMailbox;
  const ordered = inTeamOrder(members);
  const owner = ordered.find((m) => m.role === 'owner');
  if (owner) return { userId: owner.userId, basis: 'owner' };
  const first = ordered[0];
  return first ? { userId: first.userId, basis: 'first_member' } : null;
}

export interface Team {
  /** In team order: oldest membership first. */
  members: TeamMember[];
  principal: Principal | null;
}

/** The organization's members with their profiles, in team order: the members read and each profile. */
export async function readTeamMembers(
  store: DataStore,
  organizationId: string,
): Promise<TeamMember[]> {
  const rows = await listOrganizationMembers(store, organizationId);
  return inTeamOrder(
    await Promise.all(
      rows.map(async (member): Promise<TeamMember> => {
        const profile = (await store.userProfileById(member.user_id)) as UserProfile | null;
        return {
          userId: member.user_id,
          role: member.role,
          email: profile?.email ?? null,
          fullName: profile?.full_name ?? null,
          createdAt: member.created_at,
        };
      }),
    ),
  );
}

/**
 * The organization's members and its principal: the members and their
 * profiles (the same reads the Tasks page's people come from) and one read of
 * the Google integrations.
 */
export async function readTeam(store: DataStore, organizationId: string): Promise<Team> {
  const [members, integrations] = await Promise.all([
    readTeamMembers(store, organizationId),
    store.list('integrations', organizationId, { eq: { provider: 'google' } }) as Promise<
      Integration[]
    >,
  ]);
  return { members, principal: choosePrincipal(members, integrations) };
}

/** Just the principal's user id, or null for an organization with no members. */
export async function readPrincipalId(
  store: DataStore,
  organizationId: string,
): Promise<string | null> {
  return (await readTeam(store, organizationId)).principal?.userId ?? null;
}
