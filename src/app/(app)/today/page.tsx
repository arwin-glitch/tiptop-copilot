import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { AlertTriangle, ArrowRight, Calendar, Mail } from 'lucide-react';
import { requireAuth } from '@/lib/auth/session';
import { gatherTodayData, generateDailyBrief, getTodaysBrief } from '@/lib/services/brief';
import { PageHeader, PageShell } from '@/components/shell/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge, RecommendationBadge } from '@/components/ui/badge';
import { EmptyState, Notice, SkeletonText } from '@/components/ui/feedback';
import { Button } from '@/components/ui/button';
import { GeneratedMeta } from '@/components/evidence/source-drawer';
import { BriefItemRow, ExpandableSection, OpenSourcesButton } from '@/components/today/sections';
import {
  CreateFollowUpButton,
  RefreshOutlookButton,
  TaskControls,
} from '@/components/today/today-actions';
import { formatTime, formatWeekdayLong, isOverdue, relativeTime } from '@/lib/util/time';
import type { Citation } from '@/lib/types/domain';

export const metadata: Metadata = { title: 'Today' };
export const dynamic = 'force-dynamic';

export default function TodayPage() {
  return (
    <PageShell>
      <Suspense fallback={<TodaySkeleton />}>
        <TodayContent />
      </Suspense>
    </PageShell>
  );
}

function TodaySkeleton() {
  return (
    <div className="space-y-6">
      <SkeletonText lines={2} className="max-w-md" />
      <Card>
        <CardContent className="pt-5">
          <SkeletonText lines={4} />
        </CardContent>
      </Card>
      <SkeletonText lines={6} />
    </div>
  );
}

async function TodayContent() {
  const auth = await requireAuth();
  const now = new Date();
  const data = await gatherTodayData(auth, now);

  // Generate on first view of the day so the page is never empty on arrival;
  // an explicit refresh regenerates it.
  let brief = await getTodaysBrief(auth, now);
  let briefError: string | null = null;
  if (!brief) {
    const generated = await generateDailyBrief(auth, { now });
    if (generated.ok) brief = generated.value;
    else briefError = generated.error.message;
  }

  const citations: Citation[] = brief?.citations ?? [];
  const firstName = auth.profile.full_name?.split(' ')[0] ?? 'there';

  const nothingToday =
    data.meetings.length === 0 &&
    data.importantEmails.length === 0 &&
    data.newDeals.length === 0 &&
    data.overdueTasks.length === 0 &&
    data.dueTodayTasks.length === 0 &&
    data.portfolioRequests.length === 0;

  return (
    <>
      <PageHeader
        eyebrow={formatWeekdayLong(now, auth.profile.timezone)}
        title={`Good day, ${firstName}`}
        subtitle="What matters, why it matters, and what to do about it."
        actions={
          <>
            <Button asChild variant="secondary" size="sm">
              <Link href="/ask?q=What%20actually%20needs%20my%20attention%20today%3F">
                Ask about today
              </Link>
            </Button>
            <CreateFollowUpButton />
            <RefreshOutlookButton />
          </>
        }
      />

      {nothingToday ? (
        <EmptyState
          title="Nothing is competing for your attention"
          description="No meetings, no overdue follow-ups, no new deals and no unread items that need you. Sync your mailbox or add a deal to get started."
          action={{ label: 'Go to Inbox', href: '/inbox' }}
        />
      ) : null}

      {briefError ? (
        <Notice tone="warn" className="mb-5">
          <p className="font-medium">The outlook could not be generated.</p>
          <p className="mt-1 text-[var(--fg-muted)]">{briefError}</p>
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
              />
            </div>
            <OpenSourcesButton citations={citations} />
          </CardHeader>
          <CardContent>
            <p className="text-[15px] leading-relaxed">{brief.outlook}</p>

            {brief.priorities.length > 0 ? (
              <div className="mt-5">
                <h3 className="mb-2 text-[11px] font-medium tracking-wider text-[var(--fg-subtle)] uppercase">
                  Top {brief.priorities.length}
                </h3>
                <ol className="space-y-2.5">
                  {brief.priorities.map((item, i) => (
                    <li key={item.id} className="flex gap-3">
                      <span className="tabular mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[11px] font-semibold text-[var(--accent)]">
                        {i + 1}
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm font-medium">
                          {item.href ? (
                            <Link href={item.href} className="underline-offset-2 hover:underline">
                              {item.title}
                            </Link>
                          ) : (
                            item.title
                          )}
                        </p>
                        <p className="mt-0.5 text-sm text-[var(--fg-muted)]">{item.detail}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}

            {brief.recommended_actions.length > 0 ? (
              <div className="mt-5 rounded-md bg-[var(--bg-sunken)] p-3.5">
                <h3 className="mb-2 text-[11px] font-medium tracking-wider text-[var(--fg-subtle)] uppercase">
                  Do next
                </h3>
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

      <div className="rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)] px-4 sm:px-5">
        <ExpandableSection
          title="Follow-ups"
          count={data.overdueTasks.length + data.dueTodayTasks.length}
          defaultOpen={data.overdueTasks.length > 0}
          emptyLabel="Nothing due"
        >
          {data.overdueTasks.length > 0 ? (
            <p className="mb-2 flex items-center gap-1.5 text-sm font-medium text-[var(--danger)]">
              <AlertTriangle className="size-3.5" aria-hidden="true" />
              {data.overdueTasks.length} overdue
            </p>
          ) : null}
          <ul>
            {[...data.overdueTasks, ...data.dueTodayTasks].map((task) => (
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
                <TaskControls taskId={task.id} />
              </li>
            ))}
          </ul>
        </ExpandableSection>

        <ExpandableSection
          title="Today's calendar"
          count={data.meetings.length}
          defaultOpen={data.meetings.length > 0}
          emptyLabel="No meetings"
        >
          <ul className="space-y-3">
            {data.meetingPrep.map((prep) => (
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
                      <Badge tone="info">{prep.relatedDeal.company_name}</Badge>
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
                  {prep.event.attendees.map((a) => a.email).join(', ') || 'No attendees listed'}
                </p>
                <p className="mt-1.5 text-sm text-[var(--fg-muted)]">{prep.suggestedPrep}</p>
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
                  <p className="mt-1.5 text-xs text-[var(--fg-subtle)]">
                    Last interaction:{' '}
                    <Link
                      href={`/inbox?message=${prep.lastInteraction.id}`}
                      className="underline-offset-2 hover:underline"
                    >
                      {prep.lastInteraction.subject ?? '(no subject)'}
                    </Link>{' '}
                    · {relativeTime(prep.lastInteraction.sent_at, now)}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
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
                    <Link
                      href={`/inbox?message=${message.id}`}
                      className="truncate underline-offset-2 hover:underline"
                    >
                      {message.subject ?? '(no subject)'}
                    </Link>
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
                      : 'Not analysed yet — open the deal to run an analysis.'}
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
                ) : (
                  <Badge tone="outline">Not analysed</Badge>
                )}
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
            {data.portfolioRequests.map(({ update, company }) => (
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
                  {update.request_type ? (
                    <Badge tone={update.urgency === 'high' ? 'danger' : 'warn'}>
                      {update.request_type.replace(/_/g, ' ')}
                    </Badge>
                  ) : null}
                </p>
                <p className="mt-1 text-sm text-[var(--fg-muted)]">
                  {update.request_detail ?? update.summary}
                </p>
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
                <Link
                  href={`/inbox?message=${message.id}`}
                  className="text-sm font-medium underline-offset-2 hover:underline"
                >
                  {message.subject ?? '(no subject)'}
                </Link>
                <p className="mt-0.5 text-xs text-[var(--fg-subtle)]">
                  {message.from_name ?? message.from_address} · {relativeTime(message.sent_at, now)}
                </p>
                <p className="mt-1 line-clamp-2 text-sm text-[var(--fg-muted)]">
                  {message.snippet}
                </p>
              </li>
            ))}
          </ul>
        </ExpandableSection>

        <ExpandableSection
          title="Market signals"
          count={brief?.sections.market_signals.length ?? 0}
          emptyLabel={data.researchAvailable ? 'Nothing notable' : 'Web research not configured'}
        >
          {data.researchAvailable ? (
            <ul>
              {(brief?.sections.market_signals ?? []).map((item) => (
                <BriefItemRow key={item.id} item={item} citations={citations} />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-[var(--fg-muted)]">{data.researchUnavailableReason}</p>
          )}
        </ExpandableSection>
      </div>
    </>
  );
}
