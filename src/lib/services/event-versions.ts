import 'server-only';
import type { DataStore } from '@/lib/db/store';
import type { EventActor } from '@/lib/events/contracts';
import type { EventDoc } from '@/lib/events/schema';
import type { EventVersion, EventVersionKind } from '@/lib/types/domain';
import { err, type Result } from '@/lib/util/result';

/**
 * Version history of an event's draft (D-075) — WS1 PART 2. Signatures are
 * final (WS3's History drawer codes against them); bodies land after the
 * contract commit.
 *
 * Checkpoints: autosave after 5+ minutes of activity or when an editor's
 * session ends; 'published' at every Publish; 'pre_restore' before every
 * restore; 'named' on an owner's request. Restore copies a version into the
 * draft as a NEW draft_version (after saving a pre_restore), never
 * overwrites, and still needs a Publish. Retention: named and published
 * forever; autosaves 30 days or the last 100.
 */

/** What the History drawer lists: no doc (fetch one version to preview it). */
export interface EventVersionSummary {
  id: string;
  version: number;
  kind: EventVersionKind;
  name: string | null;
  draftVersion: number;
  authorName: string | null;
  createdAt: string;
  /** "Hero – headline · Agenda – 2 items": sections changed since the previous version. */
  summary: string[];
}

function notBuilt<T>(operation: string): Result<T> {
  return err('not_configured', 'Version history is still being built.', {
    stillUsable: 'Editing and saving work as before.',
    details: { operation },
  });
}

export async function listVersions(
  store: DataStore,
  actor: EventActor,
  eventId: string,
): Promise<Result<EventVersionSummary[]>> {
  void store;
  void actor;
  void eventId;
  return notBuilt('listVersions');
}

/** One version's document, for a read-only preview in the canvas. */
export async function getVersion(
  store: DataStore,
  actor: EventActor,
  eventId: string,
  versionId: string,
): Promise<Result<{ version: EventVersion; doc: EventDoc }>> {
  void store;
  void actor;
  void eventId;
  void versionId;
  return notBuilt('getVersion');
}

export async function createNamedVersion(
  store: DataStore,
  actor: EventActor,
  eventId: string,
  name: string,
): Promise<Result<EventVersionSummary>> {
  void store;
  void actor;
  void eventId;
  void name;
  return notBuilt('createNamedVersion');
}

/** Owners only. Returns the new draft_version. */
export async function restoreVersion(
  store: DataStore,
  actor: EventActor,
  eventId: string,
  versionId: string,
): Promise<Result<{ draftVersion: number }>> {
  void store;
  void actor;
  void eventId;
  void versionId;
  return notBuilt('restoreVersion');
}

/** Called after applied ops: saves an autosave checkpoint when one is due. */
export async function maybeCheckpoint(
  store: DataStore,
  actor: EventActor,
  eventId: string,
): Promise<Result<EventVersionSummary | null>> {
  void store;
  void actor;
  void eventId;
  return notBuilt('maybeCheckpoint');
}
