'use client';

import * as React from 'react';
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { SectionHeading } from '@/components/shell/page-header';
import { TaskControls, type TaskControlsTask } from '@/components/today/today-actions';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/feedback';
import { matchesWho } from '@/lib/tasks/tasks-view';
import { useTasksWho, WhoFilter } from './tasks-tabs';

/** A To do row as the server prepared it: every label already worked out. */
export interface TodoTaskItem {
  id: string;
  title: string;
  detail: string | null;
  href: string | null;
  suggested: boolean;
  section: 'overdue' | 'today' | 'upcoming';
  /** "Overdue — was due 2d ago", "Due 1d from now" or "No due date". */
  dueLabel: string;
  /** Who it is assigned to, by short name, when the team has more than one person. */
  assignee: string | null;
  assignedTo: string | null;
  /** Set for a money or legal task. */
  money: { why: string; stale: string | null; needsProof: boolean } | null;
  controls: TaskControlsTask;
}

const SECTIONS = [
  { key: 'overdue', label: 'Overdue' },
  { key: 'today', label: 'Due today' },
  { key: 'upcoming', label: 'Upcoming' },
] as const;

/**
 * The To do tab: overdue first, then due today, then upcoming, filtered in
 * the browser by whose tasks they are, so the filter is instant.
 */
export function TodoTasks({ items }: { items: TodoTaskItem[] }) {
  const { who, people } = useTasksWho();
  const shown = items.filter((item) => matchesWho(item.assignedTo, who));
  const name = people.find((p) => p.id === who)?.short;

  return (
    <div className="space-y-6">
      <WhoFilter />
      {shown.length === 0 ? (
        <EmptyState
          title={name ? `Nothing for ${name}` : 'Nothing here'}
          description="Choose Everyone to see the whole list."
        />
      ) : (
        <div className="space-y-8" data-tour="tasks-list">
          {SECTIONS.map((section) => {
            const rows = shown.filter((item) => item.section === section.key);
            if (rows.length === 0) return null;
            return (
              <section key={section.key}>
                <SectionHeading count={rows.length}>
                  {section.key === 'overdue' ? (
                    <span className="flex items-center gap-2 text-[var(--danger)]">
                      <AlertTriangle className="size-4" aria-hidden="true" />
                      Overdue
                    </span>
                  ) : (
                    section.label
                  )}
                </SectionHeading>
                <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)]">
                  {rows.map((item) => (
                    <TodoRow key={item.id} item={item} />
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

function TodoRow({ item }: { item: TodoTaskItem }) {
  const { people } = useTasksWho();
  const overdue = item.section === 'overdue';
  return (
    <li className="flex items-start justify-between gap-3 px-4 py-3">
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
        <p
          className={
            overdue
              ? 'mt-1 text-xs font-medium text-[var(--danger)]'
              : 'mt-1 text-xs text-[var(--fg-subtle)]'
          }
        >
          {item.dueLabel}
          {item.assignee ? (
            <span className="font-normal text-[var(--fg-subtle)]"> · {item.assignee}</span>
          ) : null}
        </p>
        {item.money ? <MoneyBadges money={item.money} /> : null}
      </div>
      <TaskControls taskId={item.id} task={item.controls} people={people} />
    </li>
  );
}

/** "Money & legal", "Needs proof" and "Going stale" on a row. */
export function MoneyBadges({
  money,
}: {
  money: { why: string; stale: string | null; needsProof: boolean };
}) {
  return (
    <p className="mt-1.5 flex flex-wrap items-center gap-1.5">
      <Badge tone="outline" title={money.why}>
        Money &amp; legal
      </Badge>
      {money.needsProof ? <Badge tone="danger">Needs proof</Badge> : null}
      {money.stale ? <Badge tone="warn">{money.stale}</Badge> : null}
    </p>
  );
}
