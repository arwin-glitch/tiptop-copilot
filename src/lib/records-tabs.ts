import type { LpStage } from '@/lib/services/follow-ups';
import { resolveTab, single, tabHref, type PageTabDef } from '@/lib/util/page-tabs';

/**
 * The subtabs on each Records page: what each is called, what it holds, and
 * which one a bare URL opens on.
 *
 * Kept as data, apart from the pages, so anything that explains the app (a
 * help page, a tour) reads the same labels the tab bars show rather than a
 * copy that drifts. `/lists` is not here yet.
 *
 * Label rules, both from the end-to-end suite:
 * - No label contains a main-navigation name ("Network", "Reports", ...).
 *   Playwright matches accessible names by substring, so a tab called
 *   "Network contacts" would shadow the nav link "Network".
 * - No label is exactly "All", "Dealflow" or "Digests": the Reports filter
 *   chips use those names and are looked up page-wide.
 * And every `navLabel` stays clear of the word "main", which is how the suite
 * finds the main navigation.
 */

type Params = Record<string, string | string[] | undefined>;

export interface RecordsPageTabs<K extends string = string> {
  path: string;
  /** The page's name in the main navigation. */
  page: string;
  /** Accessible name of the subtab bar. */
  navLabel: string;
  defaultKey: K;
  tabs: readonly PageTabDef<K>[];
  /**
   * The tab a URL without a valid `?tab` opens on, when it depends on the
   * other params (a search link should land where the search box is).
   */
  fallback?: (params: Params) => K;
  /**
   * For a page whose default tab is only a routine's snapshot read from
   * Slack: the tab of the app's own records that the bare URL opens on
   * instead whenever that snapshot has nothing to show (Slack down, slow or
   * rate-limited, the routine not posted yet, every event already past). The
   * page Nick lands on is then never an empty state just because of Slack.
   */
  recordsKey?: K;
}

function define<const K extends string>(config: RecordsPageTabs<K>): RecordsPageTabs<K> {
  return config;
}

const has = (params: Params, ...names: string[]) => names.some((n) => Boolean(single(params[n])));

export const PORTFOLIO_TABS = define({
  path: '/portfolio',
  page: 'Portfolio',
  navLabel: 'Portfolio sections',
  defaultKey: 'health',
  tabs: [
    {
      key: 'health',
      label: 'Health',
      blurb: 'Every company flagged at risk, watch or healthy, with its last update and any asks.',
    },
    {
      key: 'requests',
      label: 'Requests',
      blurb:
        'What portfolio companies asked for, with a suggested action and who in your network could help.',
    },
    {
      key: 'numbers',
      label: 'Numbers',
      blurb:
        'Revenue, growth, cash, runway and any raise, as each company reported them in its own updates.',
    },
    {
      key: 'companies',
      label: 'Companies',
      blurb: 'The full list of portfolio companies. Open one for its contacts, updates and notes.',
    },
  ],
  // Citation links point at one update (`?update=<id>`): those live on Requests.
  fallback: (params) => (has(params, 'update') ? 'requests' : 'health'),
  recordsKey: 'requests',
});

export const FUND_II_TABS = define({
  path: '/fund-ii',
  page: 'Fund II',
  navLabel: 'Fund II sections',
  defaultKey: 'readers',
  tabs: [
    {
      key: 'readers',
      label: 'DocSend readers',
      blurb:
        'Who opened your DocSend links, hot readers first, with a follow-up and who can intro.',
    },
    {
      key: 'pipeline',
      label: 'LP pipeline',
      blurb:
        'Every open LP conversation by stage, the quarterly LP update draft, and who is going quiet.',
    },
    {
      key: 'passed',
      label: 'Passed',
      blurb: 'LPs who passed on Fund II, with any note.',
    },
    {
      key: 'campaigns',
      label: 'Campaigns',
      blurb:
        'LP updates and offerings sent one email per person from your mailbox, with who opened, clicked and replied.',
    },
  ],
});

export const MEETINGS_TABS = define({
  path: '/meetings',
  page: 'Meetings',
  navLabel: 'Meetings sections',
  defaultKey: 'week',
  tabs: [
    {
      key: 'week',
      label: 'Week ahead',
      blurb: 'The coming meetings by day, with who is in them and what to prepare.',
    },
    {
      key: 'notes',
      label: 'Notes',
      blurb: 'Every Granola note, searchable by title, person, company or what was said.',
    },
  ],
  // A search (from the box or the command palette) is a search of the notes.
  fallback: (params) => (has(params, 'q') ? 'notes' : 'week'),
  recordsKey: 'notes',
});

export const NETWORK_TABS = define({
  path: '/network',
  page: 'Network',
  navLabel: 'Network sections',
  defaultKey: 'intros',
  tabs: [
    {
      key: 'intros',
      label: 'Intros',
      blurb: 'Introductions you owe, have made, or that stalled, with the thread for each.',
    },
    {
      key: 'cold',
      label: 'Going cold',
      blurb: 'Key relationships with no contact for a while, and how long it has been.',
    },
    {
      key: 'people',
      label: 'People',
      blurb:
        'Everyone you have emailed or met, with counts and last contact. Search and sort here.',
    },
  ],
  // Searching and sorting happen on the people list.
  fallback: (params) => (has(params, 'q', 'sort', 'dir') ? 'people' : 'intros'),
  recordsKey: 'people',
});

export const UPDATES_TABS = define({
  path: '/updates',
  page: 'Reports',
  navLabel: 'Reports sections',
  defaultKey: 'reports',
  tabs: [
    {
      key: 'reports',
      label: 'Dealflow & digests',
      blurb:
        'The latest dealflow reports and update digests from Slack. The chips filter by type or source.',
    },
    {
      key: 'fresh',
      label: 'Fresh updates',
      blurb: 'Company updates that landed in Gmail in the last 30 days.',
    },
  ],
});

export const KNOWLEDGE_TABS = define({
  path: '/knowledge',
  page: 'Knowledge',
  navLabel: 'Knowledge sections',
  defaultKey: 'documents',
  tabs: [
    {
      key: 'documents',
      label: 'Documents',
      blurb: 'Uploaded thesis documents, memos and pass notes, and a search across all of them.',
    },
    {
      key: 'contacts',
      label: 'Contacts',
      blurb:
        'The network contacts you imported, used to suggest who could help a company. Search by name, company or role.',
    },
  ],
});

/** Every Records page with subtabs, in navigation order. */
export const RECORDS_TABS = [
  PORTFOLIO_TABS,
  FUND_II_TABS,
  MEETINGS_TABS,
  NETWORK_TABS,
  UPDATES_TABS,
  KNOWLEDGE_TABS,
] as const;

/** The tab a page request opens on: a valid `?tab`, else the page's fallback. */
export function resolvePageTab<K extends string>(config: RecordsPageTabs<K>, params: Params): K {
  return resolveTab(
    params.tab,
    config.tabs.map((t) => t.key),
    config.fallback?.(params) ?? config.defaultKey,
  );
}

/**
 * How long a bare URL waits for its snapshot before opening on the records
 * tab instead: enough for a normal uncached read (a few Slack pages), well
 * short of Slack's 8-second timeout. After one read it is cached for a minute.
 */
export const SNAPSHOT_WAIT_MS = 3_000;

/**
 * Whether a request lands on a snapshot default without asking for it: a bare
 * URL (no valid `?tab`, nothing that points at another tab) on a page with a
 * `recordsKey`. Only then does the page read the snapshot before choosing.
 * An explicit `?tab=<default>` always opens that tab, empty or not.
 */
export function landsOnSnapshot<K extends string>(
  config: RecordsPageTabs<K>,
  params: Params,
): boolean {
  if (config.recordsKey === undefined) return false;
  const named = single(params.tab);
  if (named !== undefined && config.tabs.some((t) => t.key === named)) return false;
  return resolvePageTab(config, params) === config.defaultKey;
}

/**
 * The tab a request opens on, and `home`: the tab whose link on the bar is
 * the bare path. When a bare URL's snapshot has nothing to show, both become
 * the records tab, so the snapshot tab stays one click away at
 * `?tab=<default>` (where it says why it is empty).
 */
export function openingTab<K extends string>(
  config: RecordsPageTabs<K>,
  params: Params,
  snapshotShows: boolean,
): { tab: K; home: K } {
  if (!snapshotShows && config.recordsKey !== undefined && landsOnSnapshot(config, params)) {
    return { tab: config.recordsKey, home: config.recordsKey };
  }
  return { tab: resolvePageTab(config, params), home: config.defaultKey };
}

/**
 * Where an LP is listed on Fund II. The pipeline tab shows only the open
 * stages, so an LP who passed is on the Passed tab alone; a link to the
 * pipeline would look like the record is missing.
 */
export function fundTwoLpHref(stage: LpStage): string {
  return tabHref(
    FUND_II_TABS.path,
    stage === 'passed' ? 'passed' : 'pipeline',
    FUND_II_TABS.defaultKey,
  );
}
