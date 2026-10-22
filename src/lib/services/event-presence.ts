import 'server-only';
import { isMissingColumnError, isMissingTableError } from '@/lib/db/missing-table';
import type { DataStore } from '@/lib/db/store';
import {
  actorKey,
  actorOrganizationId,
  type DraftSyncResult,
  type EventActor,
  type PresenceEntry,
} from '@/lib/events/contracts';
import { ID_RE } from '@/lib/events/schema';
import {
  PRESENCE_ACTIVE_MS,
  PRESENCE_TTL_MS,
  presenceColor,
  syncDraft,
} from '@/lib/services/events';
import type { EventPresence } from '@/lib/types/domain';
import { err, ok, type Result } from '@/lib/util/result';

/**
 * Who is in Studio, and what changed since a client last looked (D-075).
 *
 * Phase 1 transport is the sync poll: every Studio (owners and outside
 * editors alike) asks GET …/draft/sync?since=n every 2 s while visible,
 * every 10 s when hidden, and stops after 15 idle minutes. Each ask upserts
 * the asker's event_presence row {focused section, typing} and returns the
 * sections, theme and page settings changed since n, the deletions, and the
 * presence list. Outsiders hold no Supabase credentials, and every poll
 * re-checks their link, so a revoke takes effect on the next poll.
 *
 * Soft locks are advisory and worked out in the browser from this list
 * (lib/events/editor/presence.ts); the per-key rev check in merge.ts is the
 * real guard, so a crashed tab can never block anyone.
 */

// One presence model for Studio: the TTL, the active window and the colour
// come from WS1's syncDraft (lib/services/events.ts), which writes the same
// rows on every poll, so an avatar's colour matches its outline everywhere.
export { PRESENCE_ACTIVE_MS, PRESENCE_TTL_MS, presenceColor };

export interface PresenceState {
  focusedSectionId: string | null;
  typing: boolean;
}

function asEntry(row: EventPresence, now: number): PresenceEntry {
  return {
    actorKey: row.actor_key,
    name: row.name,
    color: row.color,
    outside: row.actor_key.startsWith('g:'),
    focusedSectionId: row.focused_section_id,
    typing: row.typing,
    lastSeenAt: row.last_seen_at,
    active: now - Date.parse(row.last_seen_at) <= PRESENCE_ACTIVE_MS,
  };
}

export async function upsertPresence(
  store: DataStore,
  actor: EventActor,
  eventId: string,
  state: PresenceState,
  now: number = Date.now(),
): Promise<void> {
  const key = actorKey(actor);
  await store.upsert(
    'event_presence',
    {
      event_id: eventId,
      actor_key: key,
      organization_id: actorOrganizationId(actor),
      name: (actor.name || 'Someone').slice(0, 80),
      color: presenceColor(key),
      focused_section_id:
        state.focusedSectionId && ID_RE.test(state.focusedSectionId)
          ? state.focusedSectionId
          : null,
      typing: state.typing,
      last_seen_at: new Date(now).toISOString(),
    },
    ['event_id', 'actor_key'],
  );
}

/** Everyone seen in the last minute, most recent first. */
export async function listPresence(
  store: DataStore,
  organizationId: string,
  eventId: string,
  now: number = Date.now(),
): Promise<PresenceEntry[]> {
  const since = new Date(now - PRESENCE_TTL_MS).toISOString();
  const rows = await store.list(
    'event_presence',
    organizationId,
    { eq: { event_id: eventId }, gte: { last_seen_at: since } },
    { orderBy: [{ field: 'last_seen_at', direction: 'desc' }], limit: 50 },
  );
  return rows.map((r) => asEntry(r, now));
}

/** Leaving Studio (pagehide beacon): drop the row so the avatar goes at once. */
export async function removePresence(
  store: DataStore,
  actor: EventActor,
  eventId: string,
): Promise<void> {
  await store.removeWhere('event_presence', actorOrganizationId(actor), {
    eq: { event_id: eventId, actor_key: actorKey(actor) },
  });
}

/**
 * Studio's poll, used by both sync routes (owners and outside editors). It
 * delegates to WS1's syncDraft, which re-checks the actor's capabilities,
 * upserts the caller's presence row, lists everyone else in Studio (never
 * the caller), and returns what changed after draft_version `since`, or the
 * whole document when the client is ahead, the edit log cannot reach back
 * (a restore rebases revisions and writes tombstones, so it is covered) or
 * the read was truncated.
 */
export async function syncStudio(
  store: DataStore,
  actor: EventActor,
  eventId: string,
  since: number,
  presence: PresenceState | null,
): Promise<Result<DraftSyncResult>> {
  if (actor.kind === 'grant') {
    if (actor.grant.eventId !== eventId || !actor.grant.capabilities.viewDraft) {
      return err('not_found', 'That event does not exist.');
    }
  }
  return syncDraft(store, actor, eventId, since, presence);
}

/** One row of the per-section Activity panel (no values: who, what keys, when). */
export interface ActivityEntry {
  draftVersion: number;
  op: 'insert' | 'update' | 'move' | 'delete' | 'theme' | 'page';
  sectionId: string | null;
  keys: string[];
  authorName: string;
  actorKey: string;
  outside: boolean;
  at: string;
}

/**
 * The activity log (event_edits): per section, or everything after a draft
 * version (the publish dialog's "who changed what since the last publish").
 * Names are the ones stored at the time, so attribution survives a revoked
 * link. Owners only.
 */
export async function listActivity(
  store: DataStore,
  organizationId: string,
  eventId: string,
  options: { sectionId?: string | null; sinceVersion?: number; limit?: number } = {},
): Promise<Result<ActivityEntry[]>> {
  try {
    const rows = await store.list(
      'event_edits',
      organizationId,
      {
        eq: {
          event_id: eventId,
          ...(options.sectionId ? { section_id: options.sectionId } : {}),
        },
        ...(options.sinceVersion !== undefined
          ? { gt: { draft_version: options.sinceVersion } }
          : {}),
      },
      {
        orderBy: [{ field: 'draft_version', direction: 'desc' }],
        limit: Math.min(500, options.limit ?? 100),
      },
    );
    return ok(
      rows.map((r) => ({
        draftVersion: r.draft_version,
        op: r.op,
        sectionId: r.section_id,
        keys: r.keys,
        authorName: r.author_name,
        actorKey: r.actor_key,
        outside: r.actor_key.startsWith('g:'),
        at: r.created_at,
      })),
    );
  } catch (error) {
    if (isMissingTableError(error) || isMissingColumnError(error)) {
      return err('not_configured', 'Events are not set up yet.');
    }
    return err('internal', 'The activity log could not be read just now.', { retryable: true });
  }
}
