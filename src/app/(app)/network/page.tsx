import type { Metadata } from 'next';
import { Suspense } from 'react';
import { requireAuth } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { getPrimaryIntegration } from '@/lib/services/inbox';
import { buildRelationshipList } from '@/lib/services/network';
import { readFollowUps, readFollowUpsWithin } from '@/lib/services/follow-ups';
import { RelationshipAlerts } from '@/components/network/relationship-alerts';
import { IntrosCard, snapshotUnavailable } from '@/components/followups/relay-cards';
import {
  asRelationshipSortKey,
  sortRelationships,
  type RelationshipSortKey,
  type SortDirection,
} from '@/lib/network/relationship-view';
import { NETWORK_TABS, SNAPSHOT_WAIT_MS, landsOnSnapshot, openingTab } from '@/lib/records-tabs';
import { single, tabHref } from '@/lib/util/page-tabs';
import { PageHeader, PageShell } from '@/components/shell/page-header';
import { EmptyState, SkeletonText } from '@/components/ui/feedback';
import { PageTabs } from '@/components/ui/page-tabs';
import { Stat, StatGroup } from '@/components/ui/stat';
import { NetworkTable } from '@/components/network/network-table';
import { NetworkFilterBar } from '@/components/network/network-client';

export const metadata: Metadata = { title: 'Network' };
export const dynamic = 'force-dynamic';

const PEOPLE_HREF = tabHref(NETWORK_TABS.path, 'people', NETWORK_TABS.defaultKey);

export default async function NetworkPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const q = single(params.q) ?? '';

  // Intros are only the routine's snapshot from Slack. A bare URL opens there
  // when it lists an intro and on People otherwise, never on an empty page.
  let introsShow = false;
  if (landsOnSnapshot(NETWORK_TABS, params)) {
    const auth = await requireAuth();
    const landing = await readFollowUpsWithin(getStore(), auth.organizationId, SNAPSHOT_WAIT_MS);
    introsShow = landing?.state === 'ok' && (landing.snapshot.intros?.intros.length ?? 0) > 0;
  }
  const { tab, home } = openingTab(NETWORK_TABS, params, introsShow);
  const sort = asRelationshipSortKey(single(params.sort));
  const direction: SortDirection = single(params.dir) === 'asc' ? 'asc' : 'desc';

  return (
    <PageShell>
      <PageHeader
        title="Network"
        subtitle="Everyone you have actually corresponded or sat down with, counted from your own mail and calendar. No relationship score — the evidence itself."
      />
      <PageTabs
        label={NETWORK_TABS.navLabel}
        path={NETWORK_TABS.path}
        tabs={NETWORK_TABS.tabs.map((t) => ({ key: t.key, label: t.label }))}
        active={tab}
        defaultKey={home}
      />
      <Suspense key={tab} fallback={<SkeletonText lines={10} />}>
        {tab === 'people' ? (
          <PeopleTab q={q} sort={sort} direction={direction} />
        ) : tab === 'cold' ? (
          <ColdTab />
        ) : (
          <IntrosTab />
        )}
      </Suspense>
    </PageShell>
  );
}

/** The intro tracker's snapshot: who you owe an intro, and how the rest went. */
async function IntrosTab() {
  const auth = await requireAuth();
  const followUps = await readFollowUps(getStore(), auth.organizationId).catch(() => null);
  const empty = (description: string) => (
    <EmptyState
      title="No intros to show"
      description={description}
      action={{ label: 'See people', href: PEOPLE_HREF }}
    />
  );
  if (followUps?.state !== 'ok') return empty(snapshotUnavailable(followUps?.state));
  const intros = followUps.snapshot.intros;
  const none = empty('Shows here once the intro routine has posted.');
  if (!intros) return none;
  return <IntrosCard intros={intros} now={new Date()} empty={none} />;
}

/** The relationship radar's "going cold" list. */
async function ColdTab() {
  const auth = await requireAuth();
  const followUps = await readFollowUps(getStore(), auth.organizationId).catch(() => null);
  const empty = (title: string, description: string) => (
    <EmptyState
      title={title}
      description={description}
      action={{ label: 'See people', href: PEOPLE_HREF }}
    />
  );
  if (followUps?.state !== 'ok') {
    return empty('Nothing to show', snapshotUnavailable(followUps?.state));
  }
  const relationships = followUps.snapshot.relationships;
  if (!relationships) {
    return empty('Nothing to show', 'Shows here once the relationship routine has posted.');
  }
  return (
    <RelationshipAlerts
      relationships={relationships}
      now={new Date()}
      showWaiting={false}
      empty={empty(
        'Nothing going cold',
        'No key relationship has gone quiet. The full list is under People.',
      )}
    />
  );
}

async function PeopleTab({
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
            href: q ? PEOPLE_HREF : '/settings',
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
