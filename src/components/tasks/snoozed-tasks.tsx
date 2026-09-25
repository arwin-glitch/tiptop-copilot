'use client';

import * as React from 'react';
import Link from 'next/link';
import { TaskControls, UnsnoozeTaskButton } from '@/components/today/today-actions';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/feedback';
import { useFocusAfterRemoval } from './use-row-focus';

/** A snoozed task as the server prepared it: the wake line already worked out. */
export interface SnoozedTaskItem {
  id: string;
  title: string;
  detail: string | null;
  href: string | null;
  suggested: boolean;
  /** "Wakes Sep 29, 9:14 AM · 4d from now", or "No wake date". */
  wakeLabel: string;
  /** "Due 1d from now, before it wakes", flagged when the deadline comes first. */
  due: { text: string; beforeWake: boolean } | null;
  snoozedUntil: string | null;
}

/** The Snoozed tab: tasks still asleep, soonest to wake first. */
export function SnoozedTasks({ items }: { items: SnoozedTaskItem[] }) {
  const root = React.useRef<HTMLDivElement>(null);
  const leaving = useFocusAfterRemoval(items, root);

  if (items.length === 0) {
    return (
      <div ref={root}>
        <EmptyState
          title="Nothing snoozed"
          description="Snoozed tasks wait here until their wake date."
        />
      </div>
    );
  }

  return (
    <div ref={root}>
      <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)]">
        {items.map((item, index) => (
          <li
            key={item.id}
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
              <p className="mt-1 text-xs text-[var(--fg-subtle)]">{item.wakeLabel}</p>
              {item.due ? (
                <p
                  className={
                    item.due.beforeWake
                      ? 'mt-0.5 text-xs font-medium text-[var(--danger)]'
                      : 'mt-0.5 text-xs text-[var(--fg-subtle)]'
                  }
                >
                  {item.due.text}
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <UnsnoozeTaskButton
                taskId={item.id}
                title={item.title}
                snoozedUntil={item.snoozedUntil}
                onDone={() => leaving(item.id, index)}
              />
              <TaskControls
                taskId={item.id}
                restore={{ status: 'snoozed', snoozedUntil: item.snoozedUntil }}
                snooze={false}
                onDone={() => leaving(item.id, index)}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
