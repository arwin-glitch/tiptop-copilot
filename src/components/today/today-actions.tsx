'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { toast } from 'sonner';
import {
  AlarmClockOff,
  CalendarClock,
  Check,
  Clock,
  Ellipsis,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Scale,
  Trash2,
  UserRound,
} from 'lucide-react';
import {
  assignTaskAction,
  createTaskAction,
  deleteTaskAction,
  refreshOutlookAction,
  restoreTaskAction,
  setMoneyLegalAction,
  snoozeTaskAction,
  updateTaskStatusAction,
} from '@/app/actions';
import { useReportRefresh } from '@/components/shell/refresh-status';
import { useTaskActionHost } from '@/components/tasks/task-action-host';
import { EditTaskDialog, ProofDialog, SnoozeUntilDialog } from '@/components/tasks/task-dialogs';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/form';
import type { TaskPerson } from '@/lib/tasks/task-people';
import type { TaskRestore } from '@/lib/tasks/tasks-view';

export function RefreshOutlookButton() {
  const [pending, startTransition] = React.useTransition();
  const router = useRouter();

  return (
    <Button
      variant="secondary"
      size="sm"
      loading={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await refreshOutlookAction();
          if (result.ok) {
            toast.success('Outlook regenerated');
            router.refresh();
          } else {
            toast.error(result.error?.message ?? 'Could not regenerate the outlook', {
              description: result.error?.stillUsable,
            });
          }
        })
      }
    >
      <RefreshCw aria-hidden="true" />
      Refresh outlook
    </Button>
  );
}

export function CreateFollowUpButton({
  dealId,
  portfolioCompanyId,
  emailMessageId,
  defaultTitle,
  label = 'Create follow-up',
  size = 'sm',
  variant = 'secondary',
}: {
  dealId?: string;
  portfolioCompanyId?: string;
  emailMessageId?: string;
  defaultTitle?: string;
  label?: string;
  size?: 'sm' | 'md';
  variant?: 'primary' | 'secondary' | 'ghost';
}) {
  const [open, setOpen] = React.useState(false);
  const [title, setTitle] = React.useState(defaultTitle ?? '');
  const [detail, setDetail] = React.useState('');
  const [dueAt, setDueAt] = React.useState(defaultDue());
  const [pending, startTransition] = React.useTransition();
  // On Tasks, whose tabs hold their URL writes while this refreshes.
  const reportRefresh = useReportRefresh(pending);
  const router = useRouter();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={variant} size={size}>
          <Plus aria-hidden="true" />
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent
        title="New follow-up"
        description="Follow-ups appear on Today when they are due, and turn red when they are overdue."
      >
        <div className="space-y-4">
          <Field label="What needs doing" htmlFor="task-title">
            <Input
              id="task-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Ask Priya for cohort retention by clinic"
              autoFocus
            />
          </Field>
          <Field
            label="Detail"
            htmlFor="task-detail"
            hint="Optional. Why this matters, or what you need."
          >
            <Textarea
              id="task-detail"
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              rows={3}
            />
          </Field>
          <Field label="Due" htmlFor="task-due">
            <Input
              id="task-due"
              type="date"
              value={dueAt}
              onChange={(e) => setDueAt(e.target.value)}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={pending}
            disabled={!title.trim()}
            onClick={() => {
              reportRefresh();
              startTransition(async () => {
                const result = await createTaskAction({
                  title,
                  detail: detail || undefined,
                  dueAt: dueAt ? new Date(`${dueAt}T17:00:00`).toISOString() : undefined,
                  dealId,
                  portfolioCompanyId,
                  emailMessageId,
                });
                if (result.ok) {
                  toast.success('Follow-up created');
                  setOpen(false);
                  setTitle('');
                  setDetail('');
                  router.refresh();
                } else {
                  toast.error(result.error?.message ?? 'Could not create the follow-up');
                }
              });
            }}
          >
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function defaultDue(): string {
  const d = new Date();
  d.setDate(d.getDate() + 2);
  return d.toISOString().slice(0, 10);
}

const BACK_OPEN: TaskRestore = { status: 'open' };
const UNDO_MS = 8_000;

/** What a row's menu needs to know about its task. */
export interface TaskControlsTask {
  title: string;
  detail: string | null;
  dueAt: string | null;
  assignedTo: string | null;
  /** On the Money & legal tab: Mark complete asks for proof. */
  moneyLegal: boolean;
}

type ActionOutcome = { ok: boolean; error?: { message: string; code?: string } };

const MENU_ITEM =
  'flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-[var(--bg-hover)]';

/**
 * Mark complete and Snooze for a task on a list, and, given the task, a menu
 * to edit it, snooze it to a chosen day, assign it, mark it money & legal or
 * delete it. Each toast that takes the row away carries an Undo, run by the
 * layout's `TaskActionHost` because this row is gone by the time anyone
 * clicks it. `restore` is where Undo puts a completed or deleted task back:
 * open, or (from the Snoozed tab) snoozed until the same time.
 *
 * A money or legal task closes on proof: Mark complete opens the proof
 * dialog, also when the server is the one that knows (a page that did not
 * pass the task).
 */
export function TaskControls({
  taskId,
  restore = BACK_OPEN,
  snooze = true,
  onDone,
  task,
  people,
}: {
  taskId: string;
  restore?: TaskRestore;
  snooze?: boolean;
  /** Called once an action that takes the row away succeeded, before the refresh does. */
  onDone?: () => void;
  /** Turns on the menu. */
  task?: TaskControlsTask;
  /** Who a task can be assigned to; the menu leaves assigning out without them. */
  people?: readonly TaskPerson[];
}) {
  const [pending, startTransition] = React.useTransition();
  // On Tasks, whose tabs hold their URL writes while this refreshes.
  const reportRefresh = useReportRefresh(pending);
  const router = useRouter();
  const host = useTaskActionHost();
  const [dialog, setDialog] = React.useState<'edit' | 'snooze' | 'proof' | null>(null);
  // Set while a menu item opens a dialog, so the closing menu leaves focus to it.
  const toDialog = React.useRef(false);

  /** `undo` null: the row stays, so no Undo and no `onDone`. */
  const run = (
    fn: () => Promise<ActionOutcome>,
    success: string,
    undo: TaskRestore | null,
    after?: (ok: boolean) => void,
  ) => {
    reportRefresh();
    startTransition(async () => {
      const result = await fn();
      if (result.ok) {
        toast.success(
          success,
          undo
            ? {
                duration: UNDO_MS,
                action: {
                  label: 'Undo',
                  onClick: () =>
                    host.run(() => restoreTaskAction(taskId, undo), {
                      success: undo.status === 'snoozed' ? 'Snoozed again' : 'Back on your list',
                      error: 'Could not undo',
                    }),
                },
              }
            : undefined,
        );
        after?.(true);
        if (undo) onDone?.();
        router.refresh();
      } else if (result.error?.code === 'proof_required') {
        after?.(false);
        setDialog('proof');
      } else {
        after?.(false);
        toast.error(result.error?.message ?? 'That did not work');
      }
    });
  };

  // A snooze from To do comes back open; from the Snoozed tab, to its old wake time.
  const snoozeUndo = snooze ? BACK_OPEN : restore;
  const openDialog = (which: 'edit' | 'snooze') => () => {
    toDialog.current = true;
    setDialog(which);
  };
  const close = (open: boolean) => {
    if (!open) setDialog(null);
  };

  return (
    <div className="flex shrink-0 items-center gap-1" data-tour="task-controls">
      <Button
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={() =>
          task?.moneyLegal
            ? setDialog('proof')
            : run(() => updateTaskStatusAction(taskId, 'complete'), 'Marked complete', restore)
        }
        aria-label="Mark complete"
        title={task?.moneyLegal ? 'Close with proof' : 'Mark complete'}
      >
        <Check aria-hidden="true" />
      </Button>
      {snooze ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => run(() => snoozeTaskAction(taskId, 3), 'Snoozed for 3 days', BACK_OPEN)}
          aria-label="Snooze for 3 days"
          title="Snooze 3 days"
        >
          <Clock aria-hidden="true" />
        </Button>
      ) : null}
      {task ? (
        <DropdownMenu.Root modal={false}>
          <DropdownMenu.Trigger asChild>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              aria-label="More actions"
              title="Edit, snooze to a day, assign, delete"
              data-tour="task-more"
            >
              <Ellipsis aria-hidden="true" />
            </Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={6}
              onCloseAutoFocus={(event) => {
                if (toDialog.current) event.preventDefault();
                toDialog.current = false;
              }}
              className="shadow-overlay z-[var(--z-overlay)] w-60 rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)] p-1"
            >
              <DropdownMenu.Item className={MENU_ITEM} onSelect={openDialog('edit')}>
                <Pencil className="size-4" aria-hidden="true" />
                Edit…
              </DropdownMenu.Item>
              <DropdownMenu.Item className={MENU_ITEM} onSelect={openDialog('snooze')}>
                <CalendarClock className="size-4" aria-hidden="true" />
                Snooze until…
              </DropdownMenu.Item>
              <DropdownMenu.CheckboxItem
                className={MENU_ITEM}
                checked={task.moneyLegal}
                onCheckedChange={(on) =>
                  run(
                    () => setMoneyLegalAction(taskId, on === true),
                    on === true ? 'Marked money & legal' : 'Taken off Money & legal',
                    null,
                  )
                }
              >
                <Scale className="size-4" aria-hidden="true" />
                <span className="flex-1">Money &amp; legal</span>
                <DropdownMenu.ItemIndicator>
                  <Check className="size-4" aria-hidden="true" />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.CheckboxItem>
              {people && people.length > 0 ? (
                <>
                  <DropdownMenu.Separator className="my-1 h-px bg-[var(--border)]" />
                  <DropdownMenu.Label className="px-2 py-1 text-xs text-[var(--fg-subtle)]">
                    Assigned to
                  </DropdownMenu.Label>
                  <DropdownMenu.RadioGroup
                    value={task.assignedTo ?? 'none'}
                    onValueChange={(value) => {
                      const to = value === 'none' ? null : value;
                      const who = people.find((p) => p.id === to)?.short;
                      run(
                        () => assignTaskAction(taskId, to),
                        who ? `Assigned to ${who}` : 'Assigned to no one',
                        null,
                      );
                    }}
                  >
                    {[
                      ...people.map((p) => ({ value: p.id, label: p.name })),
                      { value: 'none', label: 'No one' },
                    ].map((option) => (
                      <DropdownMenu.RadioItem
                        key={option.value}
                        value={option.value}
                        className={MENU_ITEM}
                      >
                        <UserRound className="size-4" aria-hidden="true" />
                        <span className="flex-1">{option.label}</span>
                        <DropdownMenu.ItemIndicator>
                          <Check className="size-4" aria-hidden="true" />
                        </DropdownMenu.ItemIndicator>
                      </DropdownMenu.RadioItem>
                    ))}
                  </DropdownMenu.RadioGroup>
                </>
              ) : null}
              <DropdownMenu.Separator className="my-1 h-px bg-[var(--border)]" />
              <DropdownMenu.Item
                className={`${MENU_ITEM} text-[var(--danger)]`}
                onSelect={() => run(() => deleteTaskAction(taskId), 'Task deleted', restore)}
              >
                <Trash2 className="size-4" aria-hidden="true" />
                Delete
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      ) : null}
      {task ? (
        <>
          <EditTaskDialog
            open={dialog === 'edit'}
            onOpenChange={close}
            taskId={taskId}
            task={task}
            run={(fn, success, after) => run(fn, success, null, after)}
          />
          <SnoozeUntilDialog
            open={dialog === 'snooze'}
            onOpenChange={close}
            taskId={taskId}
            run={(fn, success, after) => run(fn, success, snoozeUndo, after)}
          />
        </>
      ) : null}
      <ProofDialog
        open={dialog === 'proof'}
        onOpenChange={close}
        taskId={taskId}
        title={task?.title}
        people={people}
        run={(fn, success, after) => run(fn, success, restore, after)}
      />
    </div>
  );
}

/** Wakes a snoozed task now; the toast's Undo snoozes it again until the same time. */
export function UnsnoozeTaskButton({
  taskId,
  title,
  snoozedUntil,
  onDone,
}: {
  taskId: string;
  title: string;
  snoozedUntil: string | null;
  onDone?: () => void;
}) {
  const [pending, startTransition] = React.useTransition();
  const reportRefresh = useReportRefresh(pending);
  const router = useRouter();
  const host = useTaskActionHost();

  return (
    <Button
      variant="secondary"
      size="sm"
      loading={pending}
      aria-label={`Unsnooze ${title}`}
      onClick={() => {
        reportRefresh();
        startTransition(async () => {
          const result = await updateTaskStatusAction(taskId, 'open');
          if (result.ok) {
            toast.success('Back on To do', {
              duration: UNDO_MS,
              action: {
                label: 'Undo',
                onClick: () =>
                  host.run(() => restoreTaskAction(taskId, { status: 'snoozed', snoozedUntil }), {
                    success: 'Snoozed again',
                    error: 'Could not undo',
                  }),
              },
            });
            onDone?.();
            router.refresh();
          } else {
            toast.error(result.error?.message ?? 'Could not unsnooze it');
          }
        });
      }}
    >
      <AlarmClockOff aria-hidden="true" />
      Unsnooze
    </Button>
  );
}

/** Puts a completed task back on the To do list. */
export function ReopenTaskButton({
  taskId,
  title,
  onReopened,
}: {
  taskId: string;
  title: string;
  onReopened?: () => void;
}) {
  const [pending, startTransition] = React.useTransition();
  const reportRefresh = useReportRefresh(pending);
  const router = useRouter();

  return (
    <Button
      variant="secondary"
      size="sm"
      loading={pending}
      aria-label={`Reopen ${title}`}
      onClick={() => {
        reportRefresh();
        startTransition(async () => {
          const result = await updateTaskStatusAction(taskId, 'open');
          if (result.ok) {
            toast.success('Reopened');
            onReopened?.();
            router.refresh();
          } else {
            toast.error(result.error?.message ?? 'Could not reopen it');
          }
        });
      }}
    >
      <RotateCcw aria-hidden="true" />
      Reopen
    </Button>
  );
}
