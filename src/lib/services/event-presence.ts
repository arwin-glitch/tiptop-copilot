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
import { changesSince } from '@/lib/events/merge';
import { ID_RE, parseEventDoc } from '@/lib/events/schema';
import { log } from '@/lib/security/redact';
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

/** Rows older than this are ignored (a closed tab disappears on its own). */
export const PRESENCE_TTL_MS = 60_000;
/** Seen this recently: shown as active, and its focused section soft-locked. */
export const PRESENCE_ACTIVE_MS = 20_000;

/** One colour per person: distinct, readable on light and dark canvases. */
export const PRESENCE_COLORS = [
  '#2B6D56',
  '#B4532A',
  '#3B5BA9',
  '#8E3B8C',
  '#A67C00',
  '#1F7A8C',
  '#C0392B',
  '#5D6D1E',
] as const;

export function presenceColor(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return PRESENCE_COLORS[hash % PRESENCE_COLORS.length]!;
}

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

/** Whether a restore landed after `since` (its revs are old, so only a full doc is right). */
async function restoredSince(
  store: DataStore,
  organizationId: string,
  eventId: string,
  since: number,
): Promise<boolean> {
  const rows = await store.list(
    'event_versions',
    organizationId,
    {
      eq: { event_id: eventId },
      in: { kind: ['pre_restore', 'restore'] },
      gte: { draft_version: since },
    },
    { limit: 1 },
  );
  return rows.length > 0;
}

/**
 * Studio's poll: upsert the asker's presence, then everything changed after
 * draft_version `since` (sections and theme read off their revs, deletions
 * from event_edits). A full document comes back when the client is ahead of
 * the server or a restore happened since.
 * (WS1's syncDraft in lib/services/events.ts may delegate here.)
 */
export async function syncStudio(
  store: DataStore,
  actor: EventActor,
  eventId: string,
  since: number,
  presence: PresenceState | null,
  now: number = Date.now(),
): Promise<Result<DraftSyncResult>> {
  if (actor.kind === 'grant') {
    if (actor.grant.eventId !== eventId || !actor.grant.capabilities.viewDraft) {
      return err('not_found', 'That event does not exist.');
    }
  }
  const organizationId = actorOrganizationId(actor);
  try {
    const event = await store.get('events', organizationId, eventId);
    if (!event) return err('not_found', 'That event does not exist.');
    const parsed = parseEventDoc(event.draft_doc);
    if (!parsed.ok) {
      log.error('A stored event page failed validation', {
        event: eventId,
        issue: parsed.issues[0] ?? '',
      });
      return err(
        'internal',
        'This event page could not be read. Restore an earlier version from History.',
      );
    }
    if (presence) await upsertPresence(store, actor, eventId, presence, now);
    const doc = parsed.value;
    const version = event.draft_version;
    const base = {
      version,
      presence: await listPresence(store, organizationId, eventId, now),
      editingPaused: event.editing_paused,
      publishedVersion: event.published_version,
    };
    const empty = { sections: [], deletedSectionIds: [], theme: null, meta: null };

    // Every Studio starts from a full snapshot (the page load), so `since`
    // is always a version the client holds; a client ahead of the server
    // (or a restore since) gets the whole document again.
    if (since < 0 || since > version) return ok({ ...base, full: doc, changes: empty });
    if (since === version) return ok({ ...base, full: null, changes: empty });
    if (await restoredSince(store, organizationId, eventId, since)) {
      return ok({ ...base, full: doc, changes: empty });
    }

    const changed = changesSince(doc, since);
    const present = new Set(doc.sections.map((s) => s.id));
    const deletions = await store.list(
      'event_edits',
      organizationId,
      { eq: { event_id: eventId, op: 'delete' }, gt: { draft_version: since } },
      { limit: 500 },
    );
    const deletedSectionIds = [
      ...new Set(
        deletions.map((d) => d.section_id).filter((id): id is string => !!id && !present.has(id)),
      ),
    ];
    return ok({ ...base, full: null, changes: { ...changed, deletedSectionIds } });
  } catch (error) {
    if (isMissingTableError(error) || isMissingColumnError(error)) {
      return err(
        'not_configured',
        'Events are not set up yet: run supabase/migrations/20261023000000_events.sql, then reload.',
      );
    }
    log.error('Studio sync failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return err('internal', 'Could not check for changes just now.', { retryable: true });
  }
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
