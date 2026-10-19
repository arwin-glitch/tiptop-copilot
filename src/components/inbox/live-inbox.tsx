'use client';

import * as React from 'react';
import { toast } from 'sonner';
import {
  Archive,
  ArrowLeft,
  ExternalLink,
  Forward,
  Inbox as InboxIcon,
  PenSquare,
  Loader2,
  MailOpen,
  Mail,
  RefreshCw,
  Reply,
  Search,
  Send,
  Star,
  Undo2,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/form';
import { swapSignOff } from '@/components/followups/email-session-client';
import { Composer, type ComposeDraft } from '@/components/inbox/composer';
import { MessageItem, longTime } from '@/components/inbox/message-view';
import { keyBelongsToOverlay } from '@/components/shell/page-hotkeys';
import { cn } from '@/lib/util/cn';
import type {
  InboxTab,
  LiveThread,
  LiveThreadList,
  LiveThreadRow,
} from '@/lib/services/inbox-live';

// The message pieces live in message-view.tsx (Follow-ups shows the full email
// with them too); these stay importable from here.
export { longTime, reflow } from '@/components/inbox/message-view';

type Signature = 'nick' | 'arwin';
type Action = 'archive' | 'inbox' | 'read' | 'unread' | 'star' | 'unstar';

const TABS: { id: InboxTab; label: string }[] = [
  { id: 'primary', label: 'Primary' },
  { id: 'other', label: 'Other tabs' },
  { id: 'starred', label: 'Starred' },
  { id: 'sent', label: 'Sent' },
];

const UNDO_SECONDS = 8;
const REFRESH_MS = 2 * 60_000;

const gmailUrl = (id: string, mailbox: string | null) =>
  mailbox
    ? `https://mail.google.com/mail/?authuser=${encodeURIComponent(mailbox)}#all/${id}`
    : `https://mail.google.com/mail/#all/${id}`;

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

function shortTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  return d.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  });
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

export function LiveInbox({ initial }: { initial: LiveThreadList }) {
  const [tab, setTab] = React.useState<InboxTab>('primary');
  const [query, setQuery] = React.useState('');
  const [searched, setSearched] = React.useState('');
  const [list, setList] = React.useState<LiveThreadList>(initial);
  const [loading, setLoading] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [checked, setChecked] = React.useState<Set<string>>(new Set());
  const [replyOpen, setReplyOpen] = React.useState(false);
  const [compose, setCompose] = React.useState<{ title: string; draft: ComposeDraft } | null>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const { canAct, mailbox } = list;

  const load = React.useCallback(
    async (next: { tab: InboxTab; q: string }, opts: { quiet?: boolean } = {}) => {
      if (!opts.quiet) setLoading(true);
      try {
        const params = new URLSearchParams({ tab: next.tab, q: next.q });
        const res = await fetch(`/api/inbox/threads?${params.toString()}`);
        if (!res.ok) throw new Error(await errorMessage(res, 'Could not load your inbox.'));
        const data = (await res.json()) as LiveThreadList;
        setList(data);
        if (!opts.quiet) {
          setChecked(new Set());
          setSelectedId(null);
        }
      } catch (e) {
        if (!opts.quiet) toast.error((e as Error).message);
      } finally {
        if (!opts.quiet) setLoading(false);
      }
    },
    [],
  );

  // Keep the first page fresh while the tab is open, like Gmail does.
  React.useEffect(() => {
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !list.nextPageToken) {
        void load({ tab, q: searched }, { quiet: true });
      }
    }, REFRESH_MS);
    return () => window.clearInterval(t);
  }, [load, tab, searched, list.nextPageToken]);

  const loadMore = async () => {
    if (!list.nextPageToken) return;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({ tab, q: searched, pageToken: list.nextPageToken });
      const res = await fetch(`/api/inbox/threads?${params.toString()}`);
      if (!res.ok) throw new Error(await errorMessage(res, 'Could not load older mail.'));
      const data = (await res.json()) as LiveThreadList;
      setList((cur) => ({
        ...data,
        rows: [...cur.rows, ...data.rows.filter((r) => !cur.rows.some((c) => c.id === r.id))],
      }));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  };

  const chooseTab = (next: InboxTab) => {
    setTab(next);
    setQuery('');
    setSearched('');
    void load({ tab: next, q: '' });
  };

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setSearched(query.trim());
    void load({ tab, q: query.trim() });
  };

  const patchRows = React.useCallback((ids: string[], patch: Partial<LiveThreadRow>) => {
    setList((cur) => ({
      ...cur,
      rows: cur.rows.map((r) => (ids.includes(r.id) ? { ...r, ...patch } : r)),
    }));
  }, []);

  const inInboxView = !searched && (tab === 'primary' || tab === 'other');

  const act = React.useCallback(
    async (ids: string[], action: Action, opts: { silent?: boolean } = {}) => {
      if (!canAct) {
        toast.error('Changing mail from the app needs sending turned on. Do it in Gmail for now.');
        return false;
      }
      const before = list.rows;
      // Optimistic, then put it back if Gmail refuses.
      if (action === 'archive' && inInboxView) {
        setList((cur) => ({ ...cur, rows: cur.rows.filter((r) => !ids.includes(r.id)) }));
        if (selectedId && ids.includes(selectedId)) setSelectedId(null);
      } else if (action === 'archive') patchRows(ids, { inInbox: false });
      else if (action === 'inbox') patchRows(ids, { inInbox: true });
      else if (action === 'read' || action === 'unread')
        patchRows(ids, { unread: action === 'unread' });
      else patchRows(ids, { starred: action === 'star' });
      setChecked(new Set());

      const res = await postJson('/api/inbox/modify', { ids, action });
      if (!res.ok) {
        setList((cur) => ({ ...cur, rows: before }));
        toast.error(await errorMessage(res, 'Gmail did not take that. Try again.'));
        return false;
      }
      if (action === 'archive' && !opts.silent) {
        toast.success(ids.length === 1 ? 'Archived' : `${ids.length} archived`, {
          action: {
            label: 'Undo',
            onClick: () => {
              void postJson('/api/inbox/modify', { ids, action: 'inbox' }).then((r) => {
                if (r.ok) setList((cur) => ({ ...cur, rows: before }));
                else toast.error('Could not move it back. Find it in All Mail in Gmail.');
              });
            },
          },
        });
      }
      return true;
    },
    [canAct, inInboxView, list.rows, patchRows, selectedId],
  );

  const open = React.useCallback(
    (row: LiveThreadRow) => {
      setSelectedId(row.id);
      setReplyOpen(false);
      if (row.unread && canAct) void act([row.id], 'read', { silent: true });
    },
    [act, canAct],
  );

  const toggleCheck = (id: string) =>
    setChecked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const rows = list.rows;
  const index = rows.findIndex((r) => r.id === selectedId);
  const selected = index >= 0 ? rows[index]! : null;

  // Gmail's keys: j/k move, o/Enter open, e archive, s star, Shift+U unread,
  // r reply, u back to the list, / search, x select. Never while something is
  // drawn over the list (the Ask Arwin panel, a tour card, a dialog): a key
  // meant for that must not archive or open the thread underneath.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (keyBelongsToOverlay(e)) return;
      const move = (delta: number) => {
        const next = rows[Math.min(rows.length - 1, Math.max(0, index + delta))];
        if (next) open(next);
      };
      switch (e.key) {
        case 'j':
          move(index < 0 ? 0 : 1);
          break;
        case 'k':
          move(-1);
          break;
        case 'o':
        case 'Enter':
          if (!selected && rows[0]) open(rows[0]);
          break;
        case 'e':
          if (selected) void act([selected.id], 'archive');
          else if (checked.size) void act([...checked], 'archive');
          break;
        case 's':
          if (selected) void act([selected.id], selected.starred ? 'unstar' : 'star');
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
          setCompose({ title: 'New email', draft: { to: '', subject: '', body: '\n\nNick' } });
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

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          data-tour="inbox-compose"
          onClick={() =>
            setCompose({ title: 'New email', draft: { to: '', subject: '', body: '\n\nNick' } })
          }
        >
          <PenSquare className="size-4" aria-hidden /> Compose
        </Button>
        <div
          role="tablist"
          aria-label="Mailbox"
          data-tour="inbox-tabs"
          className="flex flex-wrap gap-1"
        >
          {TABS.map((t) => (
            <Button
              key={t.id}
              role="tab"
              size="sm"
              variant={!searched && tab === t.id ? 'primary' : 'secondary'}
              aria-selected={!searched && tab === t.id}
              onClick={() => chooseTab(t.id)}
            >
              {t.label}
            </Button>
          ))}
        </div>
        <form
          onSubmit={submitSearch}
          data-tour="inbox-search"
          className="flex min-w-0 flex-1 items-center gap-1"
        >
          <label htmlFor="inbox-search" className="sr-only">
            Search email
          </label>
          <div className="relative min-w-0 flex-1">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-[var(--fg-subtle)]"
              aria-hidden
            />
            <input
              id="inbox-search"
              type="search"
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search all mail, like Gmail (from:jane has:attachment)"
              // The same field edge as every other input (controlBase in
              // ui/form.tsx): --border-control clears 3:1 (WCAG 1.4.11).
              className="h-9 w-full rounded-md border border-[var(--border-control)] bg-[var(--bg-raised)] pr-8 pl-8 text-sm text-[var(--fg)] placeholder:text-[var(--fg-subtle)]"
            />
            {searched ? (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => chooseTab(tab)}
                className="absolute top-1/2 right-2 -translate-y-1/2 text-[var(--fg-muted)]"
              >
                <X className="size-4" aria-hidden />
              </button>
            ) : null}
          </div>
        </form>
        <Button
          size="sm"
          variant="secondary"
          aria-label="Refresh"
          onClick={() => void load({ tab, q: searched })}
          disabled={loading}
        >
          <RefreshCw className={cn('size-4', loading && 'animate-spin')} aria-hidden />
        </Button>
      </div>

      {!canAct ? (
        <p className="rounded-md border border-[var(--border)] bg-[var(--bg-raised)] px-3 py-2 text-xs text-[var(--fg-muted)]">
          Reading only: archive, star, read/unread and Send need sending turned on (Settings ›
          Integrations). Until then, Send opens the email in Gmail.
        </p>
      ) : null}

      {list.state === 'error' ? (
        <p className="text-sm text-[var(--danger)]">{list.message ?? 'Gmail did not answer.'}</p>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <section
          aria-label="Conversations"
          data-tour="inbox-list"
          className={cn('min-w-0', selected && 'hidden lg:block')}
        >
          {checked.size > 0 ? (
            <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md bg-[var(--bg-raised)] px-2 py-1.5 text-sm">
              <span className="text-[var(--fg-muted)]">{checked.size} selected</span>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void act([...checked], 'archive')}
              >
                <Archive className="size-4" aria-hidden /> Archive
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void act([...checked], 'read')}>
                <MailOpen className="size-4" aria-hidden /> Mark read
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void act([...checked], 'unread')}
              >
                <Mail className="size-4" aria-hidden /> Mark unread
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setChecked(new Set())}>
                Clear
              </Button>
            </div>
          ) : null}
          {rows.length === 0 && !loading ? (
            <p className="py-8 text-center text-sm text-[var(--fg-subtle)]">
              {searched ? 'No mail matches that search.' : 'Nothing here. Inbox zero.'}
            </p>
          ) : (
            <ul
              className={cn(
                'divide-y divide-[var(--border)] overflow-hidden rounded-[var(--radius-card)] border border-[var(--border)]',
                loading && 'opacity-60',
              )}
            >
              {rows.map((row) => (
                <ThreadRow
                  key={row.id}
                  row={row}
                  active={row.id === selectedId}
                  checked={checked.has(row.id)}
                  onOpen={() => open(row)}
                  onCheck={() => toggleCheck(row.id)}
                  onStar={() => void act([row.id], row.starred ? 'unstar' : 'star')}
                  onArchive={row.inInbox ? () => void act([row.id], 'archive') : null}
                />
              ))}
            </ul>
          )}
          {list.nextPageToken ? (
            <div className="mt-3 flex justify-center">
              <Button size="sm" variant="secondary" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                Older mail
              </Button>
            </div>
          ) : null}
          <p className="mt-3 hidden text-xs text-[var(--fg-subtle)] lg:block">
            Keys: j/k next and previous · e archive · s star · r reply · Shift+U unread · u back · /
            search
          </p>
        </section>

        <section
          aria-label="Reading pane"
          data-tour="inbox-reading"
          className={cn(
            'min-w-0 lg:sticky lg:top-[calc(var(--titlebar-h)+1rem)] lg:max-h-[calc(100dvh-2rem-var(--titlebar-h))] lg:self-start lg:overflow-y-auto',
            !selected && 'hidden lg:block',
          )}
        >
          {selected ? (
            <ThreadView
              key={selected.id}
              row={selected}
              canAct={canAct}
              mailbox={mailbox}
              replyOpen={replyOpen}
              setReplyOpen={setReplyOpen}
              onBack={() => setSelectedId(null)}
              onAct={(action) => act([selected.id], action)}
              onSent={() => void load({ tab, q: searched }, { quiet: true })}
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
      {compose ? (
        <Composer
          key={compose.title + compose.draft.subject}
          title={compose.title}
          initial={compose.draft}
          canSend={canAct}
          onClose={() => setCompose(null)}
          onSent={() => void load({ tab, q: searched }, { quiet: true })}
        />
      ) : null}
    </div>
  );
}

function ThreadRow({
  row,
  active,
  checked,
  onOpen,
  onCheck,
  onStar,
  onArchive,
}: {
  row: LiveThreadRow;
  active: boolean;
  checked: boolean;
  onOpen: () => void;
  onCheck: () => void;
  onStar: () => void;
  onArchive: (() => void) | null;
}) {
  return (
    <li
      className={cn(
        'group relative flex items-start gap-2 px-3 py-2.5',
        row.unread ? 'bg-[var(--bg-raised)]' : '',
        // Last, so the j/k selection wins over the unread fill (tailwind-merge
        // keeps the later background). The gold rule is the 3:1 marker; the
        // tint on its own is barely 1.2:1 against the list.
        active
          ? 'bg-[var(--accent-soft)] before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-[var(--gold)]'
          : 'hover:bg-[var(--bg-hover)]',
      )}
    >
      <input
        type="checkbox"
        id={`check-${row.id}`}
        aria-label={`Select ${row.subject}`}
        checked={checked}
        onChange={onCheck}
        className="mt-1"
      />
      <button
        type="button"
        onClick={onStar}
        aria-label={row.starred ? 'Unstar' : 'Star'}
        aria-pressed={row.starred}
        className="mt-0.5 text-[var(--fg-subtle)] hover:text-[var(--gold)]"
      >
        <Star
          className={cn('size-4', row.starred && 'fill-[var(--gold)] text-[var(--gold)]')}
          aria-hidden
        />
      </button>
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <div className="flex items-baseline gap-2">
          <span className={cn('min-w-0 flex-1 truncate text-sm', row.unread && 'font-semibold')}>
            {row.unread ? <span className="sr-only">Unread: </span> : null}
            {row.who}
          </span>
          <span
            className={cn(
              'shrink-0 text-xs',
              row.unread ? 'font-semibold' : 'text-[var(--fg-muted)]',
            )}
          >
            {shortTime(row.at)}
          </span>
        </div>
        <p className={cn('truncate text-sm', row.unread ? 'font-medium' : 'text-[var(--fg)]')}>
          {row.subject}
        </p>
        <p className="truncate text-xs text-[var(--fg-muted)]">{row.snippet}</p>
        {row.flagged ? (
          <span className="mt-1 inline-block">
            <Badge tone="warn">Flagged</Badge>
          </span>
        ) : null}
        {row.labels.length > 0 ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {row.labels.map((l) => (
              <Badge key={l} tone="neutral">
                {l}
              </Badge>
            ))}
          </div>
        ) : null}
      </button>
      {onArchive ? (
        <button
          type="button"
          onClick={onArchive}
          aria-label="Archive"
          className="mt-0.5 text-[var(--fg-subtle)] opacity-100 hover:text-[var(--fg)] lg:opacity-0 lg:group-hover:opacity-100 lg:focus:opacity-100"
        >
          <Archive className="size-4" aria-hidden />
        </button>
      ) : null}
    </li>
  );
}

function ThreadView({
  row,
  canAct,
  mailbox,
  replyOpen,
  setReplyOpen,
  onBack,
  onAct,
  onSent,
  onForward,
}: {
  row: LiveThreadRow;
  canAct: boolean;
  mailbox: string | null;
  replyOpen: boolean;
  setReplyOpen: (open: boolean) => void;
  onBack: () => void;
  onAct: (action: Action) => Promise<boolean>;
  onSent: () => void;
  onForward: (draft: ComposeDraft) => void;
}) {
  const [thread, setThread] = React.useState<LiveThread | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [reloadKey, setReloadKey] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    fetch(`/api/inbox/thread?id=${row.id}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(await errorMessage(r, 'Could not open this conversation.'));
        return ((await r.json()) as { thread: LiveThread }).thread;
      })
      .then((t) => {
        if (!cancelled) {
          setThread(t);
          setError(null);
        }
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [row.id, reloadKey]);

  return (
    <article className="rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)]">
      <header className="flex flex-wrap items-center gap-1 border-b border-[var(--border)] p-2">
        <Button size="sm" variant="ghost" onClick={onBack} aria-label="Back to the list">
          <ArrowLeft className="size-4" aria-hidden />
          <span className="lg:hidden">Back</span>
        </Button>
        <div className="flex-1" />
        {row.inInbox ? (
          <Button size="sm" variant="secondary" onClick={() => void onAct('archive')}>
            <Archive className="size-4" aria-hidden /> Archive
          </Button>
        ) : (
          <Button size="sm" variant="secondary" onClick={() => void onAct('inbox')}>
            <InboxIcon className="size-4" aria-hidden /> Move to inbox
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void onAct('unread').then((ok) => ok && onBack())}
          aria-label="Mark unread"
        >
          <Mail className="size-4" aria-hidden />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void onAct(row.starred ? 'unstar' : 'star')}
          aria-label={row.starred ? 'Unstar' : 'Star'}
          aria-pressed={row.starred}
        >
          <Star
            className={cn('size-4', row.starred && 'fill-[var(--gold)] text-[var(--gold)]')}
            aria-hidden
          />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Forward"
          disabled={!thread}
          onClick={() => thread && onForward(forwardDraft(thread))}
        >
          <Forward className="size-4" aria-hidden />
        </Button>
        <Button asChild size="sm" variant="ghost">
          <a
            href={gmailUrl(row.id, mailbox)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open in Gmail"
          >
            <ExternalLink className="size-4" aria-hidden />
          </a>
        </Button>
      </header>

      <div className="space-y-3 p-4">
        <h2 className="text-lg font-semibold text-balance">{thread?.subject ?? row.subject}</h2>
        {thread && thread.labels.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {thread.labels.map((l) => (
              <Badge key={l} tone="neutral">
                {l}
              </Badge>
            ))}
          </div>
        ) : null}
        {error ? <p className="text-sm text-[var(--danger)]">{error}</p> : null}
        {!thread && !error ? (
          <p className="flex items-center gap-2 text-sm text-[var(--fg-muted)]">
            <Loader2 className="size-4 animate-spin" aria-hidden /> Opening…
          </p>
        ) : null}
        {thread ? (
          <ol className="space-y-2">
            {thread.messages.map((m, i) => (
              <MessageItem key={m.id} message={m} startOpen={i === thread.messages.length - 1} />
            ))}
          </ol>
        ) : null}
        {thread ? (
          <ReplyBox
            threadId={row.id}
            canSend={canAct}
            mailbox={mailbox}
            open={replyOpen}
            setOpen={setReplyOpen}
            onSent={() => {
              setReloadKey((k) => k + 1);
              onSent();
            }}
          />
        ) : null}
      </div>
    </article>
  );
}

interface DraftResponse {
  draft: { body: string } | null;
  draftError: string | null;
  canSend: boolean;
  signatures: { nick: string | null; arwin: string } | null;
}

function ReplyBox({
  threadId,
  canSend,
  mailbox,
  open,
  setOpen,
  onSent,
}: {
  threadId: string;
  canSend: boolean;
  mailbox: string | null;
  open: boolean;
  setOpen: (open: boolean) => void;
  onSent: () => void;
}) {
  const [loaded, setLoaded] = React.useState<DraftResponse | null>(null);
  const [body, setBody] = React.useState('');
  const [signature, setSignature] = React.useState<Signature>('nick');
  const [countdown, setCountdown] = React.useState(0);
  const [sending, setSending] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const timer = React.useRef<number | null>(null);
  const quietOpen = React.useRef(false);

  React.useEffect(() => {
    let cancelled = false;
    fetch(`/api/email-session/draft?id=${threadId}`)
      .then(async (r) => (r.ok ? ((await r.json()) as DraftResponse) : null))
      .then((d) => {
        if (cancelled || !d) return;
        setLoaded(d);
        if (d.draft?.body) {
          setBody(d.draft.body);
          // Shown, not focused: opening an email must not jump the page to the reply.
          quietOpen.current = true;
          setOpen(true);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [threadId, setOpen]);

  React.useEffect(() => {
    if (!open) return;
    if (quietOpen.current) {
      quietOpen.current = false;
      return;
    }
    document.getElementById(`reply-${threadId}`)?.focus();
  }, [open, threadId]);

  const send = React.useCallback(async () => {
    setSending(true);
    const res = await postJson('/api/email-session/send', { id: threadId, body, signature });
    setSending(false);
    if (res.ok) {
      toast.success('Sent');
      setBody('');
      setOpen(false);
      onSent();
    } else {
      toast.error(await errorMessage(res, 'It did not send. Try again.'));
    }
  }, [threadId, body, signature, setOpen, onSent]);

  // The send fires from the last tick itself; the ref always holds the newest send.
  const sendRef = React.useRef(send);
  React.useEffect(() => {
    sendRef.current = send;
  }, [send]);

  const startSend = () => {
    if (!body.trim()) {
      toast.error('Write a reply first.');
      return;
    }
    if (!canSend) {
      window.open(gmailUrl(threadId, mailbox), '_blank', 'noopener');
      return;
    }
    if (signature === 'nick' && loaded && !loaded.signatures?.nick) {
      toast.error("Nick's signature couldn't be read from Gmail. Try again, or sign as Arwin.");
      return;
    }
    let left = UNDO_SECONDS;
    setCountdown(left);
    setPending(true);
    timer.current = window.setInterval(() => {
      left -= 1;
      setCountdown(left);
      if (left <= 0) {
        if (timer.current) window.clearInterval(timer.current);
        timer.current = null;
        setPending(false);
        void sendRef.current();
      }
    }, 1000);
  };

  const undo = () => {
    if (timer.current) window.clearInterval(timer.current);
    timer.current = null;
    setPending(false);
    setCountdown(0);
  };

  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <Reply className="size-4" aria-hidden /> Reply
      </Button>
    );
  }

  const waiting = pending;
  const sigText = loaded?.signatures?.[signature] ?? null;

  return (
    <div className="space-y-2 rounded-md border border-[var(--border-strong)] bg-[var(--bg)] p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">Reply all</span>
        {loaded?.draft ? <Badge tone="ok">Draft from Gmail</Badge> : null}
        <div className="flex-1" />
        <span className="text-[var(--fg-muted)]">Sign as</span>
        {(['nick', 'arwin'] as Signature[]).map((s) => (
          <Button
            key={s}
            size="sm"
            variant={signature === s ? 'primary' : 'secondary'}
            aria-pressed={signature === s}
            onClick={() => {
              setSignature(s);
              setBody((b) => swapSignOff(b, s));
            }}
          >
            {s === 'nick' ? 'Nick' : 'Arwin'}
          </Button>
        ))}
      </div>
      <label htmlFor={`reply-${threadId}`} className="sr-only">
        Reply
      </label>
      <Textarea
        id={`reply-${threadId}`}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={8}
        disabled={waiting || sending}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            startSend();
          }
        }}
      />
      {sigText ? (
        <p className="text-xs whitespace-pre-line text-[var(--fg-subtle)]">{sigText}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {waiting ? (
          <>
            <span className="text-sm text-[var(--fg-muted)]">Sending in {countdown}s…</span>
            <Button size="sm" variant="secondary" onClick={undo}>
              <Undo2 className="size-4" aria-hidden /> Undo
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" onClick={startSend} disabled={sending}>
              {sending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Send className="size-4" aria-hidden />
              )}
              {canSend ? 'Send' : 'Send in Gmail'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Close
            </Button>
            <span className="text-xs text-[var(--fg-subtle)]">Ctrl+Enter sends</span>
          </>
        )}
      </div>
    </div>
  );
}

/** Gmail's forward: the newest message quoted under a header, its attachments carried along. */
export function forwardDraft(thread: LiveThread): ComposeDraft {
  const last = thread.messages.at(-1)!;
  const header = [
    '---------- Forwarded message ---------',
    `From: ${last.from}`,
    `Date: ${longTime(last.at)}`,
    `Subject: ${thread.subject}`,
    `To: ${last.to}`,
    last.cc ? `Cc: ${last.cc}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return {
    to: '',
    subject: /^fwd?:/i.test(thread.subject) ? thread.subject : `Fwd: ${thread.subject}`,
    body: `\n\nNick\n\n${header}\n\n${last.text}`,
    forwardOf: last.attachments.length ? last.id : null,
    attachmentNames: last.attachments.map((a) => a.name),
  };
}
