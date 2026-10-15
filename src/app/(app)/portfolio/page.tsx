import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { requireAuth, type AuthContext } from '@/lib/auth/session';
import { readFollowUps, readFollowUpsWithin } from '@/lib/services/follow-ups';
import { PortfolioHealthCard, snapshotUnavailable } from '@/components/followups/relay-cards';
import { getStore } from '@/lib/runtime';
import { listPortfolio, openRequests } from '@/lib/services/portfolio';
import { pullPortfolioFromSlack } from '@/lib/services/portfolio-ingest';
import { PORTFOLIO_TABS, SNAPSHOT_WAIT_MS, landsOnSnapshot, openingTab } from '@/lib/records-tabs';
import { tabHref } from '@/lib/util/page-tabs';
import { PageHeader, PageShell, SectionHeading } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, FieldLabel } from '@/components/ui/card';
import { EmptyState, SkeletonText } from '@/components/ui/feedback';
import { PageTabs } from '@/components/ui/page-tabs';
import { PortfolioNumbers } from '@/components/portfolio/portfolio-numbers';
import {
  AddPortfolioButton,
  ImportPortfolioButton,
  RequestActions,
} from '@/components/portfolio/portfolio-client';
import { CitationList } from '@/components/evidence/source-drawer';
import { PORTFOLIO_REQUEST_LABELS, type NetworkContact } from '@/lib/types/domain';
import { relativeTime } from '@/lib/util/time';

export const metadata: Metadata = { title: 'Portfolio' };
export const dynamic = 'force-dynamic';

const COMPANIES_HREF = tabHref(PORTFOLIO_TABS.path, 'companies', PORTFOLIO_TABS.defaultKey);

export default async function PortfolioPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
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

  // Head counts for the tab badges; a fault only drops the badge.
  const [openCount, companyCount] = await Promise.all([
    store
      .count('portfolio_updates', auth.organizationId, {
        eq: { status: 'open' },
        notNull: ['request_type'],
      })
      .catch(() => undefined),
    store
      .count('portfolio_companies', auth.organizationId, { eq: { is_archived: false } })
      .catch(() => undefined),
  ]);
  const counts: Partial<Record<string, number>> = {
    requests: openCount ? openCount : undefined,
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
          <RequestsTab auth={auth} />
        ) : tab === 'numbers' ? (
          <NumbersTab auth={auth} />
        ) : tab === 'companies' ? (
          <CompaniesTab auth={auth} />
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

async function RequestsTab({ auth }: { auth: AuthContext }) {
  const [companies, requests, contacts] = await Promise.all([
    listPortfolio(auth.organizationId),
    openRequests(auth.organizationId),
    getStore().list('network_contacts', auth.organizationId, {}) as Promise<NetworkContact[]>,
  ]);

  return (
    <section className="mb-8">
      <SectionHeading count={requests.length}>Open requests</SectionHeading>
      {requests.length === 0 ? (
        <EmptyState
          title="No open requests"
          description="Portfolio requests appear here when an update from a portfolio company is classified. Open a portfolio email in the Inbox and classify it."
          action={{ label: 'Go to Inbox', href: '/inbox?category=portfolio_company' }}
        />
      ) : (
        <ul className="space-y-3">
          {requests.map((update) => {
            const company = companies.find((c) => c.id === update.portfolio_company_id);
            const suggested = contacts.filter((c) =>
              update.suggested_network_contact_ids.includes(c.id),
            );
            return (
              <li key={update.id}>
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
                        {update.request_type ? (
                          <Badge tone={update.urgency === 'high' ? 'danger' : 'warn'}>
                            {PORTFOLIO_REQUEST_LABELS[update.request_type]}
                          </Badge>
                        ) : null}
                        {update.urgency ? (
                          <Badge tone="neutral">{update.urgency} urgency</Badge>
                        ) : null}
                      </p>
                      <span className="text-xs text-[var(--fg-subtle)]">
                        {relativeTime(update.occurred_at)}
                      </span>
                    </div>

                    <p className="mt-2 text-sm">{update.summary}</p>
                    {update.request_detail ? (
                      <p className="mt-1.5 text-sm text-[var(--fg-muted)]">
                        <span className="text-[var(--fg-subtle)]">Asked for: </span>
                        {update.request_detail}
                      </p>
                    ) : null}

                    {update.suggested_action ? (
                      <div className="mt-3 rounded-md bg-[var(--bg-sunken)] p-3">
                        <FieldLabel as="p">Suggested action</FieldLabel>
                        <p className="mt-1 text-sm">{update.suggested_action}</p>
                        {suggested.length > 0 ? (
                          <ul className="mt-2 space-y-1">
                            {suggested.map((c) => (
                              <li key={c.id} className="text-[13px] text-[var(--fg-muted)]">
                                <span className="font-medium text-[var(--fg)]">{c.full_name}</span>
                                {c.title ? ` — ${c.title}` : ''}
                                {c.company ? `, ${c.company}` : ''}
                                {c.relationship ? ` · ${c.relationship}` : ''}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="mt-2 text-xs text-[var(--fg-subtle)]">
                            No one in your uploaded network data matches this request. Nobody is
                            suggested rather than inventing a name.
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

                    <div className="mt-3">
                      <RequestActions
                        updateId={update.id}
                        portfolioCompanyId={update.portfolio_company_id}
                        emailMessageId={update.email_message_id}
                      />
                    </div>
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </section>
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

async function CompaniesTab({ auth }: { auth: AuthContext }) {
  const companies = await listPortfolio(auth.organizationId);
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
          {companies.map((company) => (
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
                <p className="mt-1 text-xs text-[var(--fg-subtle)]">
                  {[
                    company.current_priorities ? `Priority: ${company.current_priorities}` : null,
                    company.last_contact_at
                      ? `Last contact ${relativeTime(company.last_contact_at)}`
                      : 'No contact recorded',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
