import type { Metadata } from 'next';
import Link from 'next/link';
import { after } from 'next/server';
import { AlertTriangle } from 'lucide-react';
import { requireAuth } from '@/lib/auth/session';
import { dueAndOverdue, listCompletedTasks, listSnoozedTasks } from '@/lib/services/tasks';
import { listDrafts } from '@/lib/services/drafts';
import { getStore } from '@/lib/runtime';
import {
  autoCheckStatusLine,
  autoCloseInfo,
  autoCloseView,
  linkMailbox,
} from '@/lib/services/task-close';
import { getTaskRelayStatus, pullTaskRelays, readTasksVersion } from '@/lib/services/task-relay';
import { PageHeader, PageShell, SectionHeading } from '@/components/shell/page-header';
import { VersionWatcher } from '@/components/shell/version-watcher';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState, PlainText } from '@/components/ui/feedback';
import { CreateFollowUpButton, TaskControls } from '@/components/today/today-actions';
import { CompletedTasks, type CompletedTaskItem } from '@/components/tasks/completed-tasks';
import { SnoozedTasks, type SnoozedTaskItem } from '@/components/tasks/snoozed-tasks';
import { TasksTabs } from '@/components/tasks/tasks-tabs';
import {
  completedAt,
  completedGroup,
  completedLabel,
  snoozedDueLabel,
  sortCompleted,
  taskHref,
  wakeLabel,
} from '@/lib/tasks/tasks-view';
import type { Task } from '@/lib/types/domain';
import { settlesWithin } from '@/lib/util/settle';
import { relativeTime } from '@/lib/util/time';

export const metadata: Metadata = { title: 'Tasks' };
export const dynamic = 'force-dynamic';

/** How long the page waits for the relay pull before listing what is stored. */
const PULL_BUDGET_MS = 8_000;

export default async function TasksPage() {
  const auth = await requireAuth();
  const store = getStore();
  const orgId = auth.organizationId;

  // New suggested tasks, closes the task-closer posted, the 4pm "Reply to"
  // check and the snapshot, before listing. Bounded: if Slack is slow the page
  // lists what is stored and the pull finishes after the response, for the
  // open-tab watcher to pick up.
  const pull = pullTaskRelays(store, orgId).catch(() => null);
  if (!(await settlesWithin(pull, PULL_BUDGET_MS))) {
    after(async () => {
      await pull;
    });
  }

  const now = new Date();
  const [{ overdue, dueToday, upcoming }, snoozedTasks, completed, drafts] = await Promise.all([
    dueAndOverdue(orgId, now),
    listSnoozedTasks(orgId, now),
    listCompletedTasks(orgId),
    listDrafts(orgId, { limit: 20 }),
  ]);
  const [autos, mailbox, version] = await Promise.all([
    autoCloseInfo(
      store,
      orgId,
      completed.map((task) => task.id),
    ),
    linkMailbox(store, orgId),
    readTasksVersion(store, orgId, now),
  ]);
  const statusLine = autoCheckStatusLine(
    getTaskRelayStatus(orgId).lastRun,
    now,
    auth.profile.timezone,
  );

  const openCount = overdue.length + dueToday.length + upcoming.length;
  const nothing = openCount === 0;
  const completedItems: CompletedTaskItem[] = sortCompleted(completed).map((task) => {
    const at = completedAt(task);
    const group = completedGroup(at, now, auth.profile.timezone);
    const auto = autos.get(task.id);
    return {
      id: task.id,
      title: task.title,
      detail: task.detail,
      href: taskHref(task),
      suggested: task.source === 'suggested',
      completedLabel: completedLabel(at, group, now, auth.profile.timezone),
      group,
      ...(auto ? { auto: autoCloseView(auto, auth.profile.timezone, mailbox) } : {}),
    };
  });
  const snoozedItems: SnoozedTaskItem[] = snoozedTasks.map((task) => ({
    id: task.id,
    title: task.title,
    detail: task.detail,
    href: taskHref(task),
    suggested: task.source === 'suggested',
    wakeLabel: wakeLabel(task.snoozed_until, now, auth.profile.timezone),
    due: snoozedDueLabel(task.due_at, task.snoozed_until, now),
    snoozedUntil: task.snoozed_until,
  }));

  const todo = (
    <>
      {statusLine ? (
        <p className="-mt-2 mb-4 text-xs text-[var(--fg-subtle)]">{statusLine}</p>
      ) : null}
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
    </>
  );

  return (
    <PageShell>
      <PageHeader
        title="Tasks and drafts"
        subtitle="Follow-ups you owe someone, and the drafts waiting for you to send them yourself."
        actions={<CreateFollowUpButton variant="primary" label="New follow-up" />}
      />
      <VersionWatcher version={version} endpoint="/api/tasks/version" />
      <TasksTabs
        todoCount={openCount}
        snoozedCount={snoozedItems.length}
        completedCount={completedItems.length}
        todo={todo}
        snoozed={<SnoozedTasks items={snoozedItems} />}
        completed={<CompletedTasks items={completedItems} />}
      />
    </PageShell>
  );
}

function TaskList({ tasks, now, overdue }: { tasks: Task[]; now: Date; overdue?: boolean }) {
  return (
    <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)]">
      {tasks.map((task) => (
        <li key={task.id} className="flex items-start justify-between gap-3 px-4 py-3">
          <div className="min-w-0 break-words">
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
