'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowDownLeft, ArrowUpRight, CalendarDays } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  TableRowHeader,
} from '@/components/ui/table';
import {
  exchanges,
  type RelationshipRow,
  type RelationshipSortKey,
  type SortDirection,
} from '@/lib/network/relationship-view';
import { relativeTime } from '@/lib/util/time';

/**
 * The relationship list.
 *
 * The design argument here is the whole point of the screen. Affinity shows a
 * relationship *strength* — a number produced by a model you cannot inspect.
 * This shows the evidence instead: eleven in, four out, two meetings, last
 * spoke six days ago. Same job, and every figure is a count of records the
 * reader can go and open.
 *
 * So the counts are the emphasis and there is no composite score anywhere. A
 * single blended number would be easier to scan and would be exactly the kind
 * of confident guess the rest of this product refuses to make.
 */
export function NetworkTable({
  rows,
  sort,
  direction,
}: {
  rows: RelationshipRow[];
  sort: RelationshipSortKey;
  direction: SortDirection;
}) {
  const router = useRouter();
  const params = useSearchParams();

  const toggle = React.useCallback(
    (key: RelationshipSortKey) => {
      const next = new URLSearchParams(params.toString());
      const nextDirection: SortDirection =
        sort === key
          ? direction === 'asc'
            ? 'desc'
            : 'asc'
          : key === 'person' || key === 'company'
            ? 'asc'
            : 'desc';
      next.set('sort', key);
      next.set('dir', nextDirection);
      router.push(`/network?${next.toString()}`);
    },
    [direction, params, router, sort],
  );

  const sortFor = (key: RelationshipSortKey) => ({
    direction: sort === key ? direction : null,
    onToggle: () => toggle(key),
  });

  return (
    <>
      <div className="hidden lg:block">
        <Table
          caption="People you have corresponded or met with, and how much contact there has been"
          stickyHeader
          className="mt-4"
        >
          <TableHead sticky>
            <TableRow>
              <TableHeaderCell sort={sortFor('person')}>Person</TableHeaderCell>
              <TableHeaderCell sort={sortFor('company')}>Where they fit</TableHeaderCell>
              <TableHeaderCell numeric sort={sortFor('exchanges')}>
                Emails
              </TableHeaderCell>
              <TableHeaderCell numeric sort={sortFor('meetings')}>
                Meetings
              </TableHeaderCell>
              <TableHeaderCell numeric sort={sortFor('last')}>
                Last contact
              </TableHeaderCell>
              <TableHeaderCell numeric sort={sortFor('first')}>
                Known since
              </TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.email} interactive>
                <TableRowHeader className="max-w-[22rem]">
                  <span className="font-serif text-[15px] font-semibold">
                    {row.name ?? row.email}
                  </span>
                  {row.name ? (
                    <p className="text-mini truncate font-normal text-[var(--fg-subtle)]">
                      {row.email}
                    </p>
                  ) : null}
                  {row.awaitingUs ? (
                    <Badge tone="warn" className="mt-1">
                      They wrote last
                    </Badge>
                  ) : null}
                </TableRowHeader>

                <TableCell>
                  <Context row={row} />
                </TableCell>

                <TableCell numeric>
                  <Exchanges row={row} />
                </TableCell>

                <TableCell numeric>
                  {row.meetingCount > 0 ? (
                    <span className="tabular inline-flex items-center gap-1 text-sm">
                      <CalendarDays className="size-3 text-[var(--fg-subtle)]" aria-hidden="true" />
                      {row.meetingCount}
                    </span>
                  ) : (
                    <span className="text-mini text-[var(--fg-subtle)]">—</span>
                  )}
                </TableCell>

                <TableCell numeric className="text-mini whitespace-nowrap text-[var(--fg-muted)]">
                  <When at={row.lastContactAt} />
                  {row.nextMeetingAt ? (
                    <p className="text-[var(--accent)]">meets {relativeTime(row.nextMeetingAt)}</p>
                  ) : null}
                </TableCell>
                <TableCell numeric className="text-mini whitespace-nowrap text-[var(--fg-subtle)]">
                  <When at={row.firstContactAt} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <ul className="shadow-raised mt-4 divide-y divide-[var(--border)] overflow-hidden rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)] lg:hidden">
        {rows.map((row) => (
          <li key={row.email} className="px-4 py-3.5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-serif text-base font-semibold">{row.name ?? row.email}</p>
                {row.name ? (
                  <p className="text-mini truncate text-[var(--fg-subtle)]">{row.email}</p>
                ) : null}
              </div>
              {row.awaitingUs ? <Badge tone="warn">They wrote last</Badge> : null}
            </div>
            <div className="mt-1.5">
              <Context row={row} />
            </div>
            <p className="tabular text-mini mt-1.5 text-[var(--fg-subtle)]">
              {exchanges(row)} email{exchanges(row) === 1 ? '' : 's'}
              {row.meetingCount > 0
                ? ` · ${row.meetingCount} meeting${row.meetingCount === 1 ? '' : 's'}`
                : ''}
              {row.lastContactAt ? ` · last ${relativeTime(row.lastContactAt)}` : ''}
              {row.nextMeetingAt ? (
                <span className="text-[var(--accent)]">
                  {' '}
                  · meets {relativeTime(row.nextMeetingAt)}
                </span>
              ) : null}
            </p>
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * A date that may not exist yet.
 *
 * Someone on next week's calendar you have never corresponded with has no last
 * contact — and "in 6 days" would read as though you had already spoken, which
 * is precisely the mistake the first version of this screen made.
 */
function When({ at }: { at: string | null }) {
  if (at === null) return <span className="text-[var(--fg-subtle)] italic">Not yet</span>;
  return <>{relativeTime(at)}</>;
}

/**
 * Where the relationship lives.
 *
 * Only ever a link to a record that exists. No employer is guessed from the
 * email domain — invariant 9 is that the product does not invent people or
 * their affiliations, and a domain is not an employer.
 */
function Context({ row }: { row: RelationshipRow }) {
  const { dealId, dealName, portfolioCompanyId, portfolioCompanyName } = row.links;

  if (portfolioCompanyId && portfolioCompanyName) {
    return (
      <span className="flex flex-wrap items-center gap-1.5">
        <Link href={`/portfolio/${portfolioCompanyId}`}>
          <Badge tone="ok">{portfolioCompanyName}</Badge>
        </Link>
        {row.role ? <span className="text-mini text-[var(--fg-subtle)]">{row.role}</span> : null}
      </span>
    );
  }

  if (dealId && dealName) {
    return (
      <span className="flex flex-wrap items-center gap-1.5">
        <Link href={`/deals/${dealId}`}>
          <Badge tone="info">{dealName}</Badge>
        </Link>
        {row.role ? <span className="text-mini text-[var(--fg-subtle)]">{row.role}</span> : null}
      </span>
    );
  }

  if (row.company) {
    return <span className="text-sm text-[var(--fg-muted)]">{row.company}</span>;
  }

  return <span className="text-mini text-[var(--fg-subtle)] italic">No company recorded</span>;
}

/**
 * Inbound and outbound, kept apart.
 *
 * The direction is the useful half. Twelve messages that were all them writing
 * to you is a different relationship from six each way, and a single total
 * hides exactly that.
 */
function Exchanges({ row }: { row: RelationshipRow }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span
        className="tabular inline-flex items-center gap-0.5 text-sm"
        title={`${row.inboundCount} received`}
      >
        <ArrowDownLeft className="size-3 text-[var(--fg-subtle)]" aria-hidden="true" />
        {row.inboundCount}
        <span className="sr-only"> received</span>
      </span>
      <span
        className="tabular inline-flex items-center gap-0.5 text-sm text-[var(--fg-muted)]"
        title={`${row.outboundCount} sent`}
      >
        <ArrowUpRight className="size-3 text-[var(--fg-subtle)]" aria-hidden="true" />
        {row.outboundCount}
        <span className="sr-only"> sent</span>
      </span>
    </span>
  );
}
