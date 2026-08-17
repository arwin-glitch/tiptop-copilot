import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAuth } from '@/lib/auth/session';
import { getAI } from '@/lib/runtime';
import { getPortfolioDetail } from '@/lib/services/portfolio';
import { PageHeader, PageShell, DataRow, SectionHeading } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, FieldLabel } from '@/components/ui/card';
import { EmptyState, PlainText } from '@/components/ui/feedback';
import { ClassifyEmailButton, RequestActions } from '@/components/portfolio/portfolio-client';
import { CreateFollowUpButton, TaskControls } from '@/components/today/today-actions';
import { PORTFOLIO_REQUEST_LABELS } from '@/lib/types/domain';
import { formatDate, relativeTime } from '@/lib/util/time';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const auth = await requireAuth();
  const detail = await getPortfolioDetail(auth.organizationId, id);
  return { title: detail?.company.name ?? 'Portfolio company' };
}

export default async function PortfolioCompanyPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const auth = await requireAuth();
  const detail = await getPortfolioDetail(auth.organizationId, id);
  if (!detail) notFound();

  const { company, contacts, updates, tasks, emails } = detail;
  const openTasks = tasks.filter((t) => t.status === 'open');
  const aiAvailable = getAI().available();

  return (
    <PageShell>
      <PageHeader
        eyebrow="Portfolio"
        title={company.name}
        subtitle={company.key_metrics ?? undefined}
        actions={<CreateFollowUpButton portfolioCompanyId={company.id} />}
      />

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="min-w-0 space-y-6">
          <section>
            <SectionHeading count={updates.length}>Updates and requests</SectionHeading>
            {updates.length === 0 ? (
              <EmptyState
                title="No updates recorded"
                description="Open an email from this company in the Inbox and classify it to record an update here."
                action={{ label: 'Go to Inbox', href: '/inbox?category=portfolio_company' }}
              />
            ) : (
              <ul className="space-y-3">
                {updates.map((update) => (
                  <li key={update.id}>
                    <Card>
                      <CardContent className="pt-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            {update.request_type ? (
                              <Badge tone={update.urgency === 'high' ? 'danger' : 'warn'}>
                                {PORTFOLIO_REQUEST_LABELS[update.request_type]}
                              </Badge>
                            ) : null}
                            <Badge tone={update.status === 'open' ? 'info' : 'neutral'}>
                              {update.status}
                            </Badge>
                          </div>
                          <span className="text-xs text-[var(--fg-subtle)]">
                            {formatDate(update.occurred_at, auth.profile.timezone)}
                          </span>
                        </div>
                        <p className="mt-2 text-sm">{update.summary}</p>
                        {update.suggested_action ? (
                          <p className="mt-2 text-sm text-[var(--fg-muted)]">
                            <span className="text-[var(--fg-subtle)]">Suggested: </span>
                            {update.suggested_action}
                          </p>
                        ) : null}
                        {update.status === 'open' ? (
                          <div className="mt-3">
                            <RequestActions
                              updateId={update.id}
                              portfolioCompanyId={company.id}
                              emailMessageId={update.email_message_id}
                            />
                          </div>
                        ) : null}
                      </CardContent>
                    </Card>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <SectionHeading count={emails.length}>Related email</SectionHeading>
            {emails.length === 0 ? (
              <p className="text-sm text-[var(--fg-subtle)]">
                No email has been linked to this company yet. Linking happens automatically once the
                company has a website domain.
              </p>
            ) : (
              <ul className="space-y-2">
                {emails.map((m) => (
                  <li key={m.id} className="rounded-md border border-[var(--border)] p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Link
                        href={`/inbox?message=${m.id}`}
                        className="text-sm font-medium underline-offset-2 hover:underline"
                      >
                        {m.subject ?? '(no subject)'}
                      </Link>
                      {/* Same model call as the Inbox actions, so it is gated
                          the same way rather than left as the one button on
                          the site that still fails. */}
                      {aiAvailable ? <ClassifyEmailButton messageId={m.id} /> : null}
                    </div>
                    <p className="mt-0.5 text-xs text-[var(--fg-subtle)]">
                      {m.from_name ?? m.from_address} · {relativeTime(m.sent_at)}
                    </p>
                    <PlainText
                      text={m.body_text ?? m.snippet}
                      className="mt-1.5 text-[var(--fg-muted)]"
                      maxLines={3}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <aside className="space-y-6">
          <Card>
            <CardContent className="pt-4">
              <FieldLabel as="h2">Company</FieldLabel>
              <dl className="mt-2 divide-y divide-[var(--border)]">
                <DataRow label="Stage">{company.current_stage ?? unknown()}</DataRow>
                <DataRow label="Latest round">{company.latest_round ?? unknown()}</DataRow>
                <DataRow label="Ownership">{company.ownership ?? unknown()}</DataRow>
                <DataRow label="Priorities">{company.current_priorities ?? unknown()}</DataRow>
                <DataRow label="Fundraising">{company.upcoming_fundraise ?? unknown()}</DataRow>
                <DataRow label="Hiring">{company.hiring_needs ?? unknown()}</DataRow>
                <DataRow label="GTM needs">{company.gtm_needs ?? unknown()}</DataRow>
                <DataRow label="Risks">{company.risks ?? unknown()}</DataRow>
                <DataRow label="Last contact">
                  {company.last_contact_at
                    ? formatDate(company.last_contact_at, auth.profile.timezone)
                    : unknown()}
                </DataRow>
                <DataRow label="Next follow-up">
                  {company.next_follow_up_at
                    ? formatDate(company.next_follow_up_at, auth.profile.timezone)
                    : unknown()}
                </DataRow>
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-4">
              <FieldLabel as="h2">Contacts</FieldLabel>
              {contacts.length === 0 ? (
                <p className="mt-2 text-sm text-[var(--fg-subtle)]">None recorded.</p>
              ) : (
                <ul className="mt-2 space-y-1.5">
                  {contacts.map((c) => (
                    <li key={c.id} className="text-sm">
                      <span className="font-medium">{c.name}</span>
                      {c.role ? <span className="text-[var(--fg-muted)]"> — {c.role}</span> : null}
                      {c.email ? (
                        <p className="text-xs text-[var(--fg-subtle)]">{c.email}</p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-4">
              <FieldLabel as="h2">Tasks</FieldLabel>
              {openTasks.length === 0 ? (
                <p className="mt-2 text-sm text-[var(--fg-subtle)]">No open tasks.</p>
              ) : (
                <ul className="mt-2">
                  {openTasks.map((t) => (
                    <li
                      key={t.id}
                      className="flex items-start justify-between gap-2 border-b border-[var(--border)] py-2 last:border-b-0"
                    >
                      <div className="min-w-0">
                        <p className="text-sm">{t.title}</p>
                        {t.due_at ? (
                          <p className="text-xs text-[var(--fg-subtle)]">
                            Due {relativeTime(t.due_at)}
                          </p>
                        ) : null}
                      </div>
                      <TaskControls taskId={t.id} />
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </aside>
      </div>
    </PageShell>
  );
}

function unknown() {
  return <span className="text-[var(--fg-subtle)] italic">Not recorded</span>;
}
