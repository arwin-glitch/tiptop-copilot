import type { Metadata } from 'next';
import { Suspense } from 'react';
import { requireAuth } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { getPrimaryIntegration } from '@/lib/services/inbox';
import { buildRelationshipList } from '@/lib/services/network';
import {
  asRelationshipSortKey,
  sortRelationships,
  type RelationshipSortKey,
  type SortDirection,
} from '@/lib/network/relationship-view';
import { PageHeader, PageShell } from '@/components/shell/page-header';
import { EmptyState, SkeletonText } from '@/components/ui/feedback';
import { Stat, StatGroup } from '@/components/ui/stat';
import { NetworkTable } from '@/components/network/network-table';
import { NetworkFilterBar } from '@/components/network/network-client';

export const metadata: Metadata = { title: 'Network' };
export const dynamic = 'force-dynamic';

export default async function NetworkPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const q = single(params.q) ?? '';
  const sort = asRelationshipSortKey(single(params.sort));
  const direction: SortDirection = single(params.dir) === 'asc' ? 'asc' : 'desc';

  return (
    <PageShell>
      <PageHeader
        title="Network"
        subtitle="Everyone you have actually corresponded or sat down with, counted from your own mail and calendar. No relationship score — the evidence itself."
      />
      <Suspense fallback={<SkeletonText lines={10} />}>
        <NetworkContent q={q} sort={sort} direction={direction} />
      </Suspense>
    </PageShell>
  );
}

async function NetworkContent({
  q,
  sort,
  direction,
}: {
  q: string;
  sort: RelationshipSortKey;
  direction: SortDirection;
}) {
  const auth = await requireAuth();
  const store = getStore();
  const integration = await getPrimaryIntegration(store, auth.organizationId);

  // Every address the fund itself sends from. Without this the mailbox owner
  // turns up as their own most frequent contact.
  const ownAddresses = [auth.profile.email, integration?.account_email ?? null].filter(
    (a): a is string => Boolean(a),
  );

  const rows = await buildRelationshipList(store, auth.organizationId, {
    ownAddresses,
    search: q || undefined,
  });

  const awaiting = rows.filter((r) => r.awaitingUs).length;
  const met = rows.filter((r) => r.meetingCount > 0).length;

  return (
    <>
      <StatGroup className="mb-5" columns={3}>
        <Stat size="sm" label="People" value={rows.length} hint="from mail and calendar" />
        <Stat size="sm" label="Met in person" value={met} hint="at least one meeting" />
        <Stat size="sm" label="They wrote last" value={awaiting} hint="the ball is in your court" />
      </StatGroup>

      <NetworkFilterBar q={q} />

      {rows.length === 0 ? (
        <EmptyState
          className="mt-5"
          title={q ? 'Nobody matches' : 'No correspondents yet'}
          description={
            q
              ? 'Clear the search, or try part of a name, address or company.'
              : 'This list is built from synced mail and calendar. Connect Google Workspace, or run a sync from the Inbox, and everyone you correspond with will appear here.'
          }
          action={{
            label: q ? 'Clear search' : 'Go to Settings',
            href: q ? '/network' : '/settings',
          }}
        />
      ) : (
        <NetworkTable
          rows={sortRelationships(rows, sort, direction)}
          sort={sort}
          direction={direction}
        />
      )}
    </>
  );
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
