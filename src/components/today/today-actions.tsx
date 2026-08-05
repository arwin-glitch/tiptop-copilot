'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Check, Clock, Plus, RefreshCw } from 'lucide-react';
import {
  createTaskAction,
  refreshOutlookAction,
  snoozeTaskAction,
  updateTaskStatusAction,
} from '@/app/actions';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/form';

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
            onClick={() =>
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
              })
            }
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

export function TaskControls({ taskId }: { taskId: string }) {
  const [pending, startTransition] = React.useTransition();
  const router = useRouter();

  const run = (fn: () => Promise<{ ok: boolean; error?: { message: string } }>, success: string) =>
    startTransition(async () => {
      const result = await fn();
      if (result.ok) {
        toast.success(success);
        router.refresh();
      } else {
        toast.error(result.error?.message ?? 'That did not work');
      }
    });

  return (
    <div className="flex shrink-0 items-center gap-1">
      <Button
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={() => run(() => updateTaskStatusAction(taskId, 'complete'), 'Marked complete')}
        aria-label="Mark complete"
        title="Mark complete"
      >
        <Check aria-hidden="true" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={() => run(() => snoozeTaskAction(taskId, 3), 'Snoozed for 3 days')}
        aria-label="Snooze for 3 days"
        title="Snooze 3 days"
      >
        <Clock aria-hidden="true" />
      </Button>
    </div>
  );
}
