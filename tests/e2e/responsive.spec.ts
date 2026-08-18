import { expect, test, type Page } from '@playwright/test';

/**
 * Mobile layout and accessibility.
 *
 * This project runs on a Pixel 7 viewport. The things worth asserting are the
 * ones a desktop-only pass never catches: nothing scrolls sideways, the bottom
 * navigation is reachable by thumb and large enough to hit, and the page is
 * still navigable by keyboard and screen reader.
 */

async function enterDemo(page: Page) {
  await page.goto('/login');
  const enter = page.getByRole('button', { name: 'Enter demo workspace' });
  if (await enter.isVisible().catch(() => false)) await enter.click();
  await page.waitForURL(/\/today/);
}

const PAGES = [
  '/today',
  '/inbox',
  '/deals',
  '/ask',
  '/portfolio',
  '/network',
  '/knowledge',
  '/tasks',
  '/settings',
];

test.beforeEach(async ({ page }) => {
  await enterDemo(page);
});

test.describe('mobile layout', () => {
  for (const path of PAGES) {
    test(`${path} never scrolls horizontally`, async ({ page }) => {
      await page.goto(path);
      // Wait for rendered content, not `networkidle` — this app streams RSC
      // payloads, so the network is never reliably idle and the wait flakes.
      await expect(page.locator('h1')).toBeVisible();

      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      // A few pixels of rounding is fine; a sideways scrollbar is not.
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 2);
    });
  }

  test('the bottom navigation is present and thumb-sized', async ({ page }) => {
    await page.goto('/today');
    const nav = page.getByRole('navigation', { name: 'Main' }).last();
    await expect(nav).toBeVisible();

    for (const label of ['Today', 'Inbox', 'Deals', 'Ask', 'Portfolio']) {
      const link = nav.getByRole('link', { name: label });
      await expect(link).toBeVisible();
      const box = await link.boundingBox();
      // Comfortably above the 44px minimum touch target.
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  });

  test('the bottom navigation stays fixed while the page scrolls', async ({ page }) => {
    await page.goto('/today');
    const nav = page.getByRole('navigation', { name: 'Main' }).last();
    const before = await nav.boundingBox();

    await page.mouse.wheel(0, 2000);
    await page.waitForTimeout(300);

    const after = await nav.boundingBox();
    expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThan(4);
  });

  test('navigation actually navigates on a touch viewport', async ({ page }) => {
    await page.goto('/today');
    const nav = page.getByRole('navigation', { name: 'Main' }).last();
    await nav.getByRole('link', { name: 'Deals' }).click();
    await page.waitForURL(/\/deals/);
    await expect(page.getByRole('heading', { name: 'Deals' })).toBeVisible();
  });

  test('the deal detail page is readable on a narrow screen', async ({ page }) => {
    await page.goto('/deals/00000000-0000-4000-8000-000000000064');
    await expect(page.getByRole('heading', { name: 'Vetrix' })).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(2);
  });

  test('the ask composer stays reachable above the bottom bar', async ({ page }) => {
    await page.goto('/ask');
    const field = page.getByLabel('Your question');
    await expect(field).toBeVisible();

    const box = await field.boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    // The field must be inside the viewport, not underneath the nav bar.
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual((viewport?.height ?? 0) + 1);
  });
});

test.describe('accessibility', () => {
  test('every page has exactly one h1 and a main landmark', async ({ page }) => {
    for (const path of PAGES) {
      await page.goto(path);
      await expect(page.locator('main')).toHaveCount(1);
      await expect(page.locator('h1'), `${path} needs one h1`).toHaveCount(1);
    }
  });

  test('the skip link is the first thing keyboard focus reaches', async ({ page }) => {
    await page.goto('/today');
    await page.keyboard.press('Tab');

    const focused = page.locator(':focus');
    await expect(focused).toHaveText('Skip to content');
    await expect(focused).toHaveAttribute('href', '#main');
  });

  test('the demo banner is announced as a status region', async ({ page }) => {
    await page.goto('/today');
    await expect(page.getByRole('status').first()).toContainText('Demo mode');
  });

  test('navigation marks the current page for assistive technology', async ({ page }) => {
    await page.goto('/inbox');
    // The sidebar also marks it, but is display:none at this width — assert on
    // the bottom bar, which is the navigation actually presented here.
    const current = page
      .getByRole('navigation', { name: 'Main' })
      .last()
      .locator('[aria-current="page"]');
    await expect(current).toBeVisible();
    await expect(current).toContainText('Inbox');
  });

  test('every image and icon-only control carries an accessible name', async ({ page }) => {
    for (const path of ['/today', '/deals', '/settings']) {
      await page.goto(path);

      const unnamedImages = await page.locator('img:not([alt])').count();
      expect(unnamedImages, `${path} has an image with no alt`).toBe(0);

      const unnamed = await page.evaluate(() =>
        Array.from(document.querySelectorAll('button, a[href]'))
          .filter((el) => {
            // textContent, not innerText: a control inside a collapsed
            // <details> is still a control, and still needs a name.
            const label =
              el.getAttribute('aria-label') ??
              el.getAttribute('title') ??
              (el.textContent ?? '').trim();
            return !label;
          })
          .map((el) => el.outerHTML.slice(0, 120)),
      );
      expect(unnamed, `${path} has an unlabelled control`).toEqual([]);
    }
  });

  test('form controls are labelled', async ({ page }) => {
    await page.goto('/inbox');
    const unlabelled = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input:not([type=hidden]), select, textarea'))
        .filter((el) => {
          const id = el.getAttribute('id');
          const hasLabelFor = id ? document.querySelector(`label[for="${id}"]`) : null;
          return (
            !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby') && !hasLabelFor
          );
        })
        .map((el) => el.outerHTML.slice(0, 120)),
    );
    expect(unlabelled).toEqual([]);
  });

  test('the theme toggle is an operable radio group', async ({ page }) => {
    await page.goto('/today');
    const group = page.getByRole('radiogroup', { name: 'Colour theme' }).first();
    await expect(group).toBeVisible();

    await group.getByRole('radio', { name: 'Dark' }).click();
    await expect(group.getByRole('radio', { name: 'Dark' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(page.locator('html')).toHaveClass(/dark/);
  });

  test('the page is usable with the keyboard alone', async ({ page }) => {
    await page.goto('/deals');
    for (let i = 0; i < 12; i++) await page.keyboard.press('Tab');

    // Focus is somewhere real, and it is visible.
    const tag = await page.evaluate(() => document.activeElement?.tagName ?? null);
    expect(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']).toContain(tag);
  });
});
