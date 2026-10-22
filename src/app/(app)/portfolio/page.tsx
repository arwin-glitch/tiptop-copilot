import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { after } from 'next/server';
import { Suspense } from 'react';
import { requireAuth, type AuthContext } from '@/lib/auth/session';
import { readFollowUps, readFollowUpsWithin } from '@/lib/services/follow-ups';
import { PortfolioHealthCard, snapshotUnavailable } from '@/components/followups/relay-cards';
import { getStore } from '@/lib/runtime';
import { listPortfolio, openRequests } from '@/lib/services/portfolio';
import { refreshPortfolioAsksOnView } from '@/lib/services/portfolio-asks';
import { loadPortfolioContacts } from '@/lib/services/portfolio-contacts';
import { pullPortfolioFromSlack } from '@/lib/services/portfolio-ingest';
import { peekPortfolioJobs, readPortfolioJobs } from '@/lib/services/portfolio-jobs';
import { cachedJobLinkVerdicts, jobLinkVerdicts } from '@/lib/services/job-liveness';
import { DEFAULT_MAILBOX } from '@/lib/services/task-close';
import { applyJobLiveness, parseJobFilters } from '@/lib/portfolio/jobs';
import { helpersForRequests, type RequestHelper } from '@/lib/services/network-helpers';
import {
  PORTFOLIO_TABS,
  SNAPSHOT_WAIT_MS,
  landsOnSnapshot,
  movedStudentsHref,
  openingTab,
} from '@/lib/records-tabs';
import { CARD_CONTACTS, provenanceLabel } from '@/lib/portfolio/contacts';
import {
  groupRequests,
  isAutoAsk,
  requestLabel,
  type RequestGroup,
} from '@/lib/portfolio/requests';
import {
  PAGE_PARAM,
  SHOW_PARAM,
  showMoreHref,
  shownCount,
  single,
  tabHref,
} from '@/lib/util/page-tabs';
import { AffinityEntries } from '@/components/crm/affinity-entries';
import { PageHeader, PageShell, SectionHeading } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, FieldLabel } from '@/components/ui/card';
import { EmptyState, Notice, SkeletonText } from '@/components/ui/feedback';
import { PageTabs } from '@/components/ui/page-tabs';
import { ShowMore } from '@/components/ui/show-more';
import { PortfolioNumbers } from '@/components/portfolio/portfolio-numbers';
import { PortfolioJobsView } from '@/components/portfolio/portfolio-jobs';
import {
  JobApprovalsView,
  JobBoardRolesView,
  JobCompaniesView,
  JobsBoardHeader,
} from '@/components/portfolio/jobs-board/board-views';
import { loadJobsBoardTab, parseJobsView } from '@/components/portfolio/jobs-board/data';
import {
  AddPortfolioButton,
  DismissAskButton,
  ImportPortfolioButton,
  RequestActions,
} from '@/components/portfolio/portfolio-client';
import { CitationList } from '@/components/evidence/source-drawer';
import { ThreadLinks } from '@/components/email/thread-links';
import { citationEmail } from '@/lib/ai/citations';
import type { PortfolioCompany, PortfolioUpdate } from '@/lib/types/domain';
import { relativeTime } from '@/lib/util/time';

export const metadata: Metadata = { title: 'Portfolio' };
export const dynamic = 'force-dynamic';

const COMPANIES_HREF = tabHref(PORTFOLIO_TABS.path, 'companies', PORTFOLIO_TABS.defaultKey);
/** Request cards per page: one per email, however many asks it had. */
const REQUESTS_STEP = 10;

export default async function PortfolioPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  // Students & interns moved to Network: old links and bookmarks land there, filters kept.
  const moved = movedStudentsHref(params);
  if (moved) redirect(moved);
  const auth = await requireAuth();
  const store = getStore();

  // Health is only the routine's snapshot from Slack. A bare URL opens there
  // when it has something to show and on Requests otherwise, so a Slack fault
  // never lands Nick on an empty page.
  const landing = landsOnSnapshot(PORTFOLIO_TABS, params)
    ? await readFollowUpsWithin(store, auth.organizationId, SNAPSHOT_WAIT_MS)
    : null;
  const healthShows =
    landing?.state === 'ok' && (landing.snapshot.portfolioHealth?.companies.length ?? 0) > 0;
  const { tab, home } = openingTab(PORTFOLIO_TABS, params, healthShows);

  // A company a cloud routine just spotted waits in the Slack relay; pull it in
  // before anything that lists companies, so it shows as soon as the page is
  // opened. Best effort, throttled. Health reads only the routine's snapshot.
  if (tab !== 'health') await pullPortfolioFromSlack(store, auth.organizationId).catch(() => null);

  // Asks in the companies' own update emails become open requests: read when
  // Requests is viewed (at most every 30 minutes) and by the daily job. A
  // Gmail read starts after the response (the next view shows what it found);
  // only a demo read, from memory, is waited on, briefly.
  if (tab === 'requests') {
    await refreshPortfolioAsksOnView(store, auth.organizationId, {
      schedule: (task) => after(task),
    });
  }

  // Head counts for the tab badges; a fault only drops the badge. Requests
  // counts cards, one per email: an update with four asks is one.
  const [open, companyCount] = await Promise.all([
    openRequests(auth.organizationId).catch(() => null),
    store
      .count('portfolio_companies', auth.organizationId, { eq: { is_archived: false } })
      .catch(() => undefined),
  ]);
  const groups = open ? groupRequests(open) : null;
  // Open roles only when the jobs snapshot is already in memory: never a read.
  const peeked = peekPortfolioJobs(auth.organizationId)?.roles ?? [];
  const activeRoles = applyJobLiveness(peeked, cachedJobLinkVerdicts(peeked)).filter(
    (r) => r.status === 'active',
  ).length;
  const counts: Partial<Record<string, number>> = {
    requests: groups?.length ? groups.length : undefined,
    jobs: activeRoles ? activeRoles : undefined,
    companies: companyCount,
  };

  return (
    <PageShell>
      <PageHeader
        title="Portfolio"
        subtitle="Who needs help, what they asked for, and whether anyone in your network is actually a match."
        actions={
          <>
            <ImportPortfolioButton />
            <AddPortfolioButton />
          </>
        }
      />
      <PageTabs
        label={PORTFOLIO_TABS.navLabel}
        path={PORTFOLIO_TABS.path}
        tabs={PORTFOLIO_TABS.tabs.map((t) => ({
          key: t.key,
          label: t.label,
          count: counts[t.key],
        }))}
        active={tab}
        defaultKey={home}
      />
      <Suspense key={tab} fallback={<SkeletonText lines={8} />}>
        {tab === 'requests' ? (
          <RequestsTab auth={auth} groups={groups} shownRaw={params[SHOW_PARAM]} />
        ) : tab === 'jobs' ? (
          <JobsTab auth={auth} params={params} />
        ) : tab === 'numbers' ? (
          <NumbersTab auth={auth} />
        ) : tab === 'companies' ? (
          <CompaniesTab auth={auth} />
        ) : tab === 'founders' ? (
          <FoundersTab
            auth={auth}
            q={single(params.q) ?? ''}
            list={single(params.list) ?? null}
            page={params[PAGE_PARAM]}
          />
        ) : tab === 'angel' ? (
          <AngelTab
            auth={auth}
            q={single(params.q) ?? ''}
            list={single(params.list) ?? null}
            page={params[PAGE_PARAM]}
          />
        ) : (
          <HealthTab auth={auth} />
        )}
      </Suspense>
    </PageShell>
  );
}

/** The portfolio-health routine's snapshot, risk first. */
async function HealthTab({ auth }: { auth: AuthContext }) {
  const now = new Date();
  const followUps = await readFollowUps(getStore(), auth.organizationId, { now }).catch(() => null);
  const empty = (description: string) => (
    <EmptyState
      title="No health check to show"
      description={description}
      action={{ label: 'See companies', href: COMPANIES_HREF }}
    />
  );
  if (followUps?.state !== 'ok') return empty(snapshotUnavailable(followUps?.state));
  const health = followUps.snapshot.portfolioHealth;
  const none = empty('Shows here once the portfolio-health routine has posted a check.');
  if (!health) return none;
  return <PortfolioHealthCard health={health} now={now} tz={auth.profile.timezone} empty={none} />;
}

async function RequestsTab({
  auth,
  groups: read,
  shownRaw,
}: {
  auth: AuthContext;
  /** The open requests by email, as the badge counted them; read here when that read failed. */
  groups: RequestGroup[] | null;
  shownRaw: string | string[] | undefined;
}) {
  const store = getStore();
  const [companies, groups] = await Promise.all([
    listPortfolio(auth.organizationId),
    read ?? openRequests(auth.organizationId).then(groupRequests),
  ]);
  const shown = shownCount(shownRaw, REQUESTS_STEP, Math.max(groups.length, REQUESTS_STEP));
  const visible = groups.slice(0, shown);
  // Who could help, for the cards on screen only: the imported contacts and
  // the people from Affinity, with the reason each is named. Never fails.
  const helpers = await helpersForRequests(
    store,
    auth.organizationId,
    visible.flatMap((g) => g.updates),
    companies,
  );
  const readFromUpdates = visible.some((g) => g.updates.some(isAutoAsk));

  return (
    <section className="mb-8">
      <SectionHeading count={groups.length}>Open requests</SectionHeading>
      {groups.length === 0 ? (
        <EmptyState
          title="No open requests"
          description="Requests appear here on their own when a portfolio company's update email has an asks section (read every day), and when you classify a portfolio email in the Inbox."
          action={{ label: 'Go to Inbox', href: '/inbox?category=portfolio_company' }}
        />
      ) : (
        <>
          {readFromUpdates ? (
            <p className="-mt-1 mb-3 text-sm text-[var(--fg-muted)]">
              &ldquo;Read from their update&rdquo; asks are the lines under an asks heading in a
              company&rsquo;s own update email, word for word. Who could help names only people in
              your network data, with why; where nobody is named, nobody fits.
            </p>
          ) : null}
          <ul className="space-y-3">
            {visible.map((group) => (
              <li key={group.key}>
                <RequestCard
                  group={group}
                  company={companies.find((c) => c.id === group.portfolioCompanyId) ?? null}
                  helpers={helpers}
                />
              </li>
            ))}
          </ul>
          <ShowMore
            shown={visible.length}
            total={groups.length}
            step={REQUESTS_STEP}
            href={showMoreHref(PORTFOLIO_TABS.path, { tab: 'requests' }, shown, REQUESTS_STEP)}
          />
        </>
      )}
    </section>
  );
}

/**
 * One email's requests on one card: a person's classification of it (with
 * its suggested action), and the asks read from it, each with who could
 * help. One Draft reply for the thread; Handled and Dismiss close them all,
 * and each of several asks can be dismissed on its own.
 */
function RequestCard({
  group,
  company,
  helpers,
}: {
  group: RequestGroup;
  company: PortfolioCompany | null;
  helpers: Record<string, RequestHelper[]>;
}) {
  const classified = group.updates.filter((u) => !isAutoAsk(u));
  const asks = group.updates.filter(isAutoAsk);
  const lead = group.updates[0] as PortfolioUpdate;
  const source = asks[0]?.citations[0] ?? null;
  const sourceEmail = source ? citationEmail(source) : null;
  const companyName = company?.name ?? 'this company';
  const emailMessageId = group.updates.find((u) => u.email_message_id)?.email_message_id ?? null;
  const occurredAt = group.updates.reduce(
    (latest, u) => (u.occurred_at > latest ? u.occurred_at : latest),
    lead.occurred_at,
  );
  const leadLabel = classified[0] ? requestLabel(classified[0]) : null;
  const nobodyForAsks = asks.length > 0 && asks.every((a) => !helpers[a.id]?.length);

  return (
    <Card>
      <CardContent className="pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            {company ? (
              <Link
                href={`/portfolio/${company.id}`}
                className="font-serif text-base underline-offset-2 hover:underline"
              >
                {company.name}
              </Link>
            ) : (
              'Portfolio company'
            )}
            {leadLabel ? (
              <Badge tone={classified[0]?.urgency === 'high' ? 'danger' : 'warn'}>
                {leadLabel}
              </Badge>
            ) : null}
            {classified[0]?.urgency ? (
              <Badge tone="neutral">{classified[0].urgency} urgency</Badge>
            ) : null}
            {asks.length > 0 ? (
              <Badge tone="outline">
                Read from their update{asks.length > 1 ? ` · ${asks.length} asks` : ''}
              </Badge>
            ) : null}
          </p>
          <span className="text-xs text-[var(--fg-subtle)]">{relativeTime(occurredAt)}</span>
        </div>

        {classified.map((update) => {
          const people = helpers[update.id] ?? [];
          return (
            <div key={update.id}>
              <p className="mt-2 text-sm">{update.summary}</p>
              {update.request_detail ? (
                <p className="mt-1.5 text-sm text-[var(--fg-muted)]">
                  <span className="text-[var(--fg-subtle)]">Asked for: </span>
                  {update.request_detail}
                </p>
              ) : null}
              {update.suggested_action || people.length > 0 ? (
                <div className="mt-3 rounded-md bg-[var(--bg-sunken)] p-3">
                  {update.suggested_action ? (
                    <>
                      <FieldLabel as="p">Suggested action</FieldLabel>
                      <p className="mt-1 text-sm">{update.suggested_action}</p>
                    </>
                  ) : null}
                  {people.length > 0 ? (
                    <>
                      <FieldLabel as="p" className={update.suggested_action ? 'mt-3' : undefined}>
                        Who could help
                      </FieldLabel>
                      <HelperList helpers={people} label={`Who could help ${companyName}`} />
                    </>
                  ) : (
                    <p className="mt-2 text-xs text-[var(--fg-subtle)]">
                      Nobody in your network data fits this one.
                    </p>
                  )}
                </div>
              ) : null}
              {update.citations.length > 0 ? (
                <div className="mt-3">
                  <CitationList
                    ids={update.citations.map((c) => c.id)}
                    citations={update.citations}
                  />
                </div>
              ) : null}
            </div>
          );
        })}

        {asks.length > 0 ? (
          <>
            {source ? (
              <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--fg-subtle)]">
                <span className="min-w-0 break-words">
                  Under &ldquo;{source.section ?? 'Asks'}&rdquo; in &ldquo;{source.label}&rdquo;
                  {source.publisher ? ` from ${source.publisher}` : ''}
                </span>
                {/* The update email, in Copilot's Inbox or in Gmail. */}
                {sourceEmail ? (
                  <ThreadLinks
                    id={sourceEmail.id}
                    mailbox={sourceEmail.mailbox ?? DEFAULT_MAILBOX}
                    label={source.label}
                    variant="text"
                  />
                ) : null}
              </p>
            ) : null}
            <ul className="mt-2 space-y-2" aria-label={`Asks from ${companyName}`}>
              {asks.map((ask) => {
                const label = requestLabel(ask);
                const people = helpers[ask.id] ?? [];
                return (
                  <li key={ask.id} className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm">
                        {ask.summary}
                        {label && label !== 'Ask' ? (
                          <Badge tone="warn" className="ml-2 align-middle">
                            {label}
                          </Badge>
                        ) : null}
                      </p>
                      {people.length > 0 ? (
                        <div className="mt-1 border-l-2 border-[var(--border)] pl-3">
                          <HelperList helpers={people} label={`Who could help ${companyName}`} />
                        </div>
                      ) : null}
                    </div>
                    {asks.length > 1 ? (
                      <DismissAskButton
                        updateId={ask.id}
                        label={`Dismiss the ask: ${ask.summary.slice(0, 80)}`}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {nobodyForAsks ? (
              <p className="mt-2 text-xs text-[var(--fg-subtle)]">
                Nobody in your network data fits {asks.length > 1 ? 'these asks' : 'this ask'}.
              </p>
            ) : null}
          </>
        ) : null}

        <div className="mt-3">
          <RequestActions
            updateIds={group.updates.map((u) => u.id)}
            portfolioCompanyId={group.portfolioCompanyId}
            emailMessageId={emailMessageId}
          />
        </div>
      </CardContent>
    </Card>
  );
}

/** The people who could help with one request, each with why. */
function HelperList({ helpers, label }: { helpers: RequestHelper[]; label: string }) {
  return (
    <ul className="mt-1 space-y-1.5" aria-label={label}>
      {helpers.map((p) => {
        const who = [p.title, p.company].filter(Boolean).join(', ');
        const why = [
          ...p.reasons,
          p.lastContactAt ? `last in touch ${relativeTime(p.lastContactAt)}` : null,
        ].filter(Boolean);
        return (
          <li key={p.key} className="text-[13px] text-[var(--fg-muted)]">
            {p.recordId ? (
              <Link
                href={`/lists/records/${p.recordId}`}
                className="font-medium text-[var(--fg)] underline-offset-2 hover:underline"
              >
                {p.name}
              </Link>
            ) : (
              <span className="font-medium text-[var(--fg)]">{p.name}</span>
            )}
            {who ? ` — ${who}` : ''}
            <span className="ml-1.5 text-[11px] text-[var(--fg-subtle)]">
              {p.source === 'affinity'
                ? p.kind === 'firm'
                  ? 'firm, from Affinity'
                  : 'from Affinity'
                : 'imported contact'}
            </span>
            {why.length > 0 ? (
              <span className="block text-xs text-[var(--fg-subtle)]">{why.join(' · ')}</span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Open roles at portfolio companies, from the weekly jobs routine's snapshot
 * in #deal-relay. Postings on boards with a public API are checked (cached a
 * day); a slow board never holds the tab, it fills in for the next view.
 */
async function JobsTab({
  auth,
  params,
}: {
  auth: AuthContext;
  params: Record<string, string | string[] | undefined>;
}) {
  const now = new Date();
  const store = getStore();
  const view = parseJobsView(params);
  const [jobs, companies] = await Promise.all([
    readPortfolioJobs(store, auth.organizationId, { now }).catch(() => null),
    listPortfolio(auth.organizationId).catch(() => []),
  ]);
  // The public board (D-077): its header on every view, and the scan's
  // emailed roles brought in as drafts waiting for approval. Never throws.
  const board = await loadJobsBoardTab(
    store,
    auth.organizationId,
    jobs?.state === 'ok' ? (jobs.snapshot?.roles ?? null) : null,
  );
  const header = <JobsBoardHeader data={board} view={view} />;
  if (board.available && view !== 'email') {
    return (
      <>
        {header}
        {view === 'approvals' ? (
          <JobApprovalsView data={board} timeZone={auth.profile.timezone} />
        ) : view === 'board' ? (
          <JobBoardRolesView
            data={board}
            filter={single(params.show) ?? null}
            timeZone={auth.profile.timezone}
          />
        ) : (
          <JobCompaniesView data={board} now={now} />
        )}
      </>
    );
  }
  if (jobs?.state !== 'ok') {
    return (
      <>
        {header}
        <EmptyState
          title="No open roles to show"
          description={snapshotUnavailable(jobs?.state)}
          action={{ label: 'See companies', href: COMPANIES_HREF }}
        />
      </>
    );
  }
  if (!jobs.snapshot) {
    return (
      <>
        {header}
        <EmptyState
          title="No jobs scan yet"
          description="Once a week a scan reads founders' investor updates and their “we're hiring, know anyone?” emails for open roles: what each role is, how far along, who to send candidates to. They show here after its first run."
          action={{ label: 'See companies', href: COMPANIES_HREF }}
        />
      </>
    );
  }
  const verdicts = await jobLinkVerdicts(jobs.snapshot.roles, { now });
  return (
    <>
      {header}
      <PortfolioJobsView
        snapshot={jobs.snapshot}
        roles={applyJobLiveness(jobs.snapshot.roles, verdicts)}
        filters={parseJobFilters(params)}
        companies={companies}
        mailbox={DEFAULT_MAILBOX}
        now={now}
        timeZone={auth.profile.timezone}
        shownRaw={params[SHOW_PARAM]}
      />
    </>
  );
}

/**
 * Company-reported numbers from their update emails, stored and refreshed from
 * Gmail in the background; streams in on its own.
 */
async function NumbersTab({ auth }: { auth: AuthContext }) {
  const companies = await listPortfolio(auth.organizationId);
  if (companies.length === 0) {
    return (
      <EmptyState
        title="No numbers yet"
        description="Numbers show here once portfolio companies are added and send their updates."
        action={{ label: 'See companies', href: COMPANIES_HREF }}
      />
    );
  }
  return (
    <Suspense fallback={<SkeletonText lines={4} className="mb-8" />}>
      <PortfolioNumbers
        organizationId={auth.organizationId}
        companies={companies}
        timeZone={auth.profile.timezone}
      />
    </Suspense>
  );
}

/**
 * Every row of the lists that feed Portfolio as founders: Affinity's
 * portfolio founder lists and any list of the portfolio itself, people and
 * companies alike. Companies shows the founders that match one of its
 * companies; this is the whole set, so a founder with a personal address or
 * a company Copilot does not have yet is never lost.
 */
function FoundersTab({
  auth,
  q,
  list,
  page,
}: {
  auth: AuthContext;
  q: string;
  list: string | null;
  page: string | string[] | undefined;
}) {
  return (
    <AffinityEntries
      auth={auth}
      destinations="portfolio_people"
      path={PORTFOLIO_TABS.path}
      tab="founders"
      defaultTab={PORTFOLIO_TABS.defaultKey}
      params={{ q, list, page }}
      title="Founders from Affinity"
      searchLabel="Search founders"
      searchPlaceholder="Search name"
      statusHeader="Status"
      preferFields={/company|organi[sz]ation|role|title|position|stage|sector/i}
      emptyTitle="No founder lists from Affinity yet"
      emptyDescription="Affinity's portfolio founder lists, and any list of the portfolio itself, land here once they are imported on Knowledge."
    />
  );
}

/**
 * Nick's personal angel investments, from Affinity's angel list. Read-only and
 * labelled as his own, so they are never read as part of the Fund I
 * portfolio the other tabs cover.
 */
function AngelTab({
  auth,
  q,
  list,
  page,
}: {
  auth: AuthContext;
  q: string;
  list: string | null;
  page: string | string[] | undefined;
}) {
  return (
    <AffinityEntries
      auth={auth}
      destinations="angel"
      path={PORTFOLIO_TABS.path}
      tab="angel"
      defaultTab={PORTFOLIO_TABS.defaultKey}
      params={{ q, list, page }}
      title="Angel investments"
      searchLabel="Search angel investments"
      searchPlaceholder="Search company name"
      statusHeader="Status"
      preferFields={/year|date|round|stage|sector|industry/i}
      above={
        <Notice>
          Nick&rsquo;s personal angel investments, carried over from Affinity. Not Fund I: they are
          not in the portfolio counts, health or numbers. Read-only here.
        </Notice>
      }
      emptyTitle="No angel investments from Affinity yet"
      emptyDescription="Nick's angel list from Affinity lands here once it is imported on Knowledge."
    />
  );
}

async function CompaniesTab({ auth }: { auth: AuthContext }) {
  const companies = await listPortfolio(auth.organizationId);
  // Each company's people (saved here, from Affinity, from the mail) and when
  // the fund was last in touch. Derived on read, never written; never fails.
  const people = await loadPortfolioContacts(getStore(), auth.organizationId, companies);
  return (
    <section>
      <SectionHeading count={companies.length}>Companies</SectionHeading>
      {companies.length === 0 ? (
        <EmptyState
          title="No portfolio companies yet"
          description="Add one manually or import a CSV. Portfolio email is linked automatically by domain once a company exists."
        />
      ) : (
        <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)]">
          {companies.map((company) => {
            const contacts = (people[company.id]?.contacts ?? []).slice(0, CARD_CONTACTS);
            const lastContactAt = people[company.id]?.lastContactAt ?? company.last_contact_at;
            return (
              <li key={company.id}>
                <Link
                  href={`/portfolio/${company.id}`}
                  className="block px-4 py-3.5 transition-colors hover:bg-[var(--bg-hover)]"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-serif text-base font-semibold">{company.name}</span>
                    <span className="flex flex-wrap items-center gap-1.5">
                      {company.sector ? <Badge tone="neutral">{company.sector}</Badge> : null}
                      {company.current_stage ? (
                        <Badge tone="outline">{company.current_stage}</Badge>
                      ) : null}
                    </span>
                  </div>
                  {company.geography ? (
                    <p className="mt-0.5 text-xs text-[var(--fg-subtle)]">{company.geography}</p>
                  ) : null}
                  {company.description ? (
                    <p className="mt-1 text-sm text-[var(--fg-muted)]">{company.description}</p>
                  ) : null}
                  {company.key_metrics ? (
                    <p className="mt-1 text-sm text-[var(--fg-muted)]">{company.key_metrics}</p>
                  ) : null}
                  {contacts.length > 0 ? (
                    <p className="mt-1 text-sm">
                      <span className="text-[var(--fg-subtle)]">Contacts: </span>
                      {contacts.map((c, i) => {
                        const from = provenanceLabel(c.sources);
                        return (
                          <span key={`${c.email ?? c.name}-${i}`}>
                            {i > 0 ? ' · ' : ''}
                            {c.role ? `${c.name}, ${c.role}` : c.name}
                            {from ? (
                              <span className="text-[11px] text-[var(--fg-subtle)]"> ({from})</span>
                            ) : null}
                          </span>
                        );
                      })}
                    </p>
                  ) : null}
                  <p className="mt-1 text-xs text-[var(--fg-subtle)]">
                    {[
                      company.current_priorities ? `Priority: ${company.current_priorities}` : null,
                      lastContactAt
                        ? `Last contact ${relativeTime(lastContactAt)}`
                        : 'No contact recorded',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
