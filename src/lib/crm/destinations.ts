import type { CrmEntityType, CrmSource } from '@/lib/types/domain';

/**
 * Where each CRM list's data belongs in the app.
 *
 * Affinity is going away: its 30-odd lists come across through the importer
 * and keep arriving until the subscription ends, and each list's rows belong
 * on the page where they are used rather than in a "Lists" area of their own.
 * The deal pipeline feeds Deals, LP pipelines feed Fund II, partner and
 * provider lists feed Network, and so on. This file decides which, from the
 * list's name and entity type, and holds the labels the pages show.
 *
 * Pure and client-safe: no store, no `server-only`. The server side — reading
 * a person's override and the lists and entries of one destination — is
 * `lib/services/crm-destinations.ts`.
 *
 * The rules are ordered and the first match wins. They look at the name with
 * punctuation folded to spaces, so "Non-LPs" reads as "non lps" and "CxO" as
 * "cxo". A list nothing matches goes to `archive`: kept and searchable on
 * Knowledge, shown nowhere else, until someone picks a destination for it.
 */

export const CRM_DESTINATIONS = [
  'deals',
  'sourcing',
  'lps',
  'lp_lists',
  'angel',
  'portfolio_people',
  'investors',
  'providers',
  'operators',
  'events',
  'archive',
] as const;

export type CrmDestination = (typeof CRM_DESTINATIONS)[number];

export interface CrmDestinationInfo {
  key: CrmDestination;
  /** What the lists in it are, short enough for a menu option: "Deal pipeline". */
  label: string;
  /** The page whose data it becomes, as the main navigation names it. */
  page: string;
  /** Where on that page its rows are: the page's path and the tab (and view) holding them. */
  href: string;
  /** One plain line on what goes here. */
  blurb: string;
}

/** Display order, and the page each destination feeds. */
export const CRM_DESTINATION_INFO: Record<CrmDestination, CrmDestinationInfo> = {
  deals: {
    key: 'deals',
    label: 'Deal pipeline',
    page: 'Deals',
    href: '/deals?tab=pipeline',
    blurb: 'Opportunity lists with stages, from first meeting to signed or passed.',
  },
  sourcing: {
    key: 'sourcing',
    label: 'Sourcing & watch',
    page: 'Deals',
    href: '/deals?tab=sourcing',
    blurb: 'Companies being watched or sourced: watch lists, deal-flow feeds, sector lists.',
  },
  lps: {
    key: 'lps',
    label: 'LP pipeline',
    page: 'Fund II',
    href: '/fund-ii?tab=pipeline&source=affinity',
    blurb: "Fund II's LP prospects, individuals and institutions, with their stage.",
  },
  lp_lists: {
    key: 'lp_lists',
    label: 'LP lists & SPVs',
    page: 'Fund II',
    href: '/fund-ii?tab=lists',
    blurb: "Fund I's LPs, newsletter recipients, SPV sends and allocations.",
  },
  angel: {
    key: 'angel',
    label: 'Angel investments',
    page: 'Portfolio',
    href: '/portfolio?tab=angel',
    blurb: "Nick's personal angel investments. Kept apart from the Fund I portfolio.",
  },
  portfolio_people: {
    key: 'portfolio_people',
    label: 'Portfolio founders',
    page: 'Portfolio',
    href: '/portfolio?tab=founders',
    blurb: 'Founders and teams of portfolio companies, and any list of the portfolio itself.',
  },
  investors: {
    key: 'investors',
    label: 'Investors',
    page: 'Network',
    href: '/network?tab=investors',
    blurb: 'VC, PE and growth partners, collaborators, and intro-round investor lists.',
  },
  providers: {
    key: 'providers',
    label: 'Service providers',
    page: 'Network',
    href: '/network?tab=providers',
    blurb: 'Advisors, consultants, service providers, resources and perks.',
  },
  operators: {
    key: 'operators',
    label: 'Operators',
    page: 'Network',
    href: '/network?tab=operators',
    blurb: 'CxO and founder networks outside the portfolio.',
  },
  events: {
    key: 'events',
    label: 'Events & sponsors',
    page: 'Network',
    href: '/network?tab=events',
    blurb: 'Event invite lists and sponsors.',
  },
  archive: {
    key: 'archive',
    label: 'Reference only',
    page: 'Knowledge',
    href: '/knowledge?tab=lists',
    blurb:
      'Lists no rule recognised, and lists made in Kraken. Kept and searchable here; pick a destination to use one.',
  },
};

export function isCrmDestination(value: unknown): value is CrmDestination {
  return typeof value === 'string' && (CRM_DESTINATIONS as readonly string[]).includes(value);
}

/** The words a rule looks at: lowercase, every run of punctuation one space. */
export function destinationText(name: string): string {
  return ` ${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;
}

interface Rule {
  /** A stable name for the rule, shown as the reason and asserted in tests. */
  id: string;
  destination: CrmDestination;
  test: (text: string, entity: CrmEntityType) => boolean;
}

const has = (re: RegExp) => (text: string) => re.test(text);

/**
 * In order; the first match wins. Each rule's comment says the kind of list
 * it is for (the examples are invented). Order matters where names overlap:
 * - SPV and newsletter lists name LPs too ("Harbor SPV - not LPs"), so they
 *   go before the LP pipelines.
 * - Event lists name sponsors, which would otherwise read as providers.
 * - A list of Fund I's LPs is a roster of who is in, not Fund II's pipeline:
 *   its "Committed" is Fund I money. So it goes before the LP pipelines, to
 *   the LP lists, and never counts toward Fund II's stages.
 * - "Angel Portfolio Companies" is not the fund's portfolio, so angel goes
 *   before it.
 * - Founder networks outside the portfolio ("Climate Founders Circle") go
 *   before sourcing, which would take them for a sector list.
 * - Watch lists and deal-flow feeds are sourcing even as opportunity lists,
 *   so they go before the deal-pipeline rule.
 */
const RULES: readonly Rule[] = [
  {
    // SPV sends and allocations, LP newsletters.
    id: 'spv-or-newsletter',
    destination: 'lp_lists',
    test: has(/ (spvs?|allocations?|newsletters?|capital calls?) /),
  },
  {
    // Invite lists, event sponsors, lunches and dinners.
    id: 'event',
    destination: 'events',
    test: has(
      / (events?|sponsors?|sponsorships?|lunch(es)?|dinners?|breakfasts?|invites?|invitations?|invitees?|rsvps?|summits?|conferences?|meetups?|happy hours?|guest lists?) /,
    ),
  },
  {
    // Fund I's LPs (or investors): already in, so a roster rather than a pipeline.
    id: 'fund-i-lps',
    destination: 'lp_lists',
    test: (text) =>
      / fund (i|1|one) /.test(text) && / (lps?|limited partners?|investors?) /.test(text),
  },
  {
    // LP pipelines: Fund II's prospects, individuals and institutions.
    id: 'lp',
    destination: 'lps',
    test: has(/ (lps?|limited partners?|hnwis?|family offices?|endowments?|allocators?) /),
  },
  {
    // Personal angel investments, never the fund's portfolio.
    id: 'angel',
    destination: 'angel',
    test: (text) => / angels? /.test(text) && !/ (investors?|syndicates?|networks?) /.test(text),
  },
  {
    // Founders of portfolio companies; a portfolio company list too.
    id: 'portfolio',
    destination: 'portfolio_people',
    test: has(/ (portfolio|portcos?|fund (i|ii|iii|1|2|3) (founders?|ceos?|teams?|companies)) /),
  },
  {
    // VC, PE and growth partners, collaborators, intro-round investor lists.
    id: 'investor',
    destination: 'investors',
    test: has(
      / (vcs?|venture capital|venture partners?|investors?|pe|private equity|growth equity|co ?investors?|syndicates?|gps?) /,
    ),
  },
  {
    // Advisors, consultants, service providers, resources, perks.
    id: 'provider',
    destination: 'providers',
    test: has(
      / (providers?|advisors?|advisers?|consultants?|consulting|resources?|perks?|vendors?|services?|lawyers?|law firms?|accountants?|bankers?|agencies|recruiters?) /,
    ),
  },
  {
    // CxO and founder networks outside the portfolio.
    id: 'operator',
    destination: 'operators',
    test: has(
      / (cxos?|c suite|founders?|execs?|executives?|operators?|ceos?|ctos?|cfos?|cmos?|coos?) /,
    ),
  },
  {
    // Watch lists and deal-flow feeds, whatever their entity type.
    id: 'watch-or-feed',
    destination: 'sourcing',
    test: has(/ (watch ?lists?|watch|watching|sourcing|deal ?flow|radar|scouts?|scouting) /),
  },
  {
    // The pipeline: an opportunity list, or any list called a pipeline.
    id: 'pipeline',
    destination: 'deals',
    test: (text, entity) => entity === 'deal' || / pipelines? /.test(text),
  },
  {
    // Sector and theme lists of companies: "Robotics Companies", "Fintech Top 25".
    id: 'company-theme',
    destination: 'sourcing',
    test: (text, entity) =>
      entity !== 'person' &&
      / (deals?|startups?|companies|[a-z]*saas|ai|top \d+|vertical|verticals|targets?|prospects?|markets?|thesis|sectors?|landscape|20\d\d) /.test(
        text,
      ),
  },
];

export interface CrmClassification {
  destination: CrmDestination;
  /** The rule that matched, or 'unmatched' for the archive fallback. */
  rule: string;
}

/**
 * Where a list's data belongs, from its name and entity type alone. A list
 * made in Kraken (`source`) stays here for reference until someone sends it
 * somewhere: a view saved as a list repeats rows its own list already feeds,
 * and an LP list saved that way would count every LP on Fund II twice.
 */
export function classifyCrmList(list: {
  name: string;
  entity_type: CrmEntityType;
  source?: CrmSource;
}): CrmClassification {
  if (list.source === 'copilot') return { destination: 'archive', rule: 'made-in-copilot' };
  const text = destinationText(list.name);
  for (const rule of RULES) {
    if (rule.test(text, list.entity_type)) return { destination: rule.destination, rule: rule.id };
  }
  return { destination: 'archive', rule: 'unmatched' };
}

/** A list's destination with where it came from: the rules, or a person's choice. */
export interface CrmListDestination {
  destination: CrmDestination;
  /** 'override' when someone chose it on Knowledge, 'auto' when the rules did. */
  source: 'auto' | 'override';
  /** What the rules say, kept when overridden so the choice can be undone. */
  auto: CrmDestination;
  /** The rule behind `auto`. */
  rule: string;
}

/** The destination a list uses: an override when there is a valid one, else the rules. */
export function resolveCrmListDestination(
  list: { name: string; entity_type: CrmEntityType; source?: CrmSource },
  override?: string | null,
): CrmListDestination {
  const { destination: auto, rule } = classifyCrmList(list);
  if (isCrmDestination(override)) {
    return { destination: override, source: 'override', auto, rule };
  }
  return { destination: auto, source: 'auto', auto, rule };
}

/** Items grouped by destination, in display order, leaving out empty groups. */
export function groupByDestination<T>(
  items: readonly T[],
  destinationOf: (item: T) => CrmDestination,
): { destination: CrmDestination; info: CrmDestinationInfo; items: T[] }[] {
  const groups = new Map<CrmDestination, T[]>();
  for (const item of items) {
    const key = destinationOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return CRM_DESTINATIONS.filter((d) => groups.has(d)).map((d) => ({
    destination: d,
    info: CRM_DESTINATION_INFO[d],
    items: groups.get(d) as T[],
  }));
}

/** A page the lists feed, with the destinations it holds, in display order. */
export interface CrmDestinationPage {
  /** The page's name in the main navigation, or "Knowledge" for reference-only lists. */
  page: string;
  /** The group heading: the page name, or "Reference only". */
  heading: string;
  /** The page's own path (Knowledge's lists tab for reference-only lists). */
  href: string;
  destinations: CrmDestination[];
}

/** Every page a destination feeds, in display order (Deals, Fund II, Portfolio, Network, then reference). */
export const CRM_DESTINATION_PAGES: readonly CrmDestinationPage[] = (() => {
  const pages: CrmDestinationPage[] = [];
  for (const d of CRM_DESTINATIONS) {
    const info = CRM_DESTINATION_INFO[d];
    const page = pages.find((p) => p.page === info.page);
    if (page) page.destinations.push(d);
    else
      pages.push({
        page: info.page,
        heading: d === 'archive' ? info.label : info.page,
        // The page itself, not the first destination's tab on it.
        href: d === 'archive' ? info.href : (info.href.split('?')[0] as string),
        destinations: [d],
      });
  }
  return pages;
})();

/**
 * Items grouped by the page they feed, in display order, leaving out empty
 * groups; within a page, by destination order and then as given.
 */
export function groupByPage<T>(
  items: readonly T[],
  destinationOf: (item: T) => CrmDestination,
): (CrmDestinationPage & { items: T[] })[] {
  const byDestination = groupByDestination(items, destinationOf);
  return CRM_DESTINATION_PAGES.map((page) => ({
    ...page,
    items: byDestination
      .filter((g) => page.destinations.includes(g.destination))
      .flatMap((g) => g.items),
  })).filter((page) => page.items.length > 0);
}
