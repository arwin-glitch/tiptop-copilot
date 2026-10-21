import { resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { frameActions, markAsFramelessDesktop, type FrameOptions } from '../helpers/desktop-frame';

/**
 * The desktop app's own top bar, from 0.3.0 (components/desktop/
 * desktop-title-bar.tsx), over the invented demo workspace.
 *
 * The shell is simulated (tests/helpers/desktop-frame.ts): its two globals
 * and a stand-in for its IPC that records each call. What is asserted is
 * what a unit test cannot see: in a browser nothing moves at all; in the app
 * there is exactly one bar, the page sits under it rather than behind it
 * (sticky bars, dialogs, the Ask panel, tours), the controls call the shell,
 * and keyboard focus is never stolen from the page.
 *
 * The demo banner sits between the bar and the page here, so positions are
 * measured from the banner's bottom where it matters.
 */

const EMPTY = { cookies: [], origins: [] };
const SIGNED_IN = resolve('test-results', 'desktop-titlebar-state.json');

test.beforeAll(async ({ browser }, testInfo) => {
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    storageState: EMPTY,
  });
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByRole('button', { name: 'Enter demo workspace' }).click();
  await page.waitForURL(/\/today/);
  await context.storageState({ path: SIGNED_IN });
  await context.close();
});

test.use({ storageState: SIGNED_IN, viewport: { width: 1280, height: 800 } });

const bar = (page: Page) => page.locator('[data-titlebar]');
const toolbar = (page: Page) => page.getByRole('toolbar', { name: 'Title bar' });
const controls = (page: Page) => page.getByRole('group', { name: 'Window controls' });
/** A bar button by name, found without the accessibility tree (a modal hides the bar from it). */
const barButton = (page: Page, name: string) =>
  page.locator(`[data-titlebar] button[aria-label="${name}"]`);

async function openInApp(page: Page, path: string, options: FrameOptions = {}) {
  await page.addInitScript(markAsFramelessDesktop, options);
  await page.goto(path);
  await expect(bar(page)).toHaveAttribute('data-titlebar-ready', '');
}

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  expect(b).not.toBeNull();
  return b!;
}

async function demoBannerBottom(page: Page): Promise<number> {
  const banner = await box(page.getByRole('status').filter({ hasText: 'Demo mode' }));
  return banner.y + banner.height;
}

test.describe('in a browser', () => {
  test('nothing changes: no bar, no room kept for one, the skip link first', async ({ page }) => {
    await page.goto('/today');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(bar(page)).toBeHidden();
    const css = await page.evaluate(() => {
      const html = document.documentElement;
      return {
        attr: html.hasAttribute('data-desktop-frame'),
        titlebar: getComputedStyle(html).getPropertyValue('--titlebar-h').trim(),
        gutter: getComputedStyle(html).scrollbarGutter,
        padding: getComputedStyle(document.body).paddingTop,
        art: getComputedStyle(document.querySelector('.filigree-header > svg')!).maskImage,
      };
    });
    expect(css).toEqual({
      attr: false,
      titlebar: '0px',
      gutter: 'auto',
      padding: '0px',
      art: 'none',
    });

    // The rail starts under the demo banner and is the window's height, as before.
    const aside = await box(page.locator('aside'));
    expect(Math.abs(aside.y - (await demoBannerBottom(page)))).toBeLessThanOrEqual(1);
    expect(aside.height).toBe(800);
    // Search is the sidebar's button, as before.
    await expect(page.locator('aside').getByRole('button', { name: /^Search/ })).toBeVisible();

    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  });

  test.describe('signed out', () => {
    test.use({ storageState: EMPTY });

    test('the sign-in page has no bar either', async ({ page }) => {
      await page.goto('/login');
      await expect(page.getByRole('button', { name: 'Enter demo workspace' })).toBeVisible();
      await expect(bar(page)).toBeHidden();
      expect(await page.evaluate(() => getComputedStyle(document.body).paddingTop)).toBe('0px');
    });
  });
});

test.describe('never two title bars', () => {
  test('an app before 0.3.0, or a second window, keeps its native frame', async ({ page }) => {
    // 0.2.x has a native title bar; even with the frame global it gets no bar here.
    await page.addInitScript(markAsFramelessDesktop, { version: '0.2.1' });
    await page.goto('/today');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(bar(page)).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.dataset.desktopFrame)).toBe(
      undefined,
    );
  });

  test('a 0.3.0 window without the frame global (attachments, the briefing)', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, '__TIPTOP_DESKTOP__', { value: '0.3.0' });
    });
    await page.goto('/today');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(bar(page)).toBeHidden();
  });
});

test.describe('the Windows app (0.3.0)', () => {
  test('one bar across the top, and the page under it', async ({ page }) => {
    await openInApp(page, '/today');
    // The width a fixed element spans: the window's, less a classic scrollbar
    // where there is one (the shell turns on overlay scrollbars, which take none).
    const width = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;left:0;right:0;top:0;height:1px;';
      document.body.appendChild(probe);
      const value = probe.getBoundingClientRect().width;
      probe.remove();
      return value;
    });
    const b = await box(bar(page));
    expect(b).toMatchObject({ x: 0, y: 0, height: 40, width });
    const close = await box(barButton(page, 'Close window'));
    expect(close.x + close.width).toBe(width);
    expect(close.height).toBe(40);
    expect(await page.evaluate(() => getComputedStyle(document.body).paddingTop)).toBe('40px');

    // The rail sits under the bar and ends at the bottom of the window.
    await expect(page.locator('aside')).toHaveCSS('top', '40px');
    await expect(page.locator('aside')).toHaveCSS('height', '760px');

    // Search moves into the bar; the sidebar's button steps aside.
    await expect(toolbar(page).getByRole('button', { name: 'Search Copilot' })).toBeVisible();
    await expect(page.locator('aside').getByRole('button', { name: /^Search/ })).toBeHidden();
    await expect(toolbar(page).getByRole('button', { name: 'Menu' })).toBeVisible();
    await expect(controls(page).getByRole('button', { name: 'Minimise' })).toBeVisible();

    // The page header's gold line art grows out from under the bar.
    expect(
      await page.evaluate(
        () => getComputedStyle(document.querySelector('.filigree-header > svg')!).maskImage,
      ),
    ).toContain('linear-gradient');

    // Scrolled, the rail is stuck under the bar, bottom on the window's.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect
      .poll(async () => {
        const aside = await box(page.locator('aside'));
        return [Math.round(aside.y), Math.round(aside.y + aside.height)];
      })
      .toEqual([40, 800]);
  });

  test('the bar is the colour of what is under it, in both themes', async ({ page }) => {
    await openInApp(page, '/today');
    const colours = () =>
      page.evaluate(() => {
        const band = document.querySelector('main header > span[aria-hidden="true"]');
        return {
          bar: getComputedStyle(document.querySelector('[data-titlebar]')!).backgroundColor,
          band: band ? getComputedStyle(band).backgroundColor : null,
        };
      });
    const light = await colours();
    expect(light.band).not.toBeNull();
    expect(light.bar).toBe(light.band);

    await page.evaluate(() => window.localStorage.setItem('tiptop-theme', 'dark'));
    await page.reload();
    await expect(bar(page)).toHaveAttribute('data-titlebar-ready', '');
    const dark = await colours();
    expect(dark.bar).toBe(dark.band);
    expect(dark.bar).not.toBe(light.bar);
  });

  test('the controls call the shell', async ({ page }) => {
    await openInApp(page, '/today');
    await controls(page).getByRole('button', { name: 'Minimise' }).click();
    await controls(page).getByRole('button', { name: 'Maximise' }).click();
    await controls(page).getByRole('button', { name: 'Close window' }).click();
    const menu = toolbar(page).getByRole('button', { name: 'Menu' });
    // Never a Tab stop, like a native menu bar: Alt or F10 is the keyboard's way.
    await menu.click();
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    await expect(menu).toHaveAttribute('tabindex', '-1');
    await expect
      .poll(() => frameActions(page))
      .toEqual([
        ['window_control', { action: 'minimize' }],
        ['window_control', { action: 'toggle-maximize' }],
        ['window_control', { action: 'close' }],
        // The menu hangs from the bar's bottom edge, at the button's left.
        // Told on the press, while Windows still reports the mouse button
        // down, and asked for on the click: the shell opens it only for a
        // click whose press it saw (frame.rs).
        ['show_app_menu', { x: 6, y: 40 }],
        ['show_app_menu', { x: 6, y: 40 }],
      ]);

    // Maximised: the middle button restores.
    await page.evaluate(() => {
      (window as unknown as { __frameState: { maximized: boolean } }).__frameState.maximized = true;
      window.dispatchEvent(new Event('resize'));
    });
    await expect(controls(page).getByRole('button', { name: 'Restore' })).toBeVisible();
    await expect(bar(page)).toHaveAttribute('data-maximized', '');
    // The restore glyph shows (CSS, keyed to <html>), and the next launch remembers it.
    await expect(page.locator('html')).toHaveAttribute('data-desktop-maximized', '');
    await expect(barButton(page, 'Restore').locator('rect[y="2.5"]')).toBeVisible();
    await expect(barButton(page, 'Restore').locator('rect[y="0.5"]')).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem('tiptop-desktop-maximized'))).toBe('1');

    // Full screen: it leaves full screen, and the bar no longer moves the window.
    await page.evaluate(() => {
      (window as unknown as { __frameState: { fullscreen: boolean } }).__frameState.fullscreen =
        true;
      window.dispatchEvent(new Event('resize'));
    });
    const exit = controls(page).getByRole('button', { name: 'Exit full screen' });
    await expect(exit).toBeVisible();
    await expect(bar(page)).toHaveAttribute('data-tauri-drag-region', 'false');
    await exit.click();
    await expect
      .poll(async () => (await frameActions(page)).at(-1))
      .toEqual(['window_control', { action: 'exit-full-screen' }]);
  });

  test('the menu leaves focus and the selection in the field being typed in', async ({ page }) => {
    await openInApp(page, '/ask');
    const field = page.getByLabel('Your question');
    await field.fill('Who is waiting on Nick?');
    await field.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(4, 6));
    await toolbar(page).getByRole('button', { name: 'Menu' }).click();
    await controls(page).getByRole('button', { name: 'Minimise' }).click();
    await expect(field).toBeFocused();
    expect(
      await field.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd]),
    ).toEqual([4, 6]);
  });

  test('a window that opens maximised shows "restore" from the first frame', async ({ page }) => {
    await page.addInitScript(markAsFramelessDesktop, {
      state: { maximized: true, fullscreen: false, zoom: 1 },
    });
    await page.addInitScript(() => {
      window.localStorage.setItem('tiptop-desktop-maximized', '1');
      // The shell has not answered yet: only the cached state is known.
      const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: unknown } })
        .__TAURI_INTERNALS__;
      internals.invoke = () => new Promise(() => {});
    });
    await page.goto('/today');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-desktop-maximized', '');
    const slot = controls(page).locator('button').nth(1);
    await expect(slot.locator('rect[y="2.5"]')).toBeVisible();
    await expect(slot.locator('rect[y="0.5"]')).toBeHidden();
  });

  test('Alt on its own, or F10, asks the shell for the menu', async ({ page }) => {
    await openInApp(page, '/today');
    const menuCalls = async () =>
      (await frameActions(page)).filter(([cmd]) => cmd === 'show_app_menu').length;

    // Asked as Alt goes down; the shell opens the menu only if Alt is then
    // let go with nothing else pressed (frame.rs), which no page can fake.
    await page.keyboard.press('Alt');
    await expect.poll(menuCalls).toBe(1);

    // Alt after another modifier is part of a shortcut (AltGr is Ctrl+Alt).
    await page.keyboard.press('Shift+Alt');
    await page.keyboard.press('Control+Alt');
    await page.waitForTimeout(200);
    expect(await menuCalls()).toBe(1);

    await page.keyboard.press('F10');
    await expect.poll(menuCalls).toBe(2);
    await page.keyboard.press('Shift+F10');
    await page.waitForTimeout(200);
    expect(await menuCalls()).toBe(2);
  });

  test('Windows 10 gets its own caption style', async ({ page }) => {
    const hint = (platformVersion: string) => {
      Object.defineProperty(navigator, 'userAgentData', {
        configurable: true,
        value: {
          platform: 'Windows',
          getHighEntropyValues: async () => ({ platform: 'Windows', platformVersion }),
        },
      });
    };
    await page.addInitScript(hint, '10.0.0');
    await openInApp(page, '/today');
    await expect(page.locator('html')).toHaveAttribute('data-win10', '');
    const close = (name: string) =>
      page.evaluate(
        (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
        name,
      );
    expect(await close('--titlebar-close')).toBe('#e81123');
    expect(
      await barButton(page, 'Maximise')
        .locator('rect')
        .first()
        .evaluate((el) => getComputedStyle(el).rx),
    ).toBe('0px');
  });

  test.describe('on Windows 11', () => {
    test('keeps the Windows 11 caption style', async ({ page }) => {
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'userAgentData', {
          configurable: true,
          value: {
            platform: 'Windows',
            getHighEntropyValues: async () => ({ platform: 'Windows', platformVersion: '15.0.0' }),
          },
        });
      });
      await openInApp(page, '/today');
      await page.waitForTimeout(200);
      expect(await page.evaluate(() => document.documentElement.hasAttribute('data-win10'))).toBe(
        false,
      );
      expect(
        await page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue('--titlebar-close').trim(),
        ),
      ).toBe('#c42b1c');
    });
  });

  test('Search Copilot opens search, and the bar still works over it', async ({ page }) => {
    await openInApp(page, '/today');
    const field = toolbar(page).getByRole('button', { name: 'Search Copilot' });
    const pill = await box(field);
    await field.click();
    const dialog = page.getByRole('dialog', { name: 'Search' });
    await expect(dialog).toBeVisible();
    await expect(page.getByLabel('Search everything')).toBeFocused();
    // The field looks pressed while its search is open (the bar is hidden
    // from the accessibility tree meanwhile, so found by its attribute).
    await expect(barButton(page, 'Search Copilot')).toHaveAttribute('aria-expanded', 'true');

    // It hangs just under the field, centred on it, like Slack's.
    const d = await box(dialog);
    expect(d.y).toBeGreaterThanOrEqual(40);
    expect(d.y).toBeLessThanOrEqual(52);
    expect(Math.abs(d.x + d.width / 2 - (pill.x + pill.width / 2))).toBeLessThanOrEqual(1);

    // Above the scrim: what is under the minimise button is the button.
    const minimise = barButton(page, 'Minimise');
    const m = await box(minimise);
    expect(
      await page.evaluate(
        ([x, y]) => document.elementFromPoint(x!, y!)?.closest('[data-titlebar]') !== null,
        [m.x + m.width / 2, m.y + m.height / 2],
      ),
    ).toBe(true);
    await minimise.click();
    await expect
      .poll(async () => (await frameActions(page)).at(-1))
      .toEqual(['window_control', { action: 'minimize' }]);
    // Minimising is not a click outside: search stays open, focus in its field.
    await expect(dialog).toBeVisible();
    await expect(page.getByLabel('Search everything')).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(field).toHaveAttribute('aria-expanded', 'false');
  });

  test('Back and Forward walk the history', async ({ page }) => {
    await openInApp(page, '/today');
    const back = toolbar(page).getByRole('button', { name: 'Back', exact: true });
    const forward = toolbar(page).getByRole('button', { name: 'Forward', exact: true });
    await expect(back).toBeDisabled();

    await page
      .getByRole('navigation', { name: 'Main' })
      .first()
      .getByRole('link', { name: 'Deals', exact: true })
      .click();
    await page.waitForURL(/\/deals$/);
    await expect(back).toBeEnabled();
    await back.click();
    await page.waitForURL(/\/today$/);
    await expect(forward).toBeEnabled();
    await forward.click();
    await page.waitForURL(/\/deals$/);
    await expect(forward).toBeDisabled();
  });

  test('the page column hangs from the bar with rounded corners', async ({ page }) => {
    await openInApp(page, '/today');
    const corners = page.locator('[data-titlebar] > span.top-full');
    // Not under the demo banner, which runs between the bar and the page.
    await expect(corners).toHaveCount(2);
    await expect(corners.first()).toBeHidden();
    await page.evaluate(() =>
      document.querySelector('.has-demo-banner')?.classList.remove('has-demo-banner'),
    );
    await expect(corners.first()).toBeVisible();
    const left = await box(corners.first());
    const right = await box(corners.last());
    const aside = await box(page.locator('aside'));
    expect(left).toMatchObject({ y: 40, width: 10, height: 10 });
    expect(Math.abs(left.x - (aside.x + aside.width))).toBeLessThanOrEqual(1);
    expect(right).toMatchObject({ y: 40, width: 10, height: 10 });
    expect(Math.round(right.x + right.width)).toBe(Math.round((await box(bar(page))).width));
  });

  test('sticky bars stick under the bar', async ({ page }) => {
    await openInApp(page, '/updates');
    const tabs = page.getByRole('navigation', { name: 'Reports sections' });
    await expect(tabs).toBeVisible();
    // Long enough to scroll whatever the demo store holds by now.
    await page.evaluate(() => {
      document.querySelector('main')!.style.minHeight = '3000px';
      window.scrollTo(0, document.documentElement.scrollHeight);
    });
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(200);
    const bannerBottom = await demoBannerBottom(page);
    expect(bannerBottom).toBeGreaterThan(40);
    expect(Math.abs((await box(tabs)).y - bannerBottom)).toBeLessThanOrEqual(1);
  });

  test.describe('in a narrow window', () => {
    test.use({ viewport: { width: 900, height: 700 } });

    test('the phone layout sits under the bar', async ({ page }) => {
      await openInApp(page, '/updates');
      await expect(toolbar(page).getByRole('button', { name: 'Search Copilot' })).toBeVisible();
      const header = page.locator('header').first();
      await expect(header.getByRole('button', { name: /^Search/ })).toBeHidden();
      await expect(header).toHaveCSS('top', '40px');

      // Long enough to scroll whatever the demo store holds by now: earlier
      // specs change how many reports there are.
      await page.evaluate(() => {
        document.querySelector('main')!.style.minHeight = '3000px';
        window.scrollTo(0, document.documentElement.scrollHeight);
      });
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(200);
      expect(Math.round((await box(header)).y)).toBe(40);
      // Under the phone header (52px) or the demo banner, whichever is taller.
      const tabs = await box(page.getByRole('navigation', { name: 'Reports sections' }));
      expect(Math.abs(tabs.y - 92)).toBeLessThanOrEqual(1);
      const nav = await box(page.getByRole('navigation', { name: 'Main' }).last());
      expect(Math.round(nav.y + nav.height)).toBe(700);

      // Over the phone header, the bar takes the header's see-through
      // emerald and blur, so the two match whatever scrolls under them.
      const looks = await page.evaluate(() => {
        const of = (el: Element) => ({
          background: getComputedStyle(el).backgroundColor,
          blur: getComputedStyle(el).backdropFilter,
        });
        return {
          bar: of(document.querySelector('[data-titlebar]')!),
          header: of(document.querySelector('header')!),
        };
      });
      expect(looks.bar).toEqual(looks.header);
      expect(looks.bar.blur).not.toBe('none');
    });
  });

  test.describe('in a short window', () => {
    test.use({ viewport: { width: 900, height: 560 } });

    test('the Ask sheet, a tour card and a dialog all open below the bar', async ({ page }) => {
      await openInApp(page, '/today');
      await page.getByRole('button', { name: 'Ask Arwin (AI)', exact: true }).click();
      const sheet = page.getByRole('dialog', { name: 'Ask Arwin' });
      await expect(sheet).toBeVisible();
      expect((await box(sheet)).y).toBeGreaterThanOrEqual(48);
      await sheet.getByRole('button', { name: 'Close' }).click();
      await expect(sheet).toBeHidden();

      await page.goto('/today?tour=today');
      const card = page.locator('[data-tour-card]');
      await expect(card).toBeVisible();
      expect((await box(card)).y).toBeGreaterThanOrEqual(40);
      await page.keyboard.press('Escape');
      await expect(card).toHaveCount(0);

      await toolbar(page).getByRole('button', { name: 'Search Copilot' }).click();
      const dialog = page.getByRole('dialog', { name: 'Search' });
      await expect(dialog).toBeVisible();
      const d = await box(dialog);
      expect(d.y).toBeGreaterThanOrEqual(40);
      expect(d.y + d.height).toBeLessThanOrEqual(560);
    });
  });

  test('one tab stop for the bar, between the skip link and the page', async ({ page }) => {
    await openInApp(page, '/today');
    // A second page, so Back has somewhere to go.
    await page.goto('/deals');
    await expect(bar(page)).toHaveAttribute('data-titlebar-ready', '');
    const back = toolbar(page).getByRole('button', { name: 'Back', exact: true });
    await expect(back).toBeEnabled();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    // The menu button is not a stop (Alt or F10 opens the menu).
    await page.keyboard.press('Tab');
    await expect(back).toBeFocused();
    // Forward is disabled at the end of the history: the arrow skips it.
    await page.keyboard.press('ArrowRight');
    await expect(toolbar(page).getByRole('button', { name: 'Search Copilot' })).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(back).toBeFocused();
    await page.keyboard.press('End');
    await expect(toolbar(page).getByRole('button', { name: 'Search Copilot' })).toBeFocused();
    // Tab leaves the bar (the window controls are not tab stops).
    await page.keyboard.press('Tab');
    expect(
      await page.evaluate(() => document.activeElement?.closest('[data-titlebar]') ?? null),
    ).toBeNull();
    // Shift+Tab comes back to the item last used.
    await page.keyboard.press('Shift+Tab');
    await expect(toolbar(page).getByRole('button', { name: 'Search Copilot' })).toBeFocused();
  });

  test.describe('signed out', () => {
    test.use({ storageState: EMPTY });

    test('the sign-in page has the bar, no search, and no scrollbar', async ({ page }) => {
      await openInApp(page, '/login');
      await expect(page.getByRole('button', { name: 'Enter demo workspace' })).toBeVisible();
      await expect(toolbar(page).getByRole('button', { name: 'Menu' })).toBeVisible();
      await expect(toolbar(page).getByRole('button', { name: 'Search Copilot' })).toBeHidden();
      await expect(controls(page).getByRole('button', { name: 'Close window' })).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollHeight <= document.documentElement.clientHeight,
        ),
      ).toBe(true);
      // The sign-in band runs up to the bar in the same colour.
      const colours = await page.evaluate(() => ({
        bar: getComputedStyle(document.querySelector('[data-titlebar]')!).backgroundColor,
        band: getComputedStyle(document.querySelector('main > div[aria-hidden="true"]')!)
          .backgroundColor,
      }));
      expect(colours.bar).toBe(colours.band);
    });
  });
});

test.describe('the Mac app (0.3.0)', () => {
  test('room for the traffic lights, no menu button, no window controls', async ({ page }) => {
    await openInApp(page, '/today', { frame: 'mac' });
    await expect(toolbar(page).getByRole('button', { name: 'Menu' })).toBeHidden();
    await expect(controls(page)).toBeHidden();
    const back = await box(toolbar(page).getByRole('button', { name: 'Back', exact: true }));
    expect(back.x).toBeGreaterThanOrEqual(80);
    await expect(toolbar(page).getByText('⌘K')).toBeVisible();
    await expect(toolbar(page).getByText('Ctrl K')).toBeHidden();
    // No room kept for a scrollbar: nothing sits at the bar's right end.
    expect(
      await page.evaluate(() => getComputedStyle(document.documentElement).scrollbarGutter),
    ).toBe('auto');

    // Full screen hides the traffic lights, and the room for them goes.
    await page.evaluate(() => {
      (window as unknown as { __frameState: { fullscreen: boolean } }).__frameState.fullscreen =
        true;
      window.dispatchEvent(new Event('resize'));
    });
    await expect
      .poll(
        async () => (await box(toolbar(page).getByRole('button', { name: 'Back', exact: true }))).x,
      )
      .toBeLessThanOrEqual(13);

    // Alt does nothing on a Mac.
    await page.keyboard.press('Alt');
    await page.waitForTimeout(200);
    expect(await frameActions(page)).toEqual([]);
  });
});

test.describe('zoomed in (View > Zoom 125%)', () => {
  test('the bar keeps its size on screen, and the page follows', async ({ page }) => {
    await page.addInitScript(markAsFramelessDesktop, {
      state: { maximized: false, fullscreen: false, zoom: 1.25 },
    });
    await page.goto('/today');
    const supported = await page.evaluate(() => CSS.supports('zoom', 'calc(1 / 2)'));
    test.skip(!supported, 'this engine has no CSS zoom');
    await expect(bar(page)).toHaveAttribute('data-titlebar-ready', '');

    // 40 window pixels at 125% are 32 CSS pixels.
    await expect.poll(async () => Math.round((await box(bar(page))).height * 10) / 10).toBe(32);
    expect(await page.evaluate(() => getComputedStyle(document.body).paddingTop)).toBe('32px');
    const close = await box(barButton(page, 'Close window'));
    expect(Math.abs(close.width - 36.8)).toBeLessThanOrEqual(0.5);
    // The rail's colour in the bar still ends where the rail does.
    const tint = await box(page.locator('[data-titlebar] > span').first());
    const aside = await box(page.locator('aside'));
    expect(Math.abs(tint.x + tint.width - (aside.x + aside.width))).toBeLessThanOrEqual(1);
    // Remembered for the next launch's first paint.
    expect(await page.evaluate(() => localStorage.getItem('tiptop-desktop-zoom'))).toBe('1.25');
  });
});
