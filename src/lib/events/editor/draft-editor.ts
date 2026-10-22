import type { DraftSyncResult } from '@/lib/events/contracts';
import { applyOps } from '@/lib/events/merge';
import {
  invertOp,
  type DraftChanges,
  type DraftOp,
  type DraftOpsRequest,
  type DraftOpsResult,
  type OpConflict,
} from '@/lib/events/ops';
import type { EventDoc, EventPageMeta, EventSection, EventTheme } from '@/lib/events/schema';
import { coalesce, newClientId, opKeys, opTarget } from './doc-ops';

/**
 * Studio's client-side draft: what the server confirmed, the person's
 * unsaved ops on top, and their own undo/redo stacks. Framework-agnostic and
 * pure apart from its listeners, so it is unit-tested directly
 * (tests/unit/events-undo.test.ts) and wrapped for React in use-studio.ts.
 *
 *   confirmed   the server's state as far as this client knows it (from the
 *               page load, op acks and sync polls);
 *   pending     ops not yet acknowledged, in order. At most one batch is in
 *               flight (the front `sent` entries);
 *   display     confirmed + pending, applied with the same merge the server
 *               uses (lib/events/merge.ts), so what Studio shows is what the
 *               server will most likely end up with — and an op the server
 *               would refuse as stale is already not shown.
 *
 * Every op carries the rev of its target this person last saw. When one of
 * their own batches lands, the ops still queued behind it are REBASED onto
 * the new revs, but only where every newer key rev is this person's own
 * write; a key someone else changed keeps the old baseRev, so the server
 * reports the conflict instead of silently overwriting them.
 *
 * Undo is per person, up to 100 ops, cleared on reload. Undo sends the
 * inverse as a NEW rev-checked op; if someone changed that key since, it
 * comes back as a conflict and Studio says "Can't undo – Morgan changed this
 * since", so undo never overwrites a collaborator.
 *
 * A change not saved yet (autosave waits 1.2 s; offline it waits for the
 * network) is undone LOCALLY: it simply leaves the queue, and Redo puts it
 * back, with no round trip. A change in flight is undone as soon as the
 * server confirms it.
 */

export const UNDO_LIMIT = 100;
/** "Keep mine" resends over whatever is there now (no key is ever newer than this). */
export const KEEP_MINE_REV = Number.MAX_SAFE_INTEGER;
export const MAX_BATCH = 50;

export type OpOrigin = 'edit' | 'undo' | 'redo' | 'resolve';

export interface OpBefore {
  section?: EventSection | null;
  theme?: EventTheme;
  meta?: EventPageMeta;
}

export interface PendingOp {
  op: DraftOp;
  before: OpBefore;
  origin: OpOrigin;
  /** A short label for undo/redo tooltips and notices ("Edit Hero"). */
  label: string;
  sent: boolean;
}

export interface UndoEntry {
  op: DraftOp;
  before: OpBefore;
  /** The target's rev right after this op landed. */
  revAfter: number;
  label: string;
}

/** A conflict the person needs to decide on (the conflict dialog). */
export interface StudioConflict {
  id: string;
  conflict: OpConflict;
  pending: PendingOp;
}

/** A one-line message for a toast ("Can't undo – Morgan changed this since"). */
export interface StudioNotice {
  id: string;
  tone: 'info' | 'warning' | 'error';
  text: string;
}

export interface DraftEditorInit {
  doc: EventDoc;
  version: number;
}

type Listener = () => void;

function targetKey(target: 'section' | 'theme' | 'meta', id: string | null, key: string): string {
  return target === 'section' ? `s:${id}:${key}` : `${target}:${key}`;
}

export class DraftEditor {
  private confirmedDoc: EventDoc;
  /** Highest draft_version this client has seen (acks and syncs). */
  private knownVersion: number;
  /** The draft_version the last sync answered for (the next poll's `since`). */
  private synced: number;
  private queue: PendingOp[] = [];
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  /** Unsaved changes taken back by Undo, newest last (Redo re-queues them). */
  private localRedo: PendingOp[] = [];
  /** Queued undos of saved changes, by the undo op's id (Redo before it is saved). */
  private queuedUndos = new Map<string, UndoEntry>();
  /** An in-flight change the person undid: undone as soon as it is confirmed. */
  private undoOnAck: string | null = null;
  /** target:key → the rev this person's own write produced. */
  private myWrites = new Map<string, number>();
  private conflictList: StudioConflict[] = [];
  private noticeList: StudioNotice[] = [];
  private displayCache: EventDoc | null = null;
  private listeners = new Set<Listener>();
  private revision = 0;

  constructor(init: DraftEditorInit) {
    this.confirmedDoc = structuredClone(init.doc);
    this.knownVersion = init.version;
    this.synced = init.version;
  }

  /* -------------------------------------------------------- subscription */

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Changes whenever anything visible changed (for useSyncExternalStore). */
  getRevision = (): number => this.revision;

  /** The display document, stable between changes (a useSyncExternalStore snapshot). */
  getDisplay = (): EventDoc => this.display;

  private emit(): void {
    this.displayCache = null;
    this.revision++;
    for (const l of this.listeners) l();
  }

  /* ------------------------------------------------------------- reading */

  get confirmed(): EventDoc {
    return this.confirmedDoc;
  }

  get version(): number {
    return this.knownVersion;
  }

  get syncedVersion(): number {
    return this.synced;
  }

  get pending(): readonly PendingOp[] {
    return this.queue;
  }

  get hasUnsaved(): boolean {
    return this.queue.length > 0;
  }

  get inFlight(): boolean {
    return this.queue.some((p) => p.sent);
  }

  get conflicts(): readonly StudioConflict[] {
    return this.conflictList;
  }

  get notices(): readonly StudioNotice[] {
    return this.noticeList;
  }

  /** The newest unsaved change Undo can take back locally, if any. */
  private localUndoable(): PendingOp | null {
    const last = this.queue.at(-1);
    return last && (last.origin === 'edit' || last.origin === 'redo') ? last : null;
  }

  /** The newest queued (unsaved) undo that Redo can take back locally, if any. */
  private localRedoable(): PendingOp | null {
    const last = this.queue.at(-1);
    return last && !last.sent && last.origin === 'undo' && this.queuedUndos.has(last.op.opId)
      ? last
      : null;
  }

  get canUndo(): boolean {
    return this.localUndoable() !== null || this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.localRedo.length > 0 || this.localRedoable() !== null || this.redoStack.length > 0;
  }

  get undoLabel(): string | null {
    return this.localUndoable()?.label ?? this.undoStack.at(-1)?.label ?? null;
  }

  get redoLabel(): string | null {
    return (
      this.localRedo.at(-1)?.label ??
      this.localRedoable()?.label ??
      this.redoStack.at(-1)?.label ??
      null
    );
  }

  /** What Studio shows: confirmed + pending, through the server's own merge. */
  get display(): EventDoc {
    if (this.displayCache) return this.displayCache;
    if (!this.queue.length) {
      this.displayCache = this.confirmedDoc;
      return this.displayCache;
    }
    const merged = applyOps(
      this.confirmedDoc,
      this.queue.map((p) => p.op),
      { nextVersion: this.knownVersion + 1 },
    );
    this.displayCache = merged.doc;
    return this.displayCache;
  }

  /* ------------------------------------------------------------- editing */

  private snapshot(op: DraftOp): OpBefore {
    const doc = this.display;
    const { target, id } = opTarget(op);
    if (target === 'theme') return { theme: structuredClone(doc.theme) };
    if (target === 'meta') return { meta: structuredClone(doc.meta) };
    const section = doc.sections.find((s) => s.id === id);
    return { section: section ? structuredClone(section) : null };
  }

  /**
   * Queue one op. Consecutive unsent ops writing the same keys of the same
   * target fold into one (one undo step per field burst).
   */
  apply(op: DraftOp, label = 'Edit', origin: OpOrigin = 'edit'): void {
    if (origin === 'edit' || origin === 'resolve') {
      this.redoStack = [];
      this.localRedo = [];
    }
    const last = this.queue.at(-1);
    if (last && !last.sent && last.origin === origin && origin === 'edit') {
      const folded = coalesce(last.op, op);
      if (folded) {
        last.op = folded;
        this.emit();
        return;
      }
    }
    const entry: PendingOp = { op, before: this.snapshot(op), origin, label, sent: false };
    this.rebaseOne(entry);
    this.queue.push(entry);
    this.emit();
  }

  /** Take the next batch to send (null while one is in flight or nothing waits). */
  takeBatch(): DraftOpsRequest | null {
    if (this.inFlight || !this.queue.length) return null;
    const batch = this.queue.slice(0, MAX_BATCH);
    for (const p of batch) p.sent = true;
    return { baseVersion: this.synced, ops: batch.map((p) => p.op) };
  }

  /** The batch in flight failed to arrive (network, server busy): it goes back in the queue. */
  requeue(): void {
    for (const p of this.queue) p.sent = false;
    this.emit();
  }

  /** Drop everything unsaved (the link was revoked, or the person chose to discard). */
  discardPending(): void {
    this.queue = [];
    this.emit();
  }

  /* ------------------------------------------------------------- results */

  private mergeChanges(changes: DraftChanges, version: number, newerOnly: boolean): void {
    const doc: EventDoc = { ...this.confirmedDoc, sections: [...this.confirmedDoc.sections] };
    for (const section of changes.sections) {
      const i = doc.sections.findIndex((s) => s.id === section.id);
      if (i < 0) doc.sections.push(section);
      else if (!newerOnly || section.rev >= doc.sections[i]!.rev) doc.sections[i] = section;
    }
    if (changes.deletedSectionIds.length) {
      const gone = new Set(changes.deletedSectionIds);
      doc.sections = doc.sections.filter((s) => !gone.has(s.id) || s.rev > version);
    }
    if (changes.theme && (!newerOnly || changes.theme.rev >= doc.theme.rev)) {
      doc.theme = changes.theme;
    }
    if (changes.meta && (!newerOnly || changes.meta.rev >= doc.meta.rev)) {
      doc.meta = changes.meta;
    }
    this.confirmedDoc = doc;
    this.knownVersion = Math.max(this.knownVersion, version);
  }

  private revOf(target: 'section' | 'theme' | 'meta', id: string | null): number | null {
    if (target === 'theme') return this.confirmedDoc.theme.rev;
    if (target === 'meta') return this.confirmedDoc.meta.rev;
    return this.confirmedDoc.sections.find((s) => s.id === id)?.rev ?? null;
  }

  private keyRevs(
    target: 'section' | 'theme' | 'meta',
    id: string | null,
  ): Record<string, number> | null {
    if (target === 'theme') return this.confirmedDoc.theme.keyRevs;
    if (target === 'meta') return this.confirmedDoc.meta.keyRevs;
    return this.confirmedDoc.sections.find((s) => s.id === id)?.keyRevs ?? null;
  }

  /**
   * Move an op's baseRev up to the newest rev of its keys, when every key
   * newer than its baseRev was written by this person.
   */
  private rebaseOne(entry: PendingOp): void {
    const op = entry.op;
    if (op.kind === 'section.insert' || op.kind === 'section.move') return;
    const { target, id } = opTarget(op);
    const revs = this.keyRevs(target, id);
    if (!revs) return;
    const keys = op.kind === 'section.delete' ? Object.keys(revs) : opKeys(op);
    let newest = op.baseRev;
    for (const key of keys) {
      const rev = revs[key] ?? 0;
      if (rev <= op.baseRev) continue;
      if (this.myWrites.get(targetKey(target, id, key)) !== rev) return;
      newest = Math.max(newest, rev);
    }
    if (op.kind === 'section.delete') {
      const sectionRev = this.revOf('section', op.id) ?? newest;
      // Only the whole section's rev clears a delete; every newer key was ours.
      newest = Math.max(newest, sectionRev);
    }
    if (newest !== op.baseRev) entry.op = { ...op, baseRev: newest } as DraftOp;
  }

  private recordWrite(op: DraftOp): number | null {
    const { target, id } = opTarget(op);
    const rev = this.revOf(target, id);
    if (rev === null) return null;
    const revs = this.keyRevs(target, id) ?? {};
    for (const key of opKeys(op)) {
      const keyRev = revs[key];
      if (keyRev !== undefined) this.myWrites.set(targetKey(target, id, key), keyRev);
    }
    return rev;
  }

  private notify(tone: StudioNotice['tone'], text: string): void {
    this.noticeList = [...this.noticeList, { id: newClientId(), tone, text }].slice(-5);
  }

  /** The server answered the batch in flight. */
  ack(result: DraftOpsResult): void {
    const sent = this.queue.filter((p) => p.sent);
    this.queue = this.queue.filter((p) => !p.sent);
    this.mergeChanges(result.changes, result.version, true);

    const applied = new Set(result.applied);
    for (const p of sent) {
      if (!applied.has(p.op.opId)) continue;
      const revAfter = this.recordWrite(p.op);
      const entry: UndoEntry = {
        op: p.op,
        before: p.before,
        revAfter: revAfter ?? result.version,
        label: p.label,
      };
      if (p.origin === 'undo') this.redoStack.push(entry);
      else this.undoStack.push(entry);
      this.queuedUndos.delete(p.op.opId);
      if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
      if (this.redoStack.length > UNDO_LIMIT) this.redoStack.shift();
    }
    for (const p of sent) this.queuedUndos.delete(p.op.opId);
    const undoNow = this.undoOnAck;
    this.undoOnAck = null;

    for (const conflict of result.conflicts) {
      const p = sent.find((s) => s.op.opId === conflict.opId);
      if (!p) continue;
      this.handleConflict(conflict, p);
    }

    for (const p of this.queue) this.rebaseOne(p);
    // Undone while it was in flight: now that it is saved, undo it.
    if (undoNow && this.undoStack.at(-1)?.op.opId === undoNow) {
      this.undo();
      return;
    }
    this.emit();
  }

  private handleConflict(conflict: OpConflict, p: PendingOp): void {
    const who = conflict.by?.name;
    if (conflict.kind === 'forbidden') {
      this.notify('error', `${p.label}: ${conflict.message}`);
      return;
    }
    if (conflict.kind === 'invalid') {
      this.notify('error', `${p.label} could not be saved: ${conflict.message}`);
      return;
    }
    if (p.origin === 'undo' || p.origin === 'redo') {
      this.notify('warning', `Can't ${p.origin} – ${who ?? 'someone else'} changed this since.`);
      return;
    }
    if (conflict.kind === 'section_exists') {
      this.notify('warning', `${p.label}: that section is already there.`);
      return;
    }
    this.conflictList = [...this.conflictList, { id: newClientId(), conflict, pending: p }];
  }

  /** A sync poll's answer: others' changes, deletions, presence handled by the caller. */
  applySync(result: DraftSyncResult): void {
    if (result.full) {
      // A whole document (after a restore, or a client ahead of the server),
      // unless an ack already brought something newer.
      if (result.version >= this.knownVersion) {
        this.confirmedDoc = structuredClone(result.full);
        this.knownVersion = result.version;
      }
    } else {
      this.mergeChanges(result.changes, result.version, true);
    }
    this.synced = Math.max(this.synced, result.version);
    for (const p of this.queue) if (!p.sent) this.rebaseOne(p);
    this.emit();
  }

  /** Replace everything with a fresh server snapshot (after a restore). */
  reset(doc: EventDoc, version: number): void {
    this.confirmedDoc = structuredClone(doc);
    this.knownVersion = version;
    this.synced = version;
    this.queue = [];
    this.undoStack = [];
    this.redoStack = [];
    this.localRedo = [];
    this.queuedUndos.clear();
    this.undoOnAck = null;
    this.myWrites.clear();
    this.conflictList = [];
    this.emit();
  }

  /* ---------------------------------------------------------- undo, redo */

  undo(): boolean {
    const local = this.localUndoable();
    if (local && !local.sent) {
      // Not saved yet: it just leaves the queue (no round trip, works offline).
      this.queue.pop();
      this.localRedo.push(local);
      this.emit();
      return true;
    }
    if (local && local.sent) {
      // In flight: undone the moment the server confirms it.
      this.undoOnAck = local.op.opId;
      this.emit();
      return true;
    }
    const entry = this.undoStack.pop();
    if (!entry) return false;
    const inverse = invertOp(entry.op, entry.before, newClientId(), entry.revAfter);
    if (!inverse) {
      this.notify('warning', "Can't undo that change.");
      this.emit();
      return false;
    }
    this.queuedUndos.set(inverse.opId, entry);
    this.apply(inverse, entry.label, 'undo');
    return true;
  }

  redo(): boolean {
    const local = this.localRedo.pop();
    if (local) {
      const entry: PendingOp = { ...local, sent: false };
      this.rebaseOne(entry);
      this.queue.push(entry);
      this.emit();
      return true;
    }
    const queuedUndo = this.localRedoable();
    if (queuedUndo) {
      // An undo not saved yet: drop it, and the change it undid is back.
      this.queue.pop();
      const entry = this.queuedUndos.get(queuedUndo.op.opId)!;
      this.queuedUndos.delete(queuedUndo.op.opId);
      this.undoStack.push(entry);
      this.emit();
      return true;
    }
    const entry = this.redoStack.pop();
    if (!entry) return false;
    const again = invertOp(entry.op, entry.before, newClientId(), entry.revAfter);
    if (!again) {
      this.notify('warning', "Can't redo that change.");
      this.emit();
      return false;
    }
    this.apply(again, entry.label, 'redo');
    return true;
  }

  /* ------------------------------------------------------- conflicts */

  /**
   * Keep mine: send the change again over theirs. The person has seen both
   * versions and chosen theirs to lose, so the resend is not rev-checked
   * against what they were shown (baseRev at the ceiling), even when the
   * poll that brings their change has not landed yet.
   */
  keepMine(conflictId: string): void {
    const item = this.conflictList.find((c) => c.id === conflictId);
    if (!item) return;
    this.conflictList = this.conflictList.filter((c) => c.id !== conflictId);
    const op = item.pending.op;
    if (item.conflict.kind === 'section_deleted') {
      this.restoreDeleted(item);
      return;
    }
    if (
      op.kind === 'section.update' ||
      op.kind === 'theme.update' ||
      op.kind === 'page.update' ||
      op.kind === 'section.delete'
    ) {
      this.apply(
        { ...op, opId: newClientId(), baseRev: KEEP_MINE_REV } as DraftOp,
        item.pending.label,
        'resolve',
      );
    } else {
      this.emit();
    }
  }

  /** Use theirs (or Discard my change): nothing to send. */
  takeTheirs(conflictId: string): void {
    this.conflictList = this.conflictList.filter((c) => c.id !== conflictId);
    this.emit();
  }

  /** "Alex deleted this section – Restore": put the section back with my change in it. */
  private restoreDeleted(item: StudioConflict): void {
    const section = item.pending.before.section;
    const op = item.pending.op;
    if (!section) {
      this.emit();
      return;
    }
    const restored: EventSection = structuredClone(section);
    if (op.kind === 'section.update') {
      for (const [key, value] of Object.entries(op.set)) {
        if (key.startsWith('props.')) restored.props[key.slice(6)] = value;
        else (restored as unknown as Record<string, unknown>)[key] = value;
      }
      for (const key of op.unset ?? []) delete restored.props[key.slice(6)];
    }
    this.apply(
      { kind: 'section.insert', opId: newClientId(), section: restored, afterId: null },
      'Restore section',
      'resolve',
    );
  }

  dismissNotice(id: string): void {
    this.noticeList = this.noticeList.filter((n) => n.id !== id);
    this.emit();
  }

  /** Serializable unsaved ops (the offline backup). */
  backup(): DraftOp[] {
    return this.queue.map((p) => p.op);
  }

  /** Re-queue ops saved by an earlier tab that never reached the server. */
  restoreBackup(ops: readonly DraftOp[]): number {
    let n = 0;
    for (const op of ops) {
      this.apply(op, 'Unsaved change', 'resolve');
      n++;
    }
    return n;
  }
}
