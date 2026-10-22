import 'server-only';
import type { DataStore, Filter } from '@/lib/db/store';
import { blockRegistry } from '@/lib/events/blocks';
import { actorKey, actorOrganizationId, type EventActor } from '@/lib/events/contracts';
import {
  describeDiff,
  diffDocs,
  rebaseOnto,
  type DiffLabels,
  type DocDiff,
} from '@/lib/events/diff';
import type { BlockType, EventDoc } from '@/lib/events/schema';
import { recordAudit } from '@/lib/security/audit';
import { hashIp } from '@/lib/security/crypto';
import { log } from '@/lib/security/redact';
import type { EventEdit, EventRecord, EventVersion, EventVersionKind } from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';
import { err, ok, type Result } from '@/lib/util/result';
import {
  auditUserId,
  capabilitiesFor,
  cleanText,
  guard,
  isUniqueViolation,
  notFound,
  readStoredDoc,
} from './event-access';

/**
 * Version history of an event's draft (D-075).
 *
 * Checkpoints: 'autosave' after 5+ minutes of activity (applyDraftOps calls
 * maybeCheckpoint after every applied batch) or when an editor's session
 * ends (maybeCheckpoint with force); 'published' at every Publish; 'named'
 * on an owner's request; 'pre_restore' before every restore and 'restore'
 * for the restored state. Restore copies a version into the draft as a NEW
 * draft_version, never overwrites anything, and still needs a Publish.
 *
 * Retention: named, published, pre_restore and restore versions are kept
 * forever; autosaves for 30 days and at most the newest 100 (the stricter of
 * the two, so a busy event cannot fill the database). Edit-log rows
 * (event_edits) are pruned after 90 days.
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

export const AUTOSAVE_EVERY_MS = 5 * 60 * 1000;
export const AUTOSAVE_KEEP = 100;
export const AUTOSAVE_KEEP_DAYS = 30;
export const EDIT_LOG_KEEP_DAYS = 90;
const VERSION_INSERT_ATTEMPTS = 3;

/** Block and field labels from the registry (WS2), for every diff described in words. */
export const diffLabels: DiffLabels = {
  block: (type: BlockType) => blockRegistry.get(type)?.label ?? type,
  field: (type: BlockType, key: string) =>
    blockRegistry.get(type)?.fields.find((f) => f.key === key)?.label ?? null,
};

export function describeChanges(diff: DocDiff): string[] {
  return describeDiff(diff, diffLabels).map((l) => l.text);
}

function summaryOf(version: EventVersion, summary: string[]): EventVersionSummary {
  return {
    id: version.id,
    version: version.version,
    kind: version.kind,
    name: version.name,
    draftVersion: version.draft_version,
    authorName: version.author_name,
    createdAt: version.created_at,
    summary,
  };
}

function authorOf(actor: EventActor) {
  return {
    author_user_id: actor.kind === 'owner' ? actor.userId : null,
    author_editor_id: actor.kind === 'grant' ? actor.grant.grantId : null,
    author_name: cleanText(actor.name, 120) || 'Someone',
  };
}

/**
 * Save a checkpoint row. Version numbers are per event (1, 2, 3 …), unique
 * in the database: two saves racing for the same number retry with the next.
 */
export async function insertVersion(
  store: DataStore,
  input: {
    organizationId: string;
    eventId: string;
    kind: EventVersionKind;
    name: string | null;
    doc: EventDoc | Record<string, unknown>;
    draftVersion: number;
    actor: EventActor;
  },
): Promise<EventVersion> {
  for (let attempt = 1; ; attempt++) {
    const latest = await store.list(
      'event_versions',
      input.organizationId,
      { eq: { event_id: input.eventId } },
      { orderBy: [{ field: 'version', direction: 'desc' }], limit: 1 },
    );
    const row: EventVersion = {
      id: newId(),
      organization_id: input.organizationId,
      event_id: input.eventId,
      version: (latest[0]?.version ?? 0) + 1,
      kind: input.kind,
      name: input.name,
      doc: structuredClone(input.doc) as Record<string, unknown>,
      draft_version: input.draftVersion,
      ...authorOf(input.actor),
      created_at: new Date().toISOString(),
    };
    try {
      return await store.insert('event_versions', row);
    } catch (error) {
      if (attempt < VERSION_INSERT_ATTEMPTS && isUniqueViolation(error)) continue;
      throw error;
    }
  }
}

/** Autosaves beyond the newest 100, or older than 30 days, are removed. */
export async function pruneAutosaves(
  store: DataStore,
  organizationId: string,
  eventId: string,
  now: Date = new Date(),
): Promise<number> {
  const autosaves = await store.list(
    'event_versions',
    organizationId,
    { eq: { event_id: eventId, kind: 'autosave' } },
    { orderBy: [{ field: 'version', direction: 'desc' }], limit: 1000 },
  );
  const cutoff = now.getTime() - AUTOSAVE_KEEP_DAYS * 24 * 60 * 60 * 1000;
  const drop = autosaves.filter((v, i) => i >= AUTOSAVE_KEEP || Date.parse(v.created_at) < cutoff);
  for (const v of drop) await store.remove('event_versions', organizationId, v.id);
  return drop.length;
}

/** Edit-log rows older than 90 days are removed. */
export async function pruneEdits(
  store: DataStore,
  organizationId: string,
  eventId: string,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - EDIT_LOG_KEEP_DAYS * 24 * 60 * 60 * 1000).toISOString();
  return store.removeWhere('event_edits', organizationId, {
    eq: { event_id: eventId },
    lt: { created_at: cutoff },
  });
}

/* ------------------------------------------------------------------ reads */

export async function listVersions(
  store: DataStore,
  actor: EventActor,
  eventId: string,
  options: { limit?: number } = {},
): Promise<Result<EventVersionSummary[]>> {
  const caps = capabilitiesFor(actor, eventId);
  if (!caps.ok) return caps;
  if (!caps.value.viewHistory) return notFound();
  const organizationId = actorOrganizationId(actor);
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
  return guard('listVersions', async () => {
    const event = await store.get('events', organizationId, eventId);
    if (!event) return notFound();
    // One extra, so the oldest listed version has something to compare to.
    const rows = await store.list(
      'event_versions',
      organizationId,
      { eq: { event_id: eventId } },
      { orderBy: [{ field: 'version', direction: 'desc' }], limit: limit + 1 },
    );
    const docs = rows.map((r) => readStoredDoc(r.doc, { eventId, what: `version ${r.version}` }));
    return ok(
      rows.slice(0, limit).map((row, i) => {
        const doc = docs[i]!;
        const prev = i + 1 < rows.length ? docs[i + 1]! : null;
        if (!doc.ok) return summaryOf(row, ['This version could not be read.']);
        if (prev === null) {
          return summaryOf(row, ['The first saved version']);
        }
        const lines = describeChanges(diffDocs(prev.ok ? prev.value : null, doc.value));
        return summaryOf(row, lines.length ? lines : ['No visible changes']);
      }),
    );
  });
}

/** One version's document, for a read-only preview in the canvas. */
export async function getVersion(
  store: DataStore,
  actor: EventActor,
  eventId: string,
  versionId: string,
): Promise<Result<{ version: EventVersion; doc: EventDoc }>> {
  const caps = capabilitiesFor(actor, eventId);
  if (!caps.ok) return caps;
  if (!caps.value.viewHistory) return notFound();
  const organizationId = actorOrganizationId(actor);
  return guard('getVersion', async () => {
    const version = await store.get('event_versions', organizationId, versionId);
    if (!version || version.event_id !== eventId) {
      return err('not_found', 'That version does not exist.');
    }
    const doc = readStoredDoc(version.doc, { eventId, what: `version ${version.version}` });
    if (!doc.ok) return doc;
    return ok({ version, doc: doc.value });
  });
}

export async function createNamedVersion(
  store: DataStore,
  actor: EventActor,
  eventId: string,
  name: string,
): Promise<Result<EventVersionSummary>> {
  const caps = capabilitiesFor(actor, eventId);
  if (!caps.ok) return caps;
  if (actor.kind !== 'owner' || !caps.value.viewHistory) {
    return err('forbidden', 'Only TipTop can name a version.');
  }
  const label = cleanText(name ?? '', 120);
  if (!label) return err('invalid_input', 'Give the version a name (up to 120 characters).');
  const organizationId = actor.organizationId;
  return guard('createNamedVersion', async () => {
    const event = await store.get('events', organizationId, eventId);
    if (!event) return notFound();
    const doc = readStoredDoc(event.draft_doc, { eventId, what: 'draft' });
    if (!doc.ok) return doc;
    const row = await insertVersion(store, {
      organizationId,
      eventId,
      kind: 'named',
      name: label,
      doc: doc.value,
      draftVersion: event.draft_version,
      actor,
    });
    await recordAudit(store, {
      organizationId,
      userId: actor.userId,
      action: 'event.version_named',
      entityType: 'event',
      entityId: eventId,
      metadata: { version: row.version },
    });
    return ok(summaryOf(row, [`Named “${label}”`]));
  });
}

/**
 * Called after applied ops: saves an autosave checkpoint when one is due (5+
 * minutes since the last checkpoint, or since the event was created, and the
 * draft changed since). `force`: an editor's session ended — save now if the
 * draft changed since the last checkpoint.
 */
export async function maybeCheckpoint(
  store: DataStore,
  actor: EventActor,
  eventId: string,
  options: { force?: boolean; now?: Date } = {},
): Promise<Result<EventVersionSummary | null>> {
  const caps = capabilitiesFor(actor, eventId);
  if (!caps.ok) return caps;
  if (!caps.value.viewDraft) return notFound();
  const organizationId = actorOrganizationId(actor);
  const now = options.now ?? new Date();
  return guard('maybeCheckpoint', async () => {
    const event = await store.get('events', organizationId, eventId);
    if (!event) return notFound();
    const latest = (
      await store.list(
        'event_versions',
        organizationId,
        { eq: { event_id: eventId } },
        { orderBy: [{ field: 'version', direction: 'desc' }], limit: 1 },
      )
    )[0];
    const changed = event.draft_version > (latest?.draft_version ?? 0);
    if (!changed) return ok(null);
    const since = Date.parse(latest?.created_at ?? event.created_at);
    if (!options.force && now.getTime() - since < AUTOSAVE_EVERY_MS) return ok(null);
    const doc = readStoredDoc(event.draft_doc, { eventId, what: 'draft' });
    if (!doc.ok) return doc;
    const row = await insertVersion(store, {
      organizationId,
      eventId,
      kind: 'autosave',
      name: null,
      doc: doc.value,
      draftVersion: event.draft_version,
      actor,
    });
    await pruneAutosaves(store, organizationId, eventId, now);
    return ok(summaryOf(row, ['Autosave']));
  });
}

/* ---------------------------------------------------------------- restore */

/** event_edits rows describing a whole-document change (restore), one per section touched. */
export function editsForDiff(
  diff: DocDiff,
  base: {
    organizationId: string;
    eventId: string;
    draftVersion: number;
    actor: EventActor;
    ip?: string | null;
  },
): EventEdit[] {
  const now = new Date().toISOString();
  const common = {
    organization_id: base.organizationId,
    event_id: base.eventId,
    draft_version: base.draftVersion,
    actor_key: actorKey(base.actor),
    author_name: cleanText(base.actor.name, 120) || 'Someone',
    ip_hash: hashIp(base.ip ?? null),
    created_at: now,
    before: null,
    after: null,
  };
  const rows: EventEdit[] = diff.sections.map((c) => ({
    ...common,
    id: newId(),
    section_id: c.sectionId,
    op:
      c.change === 'added'
        ? 'insert'
        : c.change === 'removed'
          ? 'delete'
          : c.change === 'moved'
            ? 'move'
            : 'update',
    keys: c.keys.filter((k) => k !== 'type'),
  }));
  if (diff.theme.length) {
    rows.push({ ...common, id: newId(), section_id: null, op: 'theme', keys: [...diff.theme] });
  }
  if (diff.meta.length) {
    rows.push({ ...common, id: newId(), section_id: null, op: 'page', keys: [...diff.meta] });
  }
  return rows;
}

/**
 * Owners only. Saves the current draft as 'pre_restore', puts the version's
 * page in the draft as a new draft_version (under the same compare-and-set
 * as every save), records a 'restore' version and the edit-log rows, and
 * returns the new draft_version. The live page is untouched until Publish.
 */
export async function restoreVersion(
  store: DataStore,
  actor: EventActor,
  eventId: string,
  versionId: string,
  context: { ip?: string | null } = {},
): Promise<Result<{ draftVersion: number }>> {
  const caps = capabilitiesFor(actor, eventId);
  if (!caps.ok) return caps;
  if (actor.kind !== 'owner' || !caps.value.restoreVersions) {
    return err('forbidden', 'Only TipTop can restore a version.');
  }
  const organizationId = actor.organizationId;
  return guard('restoreVersion', async () => {
    const version = await store.get('event_versions', organizationId, versionId);
    if (!version || version.event_id !== eventId) {
      return err('not_found', 'That version does not exist.');
    }
    const target = readStoredDoc(
      version.doc,
      { eventId, what: `version ${version.version}` },
      { validateProps: blockRegistry.validateProps, validateTheme: blockRegistry.validateTheme },
    );
    if (!target.ok) {
      return err(
        'invalid_input',
        'That version no longer fits the page format, so it cannot be restored as it is.',
      );
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
      const event = await store.get('events', organizationId, eventId);
      if (!event) return notFound();
      const current = readStoredDoc(event.draft_doc, { eventId, what: 'draft' });
      if (!current.ok) return current;
      const nv = event.draft_version + 1;
      const { doc, diff } = rebaseOnto(current.value, target.value, nv);
      if (diff.empty) return ok({ draftVersion: event.draft_version });

      const written = await store.updateWhere(
        'events',
        organizationId,
        { eq: { id: eventId, draft_version: event.draft_version } },
        { draft_doc: doc as unknown as Record<string, unknown>, draft_version: nv },
      );
      if (written.length === 0) continue;

      await insertVersion(store, {
        organizationId,
        eventId,
        kind: 'pre_restore',
        name: `Before restoring version ${version.version}`,
        doc: current.value,
        draftVersion: event.draft_version,
        actor,
      });
      await insertVersion(store, {
        organizationId,
        eventId,
        kind: 'restore',
        name: `Restored version ${version.version}`,
        doc,
        draftVersion: nv,
        actor,
      });
      const edits = editsForDiff(diff, {
        organizationId,
        eventId,
        draftVersion: nv,
        actor,
        ip: context.ip,
      });
      if (edits.length) await store.insertMany('event_edits', edits);
      await recordAudit(store, {
        organizationId,
        userId: auditUserId(actor),
        action: 'event.version_restored',
        entityType: 'event',
        entityId: eventId,
        metadata: { version: version.version, draftVersion: nv, sections: diff.sections.length },
      });
      return ok({ draftVersion: nv });
    }
    return err('conflict', 'Several people are saving at once. Try the restore again.', {
      retryable: true,
    });
  });
}

/* --------------------------------------------------------------- activity */

export interface EventActivityItem {
  id: string;
  sectionId: string | null;
  op: EventEdit['op'];
  keys: string[];
  authorName: string;
  /** Made through an outside link. */
  outside: boolean;
  draftVersion: number;
  createdAt: string;
}

/**
 * The per-section Activity panel ("who changed which keys, when"), newest
 * first, from event_edits. Names are as they were at the time, so
 * attribution survives a revoked link. Owners only.
 */
export async function listActivity(
  store: DataStore,
  actor: EventActor,
  eventId: string,
  options: { sectionId?: string | null; limit?: number } = {},
): Promise<Result<EventActivityItem[]>> {
  const caps = capabilitiesFor(actor, eventId);
  if (!caps.ok) return caps;
  if (!caps.value.viewHistory) return notFound();
  const organizationId = actorOrganizationId(actor);
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
  return guard('listActivity', async () => {
    const event = await store.get('events', organizationId, eventId);
    if (!event) return notFound();
    const filter: Filter =
      options.sectionId === undefined
        ? { eq: { event_id: eventId } }
        : options.sectionId === null
          ? { eq: { event_id: eventId }, isNull: ['section_id'] }
          : { eq: { event_id: eventId, section_id: options.sectionId } };
    const rows = await store.list('event_edits', organizationId, filter, {
      orderBy: [
        { field: 'draft_version', direction: 'desc' },
        { field: 'created_at', direction: 'desc' },
      ],
      limit,
    });
    return ok(
      rows.map((e) => ({
        id: e.id,
        sectionId: e.section_id,
        op: e.op,
        keys: e.keys,
        authorName: e.author_name,
        outside: e.actor_key.startsWith('g:'),
        draftVersion: e.draft_version,
        createdAt: e.created_at,
      })),
    );
  });
}

/** Who changed what since the last publish: section id (or 'theme'/'page') → author names. */
export async function authorsSince(
  store: DataStore,
  event: Pick<EventRecord, 'id' | 'organization_id' | 'published_draft_version'>,
): Promise<Map<string, string[]>> {
  const edits = await store.list(
    'event_edits',
    event.organization_id,
    { eq: { event_id: event.id }, gt: { draft_version: event.published_draft_version } },
    { orderBy: [{ field: 'draft_version', direction: 'asc' }], limit: 2000 },
  );
  const out = new Map<string, string[]>();
  for (const e of edits) {
    const key = e.section_id ?? (e.op === 'page' ? 'page' : 'theme');
    const name = e.actor_key.startsWith('g:') ? `${e.author_name} (outside)` : e.author_name;
    const list = out.get(key) ?? [];
    if (!list.includes(name)) list.push(name);
    out.set(key, list);
  }
  return out;
}

/** Best-effort checkpoint after a save; never fails the save. */
export async function checkpointQuietly(store: DataStore, actor: EventActor, eventId: string) {
  try {
    const result = await maybeCheckpoint(store, actor, eventId);
    if (!result.ok && result.error.code !== 'not_configured') {
      log.warn('Autosave checkpoint skipped', { event: eventId, reason: result.error.code });
    }
  } catch (error) {
    log.warn('Autosave checkpoint failed', {
      event: eventId,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
