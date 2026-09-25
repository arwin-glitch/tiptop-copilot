'use client';

import * as React from 'react';
import Link from 'next/link';
import { SectionHeading } from '@/components/shell/page-header';
import { ReopenTaskButton } from '@/components/today/today-actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/feedback';
import { groupRuns, type CompletedGroupKey } from '@/lib/tasks/tasks-view';

/** How many completed tasks show before "Show more". */
const COMPLETED_PAGE = 100;

/** A completed task as the server prepared it: labels already worked out. */
export interface CompletedTaskItem {
  id: string;
  title: string;
  detail: string | null;
  href: string | null;
  suggested: boolean;
  /** "Completed 3h ago", worked out on the server so it matches on hydration. */
  completedLabel: string;
  group: CompletedGroupKey;
}

/** The Completed tab: newest first, under Today / Yesterday / Earlier headings. */
export function CompletedTasks({ items }: { items: CompletedTaskItem[] }) {
  const [shown, setShown] = React.useState(COMPLETED_PAGE);
  const list = React.useRef<HTMLDivElement>(null);
  const focusIndex = React.useRef<number | null>(null);

  React.useEffect(() => {
    // "Show more" goes away once pressed; keep keyboard users in place by
    // moving focus to the first row it revealed.
    if (focusIndex.current === null) return;
    list.current?.querySelector<HTMLElement>(`[data-index="${focusIndex.current}"]`)?.focus();
    focusIndex.current = null;
  }, [shown]);

  if (items.length === 0) {
    return <EmptyState title="Nothing completed yet" description="Tasks you tick off land here." />;
  }

  const visible = items.slice(0, shown);
  const position = new Map(visible.map((item, i) => [item.id, i]));
  const groups = groupRuns(visible);
  // Headings count the whole group, including rows behind "Show more".
  const totals = new Map(groupRuns(items).map((group) => [group.key, group.items.length]));

  return (
    <div ref={list} className="space-y-8">
      {groups.map((group) => (
        <section key={group.key}>
          <SectionHeading count={totals.get(group.key)}>{group.label}</SectionHeading>
          <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)]">
            {group.items.map((item) => (
              <CompletedRow key={item.id} item={item} index={position.get(item.id) ?? 0} />
            ))}
          </ul>
        </section>
      ))}

      {items.length > shown ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-[var(--fg-muted)]">
            Showing {shown} of {items.length}.
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              focusIndex.current = shown;
              setShown(items.length);
            }}
          >
            Show more
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function CompletedRow({ item, index }: { item: CompletedTaskItem; index: number }) {
  return (
    <li
      data-index={index}
      tabIndex={-1}
      className="flex items-start justify-between gap-3 px-4 py-3"
    >
      <div className="min-w-0">
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
        <p className="mt-1 text-xs text-[var(--fg-subtle)]">{item.completedLabel}</p>
      </div>
      <ReopenTaskButton taskId={item.id} title={item.title} />
    </li>
  );
}
