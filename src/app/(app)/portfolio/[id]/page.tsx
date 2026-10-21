import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { requireAuth } from '@/lib/auth/session';
import { getAI, getStore } from '@/lib/runtime';
import { notesForCompany } from '@/lib/services/meetings';
import { getPortfolioDetail } from '@/lib/services/portfolio';
import { affinityForCompany } from '@/lib/services/crm-pages';
import { isAutoAsk, requestLabel } from '@/lib/portfolio/requests';
import { loadPortfolioContacts } from '@/lib/services/portfolio-contacts';
import { readPortfolioJobsWithin } from '@/lib/services/portfolio-jobs';
import { cachedJobLinkVerdicts } from '@/lib/services/job-liveness';
import { applyJobLiveness, jobPlace, roleIsAtCompany } from '@/lib/portfolio/jobs';
import { SNAPSHOT_WAIT_MS } from '@/lib/records-tabs';
import { PROFILE_CONTACTS, provenanceLabel } from '@/lib/portfolio/contacts';
import { emailLinkId } from '@/lib/email/thread-links';
import { DEFAULT_MAILBOX } from '@/lib/services/task-close';
import { CompanyAffinitySection } from '@/components/crm/company-affinity';
import { ThreadLinks } from '@/components/email/thread-links';
import { MeetingNoteList } from '@/components/meetings/meeting-note-list';
import { PageHeader, PageShell, DataRow, SectionHeading } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, FieldLabel } from '@/components/ui/card';
import { EmptyState, PlainText } from '@/components/ui/feedback';
import { ClassifyEmailButton, RequestActions } from '@/components/portfolio/portfolio-client';
import { jobsTabHref } from '@/components/portfolio/portfolio-jobs';
import { CreateFollowUpButton, TaskControls } from '@/components/today/today-actions';
import { formatDate, relativeTime } from '@/lib/util/time';
import type { PortfolioCompany } from '@/lib/types/domain';
import { isOpenNow } from '@/lib/tasks/tasks-view';

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
  const openTasks = tasks.filter((t) => isOpenNow(t, new Date()));
  const aiAvailable = getAI().available();

  const [meetingNotes, affinity, people] = await Promise.all([
    notesForCompany(
      getStore(),
      auth.organizationId,
      company,
      contacts.map((c) => c.email).filter((e): e is string => Boolean(e)),
    ),
    // Affinity's side of the company: lists, people and notes. Never fails.
    affinityForCompany(getStore(), auth.organizationId, {
      name: company.name,
      domain: company.domain ?? company.website,
    }),
    // Its people from every source, and the last contact. Never fails.
    loadPortfolioContacts(getStore(), auth.organizationId, [company]),
  ]);
  const derived = people[company.id]?.contacts ?? [];
  const lastContactAt = people[company.id]?.lastContactAt ?? company.last_contact_at;

  return (
    <PageShell>
      <PageHeader
        eyebrow="Portfolio"
        title={company.name}
        subtitle={company.description ?? company.key_metrics ?? undefined}
        actions={
          <CreateFollowUpButton portfolioCompanyId={company.id} timeZone={auth.profile.timezone} />
        }
      />

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="min-w-0 space-y-6">
          <section>
            <SectionHeading count={updates.length}>Updates and requests</SectionHeading>
            {updates.length === 0 ? (
              <EmptyState
                title="No updates recorded"
                description="Asks in this company's update emails are added here on their own. To record anything else, open one of its emails in the Inbox and classify it."
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
                                {requestLabel(update)}
                              </Badge>
                            ) : null}
                            <Badge tone={update.status === 'open' ? 'info' : 'neutral'}>
                              {update.status}
                            </Badge>
                            {isAutoAsk(update) ? (
                              <Badge tone="outline">Read from their update</Badge>
                            ) : null}
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
            <SectionHeading count={meetingNotes.length}>Meetings</SectionHeading>
            <MeetingNoteList notes={meetingNotes} timezone={auth.profile.timezone} />
          </section>

          <CompanyAffinitySection
            data={affinity}
            timezone={auth.profile.timezone}
            headingLevel="h2"
          />

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
                      <span className="min-w-0 text-sm font-medium break-words">
                        {m.subject ?? '(no subject)'}
                      </span>
                      <span className="flex flex-wrap items-center gap-2">
                        {/* The email in Copilot's Inbox, or in Gmail. */}
                        <ThreadLinks
                          id={emailLinkId(m)}
                          mailbox={DEFAULT_MAILBOX}
                          label={m.subject ?? '(no subject)'}
                        />
                        {/* Same model call as the Inbox actions, so it is gated
                            the same way rather than left as the one button on
                            the site that still fails. */}
                        {aiAvailable ? <ClassifyEmailButton messageId={m.id} /> : null}
                      </span>
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
                <DataRow label="Sector">{company.sector ?? unknown()}</DataRow>
                <DataRow label="Based in">{company.geography ?? unknown()}</DataRow>
                <DataRow label="Co-investors">{company.co_investors ?? unknown()}</DataRow>
                <DataRow label="Deal source">{company.deal_source ?? unknown()}</DataRow>
                <DataRow label="Stage">{company.current_stage ?? unknown()}</DataRow>
                <DataRow label="Latest round">{company.latest_round ?? unknown()}</DataRow>
                <DataRow label="Ownership">{company.ownership ?? unknown()}</DataRow>
                <DataRow label="Priorities">{company.current_priorities ?? unknown()}</DataRow>
                <DataRow label="Fundraising">{company.upcoming_fundraise ?? unknown()}</DataRow>
                <DataRow label="Hiring">{company.hiring_needs ?? unknown()}</DataRow>
                <DataRow label="GTM needs">{company.gtm_needs ?? unknown()}</DataRow>
                <DataRow label="Risks">{company.risks ?? unknown()}</DataRow>
                <DataRow label="Last contact">
                  {lastContactAt ? formatDate(lastContactAt, auth.profile.timezone) : unknown()}
                </DataRow>
                <DataRow label="Next follow-up">
                  {company.next_follow_up_at
                    ? formatDate(company.next_follow_up_at, auth.profile.timezone)
                    : unknown()}
                </DataRow>
              </dl>
            </CardContent>
          </Card>

          {/* Streams in: the jobs scan is read from Slack and never holds the page. */}
          <Suspense fallback={null}>
            <OpenRolesCard organizationId={auth.organizationId} company={company} />
          </Suspense>

          <Card>
            <CardContent className="pt-4">
              <FieldLabel as="h2">Contacts</FieldLabel>
              {derived.length === 0 ? (
                <p className="mt-2 text-sm text-[var(--fg-subtle)]">None recorded.</p>
              ) : (
                <ul className="mt-2 space-y-1.5" aria-label="Contacts">
                  {derived.slice(0, PROFILE_CONTACTS).map((c, i) => {
                    const from = provenanceLabel(c.sources);
                    const detail = [
                      c.email,
                      from,
                      c.lastContactAt ? `last contact ${relativeTime(c.lastContactAt)}` : null,
                    ].filter(Boolean);
                    return (
                      <li key={`${c.email ?? c.name}-${i}`} className="text-sm">
                        {c.recordId ? (
                          <Link
                            href={`/lists/records/${c.recordId}`}
                            className="font-medium underline-offset-2 hover:underline"
                          >
                            {c.name}
                          </Link>
                        ) : (
                          <span className="font-medium">{c.name}</span>
                        )}
                        {c.role ? (
                          <span className="text-[var(--fg-muted)]"> — {c.role}</span>
                        ) : null}
                        {detail.length > 0 ? (
                          <p className="text-xs break-words text-[var(--fg-subtle)]">
                            {detail.join(' · ')}
                          </p>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
              {derived.length > PROFILE_CONTACTS ? (
                <p className="mt-2 text-xs text-[var(--fg-subtle)]">
                  {derived.length - PROFILE_CONTACTS} more in the mail and Affinity.
                </p>
              ) : null}
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

/** Shown on a company's page: its open roles from the weekly jobs scan. */
const ROLES_ON_PAGE = 3;

async function OpenRolesCard({
  organizationId,
  company,
}: {
  organizationId: string;
  company: PortfolioCompany;
}) {
  // The weekly jobs scan, if it answers in time; hidden when it cannot be read.
  const jobs = await readPortfolioJobsWithin(getStore(), organizationId, SNAPSHOT_WAIT_MS);
  if (jobs?.state !== 'ok' || !jobs.snapshot) return null;
  const atCompany = jobs.snapshot.roles.filter((r) => roleIsAtCompany(r, company));
  const roles = applyJobLiveness(atCompany, cachedJobLinkVerdicts(atCompany)).filter(
    (r) => r.status === 'active',
  );
  const href = jobsTabHref(atCompany[0]?.company ?? company.name);
  return (
    <Card>
      <CardContent className="pt-4">
        <FieldLabel as="h2">
          {/* Underlined at rest: colour alone would not mark the label as a link. */}
          <Link
            href={href}
            className="text-[var(--accent)] underline decoration-[color:var(--link-underline)] underline-offset-4 hover:decoration-current"
          >
            Open roles ({roles.length})
          </Link>
        </FieldLabel>
        {roles.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--fg-subtle)]">
            None in the latest weekly scan of founders&rsquo; emails.
          </p>
        ) : (
          <ul className="mt-2 space-y-1.5" aria-label="Open roles">
            {roles.slice(0, ROLES_ON_PAGE).map((r) => {
              const place = jobPlace(r);
              return (
                <li key={r.id} className="text-sm">
                  <span className="font-medium">{r.title}</span>
                  {place ? <span className="text-[var(--fg-muted)]"> · {place}</span> : null}
                  {r.status_note ? (
                    <p className="text-xs break-words text-[var(--fg-subtle)]">{r.status_note}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {roles.length > ROLES_ON_PAGE ? (
          <Link
            href={href}
            className="mt-2 inline-block text-xs text-[var(--accent)] underline-offset-2 hover:underline"
          >
            {roles.length - ROLES_ON_PAGE} more on Jobs
          </Link>
        ) : null}
      </CardContent>
    </Card>
  );
}

function unknown() {
  return <span className="text-[var(--fg-subtle)] italic">Not recorded</span>;
}
