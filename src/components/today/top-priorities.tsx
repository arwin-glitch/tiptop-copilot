import Link from 'next/link';
import { ExternalLink, ListChecks } from 'lucide-react';
import { gmailThreadUrl } from '@/lib/deals/links';
import { DEFAULT_MAILBOX } from '@/lib/services/task-close';
import type { Priorities } from '@/lib/services/follow-ups';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { relativeTime } from '@/lib/util/time';

const KIND: Record<
  Priorities['items'][number]['kind'],
  { label: string; tone: BadgeProps['tone'] }
> = {
  money: { label: 'Money', tone: 'danger' },
  reply: { label: 'Reply', tone: 'warn' },
  meeting: { label: 'Meeting', tone: 'info' },
  deal: { label: 'Deal', tone: 'info' },
  portfolio: { label: 'Portfolio', tone: 'ok' },
  other: { label: 'Other', tone: 'neutral' },
};

/**
 * The ranked list the morning brief and afternoon checkpoint post: what to do
 * first, one line each. Plain text only; the only link is rebuilt from a
 * validated Gmail thread id.
 */
export function TopPrioritiesCard({ priorities, now }: { priorities: Priorities; now: Date }) {
  if (priorities.items.length === 0) return null;
  return (
    <Card className="mb-6">
      <CardHeader>
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[var(--accent)]">
            <ListChecks className="size-4" aria-hidden />
          </span>
          <div>
            <CardTitle>Top priorities</CardTitle>
            <p className="text-xs text-[var(--fg-subtle)]">
              From the {priorities.source === 'morning' ? 'morning brief' : 'afternoon checkpoint'},{' '}
              {relativeTime(priorities.run_at, now)}
            </p>
          </div>
        </div>
        <Link
          href="/follow-ups"
          className="text-xs text-[var(--accent)] underline-offset-2 hover:underline"
        >
          Follow-ups
        </Link>
      </CardHeader>
      <CardContent>
        <ol className="space-y-2.5">
          {priorities.items.map((item, i) => {
            const href = item.thread_id ? gmailThreadUrl(item.thread_id, DEFAULT_MAILBOX) : null;
            const kind = KIND[item.kind];
            return (
              <li key={`${i}-${item.title}`} className="flex items-start gap-3">
                <span className="tabular mt-0.5 w-4 shrink-0 text-right text-sm font-semibold text-[var(--fg-subtle)]">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{item.title}</span>
                    <Badge tone={kind.tone}>{kind.label}</Badge>
                  </div>
                  <p className="text-sm text-[var(--fg-muted)]">{item.why}</p>
                </div>
                {href ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Open "${item.title}" in Gmail`}
                    className="mt-0.5 text-[var(--accent)]"
                  >
                    <ExternalLink className="size-3.5" aria-hidden />
                  </a>
                ) : null}
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}
