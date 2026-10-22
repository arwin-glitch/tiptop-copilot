import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Subtabs on the Records pages, over the invented demo workspace.
 *
 * Each page's sections sit behind a bar of links held in the URL (`?tab=`),
 * so the things worth asserting are the ones that would quietly undo that: a
 * tab that is only hidden rather than left out (so its data still loads), a
 * switch the Back button cannot undo, a stale `?tab` that blanks the page,
 * and a link from elsewhere landing on the wrong tab.
 */

// One demo sign-in for the whole file: demo entry is capped at 60 a minute
// across the suite.
const SIGNED_IN = path.resolve('test-results', 'records-tabs-state.json');

test.beforeAll(async ({ browser }, testInfo) => {
  // An explicit empty state, or this context would inherit the file's
  // `storageState` below and try to read the file it is about to write.
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    storageState: { cookies: [], origins: [] },
  });
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByRole('button', { name: 'Enter demo workspace' }).click();
  await page.waitForURL(/\/today/);
  await context.storageState({ path: SIGNED_IN });
  await context.close();
});

test.use({ storageState: SIGNED_IN });

interface TabCase {
  label: RegExp;
  /** Something on the page only while this tab is open. */
  marker: (page: Page) => Locator;
}

interface PageCase {
  path: string;
  nav: string;
  first: TabCase;
  other: TabCase & { key: string };
}

const PAGES: PageCase[] = [
  {
    path: '/portfolio',
    nav: 'Portfolio sections',
    first: {
      label: /^Health/,
      marker: (p) => p.getByRole('heading', { name: 'Portfolio health' }),
    },
    other: {
      key: 'numbers',
      label: /^Numbers/,
      marker: (p) => p.getByRole('region', { name: 'Numbers from their updates' }),
    },
  },
  {
    path: '/fund-ii',
    nav: 'Fund II sections',
    first: {
      label: /^DocSend readers/,
      marker: (p) => p.getByRole('region', { name: 'Reading your DocSend' }),
    },
    other: {
      key: 'pipeline',
      label: /^LP pipeline/,
      marker: (p) => p.getByRole('region', { name: 'Soft commit' }),
    },
  },
  {
    path: '/meetings',
    nav: 'Meetings sections',
    first: {
      label: /^Week ahead/,
      marker: (p) => p.getByRole('heading', { name: 'The week ahead' }),
    },
    other: {
      key: 'notes',
      label: /^Notes/,
      marker: (p) => p.getByRole('searchbox', { name: 'Search meetings' }),
    },
  },
  {
    path: '/network',
    nav: 'Network sections',
    first: {
      label: /^Intros/,
      marker: (p) => p.getByRole('heading', { name: 'Intros', exact: true }),
    },
    other: {
      key: 'people',
      label: /^People/,
      marker: (p) => p.getByRole('searchbox', { name: 'Search network' }),
    },
  },
  {
    path: '/updates',
    nav: 'Reports sections',
    first: {
      label: /^Dealflow & digests/,
      marker: (p) => p.getByRole('group', { name: 'Filter updates' }),
    },
    other: {
      key: 'fresh',
      label: /^Fresh updates/,
      marker: (p) => p.getByRole('region', { name: 'Fresh company updates' }),
    },
  },
  {
    path: '/knowledge',
    nav: 'Knowledge sections',
    first: {
      label: /^Documents/,
      marker: (p) => p.getByRole('searchbox', { name: 'Search knowledge base' }),
    },
    other: {
      key: 'contacts',
      label: /^Contacts/,
      marker: (p) => p.getByRole('table', { name: 'Network contacts' }),
    },
  },
];

for (const c of PAGES) {
  test(`${c.path} shows one section at a time, kept in the URL`, async ({ page }) => {
    await page.goto(c.path);
    const nav = page.getByRole('navigation', { name: c.nav });
    await expect(nav).toBeVisible();
    const first = nav.getByRole('link', { name: c.first.label });
    const other = nav.getByRole('link', { name: c.other.label });

    await expect(first).toHaveAttribute('aria-current', 'page');
    await expect(other).not.toHaveAttribute('aria-current');
    await expect(c.first.marker(page)).toBeVisible();
    // Left out, not hidden: the other tab's data is never fetched.
    await expect(c.other.marker(page)).toHaveCount(0);

    await other.click();
    await page.waitForURL((url) => url.searchParams.get('tab') === c.other.key);
    await expect(other).toHaveAttribute('aria-current', 'page');
    await expect(first).not.toHaveAttribute('aria-current');
    await expect(c.other.marker(page)).toBeVisible();
    await expect(c.first.marker(page)).toHaveCount(0);
    // The page itself stays: one heading, the same title.
    await expect(page.locator('h1')).toHaveCount(1);

    await page.goBack();
    await page.waitForURL((url) => url.pathname === c.path && !url.searchParams.has('tab'));
    await expect(first).toHaveAttribute('aria-current', 'page');
    await expect(c.first.marker(page)).toBeVisible();

    // A stale or mistyped tab opens the default rather than a blank page.
    await page.goto(`${c.path}?tab=zzz`);
    await expect(first).toHaveAttribute('aria-current', 'page');
    await expect(c.first.marker(page)).toBeVisible();
  });
}

test('every Records tab renders', async ({ page }) => {
  // Each tab URL opens with its own link marked current and no error page.
  const tabs: [string, string, RegExp][] = [
    ['/portfolio?tab=requests', 'Portfolio sections', /^Requests/],
    ['/portfolio?tab=jobs', 'Portfolio sections', /^Jobs/],
    ['/network?tab=students', 'Network sections', /^Students & interns/],
    ['/portfolio?tab=companies', 'Portfolio sections', /^Companies/],
    ['/fund-ii?tab=passed', 'Fund II sections', /^Passed/],
    ['/network?tab=cold', 'Network sections', /^Going cold/],
    ['/knowledge?tab=lists', 'Knowledge sections', /^Affinity lists/],
    ['/knowledge?tab=import', 'Knowledge sections', /^Affinity import/],
    // Affinity's data on the pages that use it.
    ['/deals?tab=pipeline', 'Deals sections', /^Pipeline/],
    ['/deals?tab=sourcing', 'Deals sections', /^Sourcing/],
    ['/portfolio?tab=founders', 'Portfolio sections', /^Founders/],
    ['/portfolio?tab=angel', 'Portfolio sections', /^Angel/],
    ['/fund-ii?tab=lists', 'Fund II sections', /^LP lists/],
    ['/network?tab=investors', 'Network sections', /^Investors/],
    ['/network?tab=providers', 'Network sections', /^Service providers/],
    ['/network?tab=operators', 'Network sections', /^Operators/],
    ['/network?tab=events', 'Network sections', /^Event lists/],
  ];
  for (const [url, nav, label] of tabs) {
    await page.goto(url);
    await expect(
      page.getByRole('navigation', { name: nav }).getByRole('link', { name: label }),
      url,
    ).toHaveAttribute('aria-current', 'page');
  }
  await page.goto('/portfolio?tab=requests');
  await expect(page.getByRole('heading', { name: /^Open requests/ })).toBeVisible();
  await page.goto('/portfolio?tab=companies');
  await expect(page.getByRole('link', { name: /^Stonebridge Ops/ })).toBeVisible();
  await page.goto('/fund-ii?tab=passed');
  await expect(page.getByRole('region', { name: 'Passed' })).toContainText(
    'Not adding managers this year',
  );
  await page.goto('/network?tab=cold');
  await expect(page.getByRole('heading', { name: /^Going cold/ })).toBeVisible();
  await page.goto('/knowledge?tab=lists');
  await expect(page.getByRole('region', { name: 'Deals', exact: true })).toBeVisible();
  await page.goto('/knowledge?tab=import');
  await expect(page.getByRole('heading', { name: 'Import from Affinity' })).toBeVisible();
});

test('links from elsewhere land on the tab that holds what they point at', async ({ page }) => {
  // A citation to one portfolio update.
  await page.goto('/portfolio?update=00000000-0000-4000-8000-000000000000');
  await expect(
    page.getByRole('navigation', { name: 'Portfolio sections' }).getByRole('link', {
      name: /^Requests/,
    }),
  ).toHaveAttribute('aria-current', 'page');

  // A command-palette meeting result is a search of the notes.
  await page.goto('/meetings?q=Ledgerly');
  const notes = page
    .getByRole('navigation', { name: 'Meetings sections' })
    .getByRole('link', { name: /^Notes/ });
  await expect(notes).toHaveAttribute('aria-current', 'page');
  const search = page.getByRole('searchbox', { name: 'Search meetings' });
  await expect(search).toHaveValue('Ledgerly');
  // Clearing that search stays on the notes rather than jumping to the default tab.
  await page.getByRole('button', { name: 'Clear search' }).click();
  await page.waitForURL((url) => !url.searchParams.get('q'));
  expect(new URL(page.url()).searchParams.get('tab')).toBe('notes');
  await expect(notes).toHaveAttribute('aria-current', 'page');

  // A sorted people list.
  await page.goto('/network?sort=person&dir=asc');
  await expect(
    page.getByRole('navigation', { name: 'Network sections' }).getByRole('link', {
      name: /^People/,
    }),
  ).toHaveAttribute('aria-current', 'page');

  // A Reports filter URL stays on the reports.
  await page.goto('/updates?view=digests');
  await expect(
    page.getByRole('navigation', { name: 'Reports sections' }).getByRole('link', {
      name: /^Dealflow & digests/,
    }),
  ).toHaveAttribute('aria-current', 'page');
});

test('the bar stays in reach below the demo banner, and a switch lands at the top', async ({
  page,
}) => {
  // The reports are the longest tab in the demo workspace.
  await page.goto('/updates');
  const nav = page.getByRole('navigation', { name: 'Reports sections' });
  await expect(nav).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Weekly digest ·/ })).toBeVisible();

  const natural = await nav.evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(natural);

  // Stuck under the banner, not behind it.
  const banner = await page.getByRole('status').filter({ hasText: 'Demo mode' }).boundingBox();
  const bannerBottom = (banner?.y ?? 0) + (banner?.height ?? 0);
  const bar = await nav.boundingBox();
  expect(bar).not.toBeNull();
  expect(bar!.y).toBeGreaterThanOrEqual(bannerBottom - 1);
  expect(bar!.y).toBeLessThan(bannerBottom + 2);

  // From the bottom of the reports, the new tab starts right under the bar.
  await nav.getByRole('link', { name: /^Fresh updates/ }).click();
  await page.waitForURL((url) => url.searchParams.get('tab') === 'fresh');
  const fresh = page.getByRole('region', { name: 'Fresh company updates' });
  await expect(fresh).toBeVisible();
  await expect(fresh).toBeInViewport();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThanOrEqual(natural);
  const after = await nav.boundingBox();
  expect(after!.y).toBeGreaterThanOrEqual(bannerBottom - 1);
});

test('an LP found in search opens on the tab that lists them', async ({ page }) => {
  // The pipeline shows only open stages: someone who passed is on Passed alone.
  // Asked the way the command palette asks, from a signed-in page.
  await page.goto('/fund-ii');
  const search = (q: string) =>
    page.evaluate(async (query) => {
      const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
        cache: 'no-store',
      });
      const body = (await response.json()) as {
        results?: { kind: string; label: string; href: string }[];
      };
      return { status: response.status, hit: body.results?.find((r) => r.kind === 'lp') };
    }, q);

  const passed = await search('Chris Park');
  expect(passed.status).toBe(200);
  expect(passed.hit).toMatchObject({ label: 'Chris Park', href: '/fund-ii?tab=passed' });
  await page.goto(passed.hit!.href);
  await expect(page.getByRole('region', { name: 'Passed' })).toContainText('Chris Park');

  const open = await search('Omar Haddad');
  expect(open.hit).toMatchObject({ label: 'Omar Haddad', href: '/fund-ii?tab=pipeline' });
  await page.goto(open.hit!.href);
  await expect(page.getByRole('region', { name: 'Meeting' })).toContainText('Omar Haddad');
});

test('a focused tab shows its whole focus ring', async ({ page }) => {
  await page.goto('/portfolio');
  const nav = page.getByRole('navigation', { name: 'Portfolio sections' });
  const first = nav.getByRole('link').first();
  await first.focus();
  await expect(first).toBeFocused();
  // The ring is drawn inside the link, so the sideways scroller around the
  // links (overflow clips everything outside it) cannot cut it off.
  const ring = await first.evaluate((el) => {
    const style = getComputedStyle(el);
    return { width: parseFloat(style.outlineWidth), offset: parseFloat(style.outlineOffset) };
  });
  expect(ring.width).toBeGreaterThan(0);
  expect(ring.offset + ring.width).toBeLessThanOrEqual(0);
});

test('keyboard focus never stops underneath the stuck bar', async ({ page }) => {
  // Shift+Tab up a long tab: each stop the window scrolls to must land below
  // the banner and the bar (WCAG 2.4.11), not at the very top under them.
  const cases: [string, string, (p: Page) => Locator][] = [
    ['/network?tab=people', 'Network sections', (p) => p.getByRole('table')],
    ['/updates', 'Reports sections', (p) => p.getByRole('heading', { name: /^Weekly digest ·/ })],
  ];
  for (const [url, name, ready] of cases) {
    await page.goto(url);
    const nav = page.getByRole('navigation', { name });
    await expect(nav).toBeVisible();
    await expect(ready(page)).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.locator('main a[href], main button, main summary').last().focus();

    let checked = 0;
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Shift+Tab');
      const stop = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || !el.closest('main') || el.closest('[data-page-tabs]')) return null;
        // The page header (its "?" tour button, its actions) sits above the
        // bar in the page's flow: focus there scrolls to the top, where the
        // bar is not stuck, so it is never underneath it.
        if (el.closest('main header')) return null;
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom };
      });
      if (!stop) continue;
      const bar = await nav.boundingBox();
      const barBottom = (bar?.y ?? 0) + (bar?.height ?? 0);
      // Fully underneath the bar is the failure; partly visible is enough to see.
      expect(stop.bottom, `${url} focus stop ${i}`).toBeGreaterThan(barBottom);
      checked++;
    }
    expect(checked, url).toBeGreaterThan(5);
  }
});

test('the contacts tab has its own search, kept on the tab', async ({ page }) => {
  await page.goto('/knowledge?tab=contacts');
  const table = page.getByRole('table', { name: 'Network contacts' });
  const rows = table.locator('tbody tr');
  const before = await rows.count();
  expect(before).toBeGreaterThan(1);

  await page.getByRole('searchbox', { name: 'Search contacts' }).fill('Ridgeline');
  await expect(rows).toHaveCount(1);
  await expect(table).toContainText('Daniel Okafor');
  expect(new URL(page.url()).searchParams.get('tab')).toBe('contacts');

  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(rows).toHaveCount(before);
  expect(new URL(page.url()).searchParams.get('tab')).toBe('contacts');
});
