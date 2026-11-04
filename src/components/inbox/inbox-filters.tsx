'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { Filter, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import {
  APPLY_EXISTING_MAX,
  buildFilterBody,
  criteriaFromSearch,
  describeActions,
  describeCriteria,
  FILTER_CATEGORIES,
  hasCriteria,
  NO_ACTIONS,
  type FilterActions,
  type FilterCriteria,
  type GmailFilter,
} from '@/lib/email/inbox-filters';
import type { AdvancedSearch } from '@/lib/email/inbox-folders';
import type { MailLabel } from '@/lib/email/inbox-actions';

/** The start of the opt-in flow that adds Gmail's filter scope (send-scopes.ts). */
export const TURN_ON_FILTERS_HREF = '/api/integrations/google/start?filters=1';

type FilterState = 'on' | 'off' | 'demo' | 'not_connected';

interface FiltersRead {
  access: { state: FilterState; canApplyExisting: boolean };
  filters: GmailFilter[];
  labels: MailLabel[];
}

const FIELD =
  'h-8 min-w-0 flex-1 border-b border-[var(--border-control)] bg-transparent px-1 text-sm text-[var(--fg)] focus-visible:border-[var(--accent)] focus-visible:outline-none';
const SELECT =
  'h-8 rounded-md border border-[var(--border-control)] bg-[var(--bg-raised)] px-2 text-sm';

async function readFilters(): Promise<FiltersRead | { error: string }> {
  try {
    const res = await fetch('/api/inbox/filters', { cache: 'no-store' });
    const j = (await res.json().catch(() => null)) as
      (FiltersRead & { ok: true }) | { ok: false; error?: { message?: string } } | null;
    if (!j || !j.ok) return { error: (j && !j.ok && j.error?.message) || 'Gmail did not answer.' };
    return j;
  } catch {
    return { error: 'Could not reach Kraken. Try again.' };
  }
}

/** The step shown instead of the filter controls until filters are turned on. */
function TurnOnFilters({ state }: { state: FilterState }) {
  if (state === 'not_connected') {
    return (
      <p className="text-sm text-[var(--fg-muted)]">
        No mailbox is connected. Connect Google in Settings › Integrations first.
      </p>
    );
  }
  return (
    <div className="space-y-3 text-sm">
      <p className="font-medium">Turn on filters</p>
      <p className="text-[var(--fg-muted)]">
        Making Gmail filters from Kraken needs one more Google permission: managing your basic mail
        settings (filters). Google asks you to approve it once. Kraken only makes or deletes a
        filter when you click Create or Delete, never on its own, and never forwards or deletes mail
        with one.
      </p>
      <a
        href={TURN_ON_FILTERS_HREF}
        className="inline-flex h-9 items-center rounded-md bg-[var(--primary)] px-3.5 text-sm font-medium text-[var(--primary-fg)] hover:bg-[var(--primary-hover)]"
      >
        Turn on filters
      </a>
    </div>
  );
}

/**
 * Gmail's Create filter dialog: the criteria from the search (editable), the
 * actions Kraken offers (no forwarding, no delete), and "Also apply filter
 * to N matching conversations". A filter is made only when Create is clicked.
 */
export function CreateFilterDialog({
  search,
  onOpenChange,
  onCreated,
}: {
  /** The search options it opened from; null when closed. */
  search: AdvancedSearch | null;
  onOpenChange: (open: boolean) => void;
  /** After a filter is made (and maybe applied): the list may have changed. */
  onCreated: (applied: number) => void;
}) {
  const open = search !== null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent
          title="Create filter"
          description="New mail that matches gets these actions in Gmail."
          className="max-w-xl"
        >
          <CreateFilterBody
            initial={criteriaFromSearch(search)}
            onDone={(applied) => {
              onOpenChange(false);
              onCreated(applied);
            }}
          />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function CreateFilterBody({
  initial,
  onDone,
}: {
  initial: FilterCriteria;
  onDone: (applied: number) => void;
}) {
  const [read, setRead] = React.useState<FiltersRead | { error: string } | null>(null);
  const [criteria, setCriteria] = React.useState<FilterCriteria>(initial);
  const [actions, setActions] = React.useState<FilterActions>(NO_ACTIONS);
  const [applyExisting, setApplyExisting] = React.useState(false);
  const [count, setCount] = React.useState<number | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  const id = React.useId();

  React.useEffect(() => {
    let live = true;
    void readFilters().then((r) => {
      if (live) setRead(r);
    });
    return () => {
      live = false;
    };
  }, []);

  const ready =
    read && !('error' in read) && (read.access.state === 'on' || read.access.state === 'demo');

  // "Also apply to N": a cheap count, a moment after the criteria stop changing.
  React.useEffect(() => {
    if (!ready || !hasCriteria(criteria)) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({
        from: criteria.from,
        to: criteria.to,
        subject: criteria.subject,
        hasWords: criteria.hasWords,
        doesntHave: criteria.doesntHave,
        hasAttachment: criteria.hasAttachment ? '1' : '0',
      });
      fetch(`/api/inbox/filters/count?${params.toString()}`, { signal: controller.signal })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { count?: number | null } | null) => setCount(j?.count ?? null))
        .catch(() => undefined);
    }, 400);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [ready, criteria]);

  if (!read) return <p className="text-sm text-[var(--fg-muted)]">Loading…</p>;
  if ('error' in read) return <p className="text-sm text-[var(--danger)]">{read.error}</p>;
  if (!ready) return <TurnOnFilters state={read.access.state} />;

  const setC = <K extends keyof FilterCriteria>(key: K, v: FilterCriteria[K]) =>
    setCriteria((c) => ({ ...c, [key]: v }));
  const setA = <K extends keyof FilterActions>(key: K, v: FilterActions[K]) =>
    setActions((a) => ({ ...a, [key]: v }));
  const built = buildFilterBody(criteria, actions);
  const shownCount = hasCriteria(criteria) ? count : 0;

  const create = async () => {
    if (!built.ok) {
      setProblem(built.message);
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const res = await fetch('/api/inbox/filters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ criteria, actions, applyExisting }),
      });
      const j = (await res.json().catch(() => null)) as {
        ok?: boolean;
        applied?: number;
        error?: { message?: string };
      } | null;
      if (!res.ok || !j?.ok) {
        setProblem(j?.error?.message ?? 'Gmail did not take that filter. Try again.');
        return;
      }
      const applied = j.applied ?? 0;
      toast.success(
        applied
          ? `Filter created and applied to ${applied} conversation${applied === 1 ? '' : 's'}`
          : 'Filter created',
      );
      onDone(applied);
    } finally {
      setBusy(false);
    }
  };

  const check = (key: 'skipInbox' | 'markRead' | 'star' | 'neverSpam', label: string) => (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={actions[key]} onChange={(e) => setA(key, e.target.checked)} />
      {label}
    </label>
  );

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
      className="space-y-4"
    >
      {read.access.state === 'demo' ? (
        <p className="rounded-md bg-[var(--bg-sunken)] px-3 py-2 text-xs text-[var(--fg-muted)]">
          Demo mailbox: the filter stays here, and nothing reaches Gmail.
        </p>
      ) : null}
      <fieldset className="space-y-2">
        <legend className="mb-1 text-xs font-medium tracking-wide text-[var(--fg-subtle)] uppercase">
          Matches
        </legend>
        {(
          [
            ['from', 'From'],
            ['to', 'To'],
            ['subject', 'Subject'],
            ['hasWords', 'Has the words'],
            ['doesntHave', "Doesn't have"],
          ] as const
        ).map(([key, label]) => (
          <div key={key} className="flex items-center gap-3">
            <label
              htmlFor={`${id}-${key}`}
              className="w-28 shrink-0 text-sm text-[var(--fg-muted)]"
            >
              {label}
            </label>
            <input
              id={`${id}-${key}`}
              value={criteria[key]}
              maxLength={500}
              onChange={(e) => setC(key, e.target.value)}
              className={FIELD}
            />
          </div>
        ))}
        <label className="flex items-center gap-2 pt-1 text-sm">
          <input
            type="checkbox"
            checked={criteria.hasAttachment}
            onChange={(e) => setC('hasAttachment', e.target.checked)}
          />
          Has attachment
        </label>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-xs font-medium tracking-wide text-[var(--fg-subtle)] uppercase">
          When mail arrives that matches
        </legend>
        {check('skipInbox', 'Skip the Inbox (Archive it)')}
        {check('markRead', 'Mark as read')}
        {check('star', 'Star it')}
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label htmlFor={`${id}-label`}>Apply the label</label>
          <select
            id={`${id}-label`}
            value={actions.label}
            onChange={(e) => setA('label', e.target.value)}
            className={SELECT}
          >
            <option value="">Choose label…</option>
            {read.labels.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </div>
        {check('neverSpam', 'Never send it to Spam')}
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label htmlFor={`${id}-imp`}>Important</label>
          <select
            id={`${id}-imp`}
            value={actions.important}
            onChange={(e) => setA('important', e.target.value as FilterActions['important'])}
            className={SELECT}
          >
            <option value="">Leave as Gmail decides</option>
            <option value="always">Always mark it as important</option>
            <option value="never">Never mark it as important</option>
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label htmlFor={`${id}-cat`}>Categorize as</label>
          <select
            id={`${id}-cat`}
            value={actions.category}
            onChange={(e) => setA('category', e.target.value as FilterActions['category'])}
            className={SELECT}
          >
            <option value="">Choose category…</option>
            {FILTER_CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
      </fieldset>

      <div className="space-y-1">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={applyExisting && read.access.canApplyExisting}
            disabled={!read.access.canApplyExisting}
            onChange={(e) => setApplyExisting(e.target.checked)}
          />
          Also apply filter to{' '}
          {shownCount === null
            ? 'matching conversations'
            : `${shownCount} matching conversation${shownCount === 1 ? '' : 's'}`}
        </label>
        <p className="pl-6 text-xs text-[var(--fg-subtle)]">
          {read.access.canApplyExisting
            ? `Archive, read, star, important and the label; up to the newest ${APPLY_EXISTING_MAX}. Categories and Spam apply to new mail.`
            : 'Needs sending turned on (Settings › Integrations). The filter still works on new mail.'}
        </p>
      </div>

      <p className="text-xs text-[var(--fg-subtle)]">
        Kraken filters never forward or delete mail. Change those in Gmail.
      </p>
      {problem ? (
        <p role="alert" className="text-sm text-[var(--danger)]">
          {problem}
        </p>
      ) : null}
      <DialogFooter>
        <Button type="submit" variant="primary" disabled={busy || !built.ok}>
          <Filter aria-hidden /> {busy ? 'Creating…' : 'Create filter'}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * The Filters list (Inbox ⋮ menu): every Gmail filter on the mailbox in
 * Gmail's words, each with Delete (asked once more). Read-only until a
 * person clicks Delete; nothing here changes a filter on its own.
 */
export function FiltersListDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent
          title="Filters"
          description="Gmail filters on this mailbox. New ones come from search options › Create filter."
          className="max-w-xl"
        >
          <FiltersListBody />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function FiltersListBody() {
  const [read, setRead] = React.useState<FiltersRead | { error: string } | null>(null);
  const [confirm, setConfirm] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    void readFilters().then(setRead);
  }, []);
  React.useEffect(load, [load]);

  if (!read) return <p className="text-sm text-[var(--fg-muted)]">Loading…</p>;
  if ('error' in read) return <p className="text-sm text-[var(--danger)]">{read.error}</p>;
  if (read.access.state === 'off' || read.access.state === 'not_connected') {
    return <TurnOnFilters state={read.access.state} />;
  }
  const names = new Map(read.labels.map((l) => [l.id, l.name]));

  const remove = async (filterId: string) => {
    setBusy(filterId);
    try {
      const res = await fetch(`/api/inbox/filters?id=${encodeURIComponent(filterId)}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        toast.success('Filter deleted');
        setRead((cur) =>
          cur && !('error' in cur)
            ? { ...cur, filters: cur.filters.filter((f) => f.id !== filterId) }
            : cur,
        );
      } else {
        const j = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        toast.error(j?.error?.message ?? 'Gmail did not delete that filter. Try again.');
      }
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  };

  if (read.filters.length === 0) {
    return (
      <p className="text-sm text-[var(--fg-muted)]">
        No filters yet. Open the search options (the sliders in the search bar) and choose Create
        filter.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-[var(--border)]" aria-label="Gmail filters">
      {read.filters.map((f) => (
        <li key={f.id} className="flex items-start gap-3 py-3">
          <div className="min-w-0 flex-1">
            <p className="font-mono text-xs break-words text-[var(--fg)]">
              {describeCriteria(f.criteria) || '(any mail)'}
            </p>
            <p className="mt-1 text-sm text-[var(--fg-muted)]">
              {describeActions(f.action, names).join(' · ') || 'No actions'}
            </p>
          </div>
          {confirm === f.id ? (
            <span className="flex shrink-0 items-center gap-1">
              <Button
                size="sm"
                variant="danger"
                disabled={busy === f.id}
                onClick={() => void remove(f.id)}
              >
                Delete filter
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
                Keep
              </Button>
            </span>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Delete filter ${describeCriteria(f.criteria)}`}
              onClick={() => setConfirm(f.id)}
            >
              <Trash2 aria-hidden /> Delete
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
