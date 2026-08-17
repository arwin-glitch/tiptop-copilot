import type { Metadata } from 'next';
import Link from 'next/link';
import { requireAuth } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { listPortfolio, openRequests } from '@/lib/services/portfolio';
import { PageHeader, PageShell, SectionHeading } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, FieldLabel } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/feedback';
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

export default async function PortfolioPage() {
  const auth = await requireAuth();
  const store = getStore();

  const [companies, requests, contacts] = await Promise.all([
    listPortfolio(auth.organizationId),
    openRequests(auth.organizationId),
    store.list('network_contacts', auth.organizationId, {}) as Promise<NetworkContact[]>,
  ]);

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
                                  <span className="font-medium text-[var(--fg)]">
                                    {c.full_name}
                                  </span>
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
                    {company.current_stage ? (
                      <Badge tone="outline">{company.current_stage}</Badge>
                    ) : null}
                  </div>
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
    </PageShell>
  );
}
