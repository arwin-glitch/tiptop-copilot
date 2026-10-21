'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { BadgeCheck, ExternalLink, Sparkles, X } from 'lucide-react';
import { dismissNeedsProofAction, restoreTaskAction } from '@/app/actions';
import { SectionHeading } from '@/components/shell/page-header';
import { useReportRefresh } from '@/components/shell/refresh-status';
import { useTaskActionHost } from '@/components/tasks/task-action-host';
import { ProofDialog } from '@/components/tasks/task-dialogs';
import {
  ReopenTaskButton,
  TaskControls,
  type TaskControlsTask,
} from '@/components/today/today-actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/feedback';
import { matchesWho, type TaskRestore } from '@/lib/tasks/tasks-view';
import { useTasksWho, WhoFilter } from './tasks-tabs';
import { MoneyBadges } from './todo-tasks';

/** A row on the Money & legal tab, as the server prepared it. */
export interface MoneyLegalItem {
  id: string;
  title: string;
  detail: string | null;
  href: string | null;
  suggested: boolean;
  group: 'needs_proof' | 'open' | 'closed';
  /** The due line, the wake line, or when it was closed. */
  when: string | null;
  whenDanger: boolean;
  assignee: string | null;
  assignedTo: string | null;
  money: { why: string; stale: string | null; needsProof: boolean };
  /** For a needs-proof row: what the auto-check said. */
  claim: { label: string; reason: string | null } | null;
  /** For a closed row: what it was closed on. */
  proof: { label: string; href: string | null; note: string | null; auto: boolean } | null;
  /** Where Undo puts it back; a snoozed row goes back to its wake time. */
  restore: TaskRestore;
  controls: TaskControlsTask;
}

const GROUPS = [
  {
    key: 'needs_proof',
    label: 'Needs proof',
    blurb:
      'The auto-check called these done but showed no proof. Close each with proof, or say it is not done.',
  },
  {
    key: 'open',
    label: 'Open',
    blurb: 'Kept here until closed with proof. Quiet for a week or more is going stale.',
  },
  { key: 'closed', label: 'Recently closed', blurb: null },
] as const;

/**
 * The Money & legal tab: wires, signatures, filings, invoices and the like,
 * kept until really closed. Needs proof first, then open (snoozed ones too:
 * a money item never drops out of sight), then the newest closed, each with
 * what it was closed on.
 */
export function MoneyLegalTasks({
  items,
  closedTotal,
}: {
  items: MoneyLegalItem[];
  closedTotal: number;
}) {
  const { who, people } = useTasksWho();
  const shown = items.filter((item) => matchesWho(item.assignedTo, who));

  if (items.length === 0) {
    return (
      <EmptyState
        title="No money or legal tasks"
        description="Tasks about wires, signatures, filings, invoices, contracts and the like land here, and stay until closed with proof. Mark any task from its menu."
      />
    );
  }

  return (
    <div className="space-y-6" data-tour="money-legal-list">
      <WhoFilter />
      {shown.length === 0 ? (
        <EmptyState
          title={`Nothing for ${people.find((p) => p.id === who)?.short ?? 'them'}`}
          description="Choose Everyone to see the whole list."
        />
      ) : (
        <div className="space-y-8">
          {GROUPS.map((group) => {
            const rows = shown.filter((item) => item.group === group.key);
            if (rows.length === 0) return null;
            return (
              <section key={group.key}>
                {/* Closed shows only the newest few: the heading counts them all, unless filtered. */}
                <SectionHeading
                  count={group.key === 'closed' && who === 'all' ? closedTotal : rows.length}
                >
                  {group.key === 'needs_proof' ? (
                    <span className="text-[var(--danger)]">{group.label}</span>
                  ) : (
                    group.label
                  )}
                </SectionHeading>
                {group.blurb ? (
                  <p className="-mt-2 mb-3 text-sm text-[var(--fg-muted)]">{group.blurb}</p>
                ) : null}
                <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)]">
                  {rows.map((item) => (
                    <MoneyRow key={item.id} item={item} />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function MoneyRow({ item }: { item: MoneyLegalItem }) {
  const { people } = useTasksWho();
  const closed = item.group === 'closed';
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
      <div className="min-w-0 break-words">
        <p className="text-sm font-medium">
          {item.href ? (
            <Link href={item.href} className="underline-offset-2 hover:underline">
              {item.title}
            </Link>
          ) : (
            item.title
          )}
          {item.suggested ? (
            <Badge tone="outline" className="ml-2">
              Suggested
            </Badge>
          ) : null}
        </p>
        {item.detail ? (
          <p className="mt-0.5 text-sm text-[var(--fg-muted)]">{item.detail}</p>
        ) : null}
        {item.when ? (
          <p
            className={
              item.whenDanger
                ? 'mt-1 text-xs font-medium text-[var(--danger)]'
                : 'mt-1 text-xs text-[var(--fg-subtle)]'
            }
          >
            {item.when}
            {item.assignee ? (
              <span className="font-normal text-[var(--fg-subtle)]"> · {item.assignee}</span>
            ) : null}
          </p>
        ) : null}
        {item.claim ? (
          <div className="mt-1 text-xs text-[var(--fg-muted)]">
            <p className="flex items-start gap-1.5">
              <Sparkles className="mt-px size-3.5 shrink-0" aria-hidden="true" />
              {item.claim.label}
            </p>
            {item.claim.reason ? (
              <p className="mt-0.5 text-[var(--fg-subtle)]">“{item.claim.reason}”</p>
            ) : null}
          </div>
        ) : null}
        {item.proof ? <ProofLine proof={item.proof} /> : null}
        {closed ? (
          <p className="mt-1.5">
            <Badge tone="ok">Closed</Badge>
          </p>
        ) : (
          <MoneyBadges money={item.money} />
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1">
        {closed ? (
          <ReopenTaskButton taskId={item.id} title={item.title} />
        ) : (
          <>
            {item.group === 'needs_proof' ? <NeedsProofButtons item={item} /> : null}
            <TaskControls
              taskId={item.id}
              task={item.controls}
              people={people}
              restore={item.restore}
              snooze={item.restore.status === 'open'}
            />
          </>
        )}
      </div>
    </li>
  );
}

/** What a closed row was closed on: a link, who confirmed it, or the auto-check's reason. */
export function ProofLine({
  proof,
}: {
  proof: { label: string; href: string | null; note: string | null; auto: boolean };
}) {
  const Icon = proof.auto ? Sparkles : BadgeCheck;
  return (
    <div className="mt-1 text-xs text-[var(--fg-muted)]">
      <p className="flex items-start gap-1.5">
        <Icon className="mt-px size-3.5 shrink-0" aria-hidden="true" />
        {proof.href ? (
          <a
            href={proof.href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 underline decoration-dotted underline-offset-2 hover:decoration-solid"
          >
            {proof.label}
            <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        ) : (
          <span>{proof.label}</span>
        )}
      </p>
      {proof.note ? (
        <p
          className="mt-0.5 line-clamp-3 text-[var(--fg-subtle)] sm:line-clamp-1"
          title={proof.note}
        >
          {proof.note}
        </p>
      ) : null}
    </div>
  );
}

const UNDO_MS = 8_000;

/** "Close with proof" and "Not done" on a row the auto-check called done without proof. */
function NeedsProofButtons({ item }: { item: MoneyLegalItem }) {
  const { people } = useTasksWho();
  const [open, setOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const reportRefresh = useReportRefresh(pending);
  const router = useRouter();
  const host = useTaskActionHost();

  return (
    <>
      <Button variant="secondary" size="sm" disabled={pending} onClick={() => setOpen(true)}>
        <BadgeCheck aria-hidden="true" />
        Close with proof
      </Button>
      <Button
        variant="ghost"
        size="sm"
        loading={pending}
        aria-label={`Not done: ${item.title}`}
        onClick={() => {
          reportRefresh();
          startTransition(async () => {
            const result = await dismissNeedsProofAction(item.id);
            if (result.ok) {
              toast.success('Kept open: not done yet');
              router.refresh();
            } else {
              toast.error(result.error?.message ?? 'That did not work');
            }
          });
        }}
      >
        <X aria-hidden="true" />
        Not done
      </Button>
      <ProofDialog
        open={open}
        onOpenChange={setOpen}
        taskId={item.id}
        title={item.title}
        people={people}
        run={(fn, success, after) => {
          reportRefresh();
          startTransition(async () => {
            const result = await fn();
            if (result.ok) {
              toast.success(success, {
                duration: UNDO_MS,
                action: {
                  label: 'Undo',
                  onClick: () =>
                    host.run(() => restoreTaskAction(item.id, item.restore), {
                      success: 'Back on your list',
                      error: 'Could not undo',
                    }),
                },
              });
              after(true);
              router.refresh();
            } else {
              after(false);
              toast.error(result.error?.message ?? 'That did not work');
            }
          });
        }}
      />
    </>
  );
}
