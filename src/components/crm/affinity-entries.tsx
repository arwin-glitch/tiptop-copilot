import * as React from 'react';
import Link from 'next/link';
import type { AuthContext } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import type { CrmDestination } from '@/lib/crm/destinations';
import { isMoneyField } from '@/lib/crm/stage-map';
import { formatCrmValue, statusTone } from '@/lib/crm/view';
import { AFFINITY_IMPORT_HREF, AFFINITY_LISTS_HREF } from '@/lib/records-tabs';
import { CRM_MIGRATION_FILE, isCrmNotSetUp } from '@/lib/services/crm';
import { entriesFor, type CrmDestinationEntry } from '@/lib/services/crm-destinations';
import type { CrmField } from '@/lib/types/domain';
import { PAGE_PARAM, pageNumber, pageWindow } from '@/lib/util/page-tabs';
import { relativeTime } from '@/lib/util/time';
import { SectionHeading } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState } from '@/components/ui/feedback';
import { LiveSearch } from '@/components/ui/live-search';
import { NotConfigured } from '@/components/ui/not-configured';
import { Pager } from '@/components/ui/pager';
import { LinkChips, pageHref } from './link-chips';

/** Rows per page. */
export const AFFINITY_ROWS_PER_PAGE = 50;

export interface AffinityEntriesParams {
  q: string;
  /** One list of the destination to narrow to (`?list=`). */
  list: string | null;
  /** Which page of rows (`?page=`, from 1). */
  page: string | string[] | undefined;
}

/**
 * The rows of every Affinity list that feeds one place in the app — Sourcing
 * on Deals, LP lists on Fund II, Investors on Network — as one condensed,
 * searchable, paged table. A chip per list narrows it to that list; the stage
 * is a badge; two of the row's other columns fill a "Details" cell, so a row
 * stays one line on a laptop. Names link to the company's or person's
 * profile, where every list and note for them is.
 *
 * Server-rendered; the URL holds the search (`q`), the list (`list`) and the
 * page of rows (`page`), on the tab it sits on. Paged 50 rows at a time with
 * previous and next, so a list of thousands is browsable end to end and the
 * page never grows into a long scroll. Survives a missing CRM (a set-up
 * notice) and a failed read (an error, the rest of the page intact).
 */
export async function AffinityEntries({
  auth,
  destinations,
  path,
  tab,
  defaultTab,
  params,
  keep = {},
  title,
  searchLabel,
  searchPlaceholder,
  hideMoney = false,
  showField,
  preferFields,
  statusIn = null,
  statusHeader = 'Stage',
  above,
  emptyTitle,
  emptyDescription,
}: {
  auth: AuthContext;
  destinations: CrmDestination | readonly CrmDestination[];
  path: string;
  tab: string;
  defaultTab: string;
  params: AffinityEntriesParams;
  /** Further params every control on the table keeps (a view switch above it). */
  keep?: Readonly<Record<string, string>>;
  /** The table's name: its heading and its accessible name. */
  title: string;
  searchLabel: string;
  searchPlaceholder: string;
  /** Leave out every column whose name or type reads as money (Events). */
  hideMoney?: boolean;
  /**
   * Show only the columns this allows: an allowlist, for a page that must
   * never show what it does not expect (Fund II: `isFundIiField`).
   */
  showField?: (field: CrmField) => boolean;
  /** Columns to show first in Details, by name. */
  preferFields?: RegExp;
  /** Only entries at these stages (each list on its own stage field). */
  statusIn?: readonly string[] | null;
  statusHeader?: string;
  /** Rendered between the heading and the table: more chips, a notice. */
  above?: React.ReactNode;
  emptyTitle: string;
  emptyDescription: string;
}) {
  const store = getStore();
  const query = {
    query: params.q || null,
    listIds: params.list ? [params.list] : null,
    statusIn,
    sort: 'recent' as const,
    limit: AFFINITY_ROWS_PER_PAGE,
  };
  const asked = pageNumber(params.page);
  let result = await entriesFor(store, auth.organizationId, destinations, {
    ...query,
    offset: (asked - 1) * AFFINITY_ROWS_PER_PAGE,
  });
  // A page past the end (a stale link, rows since removed) shows the last one.
  if (result.ok && result.value.entries.length === 0 && asked > 1 && result.value.total > 0) {
    const last = pageWindow(asked, AFFINITY_ROWS_PER_PAGE, result.value.total);
    result = await entriesFor(store, auth.organizationId, destinations, {
      ...query,
      offset: last.offset,
    });
  }

  if (isCrmNotSetUp(result)) {
    return (
      <NotConfigured
        title="Affinity data is not set up yet"
        description={`The CRM tables have not been created in the database. Run ${CRM_MIGRATION_FILE} in the Supabase SQL editor, then reload this page.`}
        stillWorks="Everything else on this page works as before."
        action={null}
      />
    );
  }
  if (!result.ok) {
    return (
      <ErrorState
        title={`${title} could not be loaded`}
        message={result.error.message}
        stillUsable="The other tabs on this page."
      />
    );
  }

  const { available, entries, total, offset } = result.value;
  const paging = pageWindow(
    Math.floor(offset / AFFINITY_ROWS_PER_PAGE) + 1,
    AFFINITY_ROWS_PER_PAGE,
    total,
  );
  if (available.length === 0) {
    return (
      <EmptyState
        title={emptyTitle}
        description={emptyDescription}
        action={{ label: 'Open Affinity import', href: AFFINITY_IMPORT_HREF }}
      />
    );
  }

  const base = { ...keep, tab, q: params.q || null };
  const listChips =
    available.length > 1
      ? [
          {
            key: 'every',
            label: 'Every list',
            count: available.reduce((sum, l) => sum + l.entry_count, 0),
            href: pageHref(path, base, defaultTab),
            active: !params.list,
          },
          ...available.map((l) => ({
            key: l.id,
            label: l.name,
            count: l.entry_count,
            href: pageHref(path, { ...base, list: l.id }, defaultTab),
            active: params.list === l.id,
          })),
        ]
      : [];
  const fieldsByList = new Map(available.map((l) => [l.id, l.fields]));
  const statusByList = new Map(
    result.value.lists.map((l) => [l.id, result.value.statusFields[l.id]]),
  );
  const searchKeep: Record<string, string> = { ...keep, tab };
  if (params.list) searchKeep.list = params.list;
  const tz = auth.profile.timezone;
  const now = new Date();
  const showList = available.length > 1 && !params.list;

  return (
    <section aria-label={title}>
      <SectionHeading count={total}>{title}</SectionHeading>
      <div className="mb-4 space-y-3">
        {listChips.length ? (
          <LinkChips label={`${title}: filter by list`} chips={listChips} />
        ) : null}
        {above}
        <LiveSearch
          path={path}
          keep={searchKeep}
          reset={[PAGE_PARAM]}
          value={params.q}
          placeholder={searchPlaceholder}
          label={searchLabel}
          className="max-w-sm"
        />
      </div>

      {entries.length === 0 ? (
        <EmptyState
          title={params.q ? 'Nothing matches' : 'Nothing here yet'}
          description={
            params.q
              ? 'Clear the search, or try part of a name.'
              : 'No rows on these lists at this stage. Every list and its destination is on Knowledge.'
          }
          action={
            params.q
              ? { label: 'Clear search', href: pageHref(path, { ...searchKeep }, defaultTab) }
              : { label: 'See Affinity lists', href: AFFINITY_LISTS_HREF }
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)]">
          <table className="w-full min-w-[560px] text-sm">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr className="border-b border-[var(--border)] text-left">
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Name
                </th>
                {showList ? (
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    List
                  </th>
                ) : null}
                <th scope="col" className="px-4 py-2.5 font-medium">
                  {statusHeader}
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Details
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((row) => (
                <EntryRow
                  key={row.entry.id}
                  row={row}
                  fields={fieldsByList.get(row.list.id) ?? []}
                  status={statusByList.get(row.list.id) ?? null}
                  showList={showList}
                  hideMoney={hideMoney}
                  showField={showField}
                  preferFields={preferFields}
                  tz={tz}
                  now={now}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager
        label={`${title}: pages`}
        page={paging.page}
        pages={paging.pages}
        total={total}
        shown={entries.length}
        offset={offset}
        hrefFor={(page) =>
          pageHref(
            path,
            { ...searchKeep, q: params.q || null, [PAGE_PARAM]: page > 1 ? String(page) : null },
            defaultTab,
          )
        }
      />
    </section>
  );
}

/** Where a row's name links: the record's profile, else the row on its list. */
export function entryHref(row: Pick<CrmDestinationEntry, 'entry' | 'list' | 'record'>): string {
  return row.record
    ? `/lists/records/${row.record.id}`
    : `/lists/${row.list.id}?q=${encodeURIComponent(row.entry.title)}`;
}

/** Up to `max` filled-in columns of a row, other than its stage, as "Name: value". */
export function entryDetails(
  row: Pick<CrmDestinationEntry, 'entry'>,
  fields: readonly CrmField[],
  options: {
    status: CrmField | null;
    hideMoney: boolean;
    showField?: (field: CrmField) => boolean;
    preferFields?: RegExp;
    tz: string;
    max?: number;
  },
): string[] {
  const usable = fields.filter((f) => {
    if (f.key === options.status?.key) return false;
    if (options.hideMoney && isMoneyField(f)) return false;
    if (options.showField && !options.showField(f)) return false;
    const v = row.entry.values[f.key];
    return v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0);
  });
  const prefer = options.preferFields;
  const ordered = prefer
    ? [...usable.filter((f) => prefer.test(f.name)), ...usable.filter((f) => !prefer.test(f.name))]
    : usable;
  return ordered
    .slice(0, options.max ?? 2)
    .map((f) => `${f.name}: ${formatCrmValue(f, row.entry.values[f.key], options.tz)}`)
    .filter((text) => !text.endsWith(': '));
}

function EntryRow({
  row,
  fields,
  status,
  showList,
  hideMoney,
  showField,
  preferFields,
  tz,
  now,
}: {
  row: CrmDestinationEntry;
  fields: readonly CrmField[];
  status: CrmField | null;
  showList: boolean;
  hideMoney: boolean;
  showField?: (field: CrmField) => boolean;
  preferFields?: RegExp;
  tz: string;
  now: Date;
}) {
  const sub = row.record?.domain ?? row.record?.primary_email ?? null;
  const details = entryDetails(row, fields, { status, hideMoney, showField, preferFields, tz });
  return (
    <tr className="border-b border-[var(--border)] align-top last:border-b-0">
      <td className="px-4 py-2.5">
        <Link href={entryHref(row)} className="font-medium underline-offset-2 hover:underline">
          {row.entry.title}
        </Link>
        <p className="text-mini text-[var(--fg-subtle)]">
          {[sub, `updated ${relativeTime(row.entry.updated_at, now)}`].filter(Boolean).join(' · ')}
        </p>
      </td>
      {showList ? <td className="px-4 py-2.5 text-[var(--fg-muted)]">{row.list.name}</td> : null}
      <td className="px-4 py-2.5">
        {row.status ? (
          <Badge tone={statusTone(row.status)}>{row.status}</Badge>
        ) : (
          <span className="text-[var(--fg-subtle)]" aria-label="No stage">
            —
          </span>
        )}
      </td>
      <td className="px-4 py-2.5 text-[var(--fg-muted)]">
        {details.length ? details.join(' · ') : <span className="text-[var(--fg-subtle)]">—</span>}
      </td>
    </tr>
  );
}
