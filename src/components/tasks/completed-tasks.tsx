'use client';

import * as React from 'react';
import Link from 'next/link';
import { ExternalLink, Sparkles } from 'lucide-react';
import { SectionHeading } from '@/components/shell/page-header';
import { ReopenTaskButton } from '@/components/today/today-actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/feedback';
import { COMPLETED_PAGE, completedSections, type CompletedGroupKey } from '@/lib/tasks/tasks-view';
import { useFocusAfterRemoval } from './use-row-focus';

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
  /** Set when the task-closer or the reply check closed it, and no person has since. */
  auto?: {
    /** "Closed automatically · email sent Sep 22". */
    label: string;
    /** The sent email in Gmail; none for a calendar event. */
    href: string | null;
    reason: string | null;
  };
}

/** The Completed tab: newest first, under Today / Yesterday / Earlier headings. */
export function CompletedTasks({ items }: { items: CompletedTaskItem[] }) {
  const [shown, setShown] = React.useState(COMPLETED_PAGE);
  const root = React.useRef<HTMLDivElement>(null);
  const focusIndex = React.useRef<number | null>(null);
  // Reopen takes its row away; focus follows to the next one.
  const leaving = useFocusAfterRemoval(items, root);

  React.useEffect(() => {
    // "Show more" goes away once pressed; keep keyboard users in place by
    // moving focus to the first row it revealed.
    if (focusIndex.current === null) return;
    root.current?.querySelector<HTMLElement>(`[data-index="${focusIndex.current}"]`)?.focus();
    focusIndex.current = null;
  }, [shown]);

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
                onReopened={() => leaving(item.id, (starts[s] ?? 0) + i)}
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
        {item.auto ? (
          <div className="mt-1 text-xs text-[var(--fg-muted)]">
            <p className="flex items-start gap-1.5">
              <Sparkles className="mt-px size-3.5 shrink-0" aria-hidden="true" />
              {item.auto.href ? (
                <a
                  href={item.auto.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 underline decoration-dotted underline-offset-2 hover:decoration-solid"
                >
                  {item.auto.label}
                  <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
                  <span className="sr-only">(opens Gmail in a new tab)</span>
                </a>
              ) : (
                <span>{item.auto.label}</span>
              )}
            </p>
            {item.auto.reason ? (
              <p
                className="mt-0.5 line-clamp-3 text-[var(--fg-subtle)] sm:line-clamp-1"
                title={item.auto.reason}
              >
                {item.auto.reason}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
      <ReopenTaskButton taskId={item.id} title={item.title} onReopened={onReopened} />
    </li>
  );
}
