import { ExternalLink, Eye, Globe } from 'lucide-react';
import { ATS_LABELS, atsBoardUrl } from '@/lib/jobs-board/ats';
import { isCareersPageRole } from '@/lib/jobs-board/careers-page';
import { functionLabel, placeLine, SENIORITY_LABELS } from '@/lib/jobs-board/fields';
import { PUBLIC_STATE_LABELS, applyLinkFor, type PublicState } from '@/lib/jobs-board/public';
import { isPrivateDocLink } from '@/lib/jobs-board/links';
import { PORTFOLIO_TABS } from '@/lib/records-tabs';
import { formatMonthDay, relativeTime } from '@/lib/util/time';
import type { JobPosting } from '@/lib/types/domain';
import { LinkChips, pageHref, type LinkChip } from '@/components/crm/link-chips';
import { SectionHeading } from '@/components/shell/page-header';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState, Notice } from '@/components/ui/feedback';
import {
  BoardSwitch,
  BoardTextButton,
  CompanyJobsForm,
  CopyBoardLink,
  RefreshButton,
  RoleActions,
  RoleEditorButton,
  type CompanyOption,
} from './board-client';
import { JobsAssistantButton } from './assistant-panel';
import type { JobsBoardTab, JobsView } from './data';

/**
 * Portfolio > Jobs, the public board's half: the header every Jobs view
 * shows (the board's switch, "View public board" and its link), the views'
 * chips, and the Approvals, Public board and Companies views. The "From
 * email" view is the original Jobs list (portfolio-jobs.tsx).
 */

const MIGRATION = 'supabase/migrations/20261022100000_public_jobs.sql';

export function jobsViewHref(view: JobsView, extra: Record<string, string> = {}): string {
  return pageHref(
    PORTFOLIO_TABS.path,
    { tab: 'jobs', view: view === 'email' ? null : view, ...extra },
    PORTFOLIO_TABS.defaultKey,
  );
}

const SOURCE_LABELS: Record<JobPosting['source'], string> = {
  ats: 'From its job board',
  email: 'From founders’ emails',
  manual: 'Added by hand',
};

/** Where a role came from; a board role read from a careers page's own data says so. */
function sourceLabel(posting: Pick<JobPosting, 'source' | 'source_key'>): string {
  return isCareersPageRole(posting) ? 'From careers page' : SOURCE_LABELS[posting.source];
}

const STATE_TONE: Record<PublicState, BadgeProps['tone']> = {
  public: 'ok',
  closed: 'neutral',
  hidden: 'neutral',
  needs_approval: 'warn',
  not_published: 'outline',
  auto_publish_off: 'outline',
  stale: 'warn',
  no_apply_link: 'warn',
  company_gone: 'neutral',
};

export function JobsBoardHeader({ data, view }: { data: JobsBoardTab; view: JobsView }) {
  const previewFirst = data.available && !data.enabled;
  const publicRoles = data.board.jobs.length;
  const publicCompanies = data.board.companies.filter((c) => c.openRoles > 0).length;
  const chips: LinkChip[] = [
    { key: 'email', label: 'From email', href: jobsViewHref('email'), active: view === 'email' },
    {
      key: 'approvals',
      label: 'Approvals',
      count: data.pending.length,
      href: jobsViewHref('approvals'),
      active: view === 'approvals',
      attention: data.pending.length > 0,
    },
    {
      key: 'board',
      label: 'Public board',
      count: publicRoles,
      href: jobsViewHref('board'),
      active: view === 'board',
    },
    {
      key: 'companies',
      label: 'Companies',
      href: jobsViewHref('companies'),
      active: view === 'companies',
    },
  ];

  return (
    <section aria-label="Public job board" className="mb-5">
      <Card>
        <CardContent className="pt-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="flex flex-wrap items-center gap-2 font-serif text-base font-semibold">
                <Globe className="size-4 text-[var(--fg-subtle)]" aria-hidden="true" />
                Public job board
                {data.available ? (
                  <Badge tone={data.enabled ? 'ok' : 'neutral'}>
                    {data.enabled ? 'Live' : 'Off'}
                  </Badge>
                ) : (
                  <Badge tone="warn">Needs setup</Badge>
                )}
              </h2>
              <p className="mt-1 text-sm text-[var(--fg-muted)]">
                {!data.available
                  ? 'The board needs its database tables before it can be switched on. Roles from email below keep working.'
                  : data.enabled
                    ? `Anyone can see it. ${publicRoles} ${publicRoles === 1 ? 'role' : 'roles'} from ${publicCompanies} ${publicCompanies === 1 ? 'company' : 'companies'} are public.`
                    : `Off: visitors see a "coming soon" page with no roles. ${publicRoles} ${publicRoles === 1 ? 'role is' : 'roles are'} ready to show when it is on.`}
              </p>
              {data.available && data.pending.length > 0 ? (
                <p className="mt-1 text-sm">
                  <a
                    href={jobsViewHref('approvals')}
                    className="font-medium text-[var(--warn)] hover:underline"
                  >
                    {data.pending.length} emailed{' '}
                    {data.pending.length === 1 ? 'role waits' : 'roles wait'} for approval →
                  </a>
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2" data-tour="jobs-board">
              {previewFirst ? (
                // While the board is off the public page only says "coming
                // soon", so the first button shows the board as it will look.
                <Button asChild size="sm" variant="primary">
                  <a href="/jobs-preview" target="_blank" rel="noopener noreferrer">
                    <Eye aria-hidden="true" />
                    Preview board
                  </a>
                </Button>
              ) : null}
              <Button asChild size="sm" variant={previewFirst ? 'secondary' : 'primary'}>
                <a href={data.publicHref} target="_blank" rel="noopener noreferrer">
                  <ExternalLink aria-hidden="true" />
                  {previewFirst ? 'View public board (coming soon)' : 'View public board'}
                </a>
              </Button>
              <CopyBoardLink href={data.publicHref} />
              {data.available ? (
                <>
                  <BoardSwitch enabled={data.enabled} />
                  <BoardTextButton
                    title={data.settings?.title ?? data.board.title}
                    intro={data.settings?.intro ?? ''}
                    accent={data.settings?.accent ?? data.board.accent}
                  />
                  <JobsAssistantButton />
                </>
              ) : null}
            </div>
          </div>
          {!data.available ? (
            <Notice tone="warn" className="mt-3">
              Run {MIGRATION} in the Supabase SQL editor. Until then the public pages say
              &ldquo;coming soon&rdquo;.
            </Notice>
          ) : null}
        </CardContent>
      </Card>
      {data.available ? (
        <div data-tour="jobs-views">
          <LinkChips label="Jobs views" chips={chips} className="mt-3" />
        </div>
      ) : null}
    </section>
  );
}

function companyName(data: JobsBoardTab, id: string): string {
  return data.portfolio.find((p) => p.id === id)?.name ?? 'Portfolio company';
}

function companyOptions(data: JobsBoardTab): CompanyOption[] {
  return data.portfolio
    .map((p) => ({ id: p.id, name: p.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function RoleSummary({
  data,
  posting,
  timeZone,
  now,
}: {
  data: JobsBoardTab;
  posting: JobPosting;
  timeZone: string;
  /** Set on Approvals: how long ago the founder first mentioned the role. */
  now?: Date;
}) {
  const place = placeLine(posting.locations, posting.remote);
  const details = [
    posting.job_function !== 'other' ? functionLabel(posting.job_function) : null,
    posting.seniority ? SENIORITY_LABELS[posting.seniority] : null,
    posting.comp,
  ].filter(Boolean);
  const apply = applyLinkFor(
    posting,
    data.companyByPortfolio.get(posting.portfolio_company_id) ?? null,
  );
  return (
    <div className="min-w-0">
      <h3 className="font-serif text-base font-semibold break-words">{posting.title}</h3>
      <p className="text-sm break-words text-[var(--fg-muted)]">
        <span className="font-medium text-[var(--fg)]">
          {companyName(data, posting.portfolio_company_id)}
        </span>
        {place ? ` · ${place}` : ''}
      </p>
      {details.length > 0 ? (
        <p className="mt-0.5 text-sm text-[var(--fg-muted)]">{details.join(' · ')}</p>
      ) : null}
      <p className="mt-1 text-xs break-all text-[var(--fg-subtle)]">
        {apply ? (
          <>
            Apply link:{' '}
            <a
              href={apply}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="text-[var(--accent)] hover:underline"
            >
              {apply.replace(/^https?:\/\//, '').slice(0, 80)}
            </a>
          </>
        ) : (
          'No apply link yet: add one with Edit, or a careers page on Companies.'
        )}
        {posting.posted_at
          ? now && posting.source === 'email'
            ? ` · first mentioned ${relativeTime(posting.posted_at, now)}`
            : ` · since ${formatMonthDay(posting.posted_at, timeZone)}`
          : ''}
      </p>
    </div>
  );
}

/* --------------------------------------------------------- approvals -- */

export function JobApprovalsView({
  data,
  timeZone,
  now = new Date(),
}: {
  data: JobsBoardTab;
  timeZone: string;
  now?: Date;
}) {
  const options = companyOptions(data);
  return (
    <section aria-label="Roles waiting for approval">
      <SectionHeading count={data.pending.length}>Waiting for approval</SectionHeading>
      <p className="-mt-1 mb-3 text-sm text-[var(--fg-muted)]">
        Roles founders emailed Nick, from the weekly jobs scan. None is public until you approve it.
        Only the title, company, place, level and the job link go on the board; the people to send
        candidates to, the founders&rsquo; notes and the emails never do.
      </p>
      {data.pending.length === 0 ? (
        <EmptyState
          title="Nothing waiting"
          description="Emailed roles at portfolio companies land here as drafts after the jobs scan. A role the company already lists on its own job board is not added twice."
        />
      ) : (
        <ul className="space-y-3" aria-label="Roles to approve">
          {data.pending.map((posting) => {
            const privateLink = isPrivateDocLink(posting.apply_url);
            return (
              <li key={posting.id}>
                <Card>
                  <CardContent className="pt-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <RoleSummary data={data} posting={posting} timeZone={timeZone} now={now} />
                      <Badge tone="warn">{SOURCE_LABELS.email}</Badge>
                    </div>
                    {privateLink ? (
                      <Notice tone="warn" className="mt-3">
                        The founder&rsquo;s link is a shared document, which may be private. Open it
                        and check that anyone can see it before approving, or use Edit to point the
                        role at the company&rsquo;s careers page.
                      </Notice>
                    ) : null}
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <RoleActions
                        id={posting.id}
                        title={posting.title}
                        isPublic={false}
                        hidden={false}
                        closed={false}
                        featured={false}
                        source="email"
                        approveLabel={privateLink ? 'Link checked: approve' : 'Approve and publish'}
                        confirmLink={privateLink}
                      />
                      <RoleEditorButton companies={options} posting={posting} />
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

/* ------------------------------------------------------- public board -- */

const BOARD_FILTERS = ['public', 'not_public', 'hidden', 'closed'] as const;
type BoardFilter = (typeof BOARD_FILTERS)[number];
const BOARD_FILTER_LABELS: Record<BoardFilter, string> = {
  public: 'Public',
  not_public: 'Not public',
  hidden: 'Hidden',
  closed: 'Closed',
};

function filterOf(state: PublicState): BoardFilter {
  if (state === 'public') return 'public';
  if (state === 'hidden') return 'hidden';
  if (state === 'closed' || state === 'company_gone') return 'closed';
  return 'not_public';
}

export function JobBoardRolesView({
  data,
  filter: rawFilter,
  timeZone,
}: {
  data: JobsBoardTab;
  filter: string | null;
  timeZone: string;
}) {
  const filter: BoardFilter = (BOARD_FILTERS as readonly string[]).includes(rawFilter ?? '')
    ? (rawFilter as BoardFilter)
    : 'public';
  // Emailed roles still waiting are on Approvals.
  const roles = data.postings.filter(
    (p) => !(p.source === 'email' && !p.approved_at && p.status === 'active' && !p.hidden_at),
  );
  const counts = new Map<BoardFilter, number>();
  for (const p of roles) {
    const f = filterOf(data.states.get(p.id) ?? 'not_published');
    counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  const chips: LinkChip[] = BOARD_FILTERS.map((f) => ({
    key: f,
    label: BOARD_FILTER_LABELS[f],
    count: counts.get(f) ?? 0,
    href: jobsViewHref('board', f === 'public' ? {} : { show: f }),
    active: filter === f,
  }));
  const visible = roles
    .filter((p) => filterOf(data.states.get(p.id) ?? 'not_published') === filter)
    .sort(
      (a, b) =>
        Number(b.featured) - Number(a.featured) ||
        companyName(data, a.portfolio_company_id).localeCompare(
          companyName(data, b.portfolio_company_id),
        ) ||
        a.title.localeCompare(b.title),
    );
  const slugOf = (p: JobPosting) => data.companyByPortfolio.get(p.portfolio_company_id)?.slug;
  const boardBase = data.publicHref.replace(/\/+$/, '');

  return (
    <section aria-label="Roles on the public board">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <SectionHeading count={visible.length}>Roles</SectionHeading>
        <span className="flex flex-wrap gap-2">
          <RefreshButton label="Refresh now" />
          <RoleEditorButton companies={companyOptions(data)} />
        </span>
      </div>
      <p className="-mt-1 mb-3 text-sm text-[var(--fg-muted)]">
        Roles read from companies&rsquo; own job boards, added by hand, or approved from email.
        Publish puts a role on the board; Hide keeps it off, whatever later reads of its job board
        say.
      </p>
      <LinkChips label="Filter roles by public state" chips={chips} className="mb-3" />
      {visible.length === 0 ? (
        <EmptyState
          title={
            filter === 'public'
              ? 'Nothing public yet'
              : `No ${BOARD_FILTER_LABELS[filter].toLowerCase()} roles`
          }
          description={
            filter === 'public'
              ? 'Approve emailed roles, add a role by hand, or give a company a careers page on a supported job board (Companies) and publish its roles.'
              : 'Nothing here.'
          }
          action={
            filter === 'public'
              ? { label: 'Set up companies', href: jobsViewHref('companies') }
              : undefined
          }
        />
      ) : (
        <ul className="space-y-3" aria-label="Board roles">
          {visible.map((posting) => {
            const state = data.states.get(posting.id) ?? 'not_published';
            const slug = slugOf(posting);
            return (
              <li key={posting.id}>
                <Card>
                  <CardContent className="pt-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <RoleSummary data={data} posting={posting} timeZone={timeZone} />
                      <span className="flex flex-wrap items-center gap-1.5">
                        <Badge tone={STATE_TONE[state]}>{PUBLIC_STATE_LABELS[state]}</Badge>
                        {posting.featured && state === 'public' ? (
                          <Badge tone="accent">Featured</Badge>
                        ) : null}
                        <Badge tone="outline">{sourceLabel(posting)}</Badge>
                      </span>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <RoleActions
                        id={posting.id}
                        title={posting.title}
                        isPublic={state === 'public'}
                        hidden={Boolean(posting.hidden_at)}
                        closed={posting.status !== 'active'}
                        featured={posting.featured}
                        source={posting.source}
                        approveLabel={state === 'stale' ? 'Still open: re-confirm' : undefined}
                        confirmLink={
                          posting.source === 'email' && isPrivateDocLink(posting.apply_url)
                        }
                      />
                      {posting.source !== 'ats' ? (
                        <RoleEditorButton companies={companyOptions(data)} posting={posting} />
                      ) : null}
                      {state === 'public' && slug ? (
                        <Button asChild size="sm" variant="link">
                          <a
                            href={`${boardBase}/${slug}/${posting.slug}`}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            View on the board
                          </a>
                        </Button>
                      ) : null}
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

/* ---------------------------------------------------------- companies -- */

export function JobCompaniesView({ data, now }: { data: JobsBoardTab; now: Date }) {
  const companies = [...data.portfolio].sort((a, b) => a.name.localeCompare(b.name));
  const counts = new Map<string, number>();
  for (const j of data.board.jobs) counts.set(j.companySlug, (counts.get(j.companySlug) ?? 0) + 1);

  return (
    <section aria-label="Companies on the job board">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <SectionHeading count={companies.length}>Companies</SectionHeading>
        <RefreshButton label="Refresh all now" />
      </div>
      <p className="-mt-1 mb-3 text-sm text-[var(--fg-muted)]">
        Give a company its careers page and Kraken reads its public job board every day: Greenhouse,
        Lever, Ashby, Workable and Recruitee, or the roles a careers page lists in its page data for
        search engines. Its roles go public only after you publish them, or on their own once you
        switch on &ldquo;Publish its board roles on their own&rdquo;. LinkedIn is only linked to,
        never read.
      </p>
      {companies.length === 0 ? (
        <EmptyState
          title="No portfolio companies"
          description="Add companies on the Companies tab first."
        />
      ) : (
        <ul className="space-y-3" aria-label="Company job settings">
          {companies.map((company) => {
            const settings = data.companyByPortfolio.get(company.id) ?? null;
            const board =
              settings?.ats && settings.ats_token
                ? { ats: settings.ats, token: settings.ats_token }
                : null;
            const open = settings ? (counts.get(settings.slug) ?? 0) : 0;
            const sync = settings?.last_sync_at
              ? `${settings.last_sync_status === 'ok' ? 'Read' : settings.last_sync_status === 'failed' ? 'Could not read' : 'Skipped'} ${relativeTime(settings.last_sync_at, now)}: ${settings.last_sync_message ?? ''}`
              : null;
            return (
              <li key={company.id}>
                <Card>
                  <CardContent className="pt-4">
                    <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h3 className="font-serif text-base font-semibold">{company.name}</h3>
                        <p className="text-xs text-[var(--fg-subtle)]">
                          {open} public {open === 1 ? 'role' : 'roles'}
                          {sync ? ` · ${sync}` : ''}
                        </p>
                      </div>
                      <span className="flex flex-wrap items-center gap-1.5">
                        {board ? (
                          <Badge tone="ok">
                            <a
                              href={atsBoardUrl(board)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="hover:underline"
                            >
                              {ATS_LABELS[board.ats]} · {board.token}
                            </a>
                          </Badge>
                        ) : settings?.careers_url && settings.sync_enabled ? (
                          <Badge tone="ok">Reads its careers page</Badge>
                        ) : settings?.careers_url ? (
                          <Badge tone="warn">No supported job board found</Badge>
                        ) : (
                          <Badge tone="outline">No careers page</Badge>
                        )}
                        {settings?.last_sync_status === 'failed' ? (
                          <Badge tone="danger">Last read failed</Badge>
                        ) : null}
                        {(board || settings?.careers_url) && settings?.sync_enabled ? (
                          <RefreshButton companyId={company.id} label="Refresh now" />
                        ) : null}
                      </span>
                    </div>
                    {settings?.careers_url && !board && !settings.sync_enabled ? (
                      <p className="mb-3 text-sm text-[var(--fg-muted)]">
                        Kraken can&rsquo;t read this company&rsquo;s job board (it may use Rippling,
                        BambooHR, Wellfound or its own page). Add its roles by hand with &ldquo;Add
                        a role&rdquo; on Public board, or switch on &ldquo;List it even with no open
                        roles&rdquo; so visitors get a link to its careers page. If the page later
                        lists its roles in its page data, switch on the daily read.
                      </p>
                    ) : null}
                    <CompanyJobsForm
                      companyId={company.id}
                      companyName={company.name}
                      careersUrl={settings?.careers_url ?? ''}
                      hasBoard={Boolean(board)}
                      linkedinUrl={settings?.linkedin_url ?? ''}
                      syncEnabled={Boolean(settings?.sync_enabled)}
                      autoPublish={Boolean(settings?.auto_publish)}
                      listed={Boolean(settings?.listed)}
                      logoUrl={settings?.logo_url ?? ''}
                      about={settings?.about ?? ''}
                      aboutFallback={company.description ?? ''}
                    />
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
