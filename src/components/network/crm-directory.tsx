import Link from 'next/link';
import { ArrowDown, ArrowUp } from 'lucide-react';
import type { AuthContext } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { NETWORK_TABS } from '@/lib/records-tabs';
import {
  CONTACT_STATUS_LABELS,
  CONTACT_STATUS_THRESHOLDS,
  CONTACT_STATUSES,
  connectionsLabel,
  hasContactFilter,
  type ContactFilter,
} from '@/lib/network/contact-status';
import { CRM_MIGRATION_FILE, isCrmNotSetUp } from '@/lib/services/crm';
import {
  DIRECTORY_SCAN_MAX,
  listCrmDirectory,
  type DirectorySort,
} from '@/lib/services/crm-directory';
import { getPrimaryIntegration } from '@/lib/services/inbox';
import { relationshipScope } from '@/lib/services/relationships';
import { INDUSTRY_LABELS, recordField, TITLE_LABELS } from '@/lib/services/search-preview';
import type { CrmRecord, CrmRecordKind } from '@/lib/types/domain';
import { PAGE_PARAM, pageNumber, pageWindow } from '@/lib/util/page-tabs';
import { cn } from '@/lib/util/cn';
import { LinkChips, pageHref } from '@/components/crm/link-chips';
import {
  ContactStatusTag,
  formatContactDate,
  LastContactCell,
} from '@/components/network/contact-status-tag';
import { SectionHeading } from '@/components/shell/page-header';
import { EmptyState, ErrorState, Notice } from '@/components/ui/feedback';
import { LiveSearch } from '@/components/ui/live-search';
import { NotConfigured } from '@/components/ui/not-configured';
import { Pager } from '@/components/ui/pager';

const PATH = NETWORK_TABS.path;
const DEFAULT_TAB = NETWORK_TABS.defaultKey;
const PER_PAGE = 50;

export interface DirectoryParams {
  q: string;
  page: string | string[] | undefined;
  filter: ContactFilter;
  sort: DirectorySort;
  dir: 'asc' | 'desc';
}

const COPY: Record<
  CrmRecordKind,
  { source: string; title: string; search: string; placeholder: string; empty: string }
> = {
  person: {
    source: 'affinity',
    // The table's name is what the end-to-end suite and screen readers find it by.
    title: 'People from Affinity',
    search: 'Search Affinity people',
    placeholder: 'Search name or email',
    empty: 'People arrive with Affinity person lists and notes, imported on Knowledge.',
  },
  company: {
    source: 'companies',
    title: 'Companies from Affinity',
    search: 'Search Affinity companies',
    placeholder: 'Search name or domain',
    empty: 'Companies arrive with Affinity organization lists, imported on Knowledge.',
  },
};

/**
 * Network → People → All People / All Companies from the CRM, Affinity's
 * way: every row with its relationship status tag, Connections ("Nick
 * Tippmann & 2 more"), Last contact (green recent, amber older, muted lost),
 * first email and last meeting; filters for status, "contacted within N
 * days" and "not for more than N days"; sortable by any date column. The URL
 * holds every choice, so a view can be bookmarked or shared.
 */
export async function CrmDirectory({
  auth,
  kind,
  params,
}: {
  auth: AuthContext;
  kind: CrmRecordKind;
  params: DirectoryParams;
}) {
  const store = getStore();
  const copy = COPY[kind];
  const view = { tab: 'people', source: copy.source } as const;
  const { q, filter, sort, dir } = params;
  const state: Record<string, string | null> = {
    ...view,
    q: q || null,
    status: filter.status,
    within: filter.withinDays === null ? null : String(filter.withinDays),
    beyond: filter.beyondDays === null ? null : String(filter.beyondDays),
    sort: sort === 'name' ? null : sort,
    dir: sort === 'name' && dir === 'asc' ? null : dir,
  };
  const href = (changes: Record<string, string | null>) =>
    pageHref(PATH, { ...state, [PAGE_PARAM]: null, ...changes }, DEFAULT_TAB);

  const integration = await getPrimaryIntegration(store, auth.organizationId).catch(() => null);
  const scope = relationshipScope(auth.profile.email, integration);
  const asked = pageNumber(params.page);
  let offset = (asked - 1) * PER_PAGE;
  const read = (from: number) =>
    listCrmDirectory(
      store,
      auth.organizationId,
      { kind, query: q, filter, sort, dir, limit: PER_PAGE, offset: from },
      scope,
    );
  let result = await read(offset);
  // A page past the end (a stale link) shows the last one.
  if (result.ok && result.value.rows.length === 0 && asked > 1 && result.value.total > 0) {
    offset = pageWindow(asked, PER_PAGE, result.value.total).offset;
    result = await read(offset);
  }
  if (isCrmNotSetUp(result)) {
    return (
      <NotConfigured
        title="Affinity data is not set up yet"
        description={`The CRM tables have not been created in the database. Run ${CRM_MIGRATION_FILE} in the Supabase SQL editor, then reload this page.`}
        stillWorks="The people from your mail and calendar are one click away."
        action={null}
      />
    );
  }

  const filters = (
    <DirectoryFilters
      kind={kind}
      state={state}
      filter={filter}
      href={href}
      clear={pageHref(PATH, { ...view, q: q || null }, DEFAULT_TAB)}
    />
  );

  if (!result.ok) {
    return (
      <section aria-label={copy.title}>
        <SectionHeading>{copy.title}</SectionHeading>
        {filters}
        <ErrorState
          title={`${kind === 'person' ? 'People' : 'Companies'} could not be loaded`}
          message={result.error.message}
          stillUsable="The people from your mail and calendar, and the other tabs."
        />
      </section>
    );
  }
  const { rows, total, truncated, mail } = result.value;
  const paging = pageWindow(Math.floor(offset / PER_PAGE) + 1, PER_PAGE, total);
  const timezone = auth.profile.timezone;
  const now = new Date();

  const sortHeader = (key: DirectorySort, label: string) => {
    const on = sort === key;
    const next: 'asc' | 'desc' = on
      ? dir === 'asc'
        ? 'desc'
        : 'asc'
      : key === 'name'
        ? 'asc'
        : 'desc';
    const Icon = dir === 'asc' ? ArrowUp : ArrowDown;
    return (
      <th
        scope="col"
        className="px-4 py-2.5 font-medium whitespace-nowrap"
        aria-sort={on ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}
      >
        <Link
          href={href({
            sort: key === 'name' ? null : key,
            dir: key === 'name' && next === 'asc' ? null : next,
          })}
          prefetch={false}
          scroll={false}
          className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
        >
          {label}
          {on ? <Icon className="size-3" aria-hidden /> : null}
        </Link>
      </th>
    );
  };

  return (
    <section aria-label={copy.title}>
      <SectionHeading count={total}>{copy.title}</SectionHeading>
      <LiveSearch
        path={PATH}
        keep={view}
        reset={[PAGE_PARAM]}
        value={q}
        placeholder={copy.placeholder}
        label={copy.search}
        className="mb-3 max-w-sm"
      />
      {filters}
      {!mail ? (
        <Notice tone="warn" className="mb-3">
          Mail and calendar couldn&rsquo;t be read just now, so Connections and Last contact are
          blank. The list itself is complete.
        </Notice>
      ) : null}
      {truncated ? (
        <Notice tone="info" className="mb-3">
          Filtered and sorted across the first {DIRECTORY_SCAN_MAX.toLocaleString('en-US')} matches
          A to Z. Search a name to narrow it.
        </Notice>
      ) : null}
      {rows.length === 0 ? (
        <EmptyState
          title={
            q || hasContactFilter(filter)
              ? 'Nobody matches'
              : `No ${kind === 'person' ? 'people' : 'companies'} from Affinity yet`
          }
          description={
            q || hasContactFilter(filter)
              ? 'Clear the search or the filters, or try part of a name.'
              : copy.empty
          }
          action={
            q || hasContactFilter(filter)
              ? { label: 'Clear search and filters', href: pageHref(PATH, view, DEFAULT_TAB) }
              : { label: 'Open Affinity import', href: '/knowledge?tab=import' }
          }
        />
      ) : (
        <div
          className="overflow-x-auto rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)]"
          data-tour="directory-table"
        >
          <table className="w-full min-w-[860px] text-sm">
            <caption className="sr-only">{copy.title}</caption>
            <thead>
              <tr className="border-b border-[var(--border)] text-left">
                {sortHeader('name', 'Name')}
                <th scope="col" className="px-4 py-2.5 font-medium">
                  {kind === 'person' ? 'Email' : 'Domain'}
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  {kind === 'person' ? 'Role' : 'Industry'}
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Connections
                </th>
                {sortHeader('last_contact', 'Last contact')}
                {sortHeader('first_email', 'First email')}
                {sortHeader('last_meeting', 'Last meeting')}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ record, contact }) => (
                <tr key={record.id} className="border-b border-[var(--border)] last:border-b-0">
                  <td className="px-4 py-2.5 align-top">
                    <Link
                      href={`/lists/records/${record.id}`}
                      className="font-medium underline-offset-2 hover:underline"
                    >
                      {record.name}
                    </Link>
                    {contact ? (
                      <span className="mt-1 block">
                        <ContactStatusTag status={contact.status} />
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-2.5 align-top text-[var(--fg-muted)]">
                    {(kind === 'person' ? record.primary_email : record.domain) ?? '—'}
                  </td>
                  <td className="px-4 py-2.5 align-top text-[var(--fg-muted)]">
                    {describe(record) ?? '—'}
                  </td>
                  <td className="px-4 py-2.5 align-top text-[var(--fg-muted)]">
                    {connectionsLabel(contact?.connections.map((c) => c.name) ?? []) ?? '—'}
                  </td>
                  <td className="px-4 py-2.5 align-top">
                    <LastContactCell
                      at={contact?.lastContactAt ?? null}
                      timezone={timezone}
                      now={now}
                    />
                  </td>
                  <td className="tabular px-4 py-2.5 align-top whitespace-nowrap text-[var(--fg-muted)]">
                    {contact?.firstEmailAt
                      ? formatContactDate(contact.firstEmailAt, timezone)
                      : '—'}
                  </td>
                  <td className="tabular px-4 py-2.5 align-top whitespace-nowrap text-[var(--fg-muted)]">
                    {contact?.lastMeetingAt
                      ? formatContactDate(contact.lastMeetingAt, timezone)
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager
        label={`${copy.title}: pages`}
        page={paging.page}
        pages={paging.pages}
        total={total}
        shown={rows.length}
        offset={offset}
        hrefFor={(n) => href({ [PAGE_PARAM]: n > 1 ? String(n) : null })}
      />
    </section>
  );
}

function describe(record: CrmRecord): string | null {
  if (record.kind === 'company') return recordField(record, INDUSTRY_LABELS);
  const title = recordField(record, TITLE_LABELS);
  const org = recordField(record, [
    'Organization',
    'Organizations',
    'Company',
    'Current Organization',
  ]);
  return [title, org].filter(Boolean).join(', ') || null;
}

function DirectoryFilters({
  kind,
  state,
  filter,
  href,
  clear,
}: {
  kind: CrmRecordKind;
  state: Record<string, string | null>;
  filter: ContactFilter;
  href: (changes: Record<string, string | null>) => string;
  clear: string;
}) {
  const hidden = Object.entries(state).filter(
    ([key, value]) => value && key !== 'within' && key !== 'beyond',
  );
  const { recentMaxDays, losingMaxDays } = CONTACT_STATUS_THRESHOLDS;
  const hint: Record<string, string> = {
    recent: `≤${recentMaxDays}d`,
    losing: `${recentMaxDays + 1}–${losingMaxDays}d`,
    lost: `>${losingMaxDays}d`,
    never: 'no email or meeting',
  };
  return (
    <div className="mb-4 space-y-2" data-tour="directory-filters">
      <LinkChips
        label="Relationship status"
        chips={[
          { key: 'any', label: 'Any status', href: href({ status: null }), active: !filter.status },
          ...CONTACT_STATUSES.map((s) => ({
            key: s,
            label: CONTACT_STATUS_LABELS[s],
            href: href({ status: filter.status === s ? null : s }),
            active: filter.status === s,
          })),
        ]}
      />
      <form
        method="get"
        action={PATH}
        className="flex flex-wrap items-end gap-3 text-sm"
        aria-label="Last contact filter"
      >
        {hidden.map(([key, value]) => (
          <input key={key} type="hidden" name={key} value={value ?? ''} />
        ))}
        <label className="flex flex-col gap-1">
          <span className="text-mini text-[var(--fg-muted)]">Last contact: days or fewer</span>
          <input
            type="number"
            name="within"
            min={0}
            max={3650}
            defaultValue={filter.withinDays ?? ''}
            placeholder="e.g. 30"
            className="w-28 rounded-md border border-[var(--border-control)] bg-[var(--bg)] px-2 py-1.5"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-mini text-[var(--fg-muted)]">More than days (or never)</span>
          <input
            type="number"
            name="beyond"
            min={0}
            max={3650}
            defaultValue={filter.beyondDays ?? ''}
            placeholder="e.g. 90"
            className="w-28 rounded-md border border-[var(--border-control)] bg-[var(--bg)] px-2 py-1.5"
          />
        </label>
        <button
          type="submit"
          className="rounded-md border border-[var(--border-control)] px-3 py-1.5 font-medium hover:bg-[var(--bg-hover)]"
        >
          Apply
        </button>
        {hasContactFilter(filter) ? (
          <Link
            href={clear}
            className="py-1.5 text-[var(--accent)] underline-offset-2 hover:underline"
          >
            Clear filters
          </Link>
        ) : null}
        <span className={cn('text-mini py-1.5 text-[var(--fg-subtle)]')}>
          {CONTACT_STATUSES.map((s) => `${CONTACT_STATUS_LABELS[s]} ${hint[s]}`).join(' · ')}
          {kind === 'company' ? ' · counts everyone at the company' : ''}
        </span>
      </form>
    </div>
  );
}
