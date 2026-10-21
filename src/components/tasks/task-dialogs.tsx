'use client';

import * as React from 'react';
import { BadgeCheck } from 'lucide-react';
import {
  completeTaskWithProofAction,
  editTaskAction,
  listTaskPeopleAction,
  searchTaskCompaniesAction,
  setTaskCompanyAction,
  snoozeTaskUntilAction,
} from '@/app/actions';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/form';
import type { TaskPerson } from '@/lib/tasks/task-people';
import type { TaskCompanyOption } from '@/lib/tasks/task-company';
import { CompanyChip, type TaskCompanyChip } from './company-chip';

/**
 * The task dialogs a row's menu and its tick open: edit, snooze until a
 * chosen day, and close with proof. Each is controlled by its opener, which
 * owns the toast and the refresh, so the row's Undo works the same way as
 * Mark complete's.
 */

type Outcome = { ok: boolean; error?: { message: string; code?: string } };

/**
 * Runs a dialog's action with the opener's pending state, toast and refresh;
 * `after` hears whether it worked, so a failure leaves the dialog open.
 */
export type RunTaskAction = (
  fn: () => Promise<Outcome>,
  success: string,
  after: (ok: boolean) => void,
) => void;

const pad = (n: number) => String(n).padStart(2, '0');

/** A time as the date picker shows it: the day in this browser's own zone. */
export function localDateInput(at: Date | string | null): string {
  if (!at) return '';
  const d = typeof at === 'string' ? new Date(at) : at;
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The picker's day at a wall-clock hour in this browser's zone, as an ISO time. */
export function dateInputAt(value: string, hour: number): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const at = new Date(`${value}T${pad(hour)}:00:00`);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

function daysFromToday(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

/* -------------------------------------------------------------------- edit */

export function EditTaskDialog({
  open,
  onOpenChange,
  taskId,
  task,
  run,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taskId: string;
  task: EditableTask;
  run: RunTaskAction;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <EditTaskForm taskId={taskId} task={task} run={run} onClose={() => onOpenChange(false)} />
      ) : null}
    </Dialog>
  );
}

function EditTaskForm({
  taskId,
  task,
  run,
  onClose,
}: {
  taskId: string;
  task: EditableTask;
  run: RunTaskAction;
  onClose: () => void;
}) {
  const initialDue = localDateInput(task.dueAt);
  const initialCompany = task.company ?? null;
  const [title, setTitle] = React.useState(task.title);
  const [detail, setDetail] = React.useState(task.detail ?? '');
  const [due, setDue] = React.useState(initialDue);
  const [company, setCompany] = React.useState<TaskCompanyChip | null>(initialCompany);
  const [busy, setBusy] = React.useState(false);
  const companyChanged =
    (company?.kind ?? null) !== (initialCompany?.kind ?? null) ||
    (company?.id ?? null) !== (initialCompany?.id ?? null);

  const save = () => {
    // An unchanged day keeps its exact time: a routine's 9am stays 9am.
    const dueAt = due === initialDue ? task.dueAt : due ? dateInputAt(due, 17) : null;
    setBusy(true);
    run(
      async () => {
        const edited = await editTaskAction(taskId, {
          title,
          detail: detail.trim() ? detail : null,
          dueAt,
        });
        if (!edited.ok || !companyChanged) return edited;
        return setTaskCompanyAction(
          taskId,
          company ? { kind: company.kind, id: company.id } : null,
        );
      },
      'Task updated',
      (ok) => {
        setBusy(false);
        if (ok) onClose();
      },
    );
  };

  return (
    <DialogContent
      title="Edit task"
      description="Change what it says, when it is due, or which company it is about."
    >
      <div className="space-y-4">
        <Field label="What needs doing" htmlFor="edit-task-title">
          <Input
            id="edit-task-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={300}
            autoFocus
          />
        </Field>
        <Field label="Detail" htmlFor="edit-task-detail" hint="Optional.">
          <Textarea
            id="edit-task-detail"
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            rows={3}
          />
        </Field>
        <Field label="Due" htmlFor="edit-task-due" hint="Leave empty for no due date.">
          <Input
            id="edit-task-due"
            type="date"
            value={due}
            onChange={(e) => setDue(e.target.value)}
          />
        </Field>
        <CompanyPicker value={company} onChange={setCompany} />
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" loading={busy} disabled={!title.trim()} onClick={save}>
          Save
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/** What the edit dialog can change. */
export interface EditableTask {
  title: string;
  detail: string | null;
  dueAt: string | null;
  company?: TaskCompanyChip | null;
}

/** Wait this long after the last keystroke before searching. */
const SEARCH_DEBOUNCE_MS = 250;

/**
 * Which company a task is about: the current one as a chip with Clear, and a
 * search over deals, portfolio companies and CRM companies to pick another.
 */
function CompanyPicker({
  value,
  onChange,
}: {
  value: TaskCompanyChip | null;
  onChange: (company: TaskCompanyChip | null) => void;
}) {
  const [query, setQuery] = React.useState('');
  const [found, setFound] = React.useState<{ q: string; options: TaskCompanyOption[] }>({
    q: '',
    options: [],
  });
  const term = query.trim();

  React.useEffect(() => {
    if (term.length < 2) return;
    let live = true;
    const timer = window.setTimeout(() => {
      void searchTaskCompaniesAction(term).then((result) => {
        if (live) setFound({ q: term, options: result.ok ? (result.data ?? []) : [] });
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [term]);

  const ready = term.length >= 2 && found.q === term;
  const options = ready ? found.options : [];

  return (
    <Field
      label="Company"
      htmlFor="edit-task-company"
      hint="Optional. The deal, portfolio or CRM company it is about, shown beside the task."
    >
      {value ? (
        <div className="flex items-center gap-1">
          <CompanyChip company={{ ...value, href: null }} className="ml-0" />
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Clear company ${value.name}`}
            onClick={() => onChange(null)}
          >
            Clear
          </Button>
        </div>
      ) : null}
      <Input
        id="edit-task-company"
        type="search"
        value={query}
        autoComplete="off"
        onChange={(e) => setQuery(e.target.value)}
        placeholder={value ? 'Search to change it' : 'Search deals, portfolio and CRM companies'}
      />
      {options.length > 0 ? (
        <ul
          aria-label="Matching companies"
          className="max-h-48 overflow-auto rounded-[var(--radius-field)] border border-[var(--border)] bg-[var(--bg-raised)] p-1"
        >
          {options.map((option) => (
            <li key={`${option.kind}:${option.id}`}>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)] focus-visible:outline-none"
                onClick={() => {
                  onChange({ kind: option.kind, id: option.id, name: option.name, href: null });
                  setQuery('');
                }}
              >
                <span className="truncate">{option.name}</span>
                <span className="shrink-0 text-xs text-[var(--fg-subtle)]">{option.sub}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : ready ? (
        <p className="text-xs text-[var(--fg-subtle)]">No company by that name in Copilot.</p>
      ) : null}
    </Field>
  );
}

/* ------------------------------------------------------------------ snooze */

/** When a chosen snooze wakes on its day: first thing in the morning. */
const WAKE_HOUR = 9;

export function SnoozeUntilDialog({
  open,
  onOpenChange,
  taskId,
  run,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taskId: string;
  run: RunTaskAction;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <SnoozeUntilForm taskId={taskId} run={run} onClose={() => onOpenChange(false)} />
      ) : null}
    </Dialog>
  );
}

function SnoozeUntilForm({
  taskId,
  run,
  onClose,
}: {
  taskId: string;
  run: RunTaskAction;
  onClose: () => void;
}) {
  const [day, setDay] = React.useState(() => localDateInput(daysFromToday(3)));
  const [busy, setBusy] = React.useState(false);
  const until = dateInputAt(day, WAKE_HOUR);
  const label = until
    ? new Date(until).toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      })
    : null;

  return (
    <DialogContent
      title="Snooze until"
      description="The task leaves To do and comes back the morning of the day you pick."
    >
      <Field label="Wake on" htmlFor="snooze-until-day">
        <Input
          id="snooze-until-day"
          type="date"
          value={day}
          min={localDateInput(daysFromToday(1))}
          onChange={(e) => setDay(e.target.value)}
          autoFocus
        />
      </Field>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          loading={busy}
          disabled={!until}
          onClick={() => {
            if (!until) return;
            setBusy(true);
            run(
              () => snoozeTaskUntilAction(taskId, until),
              `Snoozed until ${label}`,
              (ok) => {
                setBusy(false);
                if (ok) onClose();
              },
            );
          }}
        >
          Snooze
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/* ------------------------------------------------------------------- proof */

/**
 * Closing a money or legal task: a link to the proof (the confirmation email
 * in Gmail, the signed copy, a receipt) or who on the team confirmed it, and
 * an optional note. `people` comes from the page when it has them, and is
 * fetched once otherwise.
 */
export function ProofDialog({
  open,
  onOpenChange,
  taskId,
  title,
  people,
  run,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taskId: string;
  title?: string;
  people?: readonly TaskPerson[];
  run: RunTaskAction;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <ProofForm
          taskId={taskId}
          title={title}
          people={people}
          run={run}
          onClose={() => onOpenChange(false)}
        />
      ) : null}
    </Dialog>
  );
}

function ProofForm({
  taskId,
  title,
  people: given,
  run,
  onClose,
}: {
  taskId: string;
  title?: string;
  people?: readonly TaskPerson[];
  run: RunTaskAction;
  onClose: () => void;
}) {
  const [fetched, setFetched] = React.useState<readonly TaskPerson[] | null>(null);
  const people = given ?? fetched ?? [];
  const [kind, setKind] = React.useState<'link' | 'confirmed'>('link');
  const [url, setUrl] = React.useState('');
  const [chosen, setChosen] = React.useState<string | null>(null);
  const [note, setNote] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const confirmedBy = chosen ?? people.find((p) => p.owner)?.id ?? people[0]?.id ?? '';

  React.useEffect(() => {
    if (given) return;
    let live = true;
    void listTaskPeopleAction().then((result) => {
      if (live && result.ok) setFetched(result.data ?? []);
    });
    return () => {
      live = false;
    };
  }, [given]);

  const ready = kind === 'link' ? /^https?:\/\/\S+$/i.test(url.trim()) : Boolean(confirmedBy);

  return (
    <DialogContent
      title="Close with proof"
      description={
        title
          ? `“${title}” is a money or legal task, so it closes on proof.`
          : 'Money and legal tasks close on proof.'
      }
    >
      <fieldset className="space-y-3">
        <legend className="mb-2 text-sm font-medium">What shows it is done?</legend>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="proof-kind"
            className="mt-1"
            checked={kind === 'link'}
            onChange={() => setKind('link')}
          />
          <span>A link: the confirmation email, the signed copy or the receipt</span>
        </label>
        {kind === 'link' ? (
          <Field label="Link to the proof" htmlFor="proof-url">
            <Input
              id="proof-url"
              type="url"
              inputMode="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://mail.google.com/…"
              autoFocus
            />
          </Field>
        ) : null}
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="proof-kind"
            className="mt-1"
            checked={kind === 'confirmed'}
            disabled={people.length === 0}
            onChange={() => setKind('confirmed')}
          />
          <span>
            {people.length === 0
              ? 'Someone on the team confirmed it'
              : `${people.find((p) => p.id === confirmedBy)?.short ?? 'Someone'} confirmed it`}
          </span>
        </label>
        {kind === 'confirmed' && people.length > 1 ? (
          <Field label="Who confirmed it" htmlFor="proof-who">
            <Select id="proof-who" value={confirmedBy} onChange={(e) => setChosen(e.target.value)}>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
      </fieldset>
      <Field label="Note" htmlFor="proof-note" hint="Optional." className="mt-4">
        <Textarea
          id="proof-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          maxLength={500}
        />
      </Field>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          loading={busy}
          disabled={!ready}
          onClick={() => {
            const proof =
              kind === 'link'
                ? { kind: 'link' as const, url: url.trim(), note: note.trim() || undefined }
                : { kind: 'confirmed' as const, confirmedBy, note: note.trim() || undefined };
            setBusy(true);
            run(
              () => completeTaskWithProofAction(taskId, proof),
              'Closed with proof',
              (ok) => {
                setBusy(false);
                if (ok) onClose();
              },
            );
          }}
        >
          <BadgeCheck aria-hidden="true" />
          Close with proof
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
