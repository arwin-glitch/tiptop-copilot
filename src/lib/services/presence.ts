import 'server-only';
import type { DataStore } from '@/lib/db/store';
import type { AuditEvent, OrganizationMember, UserProfile } from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';
import { processWide } from '@/lib/util/process-state';

/**
 * "When did Nick last open the app?" — so Arwin can see it instead of asking.
 *
 * A page view writes one `app.visited` row in `audit_events`, at most once per
 * VISIT_THROTTLE_MS per person (no schema change, same as the push ledger).
 * Last activity is the newest row of a kind only a person in the app creates
 * (a visit, a session answer, a question in Ask, turning on alerts). Background
 * jobs such as the mailbox sync write rows under the mailbox owner too, so
 * "any row by Nick" would say he was here when only a sync ran.
 */

export const VISIT_ACTION = 'app.visited';
const VISIT_THROTTLE_MS = 15 * 60_000;
const SUBSCRIPTION_ACTION = 'push.subscription';
const PERSON_ACTIONS = [
  VISIT_ACTION,
  'email.session_answer',
  'chat.question_asked',
  SUBSCRIPTION_ACTION,
] as const;

const lastWrite = processWide('presence-last-write', () => new Map<string, number>());

/** Test hook. */
export function resetPresenceCache(): void {
  lastWrite.clear();
}

/** Best-effort: never throws, never blocks the page on a store fault. */
export async function recordVisit(
  store: DataStore,
  organizationId: string,
  userId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const key = `${organizationId}:${userId}`;
  const prev = lastWrite.get(key);
  if (prev !== undefined && now.getTime() - prev < VISIT_THROTTLE_MS) return false;
  lastWrite.set(key, now.getTime());
  try {
    const row: AuditEvent = {
      id: newId(),
      organization_id: organizationId,
      user_id: userId,
      action: VISIT_ACTION,
      entity_type: 'app',
      entity_id: null,
      metadata: {},
      ip_hash: null,
      created_at: now.toISOString(),
    };
    await store.insert('audit_events', row);
    return true;
  } catch {
    lastWrite.delete(key);
    return false;
  }
}

export interface MailboxOwnerPresence {
  /** First name of the mailbox owner, from the mailbox address if they have no profile yet. */
  name: string;
  /** False when nobody with the mailbox address has signed in to the app. */
  signedIn: boolean;
  lastSeenAt: string | null;
  alertDevices: number;
}

const firstNameFromEmail = (email: string) => {
  const local = email.split('@')[0] ?? email;
  return local.charAt(0).toUpperCase() + local.slice(1);
};

/**
 * Presence of the person whose mailbox the app reads, for anyone else looking.
 * Returns null for the owner themself (they know when they were here) or when
 * no mailbox is connected.
 */
export async function mailboxOwnerPresence(
  store: DataStore,
  organizationId: string,
  viewerUserId: string,
  mailbox: string | null | undefined,
): Promise<MailboxOwnerPresence | null> {
  if (!mailbox) return null;
  const target = mailbox.toLowerCase();
  const members = (await store.list(
    'organization_members',
    organizationId,
    {},
  )) as OrganizationMember[];
  let owner: { member: OrganizationMember; profile: UserProfile } | null = null;
  for (const member of members) {
    const profile = await store.userProfileById(member.user_id);
    if (profile?.email.toLowerCase() === target) {
      owner = { member, profile };
      break;
    }
  }
  if (owner?.member.user_id === viewerUserId) return null;
  if (!owner) {
    return { name: firstNameFromEmail(target), signedIn: false, lastSeenAt: null, alertDevices: 0 };
  }

  const userId = owner.member.user_id;
  const [latestPerKind, alertDevices] = await Promise.all([
    Promise.all(
      PERSON_ACTIONS.map(
        (action) =>
          store.list(
            'audit_events',
            organizationId,
            { eq: { user_id: userId, action } },
            { orderBy: [{ field: 'created_at', direction: 'desc' }], limit: 1 },
          ) as Promise<AuditEvent[]>,
      ),
    ),
    store.count('audit_events', organizationId, {
      eq: { action: SUBSCRIPTION_ACTION, user_id: userId },
    }),
  ]);
  return {
    name: owner.profile.full_name?.split(' ')[0] || firstNameFromEmail(target),
    signedIn: true,
    lastSeenAt:
      latestPerKind
        .map((rows) => rows[0]?.created_at)
        .filter((at): at is string => Boolean(at))
        .sort()
        .at(-1) ?? null,
    alertDevices,
  };
}
