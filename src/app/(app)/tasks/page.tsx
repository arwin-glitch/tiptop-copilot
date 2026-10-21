import type { Metadata } from 'next';
import Link from 'next/link';
import { after } from 'next/server';
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
import {
  moneyLegalBadges,
  needsProofView,
  proofView,
  readMoneyLegal,
  readTaskPeople,
} from '@/lib/services/money-legal';
import { getTaskRelayStatus, pullTaskRelays, readTasksVersion } from '@/lib/services/task-relay';
import { PageHeader, PageShell, SectionHeading } from '@/components/shell/page-header';
import { VersionWatcher } from '@/components/shell/version-watcher';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState, PlainText } from '@/components/ui/feedback';
import { CreateFollowUpButton, type TaskControlsTask } from '@/components/today/today-actions';
import { CompletedTasks, type CompletedTaskItem } from '@/components/tasks/completed-tasks';
import { MoneyLegalTasks, type MoneyLegalItem } from '@/components/tasks/money-legal-tasks';
import { SnoozedTasks, type SnoozedTaskItem } from '@/components/tasks/snoozed-tasks';
import { TasksTabs } from '@/components/tasks/tasks-tabs';
import { TodoTasks, type TodoTaskItem } from '@/components/tasks/todo-tasks';
import {
  completedAt,
  completedGroup,
  completedLabel,
  snoozedDueLabel,
  sortCompleted,
  taskHref,
  wakeLabel,
} from '@/lib/tasks/tasks-view';
import { personShort } from '@/lib/tasks/task-people';
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

  // New suggested tasks, closes the task-closer posted, the 3pm "Reply to"
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
  const openTasks = [...overdue, ...dueToday, ...upcoming];
  const [autos, mailbox, version, money, people] = await Promise.all([
    autoCloseInfo(
      store,
      orgId,
      completed.map((task) => task.id),
    ),
    linkMailbox(store, orgId),
    readTasksVersion(store, orgId, now),
    // Never throws: a fault here hides the money and legal marks, not the page.
    readMoneyLegal(store, orgId, [...openTasks, ...snoozedTasks, ...completed]),
    readTaskPeople(orgId, store),
  ]);
  const timeZone = auth.profile.timezone;
  // Names on rows only when there is more than one person to tell apart.
  const assignee = (task: Task) =>
    people.length > 1 ? personShort(people, task.assigned_to) : null;
  const controls = (task: Task): TaskControlsTask => ({
    title: task.title,
    detail: task.detail,
    dueAt: task.due_at,
    assignedTo: task.assigned_to,
    moneyLegal: Boolean(money.states.get(task.id)?.on),
  });
  const badges = (task: Task, asleep: boolean) => {
    const marks = moneyLegalBadges(task, money.states.get(task.id), now, asleep);
    return marks ? { ...marks, needsProof: money.claims.has(task.id) } : null;
  };
  const proofOf = (task: Task) => {
    const proof = money.proofs.get(task.id);
    return proof ? { ...proofView(proof, people), auto: false } : undefined;
  };
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
      ...(proofOf(task) ? { proof: proofOf(task) } : {}),
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
    money: badges(task, true),
    controls: controls(task),
  }));

  const todoItem = (task: Task, section: TodoTaskItem['section']): TodoTaskItem => ({
    id: task.id,
    title: task.title,
    detail: task.detail,
    href: taskHref(task),
    suggested: task.source === 'suggested',
    section,
    dueLabel: dueLine(task, now),
    assignee: assignee(task),
    assignedTo: task.assigned_to,
    money: badges(task, false),
    controls: controls(task),
  });
  const todoItems: TodoTaskItem[] = [
    ...overdue.map((task) => todoItem(task, 'overdue')),
    ...dueToday.map((task) => todoItem(task, 'today')),
    ...upcoming.map((task) => todoItem(task, 'upcoming')),
  ];

  // Money & legal: needs proof, then open (overdue and soonest due first, as
  // on To do, then the snoozed ones), then the newest closed.
  const onMoney = (task: Task) => Boolean(money.states.get(task.id)?.on);
  const asleepIds = new Set(snoozedTasks.map((task) => task.id));
  const moneyOpen = [...openTasks, ...snoozedTasks].filter(onMoney);
  const moneyClosed = sortCompleted(completed.filter(onMoney));
  const moneyItems: MoneyLegalItem[] = [
    ...moneyOpen.map((task): MoneyLegalItem => {
      const asleep = asleepIds.has(task.id);
      const claim = money.claims.get(task.id);
      return {
        id: task.id,
        title: task.title,
        detail: task.detail,
        href: taskHref(task),
        suggested: task.source === 'suggested',
        group: claim ? 'needs_proof' : 'open',
        when: asleep ? wakeLabel(task.snoozed_until, now, timeZone) : dueLine(task, now),
        whenDanger: !asleep && isPastDue(task, now),
        assignee: assignee(task),
        assignedTo: task.assigned_to,
        money: badges(task, asleep) ?? { why: '', stale: null, needsProof: false },
        claim: claim ? needsProofView(claim, timeZone) : null,
        proof: null,
        restore: asleep
          ? { status: 'snoozed', snoozedUntil: task.snoozed_until }
          : { status: 'open' },
        controls: controls(task),
      };
    }),
    ...moneyClosed.slice(0, MONEY_CLOSED_SHOWN).map((task): MoneyLegalItem => {
      const at = completedAt(task);
      const group = completedGroup(at, now, timeZone);
      const auto = autos.get(task.id);
      const autoView = auto ? autoCloseView(auto, timeZone, mailbox) : null;
      return {
        id: task.id,
        title: task.title,
        detail: task.detail,
        href: taskHref(task),
        suggested: task.source === 'suggested',
        group: 'closed',
        when: completedLabel(at, group, now, timeZone),
        whenDanger: false,
        assignee: assignee(task),
        assignedTo: task.assigned_to,
        money: { why: '', stale: null, needsProof: false },
        claim: null,
        proof:
          proofOf(task) ??
          (autoView
            ? { label: autoView.label, href: autoView.href, note: autoView.reason, auto: true }
            : null),
        restore: { status: 'open' },
        controls: controls(task),
      };
    }),
  ];
  const moneyCount = moneyOpen.length;

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
        <TodoTasks items={todoItems} />
      )}

      {drafts.length > 0 ? (
        <section className="mt-10">
          <SectionHeading count={drafts.length}>Drafts</SectionHeading>
          <p className="-mt-2 mb-3 text-sm text-[var(--fg-muted)]">
            Every draft is unsent. Nothing sends on its own — copy a draft into your mail client to
            send it.
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
        title="Tasks"
        subtitle="Things you owe someone. Who you are waiting on, and who is waiting on you, are on Follow-ups."
        actions={<CreateFollowUpButton variant="primary" label="New follow-up" />}
      />
      <VersionWatcher version={version} endpoint="/api/tasks/version" />
      <TasksTabs
        todoCount={openCount}
        snoozedCount={snoozedItems.length}
        completedCount={completedItems.length}
        moneyCount={moneyCount}
        todo={todo}
        snoozed={<SnoozedTasks items={snoozedItems} />}
        completed={<CompletedTasks items={completedItems} />}
        money={<MoneyLegalTasks items={moneyItems} closedTotal={moneyClosed.length} />}
        people={people}
      />
    </PageShell>
  );
}

/** How many closed money and legal tasks the tab shows; the rest are on Completed. */
const MONEY_CLOSED_SHOWN = 5;

function isPastDue(task: Task, now: Date): boolean {
  const due = task.due_at ? Date.parse(task.due_at) : Number.NaN;
  return !Number.isNaN(due) && due < now.getTime();
}

/** "Overdue — was due 2d ago", "Due 1d from now" or "No due date". */
function dueLine(task: Task, now: Date): string {
  if (!task.due_at) return 'No due date';
  return isPastDue(task, now)
    ? `Overdue — was due ${relativeTime(task.due_at, now)}`
    : `Due ${relativeTime(task.due_at, now)}`;
}
