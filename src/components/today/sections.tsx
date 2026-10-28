'use client';

import * as React from 'react';
import Link from 'next/link';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/util/cn';
import { CitationList, SourceDrawer } from '@/components/evidence/source-drawer';
import { ThreadLinks } from '@/components/email/thread-links';
import { emailIdFromInboxHref } from '@/lib/email/thread-links';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { BriefItem, Citation } from '@/lib/types/domain';

/**
 * Collapsible Today sections.
 *
 * Closed by default below the fold so the outlook stays a thirty-second read;
 * the underlying content is always in the DOM so it is searchable and
 * screen-reader accessible without an extra round trip.
 */
export function ExpandableSection({
  title,
  count,
  children,
  defaultOpen = false,
  emptyLabel,
  action,
  note,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
  defaultOpen?: boolean;
  emptyLabel?: string;
  action?: React.ReactNode;
  /** A short line beside the count, readable while the section is closed. */
  note?: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  const id = React.useId();

  if (count === 0 && emptyLabel) {
    return (
      <section className="border-b border-[var(--border)] py-3 last:border-b-0">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="font-serif text-base font-semibold text-[var(--fg-muted)]">{title}</h2>
          <span className="text-sm text-[var(--fg-subtle)]">{emptyLabel}</span>
        </div>
      </section>
    );
  }

  return (
    <section className="border-b border-[var(--border)] py-1 last:border-b-0">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={id}
          className="flex flex-1 items-center gap-2 py-3 text-left"
        >
          <ChevronDown
            className={cn(
              'size-4 shrink-0 text-[var(--fg-subtle)] transition-transform',
              open && 'rotate-180',
            )}
            aria-hidden="true"
          />
          <h2 className="font-serif text-base font-semibold">{title}</h2>
          <span className="tabular text-sm text-[var(--fg-subtle)]">{count}</span>
          {note}
        </button>
        {action}
      </div>
      <div id={id} hidden={!open} className="pb-4 pl-6">
        {children}
      </div>
    </section>
  );
}

export function BriefItemRow({
  item,
  citations,
  trailing,
}: {
  item: BriefItem;
  citations: Citation[];
  trailing?: React.ReactNode;
}) {
  const emailId = emailIdFromInboxHref(item.href);
  return (
    <div className="flex items-start justify-between gap-3 border-b border-[var(--border)] py-2.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {item.href && !emailId ? (
            <Link href={item.href} className="underline-offset-2 hover:underline">
              {item.title}
            </Link>
          ) : (
            item.title
          )}
          {item.is_suggestion ? (
            <Badge tone="outline" className="ml-2">
              Suggestion
            </Badge>
          ) : null}
        </p>
        <p className="mt-1 text-sm text-[var(--fg-muted)]">{item.detail}</p>
        {/* An email item: in Kraken's Inbox or in Gmail. */}
        <ThreadLinks
          id={emailId}
          mailbox={null}
          label={item.title}
          variant="text"
          className="mt-1"
        />
        <div className="mt-1.5">
          <CitationList
            ids={item.citation_ids}
            citations={citations}
            emptyLabel={item.is_suggestion ? 'Not from a record' : 'No source'}
          />
        </div>
      </div>
      {trailing}
    </div>
  );
}

export function OpenSourcesButton({
  citations,
  label = 'Open sources',
}: {
  citations: Citation[];
  label?: string;
}) {
  return (
    <SourceDrawer citations={citations}>
      <Button variant="ghost" size="sm">
        {label}
        <span className="tabular ml-1 text-[var(--fg-subtle)]">{citations.length}</span>
      </Button>
    </SourceDrawer>
  );
}
