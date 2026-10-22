import type { DraftSyncResult, PresenceEntry } from '@/lib/events/contracts';
import type { DraftOp, DraftOpsResult } from '@/lib/events/ops';
import { studioFetch, type StudioEndpoints } from './api';
import { DraftEditor } from './draft-editor';
import { syncQueryString } from './sync-query';

/**
 * The network half of Studio: autosave and the sync poll around one
 * DraftEditor. Browser-only (timers, fetch, visibility), no React.
 *
 * Autosave: section-level ops, debounced 1.2 s with an 8 s maximum wait,
 * flushed at once when the tab hides. One batch in flight at a time. Offline
 * or a busy server: the batch goes back in the queue and retries with
 * backoff (and at once when the browser says it is back online), while a
 * localStorage backup keeps unsaved ops across a reload.
 *
 * Sync: GET …/sync?since=n every 2 s while visible, every 10 s hidden,
 * paused after 15 idle minutes; each poll carries this person's focused
 * section and typing flag (presence) and brings back others' changes.
 *
 * A 404 from either means the link stopped working (revoked, regenerated,
 * expired) or the event is gone: the session stops and says so.
 */

export const AUTOSAVE_DEBOUNCE_MS = 1_200;
export const AUTOSAVE_MAX_WAIT_MS = 8_000;
export const SYNC_VISIBLE_MS = 2_000;
export const SYNC_HIDDEN_MS = 10_000;
export const IDLE_AFTER_MS = 15 * 60_000;

export type SaveState = 'saved' | 'saving' | 'offline' | 'conflict' | 'paused' | 'error';

export interface SessionState {
  save: SaveState;
  saveMessage: string | null;
  presence: PresenceEntry[];
  editingPaused: boolean;
  publishedVersion: number;
  /** The link or event is gone: Studio shows a dead-end screen. */
  lost: boolean;
  idle: boolean;
}

export interface StudioSessionOptions {
  eventId: string;
  actorKey: string;
  endpoints: StudioEndpoints;
  editor: DraftEditor;
  editingPaused: boolean;
  publishedVersion: number;
  /** Read-only links (viewers) never send ops. */
  readOnly: boolean;
}

type Listener = () => void;

function backupKey(eventId: string, actorKey: string): string {
  return `tiptop-studio-unsaved:${eventId}:${actorKey}`;
}

export function readBackup(eventId: string, actorKey: string): DraftOp[] {
  try {
    const raw = window.localStorage.getItem(backupKey(eventId, actorKey));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as DraftOp[]).slice(0, 200) : [];
  } catch {
    return [];
  }
}

function writeBackup(eventId: string, actorKey: string, ops: readonly DraftOp[]): void {
  try {
    // Unsaved edits only, as a convenience across a reload: the server's
    // draft stays the source of truth and every op is rev-checked on send.
    if (ops.length) window.localStorage.setItem(backupKey(eventId, actorKey), JSON.stringify(ops));
    else window.localStorage.removeItem(backupKey(eventId, actorKey));
  } catch {
    // Private mode or storage full: the in-memory queue still holds them.
  }
}

export class StudioSession {
  readonly editor: DraftEditor;
  private readonly options: StudioSessionOptions;
  private state: SessionState;
  private listeners = new Set<Listener>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 2_000;
  private syncing = false;
  private flushing = false;
  private stopped = true;
  private lastActivity = Date.now();
  private focus: string | null = null;
  private typing = false;
  private unsubscribe: (() => void) | null = null;
  private lastQueueLength = 0;

  constructor(options: StudioSessionOptions) {
    this.options = options;
    this.editor = options.editor;
    this.state = {
      save: 'saved',
      saveMessage: null,
      presence: [],
      editingPaused: options.editingPaused,
      publishedVersion: options.publishedVersion,
      lost: false,
      idle: false,
    };
  }

  /* ----------------------------------------------------------- state */

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): SessionState => this.state;

  private set(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  /* ------------------------------------------------------- lifecycle */

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.unsubscribe = this.editor.subscribe(() => this.onEditorChange());
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('online', this.onOnline);
    window.addEventListener('pagehide', this.onPageHide);
    this.scheduleSync(0);
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const t of [this.debounceTimer, this.maxWaitTimer, this.retryTimer, this.syncTimer]) {
      if (t) clearTimeout(t);
    }
    this.debounceTimer = this.maxWaitTimer = this.retryTimer = this.syncTimer = null;
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('online', this.onOnline);
    window.removeEventListener('pagehide', this.onPageHide);
  }

  /** Any keypress, click or pointer move in Studio: resets the idle clock. */
  markActivity(): void {
    this.lastActivity = Date.now();
    if (this.state.idle) {
      this.set({ idle: false });
      this.scheduleSync(0);
    }
  }

  setFocus(sectionId: string | null): void {
    if (this.focus === sectionId) return;
    this.focus = sectionId;
    this.markActivity();
  }

  setTyping(typing: boolean): void {
    this.typing = typing;
  }

  /* -------------------------------------------------------- autosave */

  private onEditorChange(): void {
    const length = this.editor.pending.length;
    writeBackup(this.options.eventId, this.options.actorKey, this.editor.backup());
    if (this.editor.conflicts.length) this.set({ save: 'conflict', saveMessage: null });
    else if (this.state.save === 'conflict') {
      this.set({ save: this.editor.hasUnsaved ? 'saving' : 'saved' });
    }
    // A new unsent op: start (or restart) the debounce, and the max wait once.
    if (length > this.lastQueueLength && this.editor.pending.some((p) => !p.sent)) {
      this.markActivity();
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => void this.flush(), AUTOSAVE_DEBOUNCE_MS);
      if (!this.maxWaitTimer) {
        this.maxWaitTimer = setTimeout(() => void this.flush(), AUTOSAVE_MAX_WAIT_MS);
      }
      if (this.state.save === 'saved') this.set({ save: 'saving', saveMessage: null });
    } else if (length !== this.lastQueueLength && this.state.save === 'saved' && length > 0) {
      this.set({ save: 'saving' });
    }
    this.lastQueueLength = length;
  }

  /** Send what is queued now (the debounce, the max wait, a hidden tab, Ctrl+S). */
  async flush(options: { keepalive?: boolean } = {}): Promise<void> {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer);
    this.debounceTimer = this.maxWaitTimer = null;
    if (this.flushing || this.stopped || this.state.lost || this.options.readOnly) return;
    if (this.state.editingPaused && this.options.endpoints.review) {
      // Outside editors while paused: keep the changes, send nothing.
      if (this.editor.hasUnsaved) this.set({ save: 'paused' });
      return;
    }
    const batch = this.editor.takeBatch();
    if (!batch) {
      if (!this.editor.hasUnsaved && !this.editor.conflicts.length) {
        this.set({ save: 'saved', saveMessage: null });
      }
      return;
    }
    this.flushing = true;
    this.set({ save: 'saving', saveMessage: null });
    const body = JSON.stringify(batch);
    const response = await studioFetch<DraftOpsResult>(this.options.endpoints.ops, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json' },
      // A hidden tab's last save must survive the page going away.
      keepalive: options.keepalive === true && body.length < 60_000,
    });
    this.flushing = false;
    if (response.ok) {
      this.retryDelay = 2_000;
      this.editor.ack(response.value);
      // A conflict means someone else's change landed first: fetch it now, so
      // the dialog's "Keep mine" writes over what is really there.
      if (response.value.conflicts.length) this.syncNow();
      const next = this.editor.conflicts.length
        ? 'conflict'
        : this.editor.hasUnsaved
          ? 'saving'
          : 'saved';
      this.set({ save: next, saveMessage: null });
      if (this.editor.hasUnsaved && !this.editor.inFlight) void this.flush();
      return;
    }
    this.editor.requeue();
    if (response.status === 404) {
      this.set({ lost: true, save: 'error', saveMessage: response.error.message });
      this.stop();
      return;
    }
    if (response.status === 403) {
      this.set({ save: 'paused', saveMessage: response.error.message, editingPaused: true });
      return;
    }
    if (response.status === 400 || response.status === 413) {
      // The batch itself is unreadable: drop it rather than retry for ever.
      this.editor.discardPending();
      this.set({ save: 'error', saveMessage: response.error.message });
      return;
    }
    this.set({
      save: response.offline ? 'offline' : 'saving',
      saveMessage: response.offline ? null : response.error.message,
    });
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.stopped) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flush();
    }, this.retryDelay);
    this.retryDelay = Math.min(30_000, this.retryDelay * 2);
  }

  private onOnline = (): void => {
    this.retryDelay = 2_000;
    void this.flush();
    this.scheduleSync(0);
  };

  private onVisibility = (): void => {
    if (document.visibilityState === 'hidden') void this.flush({ keepalive: true });
    else this.scheduleSync(0);
  };

  private onPageHide = (): void => {
    void this.flush({ keepalive: true });
    try {
      navigator.sendBeacon?.(
        this.options.endpoints.leave,
        new Blob(['{}'], { type: 'application/json' }),
      );
    } catch {
      // Best effort: the row expires on its own after a minute.
    }
  };

  /* ------------------------------------------------------------ sync */

  private scheduleSync(delay: number): void {
    if (this.stopped) return;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => void this.poll(), delay);
  }

  /** Ask now (after a publish or restore, or a manual refresh). */
  syncNow(): void {
    this.scheduleSync(0);
  }

  private async poll(): Promise<void> {
    this.syncTimer = null;
    if (this.stopped || this.syncing) return;
    if (Date.now() - this.lastActivity > IDLE_AFTER_MS) {
      this.set({ idle: true });
      return;
    }
    this.syncing = true;
    const query = syncQueryString({
      since: this.editor.syncedVersion,
      presence: { focusedSectionId: this.focus, typing: this.typing },
    });
    const response = await studioFetch<DraftSyncResult>(`${this.options.endpoints.sync}?${query}`);
    this.syncing = false;
    if (response.ok) {
      this.editor.applySync(response.value);
      const wasPaused = this.state.editingPaused;
      this.set({
        presence: response.value.presence,
        editingPaused: response.value.editingPaused,
        publishedVersion: response.value.publishedVersion,
        ...(this.state.save === 'offline' ? { save: 'saving' as const } : {}),
      });
      if (wasPaused && !response.value.editingPaused && this.editor.hasUnsaved) void this.flush();
    } else if (response.status === 404) {
      this.set({ lost: true });
      this.stop();
      return;
    } else if (response.offline && this.editor.hasUnsaved) {
      this.set({ save: 'offline' });
    }
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    this.scheduleSync(hidden ? SYNC_HIDDEN_MS : SYNC_VISIBLE_MS);
  }
}
