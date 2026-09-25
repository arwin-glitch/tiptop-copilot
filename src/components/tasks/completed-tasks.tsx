'use client';

import * as React from 'react';
import Link from 'next/link';
import { SectionHeading } from '@/components/shell/page-header';
import { ReopenTaskButton } from '@/components/today/today-actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/feedback';
import { COMPLETED_PAGE, completedSections, type CompletedGroupKey } from '@/lib/tasks/tasks-view';

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
  const root = React.useRef<HTMLDivElement>(null);
  const focusIndex = React.useRef<number | null>(null);
  // The row just reopened, until a refresh takes it off the list.
  const reopened = React.useRef<{ id: string; index: number } | null>(null);

  React.useEffect(() => {
    // "Show more" goes away once pressed; keep keyboard users in place by
    // moving focus to the first row it revealed.
    if (focusIndex.current === null) return;
    root.current?.querySelector<HTMLElement>(`[data-index="${focusIndex.current}"]`)?.focus();
    focusIndex.current = null;
  }, [shown]);

  React.useEffect(() => {
    const gone = reopened.current;
    if (!gone || items.some((item) => item.id === gone.id)) return;
    reopened.current = null;
    // Its Reopen button went with it. Unless focus has moved on, land on the
    // row that took its place, else the Completed tab.
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const rows = root.current?.querySelectorAll<HTMLElement>('[data-index]') ?? [];
    const next = rows[Math.min(gone.index, rows.length - 1)];
    if (next) {
      next.focus();
      return;
    }
    const tab = root.current?.closest('[role="tabpanel"]')?.getAttribute('aria-labelledby');
    if (tab) document.getElementById(tab)?.focus();
  }, [items]);

  if (items.length === 0) {
    return (
      <div ref={root}>
        <EmptyState title="Nothing completed yet" description="Tasks you tick off land here." />
      </div>
    );
  }

  const { sections, hidden } = completedSections(items, shown);
  // Where each section's rows start in the list as a whole.
  const starts = sections.map((_, i) =>
    sections.slice(0, i).reduce((sum, section) => sum + section.items.length, 0),
  );

  return (
    <div ref={root} className="space-y-8">
      {sections.map((section, s) => (
        <section key={section.key}>
          <SectionHeading count={section.total}>{section.label}</SectionHeading>
          <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)]">
            {section.items.map((item, i) => (
              <CompletedRow
                key={item.id}
                item={item}
                index={(starts[s] ?? 0) + i}
                onReopened={() => {
                  reopened.current = { id: item.id, index: (starts[s] ?? 0) + i };
                }}
              />
            ))}
          </ul>
        </section>
      ))}

      {hidden > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-[var(--fg-muted)]">
            Showing {items.length - hidden} of {items.length}.
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

function CompletedRow({
  item,
  index,
  onReopened,
}: {
  item: CompletedTaskItem;
  index: number;
  onReopened: () => void;
}) {
  return (
    <li
      data-index={index}
      tabIndex={-1}
      className="flex items-start justify-between gap-3 px-4 py-3"
    >
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
        <p className="mt-1 text-xs text-[var(--fg-subtle)]">{item.completedLabel}</p>
      </div>
      <ReopenTaskButton taskId={item.id} title={item.title} onReopened={onReopened} />
    </li>
  );
}
