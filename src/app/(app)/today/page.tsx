import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { after } from 'next/server';
import { AlertTriangle, ArrowRight, Calendar, Mail } from 'lucide-react';
import { requireAuth, type AuthContext } from '@/lib/auth/session';
import { getAI, getStore } from '@/lib/runtime';
import {
  briefingVersion,
  getCurrentBrief,
  getCurrentDossier,
  pullBriefingsFromSlack,
} from '@/lib/services/briefing';
import { gatherTodayData, generateDailyBrief, getTodaysBrief } from '@/lib/services/brief';
import { getTaskRelayStatus, pullTaskRelays } from '@/lib/services/task-relay';
import { readTodayGlance } from '@/lib/services/task-glance';
import { readAffinityExitTodayLine } from '@/lib/services/affinity-exit';
import { readMoneyLegal, readTaskPeople } from '@/lib/services/money-legal';
import { readFollowUps, todayLead } from '@/lib/services/follow-ups';
import { classifyMeeting, meetingFromStoredEvent } from '@/lib/calendar/meetings';
import { emailIdFromInboxHref, emailLinkId } from '@/lib/email/thread-links';
import { autoCheckStatusLine, DEFAULT_MAILBOX, gmailMessageHref } from '@/lib/services/task-close';
import { proofCheckView, readFlaggedProofTasks } from '@/lib/services/task-proof';
import { readTaskCompanies } from '@/lib/services/task-company';
import { taskHref } from '@/lib/tasks/tasks-view';
import { todayGlanceCards } from '@/lib/tasks/glance';
import { isAutoAsk, requestLabel } from '@/lib/portfolio/requests';
import { PageHeader, PageShell } from '@/components/shell/page-header';
import { Card, CardContent, CardHeader, CardTitle, FieldLabel } from '@/components/ui/card';
import { Badge, RecommendationBadge } from '@/components/ui/badge';
import { EmptyState, Notice, SkeletonText } from '@/components/ui/feedback';
import { Button } from '@/components/ui/button';
import { GeneratedMeta } from '@/components/evidence/source-drawer';
import { BriefItemRow, ExpandableSection, OpenSourcesButton } from '@/components/today/sections';
import { RoutineBriefingCard } from '@/components/today/briefing-summary';
import { TopPrioritiesCard } from '@/components/today/top-priorities';
import { BriefingWatcher } from '@/components/today/briefing-watcher';
import { WelcomeBack } from '@/components/today/welcome-back';
import { TodayGlance } from '@/components/today/today-glance';
import { AffinityExitLine } from '@/components/today/affinity-exit-line';
import { CompanyChip } from '@/components/tasks/company-chip';
import { ThreadLinks } from '@/components/email/thread-links';
import { NotSeenSentCard, type NotSeenSentItem } from '@/components/tasks/proof-check';
import {
  CreateFollowUpButton,
  RefreshOutlookButton,
  TaskControls,
} from '@/components/today/today-actions';
import { formatTime, formatWeekdayLong, isOverdue, relativeTime } from '@/lib/util/time';
import { cn } from '@/lib/util/cn';
import type { Citation } from '@/lib/types/domain';

export const metadata: Metadata = { title: 'Today' };
export const dynamic = 'force-dynamic';

export default async function TodayPage() {
  // The header renders outside the Suspense boundary, like every other page's:
  // it needs only the signed-in profile, so the forest-green band and its gold
  // hairline are there from the first paint instead of snapping in (and pushing
  // the page down) once the brief and the Slack pulls finish.
  const auth = await requireAuth();
  const now = new Date();
  const firstName = auth.profile.full_name?.split(' ')[0] ?? 'there';
  const aiAvailable = getAI().available();
  return (
    <PageShell>
      <PageHeader
        eyebrow={formatWeekdayLong(now, auth.profile.timezone)}
        title={`Good day, ${firstName}`}
        subtitle="What matters, why it matters, and what to do about it."
        actions={
          <>
            {/* Both of these are model calls. With no provider connected they
                would fail on click, so they are absent rather than offered —
                an action that cannot succeed is not an action. */}
            {aiAvailable ? (
              <>
                <Button asChild variant="secondary" size="sm" data-tour="today-ask">
                  <Link href="/ask?q=What%20actually%20needs%20my%20attention%20today%3F">
                    Ask about today
                  </Link>
                </Button>
                <RefreshOutlookButton />
              </>
            ) : null}
            <CreateFollowUpButton timeZone={auth.profile.timezone} />
          </>
        }
      />
      <Suspense fallback={<TodaySkeleton />}>
        <TodayContent auth={auth} now={now} aiAvailable={aiAvailable} />
      </Suspense>
    </PageShell>
  );
}

function TodaySkeleton() {
  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="pt-5">
          <SkeletonText lines={4} />
        </CardContent>
      </Card>
      <SkeletonText lines={6} />
    </div>
  );
}

async function TodayContent({
  auth,
  now,
  aiAvailable,
}: {
  auth: AuthContext;
  now: Date;
  aiAvailable: boolean;
}) {
  const data = await gatherTodayData(auth, now);
  // Task additions and closes waiting in Slack (and the 3pm reply check), after
  // the response: Today only lists due tasks, and the next view shows the result.
  after(async () => {
    await pullTaskRelays(getStore(), auth.organizationId).catch(() => null);
  });
  // Best-effort: a briefing-store fault (e.g. a pending migration) must never
  // take down the rest of the page, which is otherwise fully self-contained.
  // Pull any routine post that is waiting in the Slack relay first, so a card
  // posted a minute ago shows now rather than after the next scheduled sync.
  await pullBriefingsFromSlack(getStore(), auth.organizationId).catch(() => 0);
  const dueTasks = [...data.overdueTasks, ...data.dueTodayTasks];
  const [routineBrief, routineDossier, followUps, glance, affinityExit, money, people, flagged] =
    await Promise.all([
      getCurrentBrief(getStore(), auth.organizationId).catch(() => null),
      getCurrentDossier(getStore(), auth.organizationId).catch(() => null),
      // Same rule as the briefings: a Slack fault only hides the card.
      readFollowUps(getStore(), auth.organizationId, { now }).catch(() => null),
      // And a store fault only hides the glance cards.
      readTodayGlance(getStore(), auth.organizationId, {
        now,
        timeZone: auth.profile.timezone,
      }).catch(() => null),
      // The Affinity exit reminder: a line in the last two weeks before the
      // notice date, and nothing at all on a fault.
      readAffinityExitTodayLine(getStore(), auth.organizationId, now, auth.profile.timezone).catch(
        () => null,
      ),
      // The row menus' money marks and people. Neither throws: a fault only
      // leaves the menus plainer.
      readMoneyLegal(getStore(), auth.organizationId, dueTasks),
      readTaskPeople(auth.organizationId),
      // Ticked tasks whose deliverable was never seen sent. Never throws.
      readFlaggedProofTasks(getStore(), auth.organizationId, now),
    ]);
  // Never throws: a fault only leaves the rows without company chips.
  const companies = await readTaskCompanies(getStore(), auth.organizationId, [
    ...dueTasks,
    ...flagged.map(({ task }) => task),
  ]);
  const notSeenSent: NotSeenSentItem[] = flagged.flatMap(({ task, check }) => {
    const view = proofCheckView(check, {
      timeZone: auth.profile.timezone,
      messageHref: (id) => gmailMessageHref(DEFAULT_MAILBOX, id),
    });
    return view?.state === 'flagged'
      ? [
          {
            id: task.id,
            title: task.title,
            href: taskHref(task),
            company: companies.get(task.id) ?? null,
            detail: view.detail,
          },
        ]
      : [];
  });
  // Top priorities leads the page whenever it has a list. Today's list is the
  // to-do list, so Do now steps aside for it; with no list, or only an older
  // one, all three glance cards show and the page still has a live to-do list.
  const { priorities, hideNow } = todayLead(followUps, {
    now,
    timeZone: auth.profile.timezone,
  });
  const glanceCards = todayGlanceCards(glance, { hideNow });
  const nowListed = glanceCards.includes('now');
  const glanceFootnote =
    autoCheckStatusLine(
      getTaskRelayStatus(auth.organizationId).lastRun,
      now,
      auth.profile.timezone,
    ) ?? 'Unticked items are checked against mail and calendar at 3 PM Central.';

  // Generate on first view of the day so the page is never empty on arrival;
  // an explicit refresh regenerates it.
  //
  // The failure is kept as a code, not just a message, because "no provider is
  // connected" and "the provider returned an error" are different situations
  // for the reader: one is a setting, the other is a fault. Rendering both as
  // the same amber warning made a deliberate configuration look like a bug.
  let brief = await getTodaysBrief(auth, now);
  let briefError: { code: string; message: string } | null = null;
  if (!brief) {
    const generated = await generateDailyBrief(auth, { now });
    if (generated.ok) brief = generated.value;
    else briefError = { code: generated.error.code, message: generated.error.message };
  }

  const citations: Citation[] = brief?.citations ?? [];

  // Today lists only real meetings, judged the same way as the Calendar tab
  // and the 5-minute phone alert; blocks are counted, not listed.
  const judged = data.meetingPrep.map((prep) => ({
    prep,
    verdict: classifyMeeting(meetingFromStoredEvent(prep.event), [auth.profile.email]),
  }));
  const todaysMeetings = judged.filter((j) => j.verdict.meeting);
  const hiddenBlocks = judged.length - todaysMeetings.length;

  const nothingToday =
    data.meetings.length === 0 &&
    data.importantEmails.length === 0 &&
    data.newDeals.length === 0 &&
    data.overdueTasks.length === 0 &&
    data.dueTodayTasks.length === 0 &&
    data.portfolioRequests.length === 0;

  return (
    <>
      <WelcomeBack />

      {priorities ? <TopPrioritiesCard priorities={priorities} now={now} /> : null}

      {glance && glanceCards.length > 0 ? (
        <TodayGlance glance={glance} cards={glanceCards} footnote={glanceFootnote} />
      ) : null}

      {affinityExit ? <AffinityExitLine countdown={affinityExit} /> : null}

      <NotSeenSentCard items={notSeenSent} />

      {routineBrief || routineDossier ? (
        <div
          className={cn(
            'mb-6 grid gap-4',
            routineBrief && routineDossier ? 'sm:grid-cols-2' : 'grid-cols-1',
          )}
        >
          {routineBrief ? <RoutineBriefingCard briefing={routineBrief} now={now} /> : null}
          {routineDossier ? <RoutineBriefingCard briefing={routineDossier} now={now} /> : null}
        </div>
      ) : null}
      <BriefingWatcher version={briefingVersion(routineBrief, routineDossier)} />

      {nothingToday ? (
        <EmptyState
          title="Nothing is competing for your attention"
          description="No meetings, no overdue follow-ups, no new deals and no unread items that need you. Sync your mailbox or add a deal to get started."
          action={{ label: 'Go to Inbox', href: '/inbox' }}
        />
      ) : null}

      {/* A routine briefing already covers "no AI outlook configured" — showing
          both would tell the reader the same thing twice, once as an amber
          warning and once as a working card. A genuine provider fault still
          surfaces regardless, since that's news the briefing doesn't carry. */}
      {/* No in-app model is the normal production setup: the routines' briefing
          cards and Top priorities above are the outlook, so a "not configured"
          notice here would only say a working page is broken. A real provider
          fault still surfaces. */}
      {briefError && briefError.code !== 'not_configured' ? (
        <Notice tone="warn" className="mb-5">
          <p className="font-medium">The outlook could not be generated.</p>
          <p className="mt-1 text-[var(--fg-muted)]">{briefError.message}</p>
          <p className="mt-1 text-[var(--fg-muted)]">
            Everything below is read straight from your records and is unaffected.
          </p>
        </Notice>
      ) : null}

      {brief ? (
        <Card className="mb-6">
          <CardHeader>
            <div className="min-w-0">
              <CardTitle as="h2">Outlook</CardTitle>
              <GeneratedMeta
                className="mt-1.5"
                model={brief.model}
                promptVersion={brief.prompt_version}
                generatedAt={brief.generated_at}
                timeZone={auth.profile.timezone}
              />
            </div>
            <OpenSourcesButton citations={citations} />
          </CardHeader>
          <CardContent>
            <p className="text-[15px] leading-relaxed">{brief.outlook}</p>

            {brief.priorities.length > 0 ? (
              <div className="mt-5">
                <FieldLabel as="h3" className="mb-2">
                  Top {brief.priorities.length}
                </FieldLabel>
                <ol className="space-y-2.5">
                  {brief.priorities.map((item, i) => {
                    // An email priority offers both places to read it, like the brief's rows.
                    const emailId = emailIdFromInboxHref(item.href);
                    return (
                      <li key={item.id} className="flex gap-3">
                        <span className="tabular mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--jewel)] text-[11px] font-semibold text-[var(--jewel-fg)]">
                          {i + 1}
                        </span>
                        <div className="min-w-0">
                          <p className="text-sm font-medium">
                            {item.href && !emailId ? (
                              <Link href={item.href} className="underline-offset-2 hover:underline">
                                {item.title}
                              </Link>
                            ) : (
                              item.title
                            )}
                          </p>
                          <p className="mt-0.5 text-sm text-[var(--fg-muted)]">{item.detail}</p>
                          <ThreadLinks
                            id={emailId}
                            mailbox={DEFAULT_MAILBOX}
                            label={item.title}
                            variant="text"
                            className="mt-1"
                          />
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </div>
            ) : null}

            {brief.recommended_actions.length > 0 ? (
              <div className="mt-5 rounded-md bg-[var(--bg-sunken)] p-3.5">
                <FieldLabel as="h3" className="mb-2">
                  Do next
                </FieldLabel>
                <ul className="space-y-1.5">
                  {brief.recommended_actions.map((action, i) => (
                    <li key={i} className="flex gap-2 text-sm">
                      <ArrowRight
                        className="mt-0.5 size-3.5 shrink-0 text-[var(--fg-subtle)]"
                        aria-hidden="true"
                      />
                      {action}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <div
        data-tour="today-sections"
        className="rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)] px-4 sm:px-5"
      >
        {/* When Do now is on the page it already lists these, so the full
            rows wait behind a click; the overdue count stays readable while
            closed. When Do now has stepped aside for today's Top priorities,
            or there is no glance row, overdue tasks open the section, since
            nothing above lists them. */}
        <ExpandableSection
          title="Tasks due"
          count={data.overdueTasks.length + data.dueTodayTasks.length}
          defaultOpen={!nowListed && data.overdueTasks.length > 0}
          emptyLabel="Nothing due"
          note={
            data.overdueTasks.length > 0 ? (
              <span className="flex items-center gap-1 text-sm font-medium text-[var(--danger)]">
                <AlertTriangle className="size-3.5" aria-hidden="true" />
                {data.overdueTasks.length} overdue
              </span>
            ) : null
          }
        >
          <ul>
            {dueTasks.map((task) => (
              <li
                key={task.id}
                className="flex items-start justify-between gap-3 border-b border-[var(--border)] py-2.5 last:border-b-0"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {task.deal_id ? (
                      <Link
                        href={`/deals/${task.deal_id}`}
                        className="underline-offset-2 hover:underline"
                      >
                        {task.title}
                      </Link>
                    ) : (
                      task.title
                    )}
                    <CompanyChip company={companies.get(task.id)} />
                  </p>
                  {task.detail ? (
                    <p className="mt-0.5 text-sm text-[var(--fg-muted)]">{task.detail}</p>
                  ) : null}
                  {task.due_at ? (
                    <p
                      className={
                        isOverdue(task.due_at, now)
                          ? 'mt-1 text-xs font-medium text-[var(--danger)]'
                          : 'mt-1 text-xs text-[var(--fg-subtle)]'
                      }
                    >
                      {isOverdue(task.due_at, now) ? 'Overdue — due ' : 'Due '}
                      {relativeTime(task.due_at, now)}
                    </p>
                  ) : null}
                </div>
                <TaskControls
                  taskId={task.id}
                  task={{
                    title: task.title,
                    detail: task.detail,
                    dueAt: task.due_at,
                    assignedTo: task.assigned_to,
                    moneyLegal: Boolean(money.states.get(task.id)?.on),
                    company: companies.get(task.id) ?? null,
                  }}
                  people={people}
                />
              </li>
            ))}
          </ul>
        </ExpandableSection>

        <ExpandableSection
          title="Today's meetings"
          count={todaysMeetings.length}
          defaultOpen={todaysMeetings.length > 0}
          emptyLabel="No meetings today"
        >
          <ul className="space-y-3">
            {todaysMeetings.map(({ prep, verdict }) => (
              <li
                key={prep.event.id}
                className="border-b border-[var(--border)] pb-3 last:border-b-0 last:pb-0"
              >
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="tabular text-sm font-semibold">
                    {formatTime(prep.event.starts_at, auth.profile.timezone)}
                  </span>
                  <span className="text-sm font-medium">{prep.event.title}</span>
                  {prep.relatedDeal ? (
                    <Link href={`/deals/${prep.relatedDeal.id}`}>
                      <Badge tone="accent">{prep.relatedDeal.company_name}</Badge>
                    </Link>
                  ) : null}
                  {prep.relatedPortfolio ? (
                    <Link href={`/portfolio/${prep.relatedPortfolio.id}`}>
                      <Badge tone="ok">{prep.relatedPortfolio.name}</Badge>
                    </Link>
                  ) : null}
                </div>
                <p className="mt-1 flex items-center gap-1.5 text-xs text-[var(--fg-subtle)]">
                  <Calendar className="size-3" aria-hidden="true" />
                  {verdict.reason}
                </p>
                {prep.relatedDeal || prep.relatedPortfolio ? (
                  <p className="mt-1.5 text-sm text-[var(--fg-muted)]">{prep.suggestedPrep}</p>
                ) : null}
                {prep.openQuestions.length > 0 ? (
                  <ul className="mt-1.5 space-y-1">
                    {prep.openQuestions.map((q, i) => (
                      <li key={i} className="text-sm text-[var(--fg-muted)]">
                        • {q}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {prep.lastInteraction ? (
                  <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-xs text-[var(--fg-subtle)]">
                    <span className="min-w-0 break-words">
                      Last email from them: {prep.lastInteraction.subject ?? '(no subject)'} ·{' '}
                      {relativeTime(prep.lastInteraction.sent_at, now)}
                    </span>
                    <ThreadLinks
                      id={emailLinkId(prep.lastInteraction)}
                      mailbox={DEFAULT_MAILBOX}
                      label={prep.lastInteraction.subject ?? '(no subject)'}
                      variant="text"
                    />
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-[var(--fg-subtle)]">
            {hiddenBlocks > 0
              ? `${hiddenBlocks} ${hiddenBlocks === 1 ? 'block' : 'blocks'} (Focus, Travel, Prep and the like) not shown. `
              : ''}
            {/* Today in Day view (its date is today's when the calendar opens); a click on a meeting opens its prep. */}
            <Link href="/calendar?view=day" className="link-inline">
              Full day and meeting prep in Calendar →
            </Link>
          </p>
        </ExpandableSection>

        <ExpandableSection
          title="Important email"
          count={data.importantEmails.length}
          emptyLabel="Nothing needs a reply"
        >
          <ul>
            {data.importantEmails.map((message) => (
              <li
                key={message.id}
                className="flex items-start justify-between gap-3 border-b border-[var(--border)] py-2.5 last:border-b-0"
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <Mail
                      className="size-3.5 shrink-0 text-[var(--fg-subtle)]"
                      aria-hidden="true"
                    />
                    <span className="truncate">{message.subject ?? '(no subject)'}</span>
                    {message.is_unread ? <Badge tone="info">Unread</Badge> : null}
                    {message.injection_flagged ? <Badge tone="danger">Flagged</Badge> : null}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-[var(--fg-subtle)]">
                    {message.from_name ?? message.from_address} ·{' '}
                    {relativeTime(message.sent_at, now)}
                  </p>
                  <p className="mt-1 line-clamp-2 text-sm text-[var(--fg-muted)]">
                    {message.snippet}
                  </p>
                  <ThreadLinks
                    id={emailLinkId(message)}
                    mailbox={DEFAULT_MAILBOX}
                    label={message.subject ?? '(no subject)'}
                    variant="text"
                    className="mt-1"
                  />
                </div>
              </li>
            ))}
          </ul>
        </ExpandableSection>

        <ExpandableSection title="New deals" count={data.newDeals.length} emptyLabel="No new deals">
          <ul>
            {data.newDeals.map((deal) => (
              <li key={deal.id} className="border-b border-[var(--border)] py-2.5 last:border-b-0">
                <Link
                  href={`/deals/${deal.id}`}
                  className="text-sm font-medium underline-offset-2 hover:underline"
                >
                  {deal.company_name}
                </Link>
                <p className="mt-0.5 text-sm text-[var(--fg-muted)]">
                  {deal.product_summary ?? 'No summary extracted yet.'}
                </p>
                <p className="mt-1 text-xs text-[var(--fg-subtle)]">
                  Received {relativeTime(deal.received_at, now)}
                  {deal.revenue ? ` · ${deal.revenue}` : ''}
                </p>
              </li>
            ))}
          </ul>
        </ExpandableSection>

        <ExpandableSection
          title="Awaiting a decision"
          count={data.awaitingDecision.length}
          emptyLabel="Nothing waiting"
        >
          <ul>
            {data.awaitingDecision.map(({ deal, analysis }) => (
              <li
                key={deal.id}
                className="flex items-start justify-between gap-3 border-b border-[var(--border)] py-2.5 last:border-b-0"
              >
                <div className="min-w-0">
                  <Link
                    href={`/deals/${deal.id}`}
                    className="text-sm font-medium underline-offset-2 hover:underline"
                  >
                    {deal.company_name}
                  </Link>
                  <p className="mt-0.5 text-sm text-[var(--fg-muted)]">
                    {analysis
                      ? analysis.recommended_next_step
                      : aiAvailable
                        ? 'Not analysed yet — open the deal to run an analysis.'
                        : "Open the deal for the deal-sorter's read and a one-click Research profile."}
                  </p>
                </div>
                {analysis ? (
                  <div className="shrink-0 text-right">
                    <RecommendationBadge
                      recommendation={
                        analysis.human_override?.recommendation ?? analysis.recommendation
                      }
                    />
                    <p className="tabular mt-1 text-[11px] text-[var(--fg-subtle)]">
                      {analysis.confidence}% confidence
                    </p>
                  </div>
                ) : aiAvailable ? (
                  <Badge tone="outline">Not analysed</Badge>
                ) : null}
              </li>
            ))}
          </ul>
        </ExpandableSection>

        <ExpandableSection
          title="Portfolio requests"
          count={data.portfolioRequests.length}
          emptyLabel="No open requests"
        >
          <ul>
            {data.portfolioRequests.map(({ update, updates, company }) => (
              <li
                key={update.id}
                className="border-b border-[var(--border)] py-2.5 last:border-b-0"
              >
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {company ? (
                    <Link
                      href={`/portfolio/${company.id}`}
                      className="underline-offset-2 hover:underline"
                    >
                      {company.name}
                    </Link>
                  ) : (
                    'Portfolio company'
                  )}
                  {requestLabel(update) ? (
                    <Badge tone={update.urgency === 'high' ? 'danger' : 'warn'}>
                      {requestLabel(update)}
                    </Badge>
                  ) : null}
                  {updates.some(isAutoAsk) ? (
                    <Badge tone="outline">
                      Read from their update
                      {updates.length > 1 ? ` · ${updates.length} asks` : ''}
                    </Badge>
                  ) : null}
                </p>
                {updates.length > 1 ? (
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-[var(--fg-muted)]">
                    {updates.slice(0, 3).map((u) => (
                      <li key={u.id}>{u.request_detail ?? u.summary}</li>
                    ))}
                    {updates.length > 3 ? (
                      <li className="list-none text-xs text-[var(--fg-subtle)]">
                        <Link
                          href="/portfolio?tab=requests"
                          className="underline-offset-2 hover:underline"
                        >
                          {updates.length - 3} more on Portfolio
                        </Link>
                      </li>
                    ) : null}
                  </ul>
                ) : (
                  <p className="mt-1 text-sm text-[var(--fg-muted)]">
                    {update.request_detail ?? update.summary}
                  </p>
                )}
                {update.suggested_action ? (
                  <p className="mt-1.5 text-sm">
                    <span className="text-[var(--fg-subtle)]">Suggested: </span>
                    {update.suggested_action}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </ExpandableSection>

        {/* Filled by the in-app email classifier only; with no model it could
            never show anything, so it is left out rather than shown empty. */}
        {aiAvailable || data.lpItems.length > 0 ? (
          <ExpandableSection
            title="LP, advisor and co-investor"
            count={data.lpItems.length}
            emptyLabel="Nothing waiting"
          >
            <ul>
              {data.lpItems.map((message) => (
                <li
                  key={message.id}
                  className="border-b border-[var(--border)] py-2.5 last:border-b-0"
                >
                  <p className="text-sm font-medium break-words">
                    {message.subject ?? '(no subject)'}
                  </p>
                  <p className="mt-0.5 text-xs text-[var(--fg-subtle)]">
                    {message.from_name ?? message.from_address} ·{' '}
                    {relativeTime(message.sent_at, now)}
                  </p>
                  <p className="mt-1 line-clamp-2 text-sm text-[var(--fg-muted)]">
                    {message.snippet}
                  </p>
                  <ThreadLinks
                    id={emailLinkId(message)}
                    mailbox={DEFAULT_MAILBOX}
                    label={message.subject ?? '(no subject)'}
                    variant="text"
                    className="mt-1"
                  />
                </li>
              ))}
            </ul>
          </ExpandableSection>
        ) : null}

        {data.researchAvailable ? (
          <ExpandableSection
            title="Market signals"
            count={brief?.sections.market_signals.length ?? 0}
            emptyLabel="Nothing notable"
          >
            <ul>
              {(brief?.sections.market_signals ?? []).map((item) => (
                <BriefItemRow key={item.id} item={item} citations={citations} />
              ))}
            </ul>
          </ExpandableSection>
        ) : null}
      </div>
    </>
  );
}
