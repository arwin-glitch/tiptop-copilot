import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import {
  classifyCrmList,
  CRM_DESTINATION_INFO,
  CRM_DESTINATION_PAGES,
  CRM_DESTINATIONS,
  groupByDestination,
  groupByPage,
  isCrmDestination,
  resolveCrmListDestination,
  type CrmDestination,
} from '@/lib/crm/destinations';
import type { DataStore } from '@/lib/db/store';
import { demoCrmId, DEMO_IDS } from '@/lib/demo/ids';
import { DEALS_TABS, RECORDS_TABS } from '@/lib/records-tabs';
import { isCrmNotSetUp, type CrmActor } from '@/lib/services/crm';
import {
  CRM_DESTINATION_ACTION,
  entriesFor,
  listsFor,
  listsWithDestinations,
  readDestinationOverrides,
  setListDestination,
} from '@/lib/services/crm-destinations';
import type { AuditEvent, CrmEntityType } from '@/lib/types/domain';

/**
 * Where each CRM list's data goes. The classifier is pure and tested on
 * invented list names shaped like the ones Affinity exports carry; the
 * service is tested against the demo store, whose lists are invented too.
 */

/* --------------------------------------------------------------- classifier */

const CASES: [name: string, entity: CrmEntityType, destination: CrmDestination, rule: string][] = [
  // SPVs and newsletters, even when they name LPs.
  ['Harborview SPV - First Send', 'person', 'lp_lists', 'spv-or-newsletter'],
  ['Q3 SPV Allocations', 'person', 'lp_lists', 'spv-or-newsletter'],
  ['Northwind AI SPV - Non-LP Friends', 'person', 'lp_lists', 'spv-or-newsletter'],
  ['LPs Quarterly Newsletter 2', 'person', 'lp_lists', 'spv-or-newsletter'],
  ['Capital Call Notices', 'person', 'lp_lists', 'spv-or-newsletter'],
  // Events, before the providers rule could take "sponsors".
  ['Demo Day Sponsors', 'company', 'events', 'event'],
  ['Meetup Sponsors and Partners', 'company', 'events', 'event'],
  ['Founders Dinner 2026 Invites', 'person', 'events', 'event'],
  ['Spring Lunch Guest List', 'person', 'events', 'event'],
  ['Summit RSVPs', 'person', 'events', 'event'],
  // LP pipelines, before the deal-pipeline rule.
  ['Family Office LP Pipeline', 'deal', 'lps', 'lp'],
  ['HNWI Pipeline', 'deal', 'lps', 'lp'],
  ['Institutional LP Targets', 'company', 'lps', 'lp'],
  ['Fund III LP Prospects', 'person', 'lps', 'lp'],
  ['Fund II LP Roster', 'person', 'lps', 'lp'],
  ['Institutional Allocators', 'company', 'lps', 'lp'],
  // Fund I's own LPs: a roster for LP lists, never Fund II's pipeline or its stage counts.
  ['Fund I LP Roster', 'person', 'lp_lists', 'fund-i-lps'],
  ['Fund 1 Investors', 'company', 'lp_lists', 'fund-i-lps'],
  ['Limited Partners - Fund One', 'person', 'lp_lists', 'fund-i-lps'],
  // Angel investments are not the fund's portfolio.
  ['Personal Angel Portco List', 'company', 'angel', 'angel'],
  ['Angel Portfolio Companies', 'company', 'angel', 'angel'],
  ['Angel Checks', 'deal', 'angel', 'angel'],
  // ...but angel investors are investors.
  ['Angel Investor Network', 'person', 'investors', 'investor'],
  // The fund's portfolio.
  ['Founders in the Portfolio', 'person', 'portfolio_people', 'portfolio'],
  ['Fund I Founders', 'person', 'portfolio_people', 'portfolio'],
  ['Portco CEOs', 'person', 'portfolio_people', 'portfolio'],
  ['Fund II Founders', 'person', 'portfolio_people', 'portfolio'],
  ['Portfolio', 'company', 'portfolio_people', 'portfolio'],
  // Investors and co-investors.
  ['Seed VC Contacts', 'person', 'investors', 'investor'],
  ['Seed VCs in Ohio', 'person', 'investors', 'investor'],
  ['Growth Equity / PE Firms', 'person', 'investors', 'investor'],
  ['Co-Investors 2025', 'person', 'investors', 'investor'],
  ['Brightline Seed Round VC Intros', 'person', 'investors', 'investor'],
  ['Emerging GPs', 'person', 'investors', 'investor'],
  // Providers, advisors, resources, perks.
  ['Preferred Vendor Network', 'company', 'providers', 'provider'],
  ['Advisors/ Consultants/ Accountants', 'person', 'providers', 'provider'],
  ['Resources for the Team', 'company', 'providers', 'provider'],
  ['Startup Perks Catalog', 'company', 'providers', 'provider'],
  ['Founder Resources', 'company', 'providers', 'provider'],
  // Operator networks outside the portfolio, before the sector rule.
  ['Example CxO Roundtable', 'person', 'operators', 'operator'],
  ['B2B SaaS Founders Circle', 'person', 'operators', 'operator'],
  ['CTO Circle', 'person', 'operators', 'operator'],
  // Watch lists and deal-flow feeds, even as opportunity lists.
  ['Robotics Watch List', 'company', 'sourcing', 'watch-or-feed'],
  ['Deal Flow from Scouts', 'deal', 'sourcing', 'watch-or-feed'],
  ['Example Network Dealflow', 'company', 'sourcing', 'watch-or-feed'],
  // The pipeline: any opportunity list, or a list called a pipeline.
  ['Startup Deal Pipeline', 'deal', 'deals', 'pipeline'],
  ['Inbound Deals', 'deal', 'deals', 'pipeline'],
  ['Seed Opportunities', 'deal', 'deals', 'pipeline'],
  ['Main Pipeline', 'company', 'deals', 'pipeline'],
  // Sector and theme lists of companies.
  ['Inbound Deals', 'company', 'sourcing', 'company-theme'],
  ['Applied AI Companies', 'company', 'sourcing', 'company-theme'],
  ['Healthcare SaaS+', 'company', 'sourcing', 'company-theme'],
  ['Proptech Top 25 2025', 'company', 'sourcing', 'company-theme'],
  ['Climate Startups', 'company', 'sourcing', 'company-theme'],
  // Anything else is kept for reference.
  ['Climate Startups', 'person', 'archive', 'unmatched'],
  ['Misc Imports', 'company', 'archive', 'unmatched'],
  ['Holiday Cards', 'person', 'archive', 'unmatched'],
];

describe('classifyCrmList', () => {
  it.each(CASES)('%s (%s) goes to %s', (name, entity_type, destination, rule) => {
    expect(classifyCrmList({ name, entity_type })).toEqual({ destination, rule });
  });

  it('has a case for every destination', () => {
    expect(new Set(CASES.map((c) => c.at(2)))).toEqual(new Set(CRM_DESTINATIONS));
  });

  it('ignores case and punctuation', () => {
    expect(classifyCrmList({ name: '  robotics   WATCH-list ', entity_type: 'company' })).toEqual({
      destination: 'sourcing',
      rule: 'watch-or-feed',
    });
  });

  it('does not read a word inside another word', () => {
    // "pe" is private equity only as a word: not in "perks" or "pending".
    expect(classifyCrmList({ name: 'Pending Perks', entity_type: 'company' }).destination).toBe(
      'providers',
    );
    // "lp" only as a word: not in "help".
    expect(classifyCrmList({ name: 'Help Desk', entity_type: 'company' }).destination).toBe(
      'archive',
    );
  });
});

describe('resolveCrmListDestination', () => {
  const list = { name: 'Startup Deal Pipeline', entity_type: 'deal' as const };

  it('uses the rules when nothing was chosen', () => {
    expect(resolveCrmListDestination(list)).toEqual({
      destination: 'deals',
      source: 'auto',
      auto: 'deals',
      rule: 'pipeline',
    });
  });

  it('uses a valid override and keeps what the rules said', () => {
    expect(resolveCrmListDestination(list, 'archive')).toEqual({
      destination: 'archive',
      source: 'override',
      auto: 'deals',
      rule: 'pipeline',
    });
  });

  it('ignores an override that is not a destination', () => {
    expect(resolveCrmListDestination(list, 'nowhere').source).toBe('auto');
    expect(resolveCrmListDestination(list, null).destination).toBe('deals');
  });
});

describe('the destination registry', () => {
  it('links each destination to the tab that holds its rows', () => {
    const pages = [DEALS_TABS, ...RECORDS_TABS];
    for (const d of CRM_DESTINATIONS) {
      const url = new URL(CRM_DESTINATION_INFO[d].href, 'https://copilot.example');
      const page = pages.find((p) => p.path === url.pathname);
      expect(page?.page, d).toBe(d === 'archive' ? 'Knowledge' : CRM_DESTINATION_INFO[d].page);
      expect(
        page?.tabs.map((t) => t.key),
        d,
      ).toContain(url.searchParams.get('tab'));
    }
    expect(CRM_DESTINATION_INFO.portfolio_people.href).toBe('/portfolio?tab=founders');
  });

  it('describes every destination, each linking inside the app', () => {
    for (const d of CRM_DESTINATIONS) {
      const info = CRM_DESTINATION_INFO[d];
      expect(info.key).toBe(d);
      expect(info.href.startsWith('/')).toBe(true);
      expect(info.label.length).toBeGreaterThan(0);
      expect(info.blurb.length).toBeGreaterThan(0);
    }
    expect(isCrmDestination('deals')).toBe(true);
    expect(isCrmDestination('toString')).toBe(false);
    expect(isCrmDestination(undefined)).toBe(false);
  });

  it('groups in display order and leaves out empty groups', () => {
    const groups = groupByDestination(
      [
        { n: 1, d: 'archive' as const },
        { n: 2, d: 'deals' as const },
        { n: 3, d: 'archive' as const },
      ],
      (x) => x.d,
    );
    expect(groups.map((g) => [g.destination, g.items.map((i) => i.n)])).toEqual([
      ['deals', [2]],
      ['archive', [1, 3]],
    ]);
    expect(groups[0]?.info.page).toBe('Deals');
  });
});

describe('the pages the lists feed', () => {
  it('lists each page once, in order, holding every destination', () => {
    expect(CRM_DESTINATION_PAGES.map((p) => [p.heading, p.href, p.destinations])).toEqual([
      ['Deals', '/deals', ['deals', 'sourcing']],
      ['Fund II', '/fund-ii', ['lps', 'lp_lists']],
      ['Portfolio', '/portfolio', ['angel', 'portfolio_people']],
      ['Network', '/network', ['investors', 'providers', 'operators', 'events']],
      ['Reference only', '/knowledge?tab=lists', ['archive']],
    ]);
  });

  it('groups by page, by destination within a page, and leaves out empty pages', () => {
    const groups = groupByPage(
      [
        { n: 1, d: 'events' as const },
        { n: 2, d: 'sourcing' as const },
        { n: 3, d: 'investors' as const },
        { n: 4, d: 'deals' as const },
      ],
      (x) => x.d,
    );
    expect(groups.map((g) => [g.page, g.items.map((i) => i.n)])).toEqual([
      ['Deals', [4, 2]],
      ['Network', [3, 1]],
    ]);
  });
});

/* ------------------------------------------------------------------ service */

let harness: Harness;
let store: DataStore;
let org: string;
const actor: CrmActor = { userId: DEMO_IDS.user, name: 'Morgan Ellery' };

function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.value;
}

beforeEach(async () => {
  harness = await createHarness();
  store = harness.store;
  org = harness.auth.organizationId;
});

afterEach(async () => {
  await harness.dispose();
});

/** The demo store with some tables failing as missing. */
function storeMissing(inner: DataStore, prefix: string): DataStore {
  const failure = () =>
    Object.assign(
      new Error(
        `[${prefix}] list failed: Could not find the table 'public.${prefix}' in the schema cache`,
      ),
      { code: 'PGRST205' },
    );
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const original = Reflect.get(target, prop, receiver);
      if (typeof original !== 'function') return original;
      return (...args: unknown[]) => {
        if (typeof args[0] === 'string' && args[0].startsWith(prefix)) {
          return Promise.reject(failure());
        }
        return original.apply(target, args);
      };
    },
  });
}

describe('lists by destination', () => {
  it('sends each demo list where its name says, covering every destination', async () => {
    const lists = value(await listsWithDestinations(store, org));
    expect(lists.map((l) => [l.name, l.destination.destination])).toEqual([
      ['Deal Pipeline', 'deals'],
      ['LP Pipeline', 'lps'],
      ['Portfolio', 'portfolio_people'],
      ['Climate Watch List', 'sourcing'],
      ['Angel Investments', 'angel'],
      ['Fund I Founders', 'portfolio_people'],
      ['Co-investor VCs', 'investors'],
      ['Service Providers', 'providers'],
      ['Operator Circle', 'operators'],
      ['Summit Sponsors', 'events'],
      ['Investor Newsletter', 'lp_lists'],
      ['Misc Imports', 'archive'],
      ['Seed Opportunities', 'deals'],
      ['Family Office LP Pipeline', 'lps'],
      ['Founder Lunch Invites', 'events'],
    ]);
    expect(new Set(lists.map((l) => l.destination.destination))).toEqual(new Set(CRM_DESTINATIONS));
    expect(lists.every((l) => l.destination.source === 'auto')).toBe(true);
    expect(lists[0]?.entry_count).toBe(11);
  });

  it('gives the lists of one destination, or of several', async () => {
    expect(value(await listsFor(store, org, 'deals')).map((l) => l.name)).toEqual([
      'Deal Pipeline',
      'Seed Opportunities',
    ]);
    expect(
      value(await listsFor(store, org, ['investors', 'providers'])).map((l) => l.name),
    ).toEqual(['Co-investor VCs', 'Service Providers']);
  });

  it('leaves archived lists out unless asked', async () => {
    await store.update('crm_lists', org, DEMO_IDS.crmListWatch, { archived: true });
    expect(value(await listsFor(store, org, 'sourcing'))).toEqual([]);
    expect(
      value(await listsFor(store, org, 'sourcing', { includeArchived: true })).map((l) => l.name),
    ).toEqual(['Climate Watch List']);
  });
});

describe('choosing a destination', () => {
  it('moves a list, keeps the choice as an audit row, and goes back to automatic', async () => {
    const chosen = value(
      await setListDestination(store, org, DEMO_IDS.crmListMisc, 'providers', actor),
    );
    expect(chosen).toEqual({
      destination: 'providers',
      source: 'override',
      auto: 'archive',
      rule: 'unmatched',
    });
    expect(value(await listsFor(store, org, 'providers')).map((l) => l.name)).toEqual([
      'Service Providers',
      'Misc Imports',
    ]);
    expect(await readDestinationOverrides(store, org)).toEqual({
      [DEMO_IDS.crmListMisc]: 'providers',
    });

    const back = value(await setListDestination(store, org, DEMO_IDS.crmListMisc, null, actor));
    expect(back).toMatchObject({ destination: 'archive', source: 'auto' });
    expect(await readDestinationOverrides(store, org)).toEqual({});

    const rows = (await store.list('audit_events', org, {
      eq: { action: CRM_DESTINATION_ACTION, entity_id: DEMO_IDS.crmListMisc },
    })) as AuditEvent[];
    const byTime = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at));
    expect(byTime.map((r) => r.metadata)).toEqual([
      { destination: 'providers', previous: null, list_name: 'Misc Imports' },
      { destination: null, previous: 'providers', list_name: 'Misc Imports' },
    ]);
    expect(rows.every((r) => r.user_id === DEMO_IDS.user)).toBe(true);
  });

  it('lets the latest choice win, even several in the same millisecond', async () => {
    for (const d of ['events', 'operators', 'investors'] as const) {
      value(await setListDestination(store, org, DEMO_IDS.crmListDeals, d, actor));
    }
    expect((await readDestinationOverrides(store, org))[DEMO_IDS.crmListDeals]).toBe('investors');
    const deal = value(await listsWithDestinations(store, org)).find(
      (l) => l.id === DEMO_IDS.crmListDeals,
    );
    expect(deal?.destination).toMatchObject({ destination: 'investors', auto: 'deals' });
  });

  it('refuses an unknown destination or list', async () => {
    const bad = await setListDestination(
      store,
      org,
      DEMO_IDS.crmListDeals,
      'nowhere' as CrmDestination,
    );
    expect(!bad.ok && bad.error.code).toBe('invalid_input');
    const missing = await setListDestination(
      store,
      org,
      '00000000-0000-4000-8000-00000000dead',
      'deals',
    );
    expect(!missing.ok && missing.error.code).toBe('not_found');
    const malformed = await setListDestination(store, org, 'not-a-uuid', 'deals');
    expect(!malformed.ok && malformed.error.code).toBe('not_found');
  });
});

describe('entries by destination', () => {
  it('reads every entry of the destination with its list, record and status', async () => {
    const page = value(
      await entriesFor(store, org, 'lps', { sort: 'title', listIds: [DEMO_IDS.crmListLps] }),
    );
    expect(page.total).toBe(5);
    expect(page.lists.map((l) => l.name)).toEqual(['LP Pipeline']);
    // Every list of the destination, for the page's list chips.
    expect(page.available.map((l) => l.name)).toEqual(['LP Pipeline', 'Family Office LP Pipeline']);
    expect(page.entries.map((e) => [e.entry.title, e.status])).toEqual([
      ['Desmond Achterberg', 'Committed'],
      ['Hana Kuroda', 'Declined'],
      ['Lucia Ferraro', 'Contacted'],
      ['Maren Solberg', 'Soft Circle'],
      ['Owen Thistlewood', 'Prospect'],
    ]);
    expect(page.entries[3]?.record).toMatchObject({ id: demoCrmId('record', 20), kind: 'person' });
    const both = value(await entriesFor(store, org, 'lps', { sort: 'title' }));
    expect(both.total).toBe(9);
    expect(page.entries[0]?.list).toEqual({
      id: DEMO_IDS.crmListLps,
      name: 'LP Pipeline',
      entity_type: 'person',
    });
    expect(page.statusFields[DEMO_IDS.crmListLps]?.key).toBe('status');
  });

  it('keeps rows that have no record, with a null record', async () => {
    const page = value(await entriesFor(store, org, 'angel', { sort: 'title' }));
    expect(page.entries.map((e) => [e.entry.title, e.record, e.status])).toEqual([
      ['Tallowpine Coffee', null, 'Active'],
      ['Wrenfield Audio', null, 'Exited'],
    ]);
  });

  it('searches titles, narrows to some lists, and pages', async () => {
    const found = value(await entriesFor(store, org, 'deals', { query: 'hearth' }));
    expect(found.entries.map((e) => e.entry.title).sort()).toEqual([
      'Hearthstone Payroll',
      'Hearthstone Payroll — Seed extension',
    ]);

    const both = value(
      await entriesFor(store, org, ['portfolio_people'], {
        listIds: [DEMO_IDS.crmListFounders],
        sort: 'title',
      }),
    );
    expect(both.lists.map((l) => l.name)).toEqual(['Fund I Founders']);
    expect(both.entries.map((e) => e.entry.title)).toEqual([
      'Dev Sharma',
      'Imani Oduya',
      'Maya Chen',
      'Sven Malmberg',
    ]);

    const first = value(await entriesFor(store, org, 'deals', { limit: 4, sort: 'title' }));
    const second = value(
      await entriesFor(store, org, 'deals', { limit: 4, offset: 4, sort: 'title' }),
    );
    expect(first.total).toBe(15);
    expect(first.entries).toHaveLength(4);
    const titles = [...first.entries, ...second.entries].map((e) => e.entry.title);
    expect(new Set(titles).size).toBe(8);
    expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b)));
  });

  it('filters by status on each list’s own status field, merging and paging', async () => {
    // The watch list's pipeline is Priority, the deal list's is Status.
    const all = value(
      await entriesFor(store, org, ['sourcing', 'deals'], {
        statusIn: ['High', 'Passed'],
        sort: 'title',
      }),
    );
    expect(all.total).toBe(3);
    expect(all.entries.map((e) => [e.entry.title, e.status])).toEqual([
      ['Ferrowind Energy', 'High'],
      ['Gullwing Logistics', 'Passed'],
      ['Nettlefield Foods', 'Passed'],
    ]);
    const page2 = value(
      await entriesFor(store, org, ['sourcing', 'deals'], {
        statusIn: ['High', 'Passed'],
        sort: 'title',
        limit: 2,
        offset: 1,
      }),
    );
    expect(page2.total).toBe(3);
    expect(page2.entries.map((e) => e.entry.title)).toEqual([
      'Gullwing Logistics',
      'Nettlefield Foods',
    ]);
    // A list with no status field contributes nothing to a status filter.
    const none = value(await entriesFor(store, org, 'archive', { statusIn: ['Active'] }));
    expect(none).toMatchObject({ total: 0, entries: [] });
  });

  it('is empty, not an error, for a destination with no lists', async () => {
    await store.update('crm_lists', org, DEMO_IDS.crmListMisc, { archived: true });
    const page = value(await entriesFor(store, org, 'archive'));
    expect(page).toMatchObject({ lists: [], entries: [], total: 0 });
  });
});

describe('before the CRM migration has been applied', () => {
  it('every read and the write say "not set up yet"', async () => {
    const missing = storeMissing(store, 'crm_');
    expect(isCrmNotSetUp(await listsWithDestinations(missing, org))).toBe(true);
    expect(isCrmNotSetUp(await listsFor(missing, org, 'deals'))).toBe(true);
    expect(isCrmNotSetUp(await entriesFor(missing, org, 'deals'))).toBe(true);
    expect(
      isCrmNotSetUp(await setListDestination(missing, org, DEMO_IDS.crmListDeals, 'lps')),
    ).toBe(true);
  });

  it('falls back to the rules when the choices cannot be read', async () => {
    value(await setListDestination(store, org, DEMO_IDS.crmListDeals, 'archive', actor));
    const noAudit = storeMissing(store, 'audit_events');
    expect(await readDestinationOverrides(noAudit, org)).toEqual({});
    const lists = value(await listsWithDestinations(noAudit, org));
    expect(lists.find((l) => l.id === DEMO_IDS.crmListDeals)?.destination.destination).toBe(
      'deals',
    );
  });
});
