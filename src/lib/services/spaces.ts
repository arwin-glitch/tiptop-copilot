import 'server-only';
import type { AuthContext } from '@/lib/auth/session';
import { listOrganizationMembers } from '@/lib/db/members';
import { isMissingColumnError, isMissingTableError } from '@/lib/db/missing-table';
import type { DataStore } from '@/lib/db/store';
import { recordAudit } from '@/lib/security/audit';
import {
  dedupeRules,
  isEmptyRuleSet,
  MAX_RULES,
  ruleSet,
  type RuleInput,
  type SpaceRuleSet,
} from '@/lib/spaces/rules';
import type {
  Integration,
  Space,
  SpaceHiddenItem,
  SpaceItemKind,
  SpaceMember,
  SpaceRule,
  SpaceSourceKind,
} from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';
import { err, ok, type Result } from '@/lib/util/result';
import { getPrimaryIntegration } from './inbox';
import { isPersonalDomain } from './warm-paths';

/**
 * Spaces (Fyxer's "Spaces"): a shared home for one client or project. A
 * Space is a name and its rules (a company's domain, people's addresses,
 * keywords); its emails and meetings are found from those rules whenever it
 * is read, never copied. This file is the Space itself: who may see it,
 * creating and editing it, its members and the items they hid. What is in it
 * (emails, meetings, counts, suggestions) is space-content.ts; Ask is
 * space-ask.ts.
 *
 * Members only. A Space is seen by its owner and the people invited to it;
 * the rest of the organization never sees it, its name included, so a Space
 * nobody may see reads as "not found", never "forbidden". An invited person
 * sees only the invite until they accept, and nothing of theirs comes in
 * before that. Read-only toward mail and calendars throughout.
 *
 * Before the migration is run every call says so and stores nothing.
 */

export const SPACES_NOT_SET_UP =
  'Spaces need a database update before they can be used. Nothing else changes.';

export const MAX_SPACES = 200;
const NAME_MAX = 120;
const DESCRIPTION_MAX = 500;

export type SpaceViewer = Pick<AuthContext, 'organizationId' | 'userId' | 'role'> & {
  isDemo?: boolean;
};

const needsMigration = () =>
  err('not_configured', SPACES_NOT_SET_UP, { details: { needsMigration: true } });

const gone = () => err('not_found', 'That Space is gone, or it is not shared with you.');

/** Runs a read, turning "the table is not there yet" into null. */
async function guard<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (isMissingTableError(error)) return null;
    throw error;
  }
}

/** Whether the Spaces migration has been run. */
export async function spacesReady(store: DataStore, organizationId: string): Promise<boolean> {
  const rows = await guard(() => store.list('spaces', organizationId, {}, { limit: 1 }));
  if (rows === null) return false;
  // The tasks link column is in the same migration; a half-applied run says so.
  try {
    await store.list('tasks', organizationId, { notNull: ['space_id'] }, { limit: 1 });
    return true;
  } catch (error) {
    if (isMissingColumnError(error)) return false;
    throw error;
  }
}

/* ---------------------------------------------------------------- access */

export interface SpaceBundle {
  space: Space;
  rules: SpaceRule[];
  members: SpaceMember[];
  hidden: SpaceHiddenItem[];
}

export interface SpaceAccess extends SpaceBundle {
  /** The viewer's own membership row, if any. */
  me: SpaceMember | null;
  isOwner: boolean;
  /** The owner, or an organization admin who is in the Space. */
  canManage: boolean;
  /** In the Space (the owner, or accepted): sees what is in it. */
  canView: boolean;
  /** Invited and not answered yet: sees the invite alone. */
  invited: boolean;
  set: SpaceRuleSet;
}

const isActive = (m: SpaceMember) => m.status === 'invited' || m.status === 'accepted';

export function accessFor(bundle: SpaceBundle, viewer: SpaceViewer): SpaceAccess | null {
  const me = bundle.members.find((m) => m.user_id === viewer.userId) ?? null;
  const isOwner = bundle.space.created_by === viewer.userId;
  if (!isOwner && (!me || !isActive(me))) return null;
  const accepted = isOwner || me?.status === 'accepted';
  const adminInside = (viewer.role === 'admin' || viewer.role === 'owner') && accepted;
  return {
    ...bundle,
    me,
    isOwner,
    canManage: isOwner || adminInside,
    canView: accepted,
    invited: !isOwner && me?.status === 'invited',
    set: ruleSet(bundle.rules),
  };
}

async function bundlesFor(
  store: DataStore,
  organizationId: string,
  spaces: Space[],
): Promise<SpaceBundle[]> {
  if (!spaces.length) return [];
  const ids = spaces.map((s) => s.id);
  const [rules, members, hidden] = await Promise.all([
    store.list('space_rules', organizationId, { in: { space_id: ids } }),
    store.list('space_members', organizationId, { in: { space_id: ids } }),
    store.list('space_hidden_items', organizationId, { in: { space_id: ids } }),
  ]);
  return spaces.map((space) => ({
    space,
    rules: (rules as SpaceRule[]).filter((r) => r.space_id === space.id),
    members: (members as SpaceMember[]).filter((m) => m.space_id === space.id),
    hidden: (hidden as SpaceHiddenItem[]).filter((h) => h.space_id === space.id),
  }));
}

/** The Spaces the viewer may see (theirs, invited or in), newest first. */
export async function listMySpaces(
  store: DataStore,
  viewer: SpaceViewer,
): Promise<Result<SpaceAccess[]>> {
  const org = viewer.organizationId;
  const [all, mine] = await Promise.all([
    guard(
      () =>
        store.list(
          'spaces',
          org,
          { isNull: ['archived_at'] },
          {
            orderBy: [{ field: 'created_at', direction: 'desc' }],
            limit: MAX_SPACES,
          },
        ) as Promise<Space[]>,
    ),
    guard(
      () =>
        store.list('space_members', org, { eq: { user_id: viewer.userId } }) as Promise<
          SpaceMember[]
        >,
    ),
  ]);
  if (all === null || mine === null) return needsMigration();
  const inIds = new Set(mine.filter(isActive).map((m) => m.space_id));
  const visible = all.filter((s) => s.created_by === viewer.userId || inIds.has(s.id));
  const bundles = await bundlesFor(store, org, visible);
  return ok(bundles.map((b) => accessFor(b, viewer)).filter((a): a is SpaceAccess => a !== null));
}

/** One Space, if the viewer may see it. */
export async function getSpaceAccess(
  store: DataStore,
  viewer: SpaceViewer,
  spaceId: string,
): Promise<Result<SpaceAccess>> {
  const space = await guard(() => store.get('spaces', viewer.organizationId, spaceId));
  if (space === null) {
    const ready = await spacesReady(store, viewer.organizationId);
    return ready ? gone() : needsMigration();
  }
  if (!space || space.archived_at) return gone();
  const [bundle] = await bundlesFor(store, viewer.organizationId, [space]);
  const access = bundle ? accessFor(bundle, viewer) : null;
  return access ? ok(access) : gone();
}

/* ----------------------------------------------------------- create/edit */

export interface SpaceInput {
  name: string;
  description?: string | null;
  rules: RuleInput[];
  sourceKind?: SpaceSourceKind;
  sourceRef?: string | null;
}

function checkRules(rules: readonly RuleInput[]): Result<RuleInput[]> {
  const clean = dedupeRules(rules);
  if (clean.length > MAX_RULES) {
    return err('invalid_input', `A Space can have up to ${MAX_RULES} rules.`);
  }
  const personal = clean.find((r) => r.kind === 'domain' && isPersonalDomain(r.value));
  if (personal) {
    return err(
      'invalid_input',
      `${personal.value} is a personal mail domain: it would pull in everyone who uses it. Add those people's addresses instead.`,
    );
  }
  if (isEmptyRuleSet(ruleSet(clean))) {
    return err(
      'invalid_input',
      'Add a domain, an email address or a keyword so the Space can find its mail.',
    );
  }
  return ok(clean);
}

const cleanName = (name: string) => name.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);

export async function createSpace(
  store: DataStore,
  viewer: SpaceViewer,
  input: SpaceInput,
  now: Date = new Date(),
): Promise<Result<Space>> {
  if (viewer.role === 'viewer') return err('forbidden', 'Viewers cannot make Spaces.');
  const name = cleanName(input.name);
  if (!name) return err('invalid_input', 'Name the Space first.');
  const rules = checkRules(input.rules);
  if (!rules.ok) return rules;
  const existing = await listMySpaces(store, viewer);
  if (!existing.ok) return existing;
  if (existing.value.length >= MAX_SPACES) {
    return err('invalid_input', `Kraken keeps up to ${MAX_SPACES} Spaces.`);
  }
  const stamp = now.toISOString();
  const space: Space = {
    id: newId(),
    organization_id: viewer.organizationId,
    name,
    description: input.description?.trim().slice(0, DESCRIPTION_MAX) || null,
    source_kind: input.sourceKind ?? 'manual',
    source_ref: input.sourceRef?.slice(0, 200) ?? null,
    created_by: viewer.userId,
    archived_at: null,
    created_at: stamp,
    updated_at: stamp,
  };
  await store.insert('spaces', space);
  await store.insertMany(
    'space_rules',
    rules.value.map((r) => ({
      id: newId(),
      organization_id: viewer.organizationId,
      space_id: space.id,
      kind: r.kind,
      value: r.value,
      created_at: stamp,
    })),
  );
  await store.insert('space_members', {
    id: newId(),
    organization_id: viewer.organizationId,
    space_id: space.id,
    user_id: viewer.userId,
    role: 'owner',
    status: 'accepted',
    invited_by: null,
    accepted_at: stamp,
    created_at: stamp,
    updated_at: stamp,
  });
  await recordAudit(store, {
    organizationId: viewer.organizationId,
    userId: viewer.userId,
    action: 'space.created',
    entityType: 'space',
    entityId: space.id,
    metadata: { source: space.source_kind, rules: rules.value.length },
  });
  return ok(space);
}

export async function updateSpace(
  store: DataStore,
  viewer: SpaceViewer,
  spaceId: string,
  patch: { name?: string; description?: string | null; rules?: RuleInput[] },
  now: Date = new Date(),
): Promise<Result<Space>> {
  const access = await getSpaceAccess(store, viewer, spaceId);
  if (!access.ok) return access;
  if (!access.value.canManage) return err('forbidden', 'Only the Space owner can change it.');
  const changes: Partial<Space> = { updated_at: now.toISOString() };
  if (patch.name !== undefined) {
    const name = cleanName(patch.name);
    if (!name) return err('invalid_input', 'Name the Space first.');
    changes.name = name;
  }
  if (patch.description !== undefined) {
    changes.description = patch.description?.trim().slice(0, DESCRIPTION_MAX) || null;
  }
  if (patch.rules) {
    const rules = checkRules(patch.rules);
    if (!rules.ok) return rules;
    await store.removeWhere('space_rules', viewer.organizationId, { eq: { space_id: spaceId } });
    await store.insertMany(
      'space_rules',
      rules.value.map((r) => ({
        id: newId(),
        organization_id: viewer.organizationId,
        space_id: spaceId,
        kind: r.kind,
        value: r.value,
        created_at: now.toISOString(),
      })),
    );
  }
  const updated = await store.update('spaces', viewer.organizationId, spaceId, changes);
  return ok(updated as Space);
}

/**
 * Deletes a Space: its rules, members and hidden items go with it (the
 * database cascades; the demo store is cleared here). Its action items stay
 * as ordinary tasks. Nothing in Gmail or the calendar changes.
 */
export async function deleteSpace(
  store: DataStore,
  viewer: SpaceViewer,
  spaceId: string,
): Promise<Result<true>> {
  const access = await getSpaceAccess(store, viewer, spaceId);
  if (!access.ok) return access;
  if (!access.value.canManage) return err('forbidden', 'Only the Space owner can delete it.');
  const org = viewer.organizationId;
  for (const table of ['space_rules', 'space_members', 'space_hidden_items'] as const) {
    await store.removeWhere(table, org, { eq: { space_id: spaceId } });
  }
  const linked = await store.list('tasks', org, { eq: { space_id: spaceId } }).catch(() => []);
  for (const task of linked) await store.update('tasks', org, task.id, { space_id: null });
  await store.remove('spaces', org, spaceId);
  await recordAudit(store, {
    organizationId: org,
    userId: viewer.userId,
    action: 'space.deleted',
    entityType: 'space',
    entityId: spaceId,
  });
  return ok(true);
}

/* --------------------------------------------------------------- members */

export interface TeamPerson {
  userId: string;
  name: string;
  email: string | null;
}

/** Everyone in the Kraken organization, for the invite picker and member names. */
export async function teamPeople(store: DataStore, organizationId: string): Promise<TeamPerson[]> {
  const members = await listOrganizationMembers(store, organizationId).catch(() => []);
  const profiles = await Promise.all(members.map((m) => store.userProfileById(m.user_id)));
  return members.map((m, i) => {
    const p = profiles[i];
    return {
      userId: m.user_id,
      name: p?.full_name?.trim() || p?.email || 'Teammate',
      email: p?.email ?? null,
    };
  });
}

export async function inviteMember(
  store: DataStore,
  viewer: SpaceViewer,
  spaceId: string,
  userId: string,
  now: Date = new Date(),
): Promise<Result<SpaceMember>> {
  const access = await getSpaceAccess(store, viewer, spaceId);
  if (!access.ok) return access;
  if (!access.value.canManage) return err('forbidden', 'Only the Space owner can invite people.');
  const team = await teamPeople(store, viewer.organizationId);
  if (!team.some((p) => p.userId === userId)) {
    return err('invalid_input', 'Only people in your Kraken workspace can be invited.');
  }
  const stamp = now.toISOString();
  const existing = access.value.members.find((m) => m.user_id === userId);
  if (existing) {
    if (isActive(existing)) return ok(existing);
    // Declined or left before: a fresh invite they answer again.
    const row = await store.update('space_members', viewer.organizationId, existing.id, {
      status: 'invited',
      invited_by: viewer.userId,
      accepted_at: null,
      updated_at: stamp,
    });
    return ok(row as SpaceMember);
  }
  const row: SpaceMember = {
    id: newId(),
    organization_id: viewer.organizationId,
    space_id: spaceId,
    user_id: userId,
    role: 'member',
    status: 'invited',
    invited_by: viewer.userId,
    accepted_at: null,
    created_at: stamp,
    updated_at: stamp,
  };
  await store.insert('space_members', row);
  await recordAudit(store, {
    organizationId: viewer.organizationId,
    userId: viewer.userId,
    action: 'space.member_invited',
    entityType: 'space',
    entityId: spaceId,
  });
  return ok(row);
}

/** The invitee answers their own invite. Nothing of theirs comes in before "accept". */
export async function answerInvite(
  store: DataStore,
  viewer: SpaceViewer,
  spaceId: string,
  answer: 'accept' | 'decline',
  now: Date = new Date(),
): Promise<Result<SpaceMember>> {
  const access = await getSpaceAccess(store, viewer, spaceId);
  if (!access.ok) return access;
  const me = access.value.me;
  if (!me || me.status !== 'invited') return err('invalid_input', 'There is no invite to answer.');
  const stamp = now.toISOString();
  const row = await store.update('space_members', viewer.organizationId, me.id, {
    status: answer === 'accept' ? 'accepted' : 'declined',
    accepted_at: answer === 'accept' ? stamp : null,
    updated_at: stamp,
  });
  return ok(row as SpaceMember);
}

/**
 * Takes someone out of a Space: the owner removing a member, or a member
 * leaving. Their row goes, and with it everything they contributed (their
 * mailbox and calendar are no longer read for it) and the items they hid.
 * The owner cannot be removed.
 */
export async function removeMember(
  store: DataStore,
  viewer: SpaceViewer,
  spaceId: string,
  userId: string,
): Promise<Result<true>> {
  const access = await getSpaceAccess(store, viewer, spaceId);
  if (!access.ok) return access;
  const self = userId === viewer.userId;
  if (!self && !access.value.canManage) {
    return err('forbidden', 'Only the Space owner can remove people.');
  }
  if (userId === access.value.space.created_by) {
    return err('invalid_input', 'The owner stays in the Space. Delete the Space instead.');
  }
  const row = access.value.members.find((m) => m.user_id === userId);
  if (!row) return err('not_found', 'They are not in this Space.');
  const org = viewer.organizationId;
  await store.remove('space_members', org, row.id);
  await store.removeWhere('space_hidden_items', org, {
    eq: { space_id: spaceId, user_id: userId },
  });
  await recordAudit(store, {
    organizationId: org,
    userId: viewer.userId,
    action: self ? 'space.member_left' : 'space.member_removed',
    entityType: 'space',
    entityId: spaceId,
  });
  return ok(true);
}

/* ------------------------------------------------------- contributors -- */

export interface Contributors {
  /** The mailbox Kraken reads today (the organization's primary Google connection). */
  primary: Integration | null;
  /**
   * Whose the primary mailbox's items are in this Space: the person who
   * connected it, when they are in the Space; else the Space's owner, who
   * brought them in by making it.
   */
  primaryOwner: string;
  /** Members who accepted and have a Google connection of their own, beside the primary. */
  extra: { userId: string; integration: Integration }[];
  /** People whose own calendar entries stay out (connected, but not in the Space or not accepted). */
  excludedUsers: Set<string>;
  /** Accepted members with no Google connection of their own: "connect your Google to contribute". */
  withoutMailbox: string[];
}

export async function spaceContributors(
  store: DataStore,
  access: Pick<SpaceAccess, 'space' | 'members'>,
): Promise<Contributors> {
  const org = access.space.organization_id;
  const [primary, integrations] = await Promise.all([
    getPrimaryIntegration(store, org).catch(() => null),
    (
      store.list('integrations', org, { eq: { provider: 'google' } }) as Promise<Integration[]>
    ).catch(() => [] as Integration[]),
  ]);
  const accepted = new Set(
    access.members.filter((m) => m.status === 'accepted').map((m) => m.user_id),
  );
  accepted.add(access.space.created_by);
  const own = integrations.filter(
    (i) => i.id !== primary?.id && i.status !== 'disconnected' && i.kinds.includes('gmail'),
  );
  const extra = own
    .filter((i) => accepted.has(i.user_id))
    .map((integration) => ({ userId: integration.user_id, integration }));
  const excludedUsers = new Set(own.filter((i) => !accepted.has(i.user_id)).map((i) => i.user_id));
  const primaryOwner =
    primary && accepted.has(primary.user_id) ? primary.user_id : access.space.created_by;
  const withMailbox = new Set([primaryOwner, ...extra.map((e) => e.userId)]);
  return {
    primary,
    primaryOwner,
    extra,
    excludedUsers,
    withoutMailbox: [...accepted].filter((u) => !withMailbox.has(u)),
  };
}

/* ---------------------------------------------------------------- hiding */

export const hiddenKey = (kind: SpaceItemKind, id: string) => `${kind}:${id}`;

export function hiddenSet(access: Pick<SpaceAccess, 'hidden'>): Set<string> {
  return new Set(access.hidden.map((h) => hiddenKey(h.item_kind, h.item_id)));
}

/**
 * Hides one of the viewer's own emails, meetings or notes from the Space (or
 * shows it again). Honoured on every tab, the counts and Ask. `owner` is
 * whose the item is (space-content.ts works it out); only they, or the
 * Space's owner, may hide it. A dismissed suggestion is any member's.
 */
export async function setItemHidden(
  store: DataStore,
  viewer: SpaceViewer,
  access: SpaceAccess,
  item: { kind: SpaceItemKind; id: string; owner: string | null },
  hidden: boolean,
  now: Date = new Date(),
): Promise<Result<true>> {
  if (!access.canView) return err('forbidden', 'Accept the invite first.');
  const id = item.id.trim().slice(0, 200);
  if (!id) return err('invalid_input', 'Unknown item.');
  const org = viewer.organizationId;
  const existing = access.hidden.find((h) => h.item_kind === item.kind && h.item_id === id);
  if (hidden) {
    if (item.kind !== 'suggestion' && item.owner !== viewer.userId && !access.isOwner) {
      return err('forbidden', 'You can hide only your own emails and meetings.');
    }
    if (existing) return ok(true);
    await store.insert('space_hidden_items', {
      id: newId(),
      organization_id: org,
      space_id: access.space.id,
      user_id: viewer.userId,
      item_kind: item.kind,
      item_id: id,
      created_at: now.toISOString(),
    });
    access.hidden.push({
      id: 'local',
      organization_id: org,
      space_id: access.space.id,
      user_id: viewer.userId,
      item_kind: item.kind,
      item_id: id,
      created_at: now.toISOString(),
    });
    return ok(true);
  }
  if (!existing) return ok(true);
  if (existing.user_id !== viewer.userId && !access.canManage) {
    return err('forbidden', 'Only the person who hid it can show it again.');
  }
  await store.remove('space_hidden_items', org, existing.id);
  return ok(true);
}
