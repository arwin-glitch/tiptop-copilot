import type { Metadata } from 'next';
import { Suspense } from 'react';
import { requireAuth } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { getPrimaryIntegration } from '@/lib/services/inbox';
import { buildRelationshipList } from '@/lib/services/network';
import { readFollowUps, readFollowUpsWithin } from '@/lib/services/follow-ups';
import {
  fundAddresses,
  getRelationshipIndex,
  goingCold,
  networkStrengths,
  relationshipScope,
  withGoingCold,
} from '@/lib/services/relationships';
import { goingColdDays } from '@/lib/network/strength';
import { GoingColdWindow } from '@/components/network/going-cold-window';
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
import { EmptyState, Notice, SkeletonText } from '@/components/ui/feedback';
import { PageTabs } from '@/components/ui/page-tabs';
import { Stat, StatGroup } from '@/components/ui/stat';
import { NetworkTable } from '@/components/network/network-table';
import { NetworkFilterBar } from '@/components/network/network-client';
import { KeepInTouchTab } from '@/components/network/keep-in-touch-tab';

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
        subtitle="Everyone you have actually corresponded or sat down with, counted from your own mail and calendar. Every strength shows the evidence it was counted from."
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
          <ColdTab days={goingColdDays(single(params.days))} />
        ) : tab === 'keep' ? (
          <KeepInTouchTab />
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

/** The relationship radar's "going cold" list, with Copilot's own from mail and calendar. */
async function ColdTab({ days }: { days: number }) {
  const auth = await requireAuth();
  const store = getStore();
  const integration = await getPrimaryIntegration(store, auth.organizationId).catch(() => null);
  const scope = relationshipScope(auth.profile.email, integration);
  const [followUps, derived] = await Promise.all([
    readFollowUps(store, auth.organizationId).catch(() => null),
    goingCold(store, auth.organizationId, { ...scope, timeZone: auth.profile.timezone }, days),
  ]);
  const empty = (title: string, description: string) => (
    <EmptyState
      title={title}
      description={description}
      action={{ label: 'See people', href: PEOPLE_HREF }}
    />
  );
  const snapshot = followUps?.state === 'ok' ? followUps.snapshot.relationships : null;
  const relationships = withGoingCold(snapshot, derived.ok ? derived.value : []);
  // Copilot's own check failing is never an all-clear: say it did not run.
  const unchecked = derived.ok
    ? null
    : `Copilot could not check mail and calendar for relationships going quiet: ${derived.error.message}`;
  const allClear = unchecked
    ? empty('Not checked just now', unchecked)
    : empty(
        'Nothing going cold',
        'No key relationship has gone quiet. The full list is under People.',
      );
  if (!relationships) {
    return followUps?.state !== 'ok' && !unchecked
      ? empty('Nothing to show', snapshotUnavailable(followUps?.state))
      : allClear;
  }
  return (
    <>
      {unchecked && relationships.cold.length > 0 ? (
        <Notice tone="warn" className="mb-4">
          {unchecked} Only the relationship routine&apos;s list is shown.
        </Notice>
      ) : null}
      <RelationshipAlerts
        relationships={relationships}
        now={new Date()}
        showWaiting={false}
        empty={allClear}
      />
      <GoingColdWindow days={days} />
    </>
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

  const scope = {
    ...relationshipScope(auth.profile.email, integration),
    timeZone: auth.profile.timezone,
  };
  // Every address the fund itself sends from (each member, each mailbox,
  // Nick's aliases), as the strengths count them. Without this the mailbox
  // owner, or a colleague, turns up as a contact.
  const ownAddresses = [
    ...new Set([
      ...scope.ownAddresses,
      ...(await fundAddresses(store, auth.organizationId).catch(() => [])),
    ]),
  ];
  const [rows] = await Promise.all([
    buildRelationshipList(store, auth.organizationId, { ownAddresses, search: q || undefined }),
    getRelationshipIndex(store, auth.organizationId, scope), // built alongside, read below
  ]);
  const strengths = await networkStrengths(
    store,
    auth.organizationId,
    rows.map((r) => r.email),
    scope,
  );

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

      {strengths.ok ? null : (
        <Notice tone="warn" className="mt-4">
          Strength badges are missing: {strengths.error.message}
        </Notice>
      )}

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
          strengths={strengths.ok ? strengths.value : undefined}
          sort={sort}
          direction={direction}
        />
      )}
    </>
  );
}
