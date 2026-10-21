import type { Metadata } from 'next';
import { Suspense } from 'react';
import { requireAuth } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { getPrimaryIntegration } from '@/lib/services/inbox';
import { buildRelationshipList } from '@/lib/services/network';
import { readFollowUps, readFollowUpsWithin } from '@/lib/services/follow-ups';
import { introDrafts } from '@/lib/services/intro-drafts';
import { mailboxCanSend } from '@/lib/services/docsend-follow-up';
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
import { PAGE_PARAM, single, tabHref } from '@/lib/util/page-tabs';
import type { CrmDestination } from '@/lib/crm/destinations';
import type { AuthContext } from '@/lib/auth/session';
import { AffinityEntries } from '@/components/crm/affinity-entries';
import { pageHref } from '@/components/crm/link-chips';
import {
  AffinityPeople,
  PeopleSourceSwitch,
  affinityPeopleCount,
  type PeopleSource,
} from '@/components/network/affinity-people';
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
  const source: PeopleSource = single(params.source) === 'affinity' ? 'affinity' : 'mail';
  const list = single(params.list) ?? null;
  const page = params[PAGE_PARAM];

  return (
    <PageShell>
      <PageHeader
        title="Network"
        subtitle="Everyone you have actually corresponded or sat down with, counted from your own mail and calendar, plus the investors, providers, operators and events carried over from Affinity. Every strength shows the evidence it was counted from."
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
          source === 'affinity' ? (
            <AffinityPeopleTab q={q} page={page} />
          ) : (
            <PeopleTab q={q} sort={sort} direction={direction} />
          )
        ) : isAffinityTab(tab) ? (
          <AffinityTab tab={tab} q={q} list={list} page={page} />
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

type AffinityTabKey = 'investors' | 'providers' | 'operators' | 'events';

/** The Network tabs that are one Affinity destination each, and how each reads. */
const AFFINITY_TABS: Record<
  AffinityTabKey,
  {
    destination: CrmDestination;
    title: string;
    search: string;
    statusHeader: string;
    prefer: RegExp;
    empty: string;
  }
> = {
  investors: {
    destination: 'investors',
    title: 'Investors',
    search: 'Search investors',
    statusHeader: 'Relationship',
    prefer: /firm|fund|organi[sz]ation|company|focus|stage|location/i,
    empty:
      "Affinity's VC, PE and growth partner lists, co-investors and intro-round investor lists land here once they are imported on Knowledge.",
  },
  providers: {
    destination: 'providers',
    title: 'Service providers',
    search: 'Search service providers',
    statusHeader: 'Category',
    prefer: /category|service|type|specialt|contact|perk/i,
    empty:
      "Affinity's advisor, consultant, service-provider, resource and perks lists land here once they are imported on Knowledge.",
  },
  operators: {
    destination: 'operators',
    title: 'Operators',
    search: 'Search operators',
    statusHeader: 'Function',
    prefer: /function|role|title|company|organi[sz]ation|expertise/i,
    empty:
      "Affinity's CxO and founder network lists land here once they are imported on Knowledge.",
  },
  events: {
    destination: 'events',
    title: 'Events',
    search: 'Search event lists',
    statusHeader: 'RSVP / tier',
    prefer: /rsvp|tier|event|company|organi[sz]ation|table/i,
    empty:
      "Affinity's event invite lists and sponsor lists land here once they are imported on Knowledge.",
  },
};

function isAffinityTab(tab: string): tab is AffinityTabKey {
  return Object.prototype.hasOwnProperty.call(AFFINITY_TABS, tab);
}

/** One Affinity destination as a searchable, paged table. */
async function AffinityTab({
  tab,
  q,
  list,
  page,
}: {
  tab: AffinityTabKey;
  q: string;
  list: string | null;
  page: string | string[] | undefined;
}) {
  const auth = await requireAuth();
  const config = AFFINITY_TABS[tab];
  return (
    <AffinityEntries
      auth={auth}
      destinations={config.destination}
      path={NETWORK_TABS.path}
      tab={tab}
      defaultTab={NETWORK_TABS.defaultKey}
      params={{ q, list, page }}
      title={config.title}
      searchLabel={config.search}
      searchPlaceholder="Search name"
      statusHeader={config.statusHeader}
      preferFields={config.prefer}
      // Sponsorship amounts are not something to read on a people page.
      hideMoney={tab === 'events'}
      emptyTitle={`No ${config.title.toLowerCase()} from Affinity yet`}
      emptyDescription={config.empty}
    />
  );
}

/** The people carried over from Affinity, behind the same tab as the mail list. */
async function AffinityPeopleTab({ q, page }: { q: string; page: string | string[] | undefined }) {
  const auth = await requireAuth();
  const [affinityCount, mailCount] = await Promise.all([
    affinityPeopleCount(auth),
    mailPeopleCount(auth),
  ]);
  return (
    <>
      <PeopleSourceSwitch
        source="affinity"
        q={q}
        mailCount={mailCount}
        affinityCount={affinityCount}
      />
      <AffinityPeople auth={auth} q={q} page={page} />
    </>
  );
}

/** How many people the mail-derived list holds, for the source switch. */
async function mailPeopleCount(auth: AuthContext): Promise<number | null> {
  try {
    const store = getStore();
    const integration = await getPrimaryIntegration(store, auth.organizationId);
    const ownAddresses = [auth.profile.email, integration?.account_email ?? null].filter(
      (a): a is string => Boolean(a),
    );
    return (await buildRelationshipList(store, auth.organizationId, { ownAddresses })).length;
  } catch {
    return null;
  }
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
  // "Write the intro" on each owed one: drafts from verified data only, and
  // never a reason for the tab to fail (both reads degrade to nothing).
  const store = getStore();
  const [drafts, integration] = await Promise.all([
    introDrafts(store, auth.organizationId, intros.intros).catch(() => ({})),
    getPrimaryIntegration(store, auth.organizationId).catch(() => null),
  ]);
  return (
    <IntrosCard
      intros={intros}
      now={new Date()}
      empty={none}
      drafts={drafts}
      canSend={mailboxCanSend(integration) && !auth.isDemo}
    />
  );
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
  // Affinity's people, counted for the switch, and for a search the ones
  // matching it, so a name only Affinity knows is one click away.
  const [affinityCount, affinityMatches] = await Promise.all([
    affinityPeopleCount(auth),
    q ? affinityPeopleCount(auth, q) : Promise.resolve(null),
  ]);

  return (
    <>
      <PeopleSourceSwitch
        source="mail"
        q={q}
        mailCount={q ? null : rows.length}
        affinityCount={affinityCount}
      />
      <StatGroup className="mb-5" columns={3}>
        <Stat size="sm" label="People" value={rows.length} hint="from mail and calendar" />
        <Stat size="sm" label="Met in person" value={met} hint="at least one meeting" />
        <Stat size="sm" label="They wrote last" value={awaiting} hint="the ball is in your court" />
      </StatGroup>

      <NetworkFilterBar q={q} />
      {q && affinityMatches ? (
        <p className="mt-2 text-sm text-[var(--fg-muted)]">
          Affinity also has {affinityMatches.toLocaleString('en-US')}{' '}
          {affinityMatches === 1 ? 'person' : 'people'} matching “{q}”.{' '}
          <a
            href={pageHref(NETWORK_TABS.path, { tab: 'people', source: 'affinity', q })}
            className="text-[var(--accent)] underline-offset-2 hover:underline"
          >
            Show them
          </a>
        </p>
      ) : null}

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
