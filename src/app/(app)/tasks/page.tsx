import type { Metadata } from 'next';
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { requireAuth } from '@/lib/auth/session';
import { dueAndOverdue, listTasks } from '@/lib/services/tasks';
import { listDrafts } from '@/lib/services/drafts';
import { PageHeader, PageShell, SectionHeading } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState, PlainText } from '@/components/ui/feedback';
import { CreateFollowUpButton, TaskControls } from '@/components/today/today-actions';
import type { Task } from '@/lib/types/domain';
import { relativeTime } from '@/lib/util/time';

export const metadata: Metadata = { title: 'Tasks' };
export const dynamic = 'force-dynamic';

export default async function TasksPage() {
  const auth = await requireAuth();
  const now = new Date();

  const [{ overdue, dueToday, upcoming }, completed, drafts] = await Promise.all([
    dueAndOverdue(auth.organizationId, now),
    listTasks(auth.organizationId, { status: 'complete' }),
    listDrafts(auth.organizationId, { limit: 20 }),
  ]);

  const nothing = overdue.length + dueToday.length + upcoming.length === 0;

  return (
    <PageShell>
      <PageHeader
        title="Tasks and drafts"
        subtitle="Follow-ups you owe someone, and the drafts waiting for you to send them yourself."
        actions={<CreateFollowUpButton variant="primary" label="New follow-up" />}
      />

      {nothing ? (
        <EmptyState
          title="Nothing outstanding"
          description="Create a follow-up, or generate one from a deal's diligence questions."
          action={{ label: 'Go to Deals', href: '/deals' }}
        />
      ) : (
        <div className="space-y-8">
          {overdue.length > 0 ? (
            <section>
              <SectionHeading count={overdue.length}>
                <span className="flex items-center gap-2 text-[var(--danger)]">
                  <AlertTriangle className="size-4" aria-hidden="true" />
                  Overdue
                </span>
              </SectionHeading>
              <TaskList tasks={overdue} now={now} overdue />
            </section>
          ) : null}

          {dueToday.length > 0 ? (
            <section>
              <SectionHeading count={dueToday.length}>Due today</SectionHeading>
              <TaskList tasks={dueToday} now={now} />
            </section>
          ) : null}

          {upcoming.length > 0 ? (
            <section>
              <SectionHeading count={upcoming.length}>Upcoming</SectionHeading>
              <TaskList tasks={upcoming} now={now} />
            </section>
          ) : null}
        </div>
      )}

      {drafts.length > 0 ? (
        <section className="mt-10">
          <SectionHeading count={drafts.length}>Drafts</SectionHeading>
          <p className="-mt-2 mb-3 text-sm text-[var(--fg-muted)]">
            Every draft is unsent. This product has no send capability and requests no send
            permission — copy a draft into your mail client to send it.
          </p>
          <ul className="space-y-3">
            {drafts.map((d) => (
              <li key={d.id}>
                <Card>
                  <CardContent className="pt-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-medium">{d.subject}</p>
                      <div className="flex items-center gap-2">
                        <Badge tone="outline">{d.kind.replace(/_/g, ' ')}</Badge>
                        <Badge tone="neutral">Not sent</Badge>
                      </div>
                    </div>
                    {d.to_addresses.length > 0 ? (
                      <p className="mt-0.5 text-xs text-[var(--fg-subtle)]">
                        To: {d.to_addresses.join(', ')}
                      </p>
                    ) : null}
                    <PlainText text={d.body} className="mt-2 text-[var(--fg-muted)]" maxLines={5} />
                    {d.deal_id ? (
                      <Link
                        href={`/deals/${d.deal_id}`}
                        className="mt-2 inline-block text-xs text-[var(--accent)] underline-offset-2 hover:underline"
                      >
                        Open deal
                      </Link>
                    ) : null}
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {completed.length > 0 ? (
        <section className="mt-10">
          <SectionHeading count={completed.length}>Completed</SectionHeading>
          <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)]">
            {completed.slice(0, 20).map((t) => (
              <li key={t.id} className="px-4 py-2.5">
                <p className="text-sm text-[var(--fg-muted)] line-through">{t.title}</p>
                {t.completed_at ? (
                  <p className="text-xs text-[var(--fg-subtle)]">
                    Completed {relativeTime(t.completed_at, now)}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </PageShell>
  );
}

function TaskList({ tasks, now, overdue }: { tasks: Task[]; now: Date; overdue?: boolean }) {
  return (
    <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)]">
      {tasks.map((task) => (
        <li key={task.id} className="flex items-start justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">
              {task.deal_id ? (
                <Link
                  href={`/deals/${task.deal_id}`}
                  className="underline-offset-2 hover:underline"
                >
                  {task.title}
                </Link>
              ) : task.portfolio_company_id ? (
                <Link
                  href={`/portfolio/${task.portfolio_company_id}`}
                  className="underline-offset-2 hover:underline"
                >
                  {task.title}
                </Link>
              ) : (
                task.title
              )}
              {task.source === 'suggested' ? (
                <Badge tone="outline" className="ml-2">
                  Suggested
                </Badge>
              ) : null}
            </p>
            {task.detail ? (
              <p className="mt-0.5 text-sm text-[var(--fg-muted)]">{task.detail}</p>
            ) : null}
            {task.due_at ? (
              <p
                className={
                  overdue
                    ? 'mt-1 text-xs font-medium text-[var(--danger)]'
                    : 'mt-1 text-xs text-[var(--fg-subtle)]'
                }
              >
                {overdue ? 'Overdue — was due ' : 'Due '}
                {relativeTime(task.due_at, now)}
              </p>
            ) : (
              <p className="mt-1 text-xs text-[var(--fg-subtle)]">No due date</p>
            )}
          </div>
          <TaskControls taskId={task.id} />
        </li>
      ))}
    </ul>
  );
}
