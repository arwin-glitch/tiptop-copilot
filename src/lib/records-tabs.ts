import type { LpStage } from '@/lib/services/follow-ups';
import { resolveTab, single, tabHref, type PageTabDef } from '@/lib/util/page-tabs';

/**
 * The subtabs on each Records page: what each is called, what it holds, and
 * which one a bare URL opens on.
 *
 * Kept as data, apart from the pages, so anything that explains the app (a
 * help page, a tour) reads the same labels the tab bars show rather than a
 * copy that drifts. Affinity's lists live under Knowledge (`?tab=lists`, and
 * the importer at `?tab=import`); `/lists` and `/lists/import` redirect there.
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

/**
 * Deals is a working page, not a Records page, but its Affinity views sit
 * behind the same kind of bar: Copilot's own screening list first (the bare
 * URL, unchanged), then the one pipeline merged with Affinity's, then the
 * companies Affinity was only watching.
 */
export const DEALS_TABS = define({
  path: '/deals',
  page: 'Deals',
  navLabel: 'Deals sections',
  defaultKey: 'screening',
  tabs: [
    {
      key: 'screening',
      label: 'Screening',
      blurb:
        'Every deal Copilot tracks, with its recommendation and how much of it rests on real evidence.',
    },
    {
      key: 'pipeline',
      label: 'Pipeline',
      blurb:
        "One pipeline: Copilot's deals and Affinity's deal lists matched by company, each with its stage, Affinity's own label kept.",
    },
    {
      key: 'sourcing',
      label: 'Sourcing',
      blurb:
        'Companies Affinity was watching or sourcing: the watch list, deals from email, sector and theme lists.',
    },
  ],
});

/**
 * Diagnostics is a System page, not a Records page, but its feed health sits
 * behind the same kind of bar: the configuration report first (the bare
 * URL, unchanged), then when each routine and job was last seen. A desktop
 * feed notice opens `?tab=feeds`. The calendar parity check (the calendar's
 * range reader against the day reader Today and the meeting pings use) is
 * `?tab=parity`; the calendars' colour labels as read live from Google,
 * `?tab=labels`.
 */
export const DIAGNOSTICS_TABS = define({
  path: '/diagnostics',
  page: 'Diagnostics',
  navLabel: 'Diagnostics sections',
  defaultKey: 'setup',
  tabs: [
    {
      key: 'setup',
      label: 'Setup',
      blurb:
        'What is configured and what is missing. Values are never shown, only whether each is present.',
    },
    {
      key: 'feeds',
      label: 'Feeds',
      blurb:
        'When each routine and job that fills the cards was last seen, against how often it runs, in plain words.',
    },
    {
      key: 'parity',
      label: 'Event parity',
      blurb:
        "Whether the calendar's Day, Week and Month show the same events as the day reader Today and the meeting pings use, for the main calendar, day by day. Read-only.",
    },
    {
      key: 'labels',
      label: 'Event labels',
      blurb:
        "Each calendar's colour labels as Google has them right now (the ones without a name folded into one line), and how many events in the next 7 days carry each. Read-only.",
    },
  ],
});

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
        'What portfolio companies asked for, one card per email, including the asks read from their own update emails, and who in your network could help, with why.',
    },
    {
      key: 'jobs',
      label: 'Jobs',
      blurb:
        'Open roles founders list in their updates and hiring emails, from a weekly scan: status, how often each was sent, who to send candidates to, and a blurb to share.',
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
      blurb:
        'The full list of portfolio companies, with up to three contacts each from Affinity and your mail and when you were last in touch. Open one for all its contacts, updates and notes.',
    },
    {
      key: 'founders',
      label: 'Founders',
      blurb:
        "Every row of Affinity's portfolio founder and portfolio lists, people and companies, whether or not it matches a company here.",
    },
    {
      key: 'angel',
      label: 'Angel',
      blurb:
        "Nick's personal angel investments from Affinity, read-only and kept apart from the Fund I portfolio.",
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
        "Every open LP conversation by stage, the quarterly LP update draft, who is going quiet, and Affinity's LP pipelines. Stages only, no amounts.",
    },
    {
      key: 'lists',
      label: 'LP lists',
      blurb:
        "Fund I's LPs, newsletter recipients and SPV lists from Affinity, with how many people are on each.",
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
      blurb:
        'Every Granola note, and every note carried over from Affinity, searchable by title, person, company or what was said.',
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
      key: 'keep',
      label: 'Keep in touch',
      blurb: 'Everyone with a check-in cadence set on their profile: overdue, due soon, on track.',
    },
    {
      key: 'students',
      label: 'Students & interns',
      blurb:
        'Students Nick mentors, schools and programs inviting TipTop in, and intern or advice requests, from a scan every Monday and Thursday: status, deadlines, the next step and whose it is.',
    },
    {
      key: 'people',
      label: 'People',
      blurb:
        'Everyone you have emailed or met, with counts and last contact, and the people carried over from Affinity. Search and sort here.',
    },
    {
      key: 'investors',
      label: 'Investors',
      blurb:
        'VC, PE and growth partners, co-investors and intro-round investor lists from Affinity.',
    },
    {
      key: 'providers',
      label: 'Service providers',
      blurb: 'Advisors, consultants, service providers, resources and perks from Affinity.',
    },
    {
      key: 'operators',
      label: 'Operators',
      blurb: 'CxO and founder networks outside the portfolio, from Affinity.',
    },
    {
      key: 'events',
      label: 'Events',
      blurb: 'Event invite lists and sponsors from Affinity, with who said yes.',
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
        'Your network for introductions: the contacts you imported and the people on the Affinity lists that feed introductions (never the LP lists). Search by name, company or role.',
    },
    {
      key: 'lists',
      label: 'Affinity lists',
      blurb:
        'Every list carried over from Affinity, grouped by the page its rows feed (Deals, Fund II, Portfolio, Network), with a menu to send a list elsewhere.',
    },
    {
      key: 'import',
      label: 'Affinity import',
      blurb:
        'Drop Affinity CSV exports (a list view and its notes) to bring them in; importing again updates rather than duplicates. The exit checklist counts down to the notice date and shows what is not copied yet.',
    },
    {
      key: 'find',
      label: 'Find & save',
      blurb:
        'Find people and companies by name, place and last contact, then save them as a list or add them to one. New people and companies are added here too.',
    },
  ],
});

/**
 * The full Ask page is not a Records page either, but it has two sections:
 * the conversation (the bare URL, which every `/ask` link opens), and the
 * feedback sent from the Ask Arwin panel's Feedback tab, where it is read and
 * closed. A conversation link (`?thread=`, `?deal=`, `?q=`) always opens the
 * conversation.
 */
export const ASK_TABS = define({
  path: '/ask',
  page: 'Ask Arwin',
  navLabel: 'Ask Arwin sections',
  defaultKey: 'conversations',
  tabs: [
    {
      key: 'conversations',
      label: 'Conversations',
      blurb: 'Ask a question and read the answer, with your recent conversations beside it.',
    },
    {
      key: 'feedback',
      label: 'Feedback',
      blurb:
        'What to change in Copilot, sent from the Feedback tab of the chat with the page it was about. Open notes first; mark each done.',
    },
  ],
});

/**
 * Students & interns, on Network. It started on Portfolio, so an old
 * `/portfolio?tab=students` link redirects here.
 */
export const STUDENTS_HREF = `${NETWORK_TABS.path}?tab=students`;

/**
 * Where an old Portfolio link to Students & interns goes now: the same tab on
 * Network with every other param (its filters, search and paging) kept. Null
 * for any other Portfolio URL.
 */
export function movedStudentsHref(params: Params): string | null {
  if (single(params.tab) !== 'students') return null;
  const query = new URLSearchParams({ tab: 'students' });
  for (const [name, value] of Object.entries(params)) {
    if (name === 'tab' || value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) query.append(name, v);
  }
  return `${NETWORK_TABS.path}?${query.toString()}`;
}

/** Knowledge's Affinity tabs, which the old `/lists` URLs redirect to. */
export const AFFINITY_LISTS_HREF = '/knowledge?tab=lists';
export const AFFINITY_IMPORT_HREF = '/knowledge?tab=import';

/**
 * The Affinity import tab's two views, a pair of chips under the tab bar: the
 * bare tab is the sync and CSV import, as it always was; `?view=exit` is the
 * exit checklist, which Today's reminder line links to.
 */
export type AffinityImportView = 'import' | 'exit';
export const AFFINITY_EXIT_HREF = '/knowledge?tab=import&view=exit';

export function affinityImportView(params: Params): AffinityImportView {
  return single(params.view) === 'exit' ? 'exit' : 'import';
}

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
