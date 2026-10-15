import { describe, expect, it } from 'vitest';
import {
  pageNumber,
  pageWindow,
  resolveTab,
  showMoreHref,
  shownCount,
  single,
  tabHref,
} from '@/lib/util/page-tabs';
import {
  DEALS_TABS,
  FUND_II_TABS,
  KNOWLEDGE_TABS,
  MEETINGS_TABS,
  NETWORK_TABS,
  PORTFOLIO_TABS,
  RECORDS_TABS,
  UPDATES_TABS,
  fundTwoLpHref,
  landsOnSnapshot,
  openingTab,
  resolvePageTab,
} from '@/lib/records-tabs';

/**
 * Subtabs on the Records pages. The URL is the state, so the two things that
 * matter are that any URL opens a real tab (a stale or hand-typed `?tab` must
 * never blank the page) and that links into a page from elsewhere — a search
 * result, a citation — land on the tab that holds what they point at.
 */

const KEYS = ['alpha', 'beta', 'gamma'] as const;

describe('resolveTab', () => {
  it('returns a known key', () => {
    expect(resolveTab('beta', KEYS, 'alpha')).toBe('beta');
  });

  it('falls back on a missing, empty or unknown value', () => {
    expect(resolveTab(undefined, KEYS, 'alpha')).toBe('alpha');
    expect(resolveTab('', KEYS, 'alpha')).toBe('alpha');
    expect(resolveTab('zzz', KEYS, 'gamma')).toBe('gamma');
    // Not a prototype key or a near miss.
    expect(resolveTab('toString', KEYS, 'alpha')).toBe('alpha');
    expect(resolveTab('Beta', KEYS, 'alpha')).toBe('alpha');
  });

  it('reads the first value of a repeated param', () => {
    expect(resolveTab(['gamma', 'beta'], KEYS, 'alpha')).toBe('gamma');
    expect(resolveTab(['zzz', 'beta'], KEYS, 'alpha')).toBe('alpha');
    expect(single([])).toBeUndefined();
  });
});

describe('tabHref', () => {
  it('links the default tab to the bare path', () => {
    expect(tabHref('/example', 'alpha', 'alpha')).toBe('/example');
  });

  it('links every other tab with ?tab=', () => {
    expect(tabHref('/example', 'beta', 'alpha')).toBe('/example?tab=beta');
  });
});

/** Every page with a subtab bar: the Records pages, and Deals. */
const TABBED_PAGES = [DEALS_TABS, ...RECORDS_TABS];

describe('the Records pages', () => {
  it('each open on a default that is one of their tabs', () => {
    for (const page of TABBED_PAGES) {
      const keys = page.tabs.map((t) => t.key);
      expect(keys, page.path).toContain(page.defaultKey);
      expect(new Set(keys).size, `${page.path} has a duplicate key`).toBe(keys.length);
      expect(resolvePageTab(page, {}), page.path).toBe(page.defaultKey);
      expect(resolvePageTab(page, { tab: 'zzz' }), page.path).toBe(page.defaultKey);
      for (const key of keys) expect(resolvePageTab(page, { tab: key })).toBe(key);
    }
  });

  it('keep labels clear of the names the end-to-end suite looks up by substring', () => {
    // Playwright matches accessible names by substring: a tab whose label
    // contains a main-navigation name shadows that nav link, and a bar whose
    // name contains "main" is found as the main navigation.
    const navNames = [
      'Today',
      'Follow-ups',
      'Tasks',
      'Deals',
      'Ask',
      'Inbox',
      'Calendar',
      'Portfolio',
      'Fund II',
      'Meetings',
      'Network',
      'Reports',
      'Knowledge',
      'Settings',
    ];
    for (const page of TABBED_PAGES) {
      expect(page.navLabel.toLowerCase(), page.path).not.toContain('main');
      for (const tab of page.tabs) {
        for (const name of navNames) {
          expect(tab.label.toLowerCase(), `${page.path} ${tab.key}`).not.toContain(
            name.toLowerCase(),
          );
        }
        // The Reports filter chips are looked up page-wide by these exact names.
        expect(['All', 'Dealflow', 'Digests']).not.toContain(tab.label);
        expect(tab.blurb.length, `${page.path} ${tab.key} needs a blurb`).toBeGreaterThan(0);
      }
    }
  });

  it('send a citation to one portfolio update to Requests', () => {
    expect(resolvePageTab(PORTFOLIO_TABS, { update: 'update-1' })).toBe('requests');
    // An explicit tab still wins.
    expect(resolvePageTab(PORTFOLIO_TABS, { update: 'update-1', tab: 'numbers' })).toBe('numbers');
    expect(resolvePageTab(PORTFOLIO_TABS, {})).toBe('health');
  });

  it('send a meetings search to the notes', () => {
    expect(resolvePageTab(MEETINGS_TABS, { q: 'Example Labs' })).toBe('notes');
    expect(resolvePageTab(MEETINGS_TABS, { q: '' })).toBe('week');
    expect(resolvePageTab(MEETINGS_TABS, { tab: 'zzz', q: 'Example' })).toBe('notes');
  });

  it('send a network search or sort to the people list', () => {
    expect(resolvePageTab(NETWORK_TABS, { q: 'Ada Example' })).toBe('people');
    expect(resolvePageTab(NETWORK_TABS, { sort: 'person' })).toBe('people');
    expect(resolvePageTab(NETWORK_TABS, { dir: 'asc' })).toBe('people');
    expect(resolvePageTab(NETWORK_TABS, { tab: 'cold', q: 'Ada' })).toBe('cold');
    expect(resolvePageTab(NETWORK_TABS, {})).toBe('intros');
  });

  it('keep the other inbound links on the default tab', () => {
    // Reports filter URLs carry no tab and must stay on the reports.
    expect(resolvePageTab(UPDATES_TABS, { view: 'digests', source: 'example' })).toBe('reports');
    // Knowledge search and document citations: the documents tab.
    expect(resolvePageTab(KNOWLEDGE_TABS, { q: 'thesis' })).toBe('documents');
    expect(resolvePageTab(KNOWLEDGE_TABS, { document: 'doc-1' })).toBe('documents');
    // The DocSend phone alert links to the bare page: the readers.
    expect(resolvePageTab(FUND_II_TABS, {})).toBe('readers');
  });
});

describe('a snapshot default with nothing to show', () => {
  // Health, Week ahead and Intros are only a routine's post read from Slack.
  // A bare URL must not land Nick on an empty state when Slack is down or the
  // routine has not posted: it opens on the page's own records instead.
  const SNAPSHOT_PAGES = [
    [PORTFOLIO_TABS, 'health', 'requests'],
    [MEETINGS_TABS, 'week', 'notes'],
    [NETWORK_TABS, 'intros', 'people'],
  ] as const;

  it('opens a bare URL on the records tab, which becomes the bare link', () => {
    for (const [page, snapshot, records] of SNAPSHOT_PAGES) {
      expect(landsOnSnapshot(page, {}), page.path).toBe(true);
      expect(openingTab(page, {}, false), page.path).toEqual({ tab: records, home: records });
      // A stale ?tab is a bare URL too.
      expect(openingTab(page, { tab: 'zzz' }, false).tab, page.path).toBe(records);
      // With something to show, the snapshot stays the default.
      expect(openingTab(page, {}, true), page.path).toEqual({ tab: snapshot, home: snapshot });
      // So the snapshot tab is still one click away, at an explicit link.
      expect(tabHref(page.path, snapshot, records)).toBe(`${page.path}?tab=${snapshot}`);
    }
  });

  it('still opens the snapshot tab when the URL asks for it', () => {
    for (const [page, snapshot] of SNAPSHOT_PAGES) {
      expect(landsOnSnapshot(page, { tab: snapshot }), page.path).toBe(false);
      expect(openingTab(page, { tab: snapshot }, false).tab, page.path).toBe(snapshot);
    }
  });

  it('leaves links that point elsewhere alone, without reading the snapshot', () => {
    expect(landsOnSnapshot(PORTFOLIO_TABS, { update: 'update-1' })).toBe(false);
    expect(openingTab(PORTFOLIO_TABS, { update: 'update-1' }, false).tab).toBe('requests');
    expect(landsOnSnapshot(PORTFOLIO_TABS, { tab: 'numbers' })).toBe(false);
    expect(openingTab(PORTFOLIO_TABS, { tab: 'numbers' }, false)).toEqual({
      tab: 'numbers',
      home: 'health',
    });
    expect(landsOnSnapshot(NETWORK_TABS, { q: 'Ada' })).toBe(false);
    expect(landsOnSnapshot(MEETINGS_TABS, { q: 'Example' })).toBe(false);
  });

  it('does not apply to pages whose default is not a snapshot', () => {
    for (const page of [FUND_II_TABS, UPDATES_TABS, KNOWLEDGE_TABS]) {
      expect(landsOnSnapshot(page, {}), page.path).toBe(false);
      expect(openingTab(page, {}, false).tab, page.path).toBe(page.defaultKey);
    }
  });
});

describe('fundTwoLpHref', () => {
  it('links an LP to the tab that lists them', () => {
    // The pipeline shows only open stages: a passed LP is on Passed alone.
    expect(fundTwoLpHref('passed')).toBe('/fund-ii?tab=passed');
    for (const stage of ['target', 'contacted', 'meeting', 'soft_commit', 'committed'] as const) {
      expect(fundTwoLpHref(stage)).toBe('/fund-ii?tab=pipeline');
    }
  });
});

describe('long lists a page at a time', () => {
  it('reads ?show= as a whole number of rows, a page by default', () => {
    expect(shownCount(undefined, 25, 500)).toBe(25);
    expect(shownCount('50', 25, 500)).toBe(50);
    expect(shownCount(['75', '100'], 25, 500)).toBe(75);
    // Junk, fractions and anything at or under a page read as the first page.
    for (const raw of ['', 'abc', '-50', '0', '10', '25', '30.5', 'Infinity']) {
      expect(shownCount(raw, 25, 500), raw).toBe(25);
    }
    // A hand-typed huge number is capped.
    expect(shownCount('100000', 25, 500)).toBe(500);
    expect(shownCount('100', 50, 10)).toBe(50);
  });

  it('links the next page with the same tab and search', () => {
    expect(showMoreHref('/example', { tab: 'notes', q: 'Ada Example' }, 25, 25)).toBe(
      '/example?tab=notes&q=Ada+Example&show=50',
    );
    // An empty search is left out.
    expect(showMoreHref('/example', { tab: 'notes', q: '' }, 50, 25)).toBe(
      '/example?tab=notes&show=75',
    );
  });
});

describe('lists of thousands, paged', () => {
  it('reads ?page= as a page counted from 1, the first by default', () => {
    expect(pageNumber(undefined)).toBe(1);
    expect(pageNumber('3')).toBe(3);
    expect(pageNumber(['4', '9'])).toBe(4);
    for (const raw of ['', 'abc', '-2', '0', '1.5', 'Infinity']) {
      expect(pageNumber(raw), raw).toBe(1);
    }
    expect(pageNumber('999999', 500)).toBe(500);
  });

  it('says where a page starts, and moves a page past the end back to the last', () => {
    expect(pageWindow(1, 50, 3000)).toEqual({ page: 1, pages: 60, offset: 0 });
    expect(pageWindow(60, 50, 3000)).toEqual({ page: 60, pages: 60, offset: 2950 });
    expect(pageWindow(61, 50, 3000)).toEqual({ page: 60, pages: 60, offset: 2950 });
    expect(pageWindow(3, 50, 101)).toEqual({ page: 3, pages: 3, offset: 100 });
    expect(pageWindow(2, 25, 0)).toEqual({ page: 1, pages: 1, offset: 0 });
  });
});
