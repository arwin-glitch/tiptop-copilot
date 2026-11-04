'use client';

import * as React from 'react';
import { toast } from 'sonner';
import {
  AlarmClock,
  Archive,
  ExternalLink,
  Forward,
  Inbox as InboxIcon,
  Info,
  Mail,
  MailOpen,
  Menu,
  MessagesSquare,
  OctagonAlert,
  PenSquare,
  Reply,
  Star,
  Tag,
  Trash2,
  Users,
  X,
  Bookmark,
  FolderInput,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/feedback';
import { Composer, type ComposeDraft } from '@/components/inbox/composer';
import { InboxNav } from '@/components/inbox/inbox-nav';
import { InboxSearch } from '@/components/inbox/inbox-search';
import { InboxToolbar, type SelectWhich } from '@/components/inbox/inbox-toolbar';
import { ContextMenu, type MenuItem } from '@/components/inbox/inbox-menus';
import { ThreadRow } from '@/components/inbox/thread-row';
import { useStoredChoice } from '@/components/inbox/use-stored';
import { ThreadView, gmailUrl } from '@/components/inbox/thread-view';
import { readerZone } from '@/components/inbox/snooze-menu';
import { keyBelongsToOverlay } from '@/components/shell/page-hotkeys';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import {
  applyLabelPlan,
  applyPending,
  labelNamesFor,
  PENDING_MS,
  planLabelChange,
  type LabelChange,
  type PendingChange,
} from '@/lib/email/inbox-actions';
import {
  CATEGORY_NAMES,
  DENSITY_KEY,
  folderLabelId,
  parseDensity,
  parseReadingPane,
  READING_PANE_KEY,
  type ReadingPane,
  smartDate,
  type Category,
  type Density,
  type FolderId,
} from '@/lib/email/inbox-folders';
import { leavesFolder, UNDO_OF, type SystemAction } from '@/lib/email/inbox-modify';
import {
  INBOX_MESSAGE_PARAM,
  INBOX_OPEN_PARAM,
  INBOX_THREAD_PARAM,
  isGmailId,
} from '@/lib/email/thread-links';
import { formatWake } from '@/lib/email/snooze';
import { cn } from '@/lib/util/cn';
import type {
  LiveThread,
  LiveThreadList,
  LiveThreadRow,
  OpenedThread,
} from '@/lib/services/inbox-live';

// The message pieces live in message-view.tsx (Follow-ups shows the full email
// with them too); these stay importable from here.
export { longTime, reflow } from '@/components/inbox/message-view';
export { forwardDraft } from '@/components/inbox/thread-view';

/*
 * The Inbox's folders as the help page names them: Primary, Promotions,
 * Social, Updates and Forums are the inbox's tabs; Starred, Snoozed,
 * Important, Sent, Scheduled, Drafts, All Mail, Spam and Trash sit in the
 * left nav (inbox-nav.tsx).
 */
const CATEGORY_ICON: Record<Category, typeof InboxIcon> = {
  primary: InboxIcon,
  promotions: Tag,
  social: Users,
  updates: Info,
  forums: MessagesSquare,
};

const PAGE = 50;
/**
 * The first page is read again this often while the tab is in view, so a
 * change made in Gmail itself shows soon. One thread-list read each time;
 * a thread is read again only when Gmail says it changed (inbox-live.ts).
 */
const REFRESH_MS = 45_000;
/** Back in view after this long, the list is read again at once. */
const STALE_ON_RETURN_MS = 20_000;
/** A quiet re-read this long after the last tap, once Gmail has caught up. */
const SETTLE_MS = 4_000;

interface View {
  folder: FolderId;
  category: Category;
  q: string;
  page: number;
}
const viewKey = (v: View) => `${v.folder}|${v.category}|${v.q}|${v.page}`;

const PATCH: Record<SystemAction, Partial<LiveThreadRow>> = {
  archive: { inInbox: false },
  inbox: { inInbox: true, inSpam: false, inTrash: false },
  read: { unread: false },
  unread: { unread: true },
  star: { starred: true },
  unstar: { starred: false },
  important: { important: true },
  unimportant: { important: false },
  trash: { inTrash: true },
  untrash: { inTrash: false },
  restore: { inTrash: false, inInbox: true },
  spam: { inSpam: true, inInbox: false },
  notspam: { inSpam: false, inInbox: true },
};

/** Gmail's toast for an action that moves a conversation, singular and plural. */
function movedText(action: SystemAction, n: number): string | null {
  const what = n === 1 ? 'Conversation' : `${n} conversations`;
  switch (action) {
    case 'archive':
      return `${what} archived`;
    case 'trash':
      return `${what} moved to Trash`;
    case 'spam':
      return `${what} marked as spam`;
    case 'notspam':
      return `${what} unmarked as spam and moved to Inbox`;
    case 'restore':
    case 'inbox':
      return `${what} moved to Inbox`;
    case 'untrash':
      return `${what} restored`;
    default:
      return null;
  }
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const j = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return j?.error?.message ?? fallback;
}

/*
 * Times here are in the reader's profile timezone and in en-US, never the
 * process's own zone or locale: the server renders the first page of rows and
 * the browser hydrates it, and the two can sit in different zones (Render runs
 * in UTC, a browser in its reader's). Text read from each one's own clock would
 * not match, and React would throw the page away and draw it again.
 */

/** A row's time: the clock today, the day earlier this year, the date before that. */
export function shortTime(iso: string | null, timeZone: string, now: Date = new Date()): string {
  return smartDate(iso, timeZone, now);
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

/** Drop `?thread=` from the address once its conversation is closed, so a reload shows the list. */
function forgetThreadParam(): void {
  const url = new URL(window.location.href);
  const names = [INBOX_THREAD_PARAM, INBOX_MESSAGE_PARAM, INBOX_OPEN_PARAM];
  if (!names.some((name) => url.searchParams.has(name))) return;
  for (const name of names) url.searchParams.delete(name);
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

/** The folder a "Move to" leaves: the inbox, or the label being looked at. */
function placeOf(folder: FolderId): string | null {
  if (folder === 'inbox') return 'INBOX';
  return folderLabelId(folder);
}

const NEW_EMAIL: ComposeDraft = { to: '', subject: '', body: '\n\nNick' };

export function LiveInbox({
  initial,
  timeZone,
  opened = null,
  initialQuery = '',
}: {
  initial: LiveThreadList;
  timeZone: string;
  /** A search the page opened on (`/inbox?q=`): `initial` is already its results. */
  initialQuery?: string;
  /**
   * A conversation a link asked for (`/inbox?thread=<id>`), opened in the
   * reading pane whether or not it is in the list; or why it could not be.
   * Opening it this way never marks it read.
   */
  opened?: OpenedThread | null;
}) {
  const [folder, setFolder] = React.useState<FolderId>(initial.folder ?? 'inbox');
  const [category, setCategory] = React.useState<Category>(initial.category ?? 'primary');
  const [query, setQuery] = React.useState(initialQuery);
  const [searched, setSearched] = React.useState(initialQuery);
  const [list, setList] = React.useState<LiveThreadList>(initial);
  /** The page token each page was read with; the last is the page on screen. */
  const [tokens, setTokens] = React.useState<(string | null)[]>([null]);
  const page = tokens.length - 1;
  const [loading, setLoading] = React.useState(false);
  const [selectedId, setSelectedId] = React.useState<string | null>(opened?.row?.id ?? null);
  // The linked conversation's row, kept apart from the list it may not be in.
  const [linked, setLinked] = React.useState<LiveThreadRow | null>(opened?.row ?? null);
  const [linkError, setLinkError] = React.useState<{ requested: string; error: string } | null>(
    opened?.error !== undefined ? { requested: opened.requested, error: opened.error } : null,
  );
  const [checked, setChecked] = React.useState<Set<string>>(new Set());
  const [replyOpen, setReplyOpen] = React.useState(false);
  const [compose, setCompose] = React.useState<{ title: string; draft: ComposeDraft } | null>(null);
  /**
   * Which Label menu the l key opened: the open thread's or the selection's,
   * keyed by what it is for, so a menu never reopens on its own for a later
   * thread or selection. Snooze (b) and Move to (v) are keyed the same way.
   */
  const [labelMenu, setLabelMenu] = React.useState<string | null>(null);
  const [snoozeMenu, setSnoozeMenu] = React.useState<string | null>(null);
  const [moveMenu, setMoveMenu] = React.useState<string | null>(null);
  // Density is remembered per browser.
  const [density, setDensity] = useStoredChoice<Density>(DENSITY_KEY, parseDensity, 'default');
  // Gmail's reading pane setting: no split (its default), or right of the list.
  const [pane, setPane] = useStoredChoice<ReadingPane>(READING_PANE_KEY, parseReadingPane, 'none');
  const split = pane === 'right';
  const [navOpen, setNavOpen] = React.useState(false);
  const [context, setContext] = React.useState<{ x: number; y: number; items: MenuItem[] } | null>(
    null,
  );
  const [newLabel, setNewLabel] = React.useState<string | null>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);
  /** Changes made here, laid over each list Gmail answers until it has caught up. */
  const pending = React.useRef(new Map<string, PendingChange<LiveThreadRow>>());
  const lastLoad = React.useRef(0);
  const settleTimer = React.useRef<number | null>(null);
  /** The newest action's undo, for the z key. */
  const lastUndo = React.useRef<(() => void) | null>(null);
  const view = React.useRef<View>({ folder, category, q: searched, page });
  React.useEffect(() => {
    view.current = { folder, category, q: searched, page };
  }, [folder, category, searched, page]);
  // The first page came with the page itself: a quick folder switch is not stale.
  React.useEffect(() => {
    lastLoad.current = Date.now();
  }, []);
  // A search the page opened on stays in the box; the address goes back to the Inbox.
  React.useEffect(() => {
    if (!initialQuery) return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has('q')) return;
    url.searchParams.delete('q');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }, [initialQuery]);
  const { canAct, canLabel, canSnooze, mailbox, labelChoices } = list;
  const canModify = list.canModify ?? canAct;

  const load = React.useCallback(
    async (next: View & { token?: string | null }, opts: { quiet?: boolean } = {}) => {
      if (!opts.quiet) setLoading(true);
      lastLoad.current = Date.now();
      try {
        const params = new URLSearchParams({
          folder: next.folder,
          category: next.category,
          q: next.q,
        });
        if (next.token) params.set('pageToken', next.token);
        const res = await fetch(`/api/inbox/threads?${params.toString()}`);
        if (!res.ok) throw new Error(await errorMessage(res, 'Could not load your inbox.'));
        const data = (await res.json()) as LiveThreadList;
        // A quiet re-read that lands after the person moved on is dropped.
        if (opts.quiet && viewKey(view.current) !== viewKey(next)) return;
        setList({
          ...data,
          rows: applyPending(data.rows, pending.current, viewKey(next), Date.now()),
        });
        if (!opts.quiet) {
          setChecked(new Set());
          setSelectedId(null);
        }
        return true;
      } catch (e) {
        if (!opts.quiet) toast.error((e as Error).message);
        return false;
      } finally {
        if (!opts.quiet) setLoading(false);
      }
    },
    [],
  );

  const quietReload = React.useCallback(() => {
    if (document.visibilityState !== 'visible' || view.current.page > 0) return;
    void load(view.current, { quiet: true });
  }, [load]);

  // Keep the first page fresh while the tab is in view, like Gmail does, and
  // read it again on coming back to the tab after a while.
  React.useEffect(() => {
    const t = window.setInterval(quietReload, REFRESH_MS);
    const onVisible = () => {
      if (Date.now() - lastLoad.current >= STALE_ON_RETURN_MS) quietReload();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [quietReload]);

  // After a tap, one quiet re-read once Gmail has settled; taps in a row share it.
  const settle = React.useCallback(() => {
    if (settleTimer.current) window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => {
      settleTimer.current = null;
      quietReload();
    }, SETTLE_MS);
  }, [quietReload]);
  React.useEffect(
    () => () => {
      if (settleTimer.current) window.clearTimeout(settleTimer.current);
    },
    [],
  );

  /**
   * Hold a change made here over the lists Gmail answers for a while.
   * `removedFrom` left out keeps the view a thread left; null clears it (the
   * thread is back in the view).
   */
  const hold = React.useCallback(
    (ids: string[], patch: Partial<LiveThreadRow>, removedFrom?: string | null) => {
      const until = Date.now() + PENDING_MS;
      for (const id of ids) {
        const prev = pending.current.get(id);
        pending.current.set(id, {
          patch: { ...prev?.patch, ...patch },
          removedFrom: removedFrom === undefined ? prev?.removedFrom : (removedFrom ?? undefined),
          until,
        });
      }
    },
    [],
  );
  const release = React.useCallback((ids: string[]) => {
    for (const id of ids) pending.current.delete(id);
  }, []);

  const goTo = React.useCallback(
    (next: { folder?: FolderId; category?: Category; q?: string }) => {
      const v: View = {
        folder: next.folder ?? folder,
        category: next.category ?? (next.folder && next.folder !== folder ? 'primary' : category),
        q: next.q ?? '',
        page: 0,
      };
      setFolder(v.folder);
      setCategory(v.category);
      setSearched(v.q);
      if (next.q === undefined) setQuery('');
      setTokens([null]);
      setNavOpen(false);
      void load(v);
    },
    [folder, category, load],
  );

  const older = () => {
    if (!list.nextPageToken) return;
    const token = list.nextPageToken;
    const next = [...tokens, token];
    setTokens(next);
    void load({ folder, category, q: searched, page: next.length - 1, token });
  };
  const newer = () => {
    if (page === 0) return;
    const next = tokens.slice(0, -1);
    setTokens(next);
    void load({ folder, category, q: searched, page: next.length - 1, token: next.at(-1) ?? null });
  };

  const patchRows = React.useCallback((ids: string[], patch: Partial<LiveThreadRow>) => {
    setList((cur) => ({
      ...cur,
      rows: cur.rows.map((r) => (ids.includes(r.id) ? { ...r, ...patch } : r)),
    }));
    setLinked((cur) => (cur && ids.includes(cur.id) ? { ...cur, ...patch } : cur));
  }, []);

  const rows = list.rows;
  const index = rows.findIndex((r) => r.id === selectedId);
  // The list's own row when the linked conversation is in it, else the linked row.
  const selected = index >= 0 ? rows[index]! : linked && linked.id === selectedId ? linked : null;

  /** Where the reader goes when the open conversation leaves the list. */
  const advanceFrom = React.useCallback(
    (ids: string[], how: 'list' | 'next' | 'prev') => {
      if (!selectedId || !ids.includes(selectedId)) return;
      if (how === 'list') {
        setSelectedId(null);
        return;
      }
      const at = rows.findIndex((r) => r.id === selectedId);
      const step = how === 'next' ? 1 : -1;
      let i = at + step;
      while (rows[i] && ids.includes(rows[i]!.id)) i += step;
      setSelectedId(rows[i]?.id ?? null);
    },
    [rows, selectedId],
  );

  /**
   * One change from a tap, drawn at once and held over the list until Gmail
   * catches up; put back if Gmail refuses. A change that takes the
   * conversation out of the folder on screen (archive, delete, spam...)
   * offers Undo, which the z key runs too.
   */
  const act = React.useCallback(
    async (
      ids: string[],
      action: SystemAction,
      opts: {
        silent?: boolean;
        advance?: 'list' | 'next' | 'prev';
        restore?: LiveThreadRow[];
      } = {},
    ): Promise<boolean> => {
      if (!canModify) {
        toast.error('Changing mail from the app needs sending turned on. Do it in Gmail for now.');
        return false;
      }
      if (ids.length === 0) return false;
      const before = list.rows;
      const linkedBefore = linked;
      const patch = PATCH[action];
      const leaves = !searched && leavesFolder(action, folder);
      if (leaves) {
        setList((cur) => ({ ...cur, rows: cur.rows.filter((r) => !ids.includes(r.id)) }));
        advanceFrom(ids, opts.advance ?? 'list');
        hold(ids, patch, viewKey(view.current));
      } else {
        patchRows(ids, patch);
        // Back in this folder: a removal held from before no longer hides it here.
        hold(ids, patch, opts.restore ? null : undefined);
        if (opts.restore) setList((cur) => ({ ...cur, rows: opts.restore! }));
      }
      setChecked(new Set());

      const res = await postJson('/api/inbox/modify', { ids, action });
      if (!res.ok) {
        release(ids);
        setList((cur) => ({ ...cur, rows: before }));
        setLinked(linkedBefore);
        toast.error(await errorMessage(res, 'Gmail did not take that. Try again.'));
        return false;
      }
      settle();
      const text = movedText(action, ids.length);
      const undoAction = UNDO_OF[action];
      if (text && undoAction && !opts.silent) {
        const undo = () => {
          lastUndo.current = null;
          // A delete from outside the inbox goes back where it was, not to the inbox.
          const back =
            action === 'trash' ? ids.filter((id) => before.find((r) => r.id === id)?.inInbox) : ids;
          const rest = action === 'trash' ? ids.filter((id) => !back.includes(id)) : [];
          const undoFor = (list: string[], a: SystemAction) =>
            list.length
              ? postJson('/api/inbox/modify', { ids: list, action: a }).then((r) => r.ok)
              : Promise.resolve(true);
          void Promise.all([undoFor(back, undoAction), undoFor(rest, 'untrash')]).then(([a, b]) => {
            if (a && b) {
              release(ids);
              hold(ids, { ...PATCH[undoAction], ...(rest.length ? {} : {}) }, null);
              setList((cur) => ({ ...cur, rows: before }));
              settle();
              toast.success('Action undone');
            } else toast.error('Could not undo that. Find it in Gmail.');
          });
        };
        lastUndo.current = undo;
        toast.success(text, { action: { label: 'Undo', onClick: undo } });
      }
      return true;
    },
    [canModify, list.rows, linked, searched, folder, advanceFrom, hold, patchRows, release, settle],
  );

  // Label as: the person's own Gmail labels. Drawn at once, held over the
  // list until Gmail catches up, and put back if Gmail refuses.
  const label = React.useCallback(
    async (ids: string[], change: LabelChange) => {
      if (!canLabel) {
        toast.error('Labels need sending turned on. Change them in Gmail for now.');
        return false;
      }
      const plan = planLabelChange(labelChoices, change);
      if (!plan.ok) {
        toast.error(plan.message);
        return false;
      }
      const before = list.rows;
      const linkedBefore = linked;
      const relabel = (row: LiveThreadRow): Partial<LiveThreadRow> => {
        const labelIds = applyLabelPlan(row.labelIds, plan);
        return { labelIds, labels: labelNamesFor(labelIds, labelChoices).slice(0, 4) };
      };
      for (const row of before) if (ids.includes(row.id)) hold([row.id], relabel(row));
      setList((cur) => ({
        ...cur,
        rows: cur.rows.map((r) => (ids.includes(r.id) ? { ...r, ...relabel(r) } : r)),
      }));
      setLinked((cur) => (cur && ids.includes(cur.id) ? { ...cur, ...relabel(cur) } : cur));

      // The route gets what was tapped, not the plan: it plans again against
      // Gmail's own label list, and a numbered family's full removal list
      // could pass the per-change cap the route holds a tap to.
      const res = await postJson('/api/inbox/modify', {
        ids,
        action: 'label',
        add: change.add,
        remove: change.remove,
      });
      if (!res.ok) {
        release(ids);
        setList((cur) => ({ ...cur, rows: before }));
        setLinked(linkedBefore);
        toast.error(await errorMessage(res, 'Gmail did not take that. Try again.'));
        return false;
      }
      settle();
      const [added] = labelNamesFor(plan.add, labelChoices);
      const [removed] = labelNamesFor(plan.remove, labelChoices);
      const moved = plan.remove.length > change.remove.length;
      toast.success(
        added
          ? `${moved ? 'Moved to' : 'Labelled'} “${added}”`
          : `Took off “${removed ?? 'the label'}”`,
      );
      return true;
    },
    [canLabel, labelChoices, linked, list.rows, hold, release, settle],
  );

  /** Gmail's "Move to": Trash and Spam are Delete and Report spam; else a label or the inbox. */
  const move = React.useCallback(
    async (ids: string[], to: string) => {
      if (to === 'TRASH') return act(ids, 'trash');
      if (to === 'SPAM') return act(ids, 'spam');
      if (!canModify) {
        toast.error('Moving mail needs sending turned on. Do it in Gmail for now.');
        return false;
      }
      const from = searched ? null : placeOf(folder);
      const before = list.rows;
      const leaves = !searched && (folder === 'inbox' || Boolean(folderLabelId(folder)));
      if (leaves) {
        setList((cur) => ({ ...cur, rows: cur.rows.filter((r) => !ids.includes(r.id)) }));
        advanceFrom(ids, 'list');
        hold(ids, {}, viewKey(view.current));
      }
      setChecked(new Set());
      const res = await postJson('/api/inbox/modify', { ids, action: 'move', to, from });
      if (!res.ok) {
        release(ids);
        setList((cur) => ({ ...cur, rows: before }));
        toast.error(await errorMessage(res, 'Gmail did not take that. Try again.'));
        return false;
      }
      settle();
      const name = to === 'INBOX' ? 'Inbox' : (labelNamesFor([to], labelChoices)[0] ?? 'the label');
      const what = ids.length === 1 ? 'Conversation' : `${ids.length} conversations`;
      const undo =
        from !== null
          ? () => {
              lastUndo.current = null;
              void postJson('/api/inbox/modify', { ids, action: 'move', to: from, from: to }).then(
                (r) => {
                  if (r.ok) {
                    release(ids);
                    setList((cur) => ({ ...cur, rows: before }));
                    settle();
                  } else toast.error('Could not undo that. Find it in Gmail.');
                },
              );
            }
          : null;
      lastUndo.current = undo;
      toast.success(
        `${what} moved to “${name}”`,
        undo ? { action: { label: 'Undo', onClick: undo } } : undefined,
      );
      return true;
    },
    [act, canModify, searched, folder, list.rows, advanceFrom, hold, release, settle, labelChoices],
  );

  const snoozedView = !searched && folder === 'snoozed';

  /** Unsnooze: back in the inbox now, out of the Snoozed list. */
  const unsnooze = React.useCallback(
    async (ids: string[], opts: { restore?: LiveThreadRow[] } = {}) => {
      const before = list.rows;
      const patch: Partial<LiveThreadRow> = { inInbox: true, snoozedUntil: null };
      if (snoozedView) {
        setList((cur) => ({ ...cur, rows: cur.rows.filter((r) => !ids.includes(r.id)) }));
        if (selectedId && ids.includes(selectedId)) setSelectedId(null);
        release(ids);
        hold(ids, patch, viewKey(view.current));
      } else if (!opts.restore) {
        patchRows(ids, patch);
      }
      setChecked(new Set());
      const res = await postJson('/api/inbox/snooze', { action: 'unsnooze', threadIds: ids });
      if (!res.ok) {
        release(ids);
        setList((cur) => ({ ...cur, rows: before }));
        toast.error(await errorMessage(res, 'Could not unsnooze that. Try again.'));
        return false;
      }
      if (opts.restore) {
        // The toast's Undo: the rows go back where they were.
        const restore = opts.restore;
        release(ids);
        hold(ids, patch, null);
        setList((cur) => ({ ...cur, rows: restore }));
      } else {
        toast.success(ids.length === 1 ? 'Back in your inbox' : `${ids.length} back in your inbox`);
      }
      settle();
      return true;
    },
    [list.rows, snoozedView, selectedId, release, hold, patchRows, settle],
  );

  /**
   * Snooze until `wakeAt`: out of the inbox now (as Archive does), back at
   * that time, unread. Drawn at once and put back if the server refuses,
   * including before Snooze's database update, which the toast then says.
   */
  const snooze = React.useCallback(
    async (ids: string[], wakeAt: Date) => {
      if (!canSnooze) {
        toast.error('Snoozing needs sending turned on. Snooze in Gmail for now.');
        return false;
      }
      const before = list.rows;
      const linkedBefore = linked;
      const iso = wakeAt.toISOString();
      const patch: Partial<LiveThreadRow> = { inInbox: false, snoozedUntil: iso };
      if (!searched && folder === 'inbox') {
        setList((cur) => ({ ...cur, rows: cur.rows.filter((r) => !ids.includes(r.id)) }));
        if (selectedId && ids.includes(selectedId)) setSelectedId(null);
        hold(ids, patch, viewKey(view.current));
      } else {
        patchRows(ids, patch);
        hold(ids, patch);
      }
      setChecked(new Set());

      const res = await postJson('/api/inbox/snooze', {
        action: 'snooze',
        threadIds: ids,
        wakeAt: iso,
      });
      if (!res.ok) {
        release(ids);
        setList((cur) => ({ ...cur, rows: before }));
        setLinked(linkedBefore);
        toast.error(await errorMessage(res, 'Could not snooze that. Try again.'));
        return false;
      }
      settle();
      const when = formatWake(wakeAt, readerZone(timeZone));
      const undo = () => {
        lastUndo.current = null;
        void unsnooze(ids, { restore: before });
      };
      lastUndo.current = undo;
      toast.success(
        ids.length === 1 ? `Snoozed until ${when}` : `${ids.length} snoozed until ${when}`,
        { action: { label: 'Undo', onClick: undo } },
      );
      return true;
    },
    [
      canSnooze,
      list.rows,
      linked,
      searched,
      folder,
      selectedId,
      hold,
      release,
      patchRows,
      settle,
      timeZone,
      unsnooze,
    ],
  );

  const openRow = React.useCallback(
    (row: LiveThreadRow) => {
      if (row.kind === 'draft') {
        toast.message('Drafts open in the compose window.');
        return;
      }
      if (row.kind === 'scheduled') {
        toast.message('Scheduled emails open in the compose window.');
        return;
      }
      setSelectedId(row.id);
      setReplyOpen(false);
      if (row.unread && canModify) void act([row.id], 'read', { silent: true });
    },
    [act, canModify],
  );

  const toggleCheck = (id: string) =>
    setChecked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selectWhich = (which: SelectWhich) => {
    const pick = (f: (r: LiveThreadRow) => boolean) =>
      setChecked(new Set(rows.filter(f).map((r) => r.id)));
    switch (which) {
      case 'all':
        return pick(() => true);
      case 'none':
        return setChecked(new Set());
      case 'read':
        return pick((r) => !r.unread);
      case 'unread':
        return pick((r) => r.unread);
      case 'starred':
        return pick((r) => r.starred);
      case 'unstarred':
        return pick((r) => !r.starred);
    }
  };

  const paneMenu = selected ? `pane:${selected.id}` : null;
  const bulkMenu = checked.size ? `bulk:${[...checked].sort().join(',')}` : null;

  // The linked conversation as the server read it, shown without a second read the first
  // time only: once it is closed, opening it again reads it fresh.
  const [seed, setSeed] = React.useState<LiveThread | null>(opened?.thread ?? null);
  if (seed && selectedId !== seed.id) setSeed(null);

  // Once the linked conversation is closed, the address goes back to the plain Inbox.
  const linkedId = opened?.row?.id ?? null;
  React.useEffect(() => {
    if (linkedId && selectedId !== linkedId) forgetThreadParam();
  }, [linkedId, selectedId]);

  const openCompose = React.useCallback(() => {
    setCompose({ title: 'New Message', draft: NEW_EMAIL });
  }, []);

  /** What the folder on screen offers for a set of rows. */
  const folderActions = (ids: string[]) => {
    const inSpam = !searched && folder === 'spam';
    const inTrash = !searched && folder === 'trash';
    const own = !searched && (folder === 'drafts' || folder === 'scheduled');
    const sample = rows.filter((r) => ids.includes(r.id));
    return {
      archive:
        own || inSpam || inTrash || !sample.some((r) => r.inInbox)
          ? null
          : () => void act(ids, 'archive'),
      moveToInbox:
        !own && !inSpam && !inTrash && sample.length > 0 && sample.every((r) => !r.inInbox)
          ? () => void act(ids, 'inbox')
          : null,
      spam: own || inSpam || inTrash ? null : () => void act(ids, 'spam'),
      notSpam: inSpam ? () => void act(ids, 'notspam') : null,
      trash: own || inTrash ? null : () => void act(ids, 'trash'),
      restore: inTrash ? () => void act(ids, 'restore') : null,
    };
  };

  const createLabel = async (name: string) => {
    const res = await postJson('/api/inbox/labels', { name });
    if (!res.ok) {
      toast.error(await errorMessage(res, 'Could not create the label. Try again.'));
      return;
    }
    const data = (await res.json()) as { label: { id: string; name: string } };
    setList((cur) => ({
      ...cur,
      labelChoices: [...cur.labelChoices, data.label].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true }),
      ),
    }));
    toast.success(`Label “${data.label.name}” created`);
  };

  const contextItems = (row: LiveThreadRow): MenuItem[] => {
    const ids = checked.has(row.id) ? [...checked] : [row.id];
    const f = folderActions(ids);
    const items: MenuItem[] = [];
    if (row.kind !== 'draft' && row.kind !== 'scheduled') {
      items.push({
        id: 'reply',
        label: 'Reply',
        icon: Reply,
        onSelect: () => {
          openRow(row);
          setReplyOpen(true);
        },
      });
      items.push({
        id: 'forward',
        label: 'Forward',
        icon: Forward,
        onSelect: () => openRow(row),
      });
    }
    if (f.archive)
      items.push({
        id: 'archive',
        label: 'Archive',
        icon: Archive,
        divider: true,
        onSelect: f.archive,
      });
    if (f.moveToInbox)
      items.push({
        id: 'inbox',
        label: 'Move to Inbox',
        icon: InboxIcon,
        divider: !f.archive,
        onSelect: f.moveToInbox,
      });
    if (f.trash) items.push({ id: 'trash', label: 'Delete', icon: Trash2, onSelect: f.trash });
    if (f.restore)
      items.push({ id: 'restore', label: 'Move to Inbox', icon: InboxIcon, onSelect: f.restore });
    if (f.spam)
      items.push({ id: 'spam', label: 'Report spam', icon: OctagonAlert, onSelect: f.spam });
    if (f.notSpam)
      items.push({ id: 'notspam', label: 'Not spam', icon: InboxIcon, onSelect: f.notSpam });
    if (row.kind !== 'draft' && row.kind !== 'scheduled') {
      items.push({
        id: 'read',
        label: row.unread ? 'Mark as read' : 'Mark as unread',
        icon: row.unread ? MailOpen : Mail,
        divider: true,
        onSelect: () => void act(ids, row.unread ? 'read' : 'unread', { silent: true }),
      });
      items.push({
        id: 'important',
        label: row.important ? 'Mark as not important' : 'Mark as important',
        icon: Bookmark,
        onSelect: () =>
          void act(ids, row.important ? 'unimportant' : 'important', { silent: true }),
      });
      items.push({
        id: 'star',
        label: row.starred ? 'Remove star' : 'Add star',
        icon: Star,
        onSelect: () => void act(ids, row.starred ? 'unstar' : 'star', { silent: true }),
      });
      const viaToolbar = (open: (key: string) => void) => () => {
        const key = `bulk:${[...ids].sort().join(',')}`;
        setChecked(new Set(ids));
        // After the selection has drawn the toolbar's menus.
        window.setTimeout(() => open(key), 0);
      };
      if (canSnooze)
        items.push({
          id: 'snooze',
          label: 'Snooze',
          icon: AlarmClock,
          divider: true,
          onSelect: viaToolbar(setSnoozeMenu),
        });
      if (canModify)
        items.push({
          id: 'move',
          label: 'Move to',
          icon: FolderInput,
          onSelect: viaToolbar(setMoveMenu),
        });
      if (canLabel)
        items.push({
          id: 'label',
          label: 'Label as',
          icon: Tag,
          onSelect: viaToolbar(setLabelMenu),
        });
    }
    return items;
  };

  // Gmail's keys: j/k move, o/Enter open, e archive, b snooze, s star,
  // Shift+U unread, r reply, l label, u back, / search, x select. Never while something is
  // drawn over the list (the Ask Arwin panel, a tour card, a dialog): a key
  // meant for that must not archive or open the thread underneath.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (keyBelongsToOverlay(e)) return;
      const move1 = (delta: number) => {
        const next = rows[Math.min(rows.length - 1, Math.max(0, index + delta))];
        if (next) openRow(next);
      };
      switch (e.key) {
        case 'j':
          move1(index < 0 ? 0 : 1);
          break;
        case 'k':
          move1(-1);
          break;
        case 'o':
        case 'Enter':
          if (!selected && rows[0]) openRow(rows[0]);
          break;
        case 'e':
          if (selected) void act([selected.id], 'archive');
          else if (checked.size) void act([...checked], 'archive');
          break;
        case 's':
          if (selected)
            void act([selected.id], selected.starred ? 'unstar' : 'star', { silent: true });
          break;
        case 'U':
          if (selected) {
            void act([selected.id], 'unread', { silent: true });
            setSelectedId(null);
          }
          break;
        case 'r':
          if (selected) {
            e.preventDefault();
            setReplyOpen(true);
          }
          break;
        case 'l':
          if (!canLabel) break;
          // Kept out of the menu's filter, which takes focus as it opens.
          e.preventDefault();
          setLabelMenu(paneMenu ?? bulkMenu);
          break;
        case 'b':
          // Gmail's snooze key: the open thread's menu, else the selection's.
          if (!canSnooze || !(paneMenu ?? bulkMenu)) break;
          e.preventDefault();
          setSnoozeMenu(paneMenu ?? bulkMenu);
          break;
        case 'u':
        case 'Escape':
          setSelectedId(null);
          break;
        case '/':
          e.preventDefault();
          searchRef.current?.focus();
          break;
        case 'c':
          e.preventDefault();
          openCompose();
          break;
        case 'x':
          if (selected) toggleCheck(selected.id);
          break;
        default:
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (list.state === 'not_connected') {
    return (
      <p className="rounded-md border border-[var(--border)] bg-[var(--bg-raised)] p-4 text-sm text-[var(--fg-muted)]">
        No mailbox is connected. Connect Google in Settings › Integrations.
      </p>
    );
  }

  const bulkIds = [...checked];
  const bulkFolder = folderActions(bulkIds);
  const inDrafts = !searched && folder === 'drafts';
  const binView = !searched && (folder === 'spam' || folder === 'trash');
  const inScheduled = !searched && folder === 'scheduled';
  const categories = list.nav?.categories ?? ['primary'];
  const showTabs = !searched && folder === 'inbox' && categories.length > 1;

  const nav = (
    <InboxNav
      folder={folder}
      searched={Boolean(searched)}
      nav={list.nav}
      labels={labelChoices}
      onCompose={() => {
        setNavOpen(false);
        openCompose();
      }}
      onFolder={(f) => goTo({ folder: f })}
      onCreateLabel={() => setNewLabel('')}
      canCreateLabel={canLabel}
    />
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setNavOpen(true)}
          aria-label="Open folders"
          // The folders' tour step, on a phone where the nav is a drawer.
          data-tour="inbox-tabs"
          className="rounded-full p-2.5 text-[var(--fg-muted)] hover:bg-[var(--bg-hover)] lg:hidden"
        >
          <Menu className="size-5" aria-hidden />
        </button>
        <InboxSearch
          value={query}
          onChange={setQuery}
          onSearch={(q) => goTo({ q })}
          onClear={() => {
            setQuery('');
            goTo({ q: '' });
          }}
          searched={Boolean(searched)}
          inputRef={searchRef}
        />
      </div>

      {!canAct ? (
        <p className="rounded-md border border-[var(--border)] bg-[var(--bg-raised)] px-3 py-2 text-xs text-[var(--fg-muted)]">
          {canModify
            ? 'Demo mailbox: changes stay here, and nothing is sent.'
            : 'Reading only: archive, delete, star, labels, read/unread and Send need sending turned on (Settings › Integrations). Until then, Send opens the email in Gmail.'}
        </p>
      ) : null}

      {list.state === 'error' ? (
        <p className="text-sm text-[var(--danger)]">{list.message ?? 'Gmail did not answer.'}</p>
      ) : null}

      {linkError ? (
        <div role="alert">
          <Notice tone="warn">
            <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
              <p className="min-w-0 flex-1">
                <span className="font-medium">Couldn&rsquo;t open that email.</span>{' '}
                {linkError.error}
              </p>
              <span className="flex items-center gap-1">
                {isGmailId(linkError.requested) ? (
                  <Button asChild size="sm" variant="ghost">
                    <a
                      href={gmailUrl(linkError.requested, mailbox)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ExternalLink className="size-4" aria-hidden /> Try in Gmail
                    </a>
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="Dismiss"
                  onClick={() => {
                    setLinkError(null);
                    forgetThreadParam();
                  }}
                >
                  <X className="size-4" aria-hidden />
                </Button>
              </span>
            </div>
          </Notice>
        </div>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <div className="hidden lg:block">{nav}</div>
        {navOpen ? (
          <div className="fixed inset-0 z-[var(--z-overlay)] lg:hidden" role="presentation">
            <button
              type="button"
              aria-label="Close folders"
              className="absolute inset-0 bg-[var(--scrim)]"
              onClick={() => setNavOpen(false)}
            />
            <div className="shadow-overlay absolute inset-y-0 left-0 w-72 max-w-[85vw] overflow-y-auto bg-[var(--bg-raised)] p-3 pt-[calc(var(--titlebar-h)+0.75rem)]">
              {nav}
            </div>
          </div>
        ) : null}

        <div
          className={cn(
            'grid min-w-0 gap-3',
            split && 'xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]',
          )}
        >
          <section
            aria-label="Conversations"
            data-tour="inbox-list"
            className={cn(
              'min-w-0 overflow-hidden rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)]',
              selected && (split ? 'hidden xl:block' : 'hidden'),
            )}
          >
            <InboxToolbar
              rows={rows}
              checked={checked}
              onSelect={selectWhich}
              onRefresh={() =>
                void load({ folder, category, q: searched, page, token: tokens.at(-1) })
              }
              loading={loading}
              folder={searched ? null : folder}
              timeZone={timeZone}
              labelChoices={labelChoices}
              selectionLabelIds={rows.filter((r) => checked.has(r.id)).map((r) => r.labelIds)}
              labelMenuOpen={labelMenu !== null && labelMenu === bulkMenu}
              setLabelMenuOpen={(o) => setLabelMenu(o ? bulkMenu : null)}
              snoozeMenuOpen={snoozeMenu !== null && snoozeMenu === bulkMenu}
              setSnoozeMenuOpen={(o) => setSnoozeMenu(o ? bulkMenu : null)}
              moveMenuOpen={moveMenu !== null && moveMenu === bulkMenu}
              setMoveMenuOpen={(o) => setMoveMenu(o ? bulkMenu : null)}
              page={{
                start: page * PAGE + 1,
                shown: rows.length,
                total: list.total ?? null,
                hasOlder: Boolean(list.nextPageToken),
                hasNewer: page > 0,
              }}
              onOlder={older}
              onNewer={newer}
              density={density}
              setDensity={setDensity}
              pane={pane}
              setPane={setPane}
              onMarkAllRead={
                canModify && rows.some((r) => r.unread)
                  ? () =>
                      void act(
                        rows.filter((r) => r.unread).map((r) => r.id),
                        'read',
                        { silent: true },
                      )
                  : null
              }
              onShortcuts={() => toast.message('Press ? for keyboard shortcuts.')}
              bulk={{
                ...(inDrafts || inScheduled
                  ? {
                      archive: null,
                      moveToInbox: null,
                      spam: null,
                      notSpam: null,
                      trash: null,
                      restore: null,
                    }
                  : bulkFolder),
                markRead: () => void act(bulkIds, 'read', { silent: true }),
                markUnread: () => void act(bulkIds, 'unread', { silent: true }),
                snooze:
                  canSnooze && !inDrafts && !inScheduled ? (at) => void snooze(bulkIds, at) : null,
                unsnooze: snoozedView ? () => void unsnooze(bulkIds) : null,
                label: canLabel && !inDrafts && !inScheduled ? (c) => void label(bulkIds, c) : null,
                move:
                  canModify && !inDrafts && !inScheduled ? (to) => void move(bulkIds, to) : null,
                important: () => void act(bulkIds, 'important', { silent: true }),
                notImportant: () => void act(bulkIds, 'unimportant', { silent: true }),
                star: () => void act(bulkIds, 'star', { silent: true }),
                unstar: () => void act(bulkIds, 'unstar', { silent: true }),
                discardDrafts: null,
                cancelScheduled: null,
              }}
            />
            {showTabs ? (
              <div
                role="tablist"
                aria-label="Inbox categories"
                className="flex border-b border-[var(--border)]"
              >
                {categories.map((c) => {
                  const Icon = CATEGORY_ICON[c];
                  const active = category === c;
                  return (
                    <button
                      key={c}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => goTo({ folder: 'inbox', category: c })}
                      className={cn(
                        'flex h-12 min-w-0 flex-1 items-center gap-3 border-b-[3px] px-4 text-sm font-medium sm:max-w-60',
                        active
                          ? 'border-[var(--accent)] text-[var(--accent)]'
                          : 'border-transparent text-[var(--fg-muted)] hover:bg-[var(--bg-hover)]',
                      )}
                    >
                      <Icon className="size-4 shrink-0" aria-hidden />
                      <span className="truncate">{CATEGORY_NAMES[c]}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}
            {snoozedView && list.snoozeReady === false ? (
              <div className="p-2">
                <Notice tone="warn">
                  Snooze needs a database update before it can be used. Nothing else changes.
                </Notice>
              </div>
            ) : null}
            {searched ? (
              <p className="border-b border-[var(--border)] px-4 py-2 text-xs text-[var(--fg-muted)]">
                Search results in all mail for <span className="font-mono">{searched}</span>
              </p>
            ) : null}
            {rows.length === 0 && !loading ? (
              <p className="py-12 text-center text-sm text-[var(--fg-subtle)]">
                {searched
                  ? 'No mail matches that search.'
                  : snoozedView
                    ? 'Nothing snoozed. Snooze a thread to have it come back later.'
                    : folder === 'inbox'
                      ? 'Nothing here. Inbox zero.'
                      : folder === 'trash'
                        ? 'No conversations in Trash.'
                        : folder === 'spam'
                          ? 'Hooray, no spam here!'
                          : 'Nothing in this folder.'}
              </p>
            ) : (
              <ul className={cn('@container', loading && 'opacity-60')}>
                {rows.map((row) => {
                  const thread = row.kind !== 'draft' && row.kind !== 'scheduled';
                  return (
                    <ThreadRow
                      key={`${row.kind ?? 'thread'}:${row.draftId ?? row.scheduledId ?? row.id}`}
                      row={row}
                      timeZone={timeZone}
                      active={row.id === selectedId}
                      checked={checked.has(row.id)}
                      density={density}
                      labelChoices={labelChoices}
                      snoozedUntil={snoozedView ? (row.snoozedUntil ?? null) : null}
                      actions={{
                        onOpen: () => openRow(row),
                        onCheck: () => toggleCheck(row.id),
                        onStar: () =>
                          void act([row.id], row.starred ? 'unstar' : 'star', { silent: true }),
                        onImportant: () =>
                          void act([row.id], row.important ? 'unimportant' : 'important', {
                            silent: true,
                          }),
                        onArchive:
                          canModify && thread && row.inInbox && !binView
                            ? () => void act([row.id], 'archive')
                            : null,
                        onDelete:
                          canModify && thread && !(folder === 'trash' && !searched)
                            ? () => void act([row.id], 'trash')
                            : null,
                        onReadToggle:
                          canModify && thread
                            ? () =>
                                void act([row.id], row.unread ? 'read' : 'unread', { silent: true })
                            : null,
                        onSnooze:
                          canSnooze && thread && !snoozedView
                            ? (at) => void snooze([row.id], at)
                            : null,
                        onUnsnooze: snoozedView ? () => void unsnooze([row.id]) : null,
                        onLabel:
                          canLabel && thread ? (change) => void label([row.id], change) : null,
                        onContextMenu: (e) => {
                          e.preventDefault();
                          setContext({ x: e.clientX, y: e.clientY, items: contextItems(row) });
                        },
                      }}
                    />
                  );
                })}
              </ul>
            )}
          </section>

          <section
            aria-label="Reading pane"
            data-tour="inbox-reading"
            className={cn(
              'min-w-0',
              split &&
                'xl:sticky xl:top-[calc(var(--titlebar-h)+1rem)] xl:max-h-[calc(100dvh-2rem-var(--titlebar-h))] xl:self-start xl:overflow-y-auto',
              !selected && (split ? 'hidden xl:block' : 'hidden'),
            )}
          >
            {selected ? (
              <ThreadView
                key={selected.id}
                row={selected}
                timeZone={timeZone}
                initialThread={seed?.id === selected.id ? seed : undefined}
                canAct={canAct}
                mailbox={mailbox}
                replyOpen={replyOpen}
                setReplyOpen={setReplyOpen}
                onBack={() => setSelectedId(null)}
                onAct={(action) => act([selected.id], action)}
                labelChoices={labelChoices}
                onLabel={canLabel ? (change) => void label([selected.id], change) : null}
                labelMenuOpen={labelMenu !== null && labelMenu === paneMenu}
                setLabelMenuOpen={(o) => setLabelMenu(o ? paneMenu : null)}
                onSnooze={canSnooze ? (at) => void snooze([selected.id], at) : null}
                snoozeMenuOpen={snoozeMenu !== null && snoozeMenu === paneMenu}
                setSnoozeMenuOpen={(o) => setSnoozeMenu(o ? paneMenu : null)}
                snoozedUntil={snoozedView ? (selected.snoozedUntil ?? null) : null}
                onUnsnooze={() => void unsnooze([selected.id])}
                onSent={() => void load({ folder, category, q: searched, page }, { quiet: true })}
                onForward={(draft) => setCompose({ title: 'Forward', draft })}
              />
            ) : (
              <div className="grid h-full min-h-60 place-items-center rounded-[var(--radius-card)] border border-dashed border-[var(--border)] p-6 text-center text-sm text-[var(--fg-subtle)]">
                <div>
                  <InboxIcon className="mx-auto mb-2 size-6" aria-hidden />
                  Pick a conversation to read it here.
                </div>
              </div>
            )}
          </section>
        </div>
      </div>

      {/* The Gmail app's floating Compose, on a phone. */}
      <button
        type="button"
        onClick={openCompose}
        aria-label="Compose"
        data-tour="inbox-compose"
        className="shadow-overlay fixed right-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-[var(--z-header)] inline-flex h-14 items-center gap-2 rounded-2xl bg-[var(--accent-soft)] px-5 text-sm font-semibold text-[var(--accent)] lg:hidden"
      >
        <PenSquare className="size-5" aria-hidden /> Compose
      </button>

      {context ? (
        <ContextMenu
          at={{ x: context.x, y: context.y }}
          items={context.items}
          onClose={() => setContext(null)}
        />
      ) : null}

      <Dialog open={newLabel !== null} onOpenChange={(o) => !o && setNewLabel(null)}>
        {newLabel !== null ? (
          <DialogContent title="New label">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const name = newLabel.trim();
                if (!name) return;
                setNewLabel(null);
                void createLabel(name);
              }}
            >
              <label htmlFor="new-label-name" className="text-sm text-[var(--fg-muted)]">
                Please enter a new label name:
              </label>
              <input
                id="new-label-name"
                autoFocus
                value={newLabel}
                maxLength={225}
                onChange={(e) => setNewLabel(e.target.value)}
                className="mt-2 h-9 w-full rounded-md border border-[var(--border-control)] bg-[var(--bg-raised)] px-3 text-sm"
              />
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setNewLabel(null)}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" disabled={!newLabel.trim()}>
                  Create
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        ) : null}
      </Dialog>

      {compose ? (
        <Composer
          key={compose.title + compose.draft.subject}
          title={compose.title}
          initial={compose.draft}
          canSend={canAct}
          onClose={() => setCompose(null)}
          onSent={() => void load({ folder, category, q: searched, page }, { quiet: true })}
        />
      ) : null}
    </div>
  );
}
