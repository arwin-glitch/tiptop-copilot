'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { BadgeCheck, ExternalLink, MailCheck, MailQuestionMark } from 'lucide-react';
import { confirmTaskProofAction } from '@/app/actions';
import { useReportRefresh } from '@/components/shell/refresh-status';
import { ReopenTaskButton } from '@/components/today/today-actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ThreadLinksForHref } from '@/components/email/thread-links';
import type { ProofCheckView } from '@/lib/tasks/proof';
import { CompanyChip, type TaskCompanyChip } from './company-chip';

/**
 * The proof check for tasks ticked by hand, as people see it: a quiet "Seen
 * sent" note when the deliverable showed up, and, when it never did, a
 * "Ticked, not seen sent" chip with two choices. "It's done" vouches for it
 * and clears the flag for good; "Reopen" puts the task back on To do. The
 * app only points: neither happens on its own.
 */

/** The note under a Completed row's title: "Seen sent · …" or the flag and why. */
export function ProofCheckNote({ view }: { view: ProofCheckView | null | undefined }) {
  if (!view) return null;
  if (view.state === 'seen') {
    return (
      <p className="mt-1 flex items-start gap-1.5 text-xs text-[var(--fg-subtle)]">
        <MailCheck className="mt-px size-3.5 shrink-0" aria-hidden="true" />
        {/* The sent email, in Kraken or in Gmail. */}
        <ThreadLinksForHref
          href={view.href}
          text={view.label}
          label={view.label}
          variant="text"
          fallback={
            view.href ? (
              <a
                href={view.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 underline decoration-dotted underline-offset-2 hover:decoration-solid"
              >
                {view.label}
                <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            ) : (
              <span>{view.label}</span>
            )
          }
        />
      </p>
    );
  }
  return (
    <div className="mt-1.5">
      <Badge tone="warn" data-proof-flag="">
        <MailQuestionMark className="size-3" aria-hidden="true" />
        {view.label}
      </Badge>
      <p className="mt-1 text-xs text-[var(--fg-muted)]">{view.detail}</p>
    </div>
  );
}

/** "It's done": the person vouches for the deliverable; the flag goes for good. */
export function ConfirmProofButton({
  taskId,
  title,
  onDone,
}: {
  taskId: string;
  title: string;
  onDone?: () => void;
}) {
  const [pending, startTransition] = React.useTransition();
  const reportRefresh = useReportRefresh(pending);
  const router = useRouter();
  return (
    <Button
      variant="secondary"
      size="sm"
      loading={pending}
      aria-label={`It's done: ${title}`}
      onClick={() => {
        reportRefresh();
        startTransition(async () => {
          const result = await confirmTaskProofAction(taskId);
          if (result.ok) {
            toast.success('Marked as done');
            onDone?.();
            router.refresh();
          } else {
            toast.error(result.error?.message ?? 'That did not work');
          }
        });
      }}
    >
      <BadgeCheck aria-hidden="true" />
      It&apos;s done
    </Button>
  );
}

export interface NotSeenSentItem {
  id: string;
  title: string;
  href: string | null;
  company: TaskCompanyChip | null;
  /** "Ticked Oct 14 · no email to Riley seen since". */
  detail: string;
}

/** How many flagged tasks Today's card lists; the rest are on Tasks → Completed. */
const SHOWN = 3;

/**
 * Today's small "Ticked, not seen sent" card, outside Top priorities, only
 * when something is flagged. Each line has "It's done" and "Reopen".
 */
export function NotSeenSentCard({ items }: { items: NotSeenSentItem[] }) {
  if (items.length === 0) return null;
  const shown = items.slice(0, SHOWN);
  const more = items.length - shown.length;
  return (
    <section aria-labelledby="not-seen-sent-heading" className="mb-6" data-tour="today-proof">
      <Card className="px-3.5 pt-3 pb-2.5 sm:px-4">
        <div className="mb-1 flex items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--warn-soft)] text-[var(--warn)]">
            <MailQuestionMark className="size-3.5" aria-hidden="true" />
          </span>
          <h2 id="not-seen-sent-heading" className="text-title font-semibold">
            Ticked, not seen sent{' '}
            <span className="tabular font-sans text-sm font-normal text-[var(--fg-subtle)]">
              · {items.length}
            </span>
          </h2>
        </div>
        <p className="mb-1 pl-9 text-xs text-[var(--fg-subtle)]">
          Ticked off, but nothing was seen going out after two working days.
        </p>
        <ul className="divide-y divide-[var(--border)]">
          {shown.map((item) => (
            <li
              key={item.id}
              className="flex flex-col gap-2 py-2 pl-9 sm:flex-row sm:items-start sm:justify-between sm:gap-3"
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
                  <CompanyChip company={item.company} />
                </p>
                <p className="mt-0.5 text-xs text-[var(--fg-muted)]">{item.detail}</p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-1">
                <ConfirmProofButton taskId={item.id} title={item.title} />
                <ReopenTaskButton taskId={item.id} title={item.title} />
              </div>
            </li>
          ))}
        </ul>
        {more > 0 ? (
          <Link
            href="/tasks?view=completed"
            className="mt-1 inline-block pl-9 text-xs font-medium text-[var(--accent)] underline-offset-2 hover:underline"
          >
            +{more} more on Completed
          </Link>
        ) : null}
      </Card>
    </section>
  );
}
