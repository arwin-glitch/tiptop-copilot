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
  const source: PeopleSource = single(params.source) === 'affinity' ? 'affinity' : 'mail';
  const list = single(params.list) ?? null;
  const page = params[PAGE_PARAM];

  return (
    <PageShell>
      <PageHeader
        title="Network"
        subtitle="Everyone you have actually corresponded or sat down with, counted from your own mail and calendar, plus the investors, providers, operators and events carried over from Affinity. No relationship score — the evidence itself."
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
          <ColdTab />
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
