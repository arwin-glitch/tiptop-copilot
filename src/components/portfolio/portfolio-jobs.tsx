import Link from 'next/link';
import { ExternalLink, Mail } from 'lucide-react';
import {
  JOB_FUNCTION_LABELS,
  JOB_STATUS_FILTERS,
  JOB_STATUS_LABELS,
  JOBS_CADENCE_DAYS,
  companyForRole,
  filterJobRoles,
  jobBlurb,
  jobFilterParams,
  jobPlace,
  jobsFreshness,
  sameJobCompany,
  type JobFilters,
  type JobFunction,
  type JobRole,
  type JobStatus,
  type JobStatusFilter,
  type JobsSnapshot,
} from '@/lib/portfolio/jobs';
import { PORTFOLIO_TABS } from '@/lib/records-tabs';
import { SHOW_PARAM, showMoreHref, shownCount } from '@/lib/util/page-tabs';
import { formatDate, formatMonthDay, relativeTime } from '@/lib/util/time';
import type { PortfolioCompany } from '@/lib/types/domain';
import { LinkChips, pageHref, type LinkChip } from '@/components/crm/link-chips';
import { ThreadLinks } from '@/components/email/thread-links';
import { SectionHeading } from '@/components/shell/page-header';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState, Notice } from '@/components/ui/feedback';
import { LiveSearch } from '@/components/ui/live-search';
import { ShowMore } from '@/components/ui/show-more';
import { CopyBlurbButton } from './copy-blurb-button';

/**
 * The Jobs tab on Portfolio: open roles founders keep sending, from the
 * weekly jobs routine's snapshot. Filters live in the URL (`status`,
 * `company`, `fn`, `q`) and the server renders the result, like the tabs.
 * Every value is plain text; a source email is its subject and date with the
 * two places to read it (Copilot's Inbox, or Gmail), rebuilt from its id.
 */

const TAB = 'jobs';
const STEP = 20;

const STATUS_TONE: Record<JobStatus, BadgeProps['tone']> = {
  active: 'ok',
  probably_filled: 'warn',
  filled: 'info',
  closed: 'neutral',
};

const FILTER_LABEL: Record<JobStatusFilter, string> = { ...JOB_STATUS_LABELS, all: 'All' };

function hrefFor(filters: JobFilters): string {
  return pageHref(
    PORTFOLIO_TABS.path,
    { tab: TAB, ...jobFilterParams(filters) },
    PORTFOLIO_TABS.defaultKey,
  );
}

/** The link to the Jobs tab, optionally filtered to one company. */
export function jobsTabHref(company?: string | null): string {
  return hrefFor({ status: 'active', company: company ?? null, fn: null, q: '' });
}

export function PortfolioJobsView({
  snapshot,
  roles,
  filters,
  companies,
  mailbox,
  now,
  timeZone,
  shownRaw,
}: {
  snapshot: JobsSnapshot;
  /** The snapshot's roles with any job-board verdicts folded in. */
  roles: readonly JobRole[];
  filters: JobFilters;
  /** Portfolio companies, to link a role to its company's page. */
  companies: readonly PortfolioCompany[];
  /** The mailbox the routine read, for Gmail links. */
  mailbox: string;
  now: Date;
  timeZone: string;
  shownRaw: string | string[] | undefined;
}) {
  const visible = filterJobRoles(roles, filters);
  const shown = shownCount(shownRaw, STEP, Math.max(visible.length, STEP));
  const page = visible.slice(0, shown);
  const freshness = jobsFreshness(snapshot.runAt, now);

  // Chips: each filter's counts with the other filters applied.
  const byStatus = filterJobRoles(roles, filters, 'status');
  const statusChips: LinkChip[] = JOB_STATUS_FILTERS.map((status) => ({
    key: status,
    label: FILTER_LABEL[status],
    count: status === 'all' ? byStatus.length : byStatus.filter((r) => r.status === status).length,
    href: hrefFor({ ...filters, status }),
    active: filters.status === status,
  }));

  const byFunction = filterJobRoles(roles, filters, 'fn');
  const functions = new Map<JobFunction, number>();
  for (const r of byFunction) functions.set(r.function, (functions.get(r.function) ?? 0) + 1);
  if (filters.fn && !functions.has(filters.fn)) functions.set(filters.fn, 0);
  const functionChips: LinkChip[] = [
    {
      key: 'any',
      label: 'Any team',
      count: byFunction.length,
      href: hrefFor({ ...filters, fn: null }),
      active: filters.fn === null,
    },
    ...[...functions.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([fn, count]) => ({
        key: fn,
        label: JOB_FUNCTION_LABELS[fn],
        count,
        href: hrefFor({ ...filters, fn }),
        active: filters.fn === fn,
      })),
  ];

  const byCompany = filterJobRoles(roles, filters, 'company');
  const companyCounts: { name: string; count: number }[] = [];
  for (const r of byCompany) {
    const entry = companyCounts.find((c) => sameJobCompany(c.name, r.company));
    if (entry) entry.count++;
    else companyCounts.push({ name: r.company, count: 1 });
  }
  if (filters.company && !companyCounts.some((c) => sameJobCompany(c.name, filters.company!))) {
    companyCounts.push({ name: filters.company, count: 0 });
  }
  const companyChips: LinkChip[] = [
    {
      key: 'all-companies',
      label: 'Every company',
      count: byCompany.length,
      href: hrefFor({ ...filters, company: null }),
      active: filters.company === null,
    },
    ...companyCounts
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .map((c) => ({
        key: `company-${c.name}`,
        label: c.name,
        count: c.count,
        href: hrefFor({ ...filters, company: c.name }),
        active: filters.company !== null && sameJobCompany(c.name, filters.company),
      })),
  ];

  const keep: Record<string, string> = { tab: TAB, ...jobFilterParams({ ...filters, q: '' }) };
  const filtered =
    filters.status !== 'active' || filters.company !== null || filters.fn !== null || filters.q;

  return (
    <section aria-label="Open roles at portfolio companies" data-tour="jobs-roles">
      <SectionHeading count={visible.length}>Open roles</SectionHeading>
      <p className="-mt-1 mb-3 text-sm text-[var(--fg-muted)]">
        Roles founders list in their investor updates and hiring emails, read by a weekly scan of
        the mailbox. Scanned {relativeTime(snapshot.runAt, now)}
        {snapshot.emailsScanned !== null
          ? ` · ${snapshot.emailsScanned} ${snapshot.emailsScanned === 1 ? 'email' : 'emails'} read`
          : ''}
        {snapshot.scannedSince ? ` since ${formatDate(snapshot.scannedSince, timeZone)}` : ''}.
      </p>

      <div className="mb-4 space-y-3">
        {freshness.stale ? (
          <Notice tone="warn">
            The weekly scan last ran {formatDate(snapshot.runAt, timeZone)}, {freshness.days} days
            ago, so roles may have changed since. It should run every {JOBS_CADENCE_DAYS} days.
          </Notice>
        ) : null}
        {snapshot.partial ? (
          <Notice>The latest scan is still posting. This shows the part that has arrived.</Notice>
        ) : null}
        {snapshot.dropped > 0 ? (
          <Notice>
            {snapshot.dropped} {snapshot.dropped === 1 ? 'role' : 'roles'} in the scan could not be
            read and {snapshot.dropped === 1 ? 'is' : 'are'} left out.
          </Notice>
        ) : null}
        <LinkChips label="Filter roles by status" chips={statusChips} />
        {functionChips.length > 2 ? (
          <LinkChips label="Filter roles by team" chips={functionChips} />
        ) : null}
        {companyChips.length > 2 || filters.company ? (
          <LinkChips label="Filter roles by company" chips={companyChips} />
        ) : null}
        <LiveSearch
          path={PORTFOLIO_TABS.path}
          keep={keep}
          reset={[SHOW_PARAM]}
          value={filters.q}
          placeholder="Search title, company or place"
          label="Search open roles"
          className="max-w-sm"
        />
      </div>

      {roles.length === 0 ? (
        <EmptyState
          title="No open roles in the latest scan"
          description="The weekly scan read founders' investor updates and hiring emails and found no roles. New ones show here after the next run."
        />
      ) : visible.length === 0 ? (
        <EmptyState
          title="No roles match"
          description={
            filters.status === 'active'
              ? 'Nothing open matches these filters. Try All, or clear the filters.'
              : 'Nothing matches these filters.'
          }
          action={filtered ? { label: 'Clear filters', href: jobsTabHref() } : undefined}
        />
      ) : (
        <>
          <ul className="space-y-3" aria-label="Roles">
            {page.map((role) => (
              <li key={role.id}>
                <JobCard
                  role={role}
                  company={companyForRole(role, companies)}
                  mailbox={mailbox}
                  timeZone={timeZone}
                />
              </li>
            ))}
          </ul>
          <ShowMore
            shown={page.length}
            total={visible.length}
            step={STEP}
            href={showMoreHref(
              PORTFOLIO_TABS.path,
              { tab: TAB, ...jobFilterParams(filters) },
              shown,
              STEP,
            )}
          />
        </>
      )}
    </section>
  );
}

function JobCard({
  role,
  company,
  mailbox,
  timeZone,
}: {
  role: JobRole;
  company: PortfolioCompany | null;
  mailbox: string;
  timeZone: string;
}) {
  const place = jobPlace(role);
  const details = [
    role.function !== 'other' ? JOB_FUNCTION_LABELS[role.function] : null,
    role.seniority,
    role.comp,
  ].filter((d): d is string => Boolean(d));
  const name = `${role.title} at ${role.company}`;

  return (
    <Card>
      <CardContent className="pt-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="font-serif text-base font-semibold break-words">{role.title}</h3>
            <p className="text-sm break-words text-[var(--fg-muted)]">
              {company ? (
                <Link
                  href={`/portfolio/${company.id}`}
                  className="font-medium text-[var(--fg)] underline-offset-2 hover:underline"
                >
                  {role.company}
                </Link>
              ) : (
                <span className="font-medium text-[var(--fg)]">{role.company}</span>
              )}
              {place ? ` · ${place}` : ''}
            </p>
          </div>
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge tone={STATUS_TONE[role.status]}>{JOB_STATUS_LABELS[role.status]}</Badge>
            {!role.is_portfolio && !company ? (
              <Badge tone="outline">Not in the portfolio</Badge>
            ) : null}
          </span>
        </div>

        {role.status_note ? (
          <p className="mt-2 text-sm break-words">
            <span className="text-[var(--fg-subtle)]">Founder&rsquo;s note: </span>
            &ldquo;{role.status_note}&rdquo;
          </p>
        ) : null}
        {details.length > 0 ? (
          <p className="mt-1 text-sm break-words text-[var(--fg-muted)]">{details.join(' · ')}</p>
        ) : null}
        <p className="mt-1 text-xs text-[var(--fg-subtle)]">
          First seen {formatMonthDay(role.first_seen, timeZone)} · Last seen{' '}
          {formatMonthDay(role.last_seen, timeZone)} · Sent {role.times_mentioned}{' '}
          {role.times_mentioned === 1 ? 'time' : 'times'}
        </p>

        <p className="mt-2 text-sm break-words">
          <span className="text-[var(--fg-subtle)]">Send candidates to: </span>
          {role.contact_name || role.contact_email ? (
            <>
              {role.contact_name ? <span className="font-medium">{role.contact_name}</span> : null}
              {role.contact_name && role.contact_email ? ' · ' : null}
              {role.contact_email ? (
                <a
                  href={`mailto:${role.contact_email}`}
                  className="text-[var(--accent)] underline-offset-2 hover:underline"
                >
                  {role.contact_email}
                </a>
              ) : null}
            </>
          ) : (
            <span className="text-[var(--fg-muted)]">
              not named in the emails; reply on the latest one
            </span>
          )}
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {role.link ? (
            <Button asChild size="sm" variant="secondary">
              <a
                href={role.link}
                target="_blank"
                rel="noopener noreferrer nofollow"
                aria-label={`Job posting: ${name}`}
              >
                <ExternalLink aria-hidden="true" />
                Job posting
              </a>
            </Button>
          ) : null}
          <CopyBlurbButton text={jobBlurb(role)} label={`Copy blurb: ${name}`} />
        </div>

        {role.sources.length > 0 ? (
          <details className="mt-3">
            <summary className="cursor-pointer text-sm text-[var(--accent)]">
              {role.sources.length === 1
                ? 'Source email'
                : `Source emails (${role.sources.length})`}
            </summary>
            <ul className="mt-2 space-y-1.5" aria-label={`Source emails for ${name}`}>
              {role.sources.map((s) => (
                <li
                  key={s.message_id}
                  className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 text-sm"
                >
                  <span className="flex min-w-0 items-start gap-2">
                    <Mail
                      className="mt-0.5 size-3.5 shrink-0 text-[var(--fg-subtle)]"
                      aria-hidden="true"
                    />
                    <span className="min-w-0 break-words">
                      {s.subject}
                      <span className="text-xs text-[var(--fg-subtle)]">
                        {' '}
                        · {formatDate(s.date, timeZone)}
                      </span>
                    </span>
                  </span>
                  <ThreadLinks id={s.message_id} mailbox={mailbox} label={s.subject} />
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}
