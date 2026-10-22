import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import { LAUNCH_PRESETS, THEME_PRESETS } from '../../src/lib/events/themes';

/**
 * The event guest renderer (D-075, WS2), through the owner-only full-page
 * theme preview (/e/theme_preview/<preset>), which renders the real
 * EventPage on the real /e surface (nonce CSP, no Copilot chrome).
 *
 * Budgets and guarantees checked here:
 *   - guest-page JavaScript: what Events adds to the framework floor stays
 *     small (islands <= 30 kB gzip; <= 80 kB with the lazily loaded WebGL
 *     engine), and reduced motion loads no effect engine at all. The spec's
 *     150 kB page total also depends on the framework floor (React, the Next
 *     runtime, the root layout), measured and logged here;
 *   - reduced motion renders statically (no running animations, no overlay);
 *   - every preset's rendered text/background tokens are AA, light and dark;
 *   - phones never scroll sideways;
 *   - the Pause control stops motion; the envelope intro opens and skips;
 *   - anonymous visitors get a 404 from the preview route.
 */

const SIGNED_IN = resolve('test-results', 'events-render-state.json');

test.beforeAll(async ({ browser }, testInfo) => {
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

function hexLuminance(color: string): number {
  const m =
    /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color) ??
    /#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(color);
  if (!m) return 0;
  const parse = (v: string) => (color.startsWith('#') ? parseInt(v, 16) : Number(v));
  const [r, g, b] = [parse(m[1]!), parse(m[2]!), parse(m[3]!)].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function ratio(a: string, b: string): number {
  const [x, y] = [hexLuminance(a), hexLuminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

async function tokens(page: Page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-event-root]')!;
    const cs = getComputedStyle(root);
    const read = (n: string) => cs.getPropertyValue(n).trim();
    const band = document.querySelector('[data-band="accent"] > .ev-section__inner');
    const bandCs = band ? getComputedStyle(band) : null;
    return {
      text: read('--ev-text'),
      bg: read('--ev-bg'),
      muted: read('--ev-muted'),
      surface: read('--ev-surface'),
      accent: read('--ev-accent'),
      accentFg: read('--ev-accent-fg'),
      bandText: bandCs?.getPropertyValue('--ev-text').trim() ?? null,
      bandBg: bandCs?.getPropertyValue('--ev-bg').trim() ?? null,
      rootColor: cs.color,
      rootBg: cs.backgroundColor,
    };
  });
}

test.describe('theme preview route', () => {
  test('is a 404 for anonymous visitors', async ({ browser, baseURL }) => {
    const context = await browser.newContext({
      baseURL,
      storageState: { cookies: [], origins: [] },
    });
    const page = await context.newPage();
    const res = await page.goto('/e/theme_preview/tiptop-signature');
    expect(res?.status()).toBe(404);
    const og = await page.goto('/e/theme_preview/tiptop-signature/og');
    expect(og?.status()).toBe(404);
    await context.close();
  });

  test('renders on the event surface with a nonce CSP and no Copilot chrome', async ({ page }) => {
    const res = await page.goto('/e/theme_preview/tiptop-signature');
    expect(res?.status()).toBe(200);
    const csp = res?.headers()['content-security-policy'] ?? '';
    expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
    expect(csp).toContain("font-src 'self'");
    await expect(page.locator('main#main[data-event-root]')).toBeVisible();
    await expect(page.locator('[data-block="hero"] h1')).toBeVisible();
    expect(await page.locator('[data-tauri-drag-region], [data-desktop-titlebar]').count()).toBe(0);
  });

  test('serves the share card PNG', async ({ page }) => {
    for (const layout of ['cover', 'type', 'ticket']) {
      const res = await page.goto(`/e/theme_preview/annual-letter/og?layout=${layout}`);
      expect(res?.status()).toBe(200);
      expect(res?.headers()['content-type']).toBe('image/png');
      expect((await res!.body()).subarray(1, 4).toString()).toBe('PNG');
    }
  });
});

test.describe('performance budget', () => {
  async function scripts(page: Page, path: string): Promise<Map<string, number>> {
    const sizes = new Map<string, number>();
    const onResponse = async (response: import('@playwright/test').Response) => {
      if (response.request().resourceType() !== 'script') return;
      try {
        sizes.set(new URL(response.url()).pathname, gzipSync(await response.body()).length);
      } catch {
        // A cancelled request has no body.
      }
    };
    page.on('response', onResponse);
    await page.goto(path, { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    page.off('response', onResponse);
    return sizes;
  }
  const sum = (m: Map<string, number>, skip?: Map<string, number>) =>
    [...m].filter(([url]) => !skip?.has(url)).reduce((a, [, b]) => a + b, 0);
  const kb = (n: number) => `${(n / 1024).toFixed(1)} kB`;

  test('the guest page stays within its JavaScript budget', async ({ browser, baseURL }) => {
    // A fresh context per measurement: nothing comes from the HTTP cache.
    const measure = async (path: string, reduced: boolean) => {
      const context = await browser.newContext({ baseURL, storageState: SIGNED_IN });
      const page = await context.newPage();
      if (reduced) await page.emulateMedia({ reducedMotion: 'reduce' });
      const sizes = await scripts(page, path);
      await context.close();
      return sizes;
    };
    // The framework floor: what any page of this app loads (React, the Next
    // runtime and the root layout), measured on a plain page.
    const floor = await measure('/privacy', false);
    const still = await measure('/e/theme_preview/tiptop-signature', true);
    const moving = await measure('/e/theme_preview/tiptop-signature', false);
    const islands = sum(still, floor);
    const withEngine = sum(moving, floor);
    console.log(
      `guest JS (gzip): framework floor ${kb(sum(floor))}; event page ${kb(sum(still))} total, ` +
        `${kb(islands)} of it event islands (reduced motion); ${kb(sum(moving))} total with the ` +
        `WebGL engine (${kb(withEngine)} event code)`,
    );
    // What Events adds on first load: the islands, and the lazily loaded
    // WebGL engine when the hero animates.
    expect(islands).toBeLessThanOrEqual(30 * 1024);
    expect(withEngine).toBeLessThanOrEqual(80 * 1024);
    // Reduced motion loads no effect engine at all (the poster is the page).
    expect(sum(still)).toBeLessThanOrEqual(sum(floor) + 30 * 1024);
  });
});

test.describe('motion', () => {
  test('reduced motion renders statically', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const id of [
      'tiptop-signature',
      'confetti-pop',
      'starfield',
      'champagne-deco',
      'kinetic-poster',
    ]) {
      await page.goto(`/e/theme_preview/${id}`);
      await page.waitForTimeout(600);
      const running = await page.evaluate(
        () =>
          document
            .getAnimations()
            .filter((a) => a.playState === 'running')
            .filter((a) =>
              (a.effect as KeyframeEffect | null)?.target?.closest?.('[data-event-root]'),
            ).length,
      );
      expect(running, id).toBe(0);
      expect(await page.locator('.ev-particles--overlay').count(), id).toBe(0);
      expect(await page.locator('.ev-pause').count(), id).toBe(0);
      // Content is all there without any animation.
      await expect(page.locator('[data-block="footer"]')).toBeAttached();
    }
  });

  test('the Pause control stops looping motion and is remembered', async ({ page }) => {
    await page.goto('/e/theme_preview/confetti-pop');
    const pause = page.getByRole('button', { name: 'Pause animations' });
    await expect(pause).toBeVisible();
    await pause.click();
    await expect(page.locator('[data-event-root]')).toHaveAttribute('data-paused', 'true');
    await expect(page.getByRole('button', { name: 'Play animations' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const running = await page.evaluate(
      () =>
        document
          .getAnimations()
          .filter((a) => a.playState === 'running')
          .filter((a) => (a.effect as KeyframeEffect | null)?.target?.closest?.('.ev-page')).length,
    );
    expect(running).toBe(0);
    await page.reload();
    await expect(page.locator('[data-event-root]')).toHaveAttribute('data-paused', 'true');
    await page.getByRole('button', { name: 'Play animations' }).click();
    await expect(page.locator('[data-event-root]')).not.toHaveAttribute('data-paused', 'true');
  });

  test('the envelope opens for the invited guest and can be skipped', async ({ page }) => {
    await page.goto('/e/theme_preview/envelope-wax-seal?intro=1&viewer=guest');
    const intro = page.locator('.ev-intro');
    await expect(intro).toBeVisible();
    await expect(intro.getByText('Dear Sarah,')).toBeVisible();
    await page.getByRole('button', { name: 'Open the invitation' }).click();
    await expect(intro).toHaveCount(0, { timeout: 6000 });
    // Once per visitor (this tab): a reload goes straight to the page.
    await page.reload();
    await expect(page.locator('.ev-intro')).toHaveCount(0, { timeout: 3000 });

    await page.evaluate(() => sessionStorage.clear());
    await page.goto('/e/theme_preview/envelope-wax-seal?intro=1');
    await expect(page.locator('.ev-intro').getByText('Dear friend,')).toBeVisible();
    await page.getByRole('button', { name: 'Skip' }).click();
    await expect(page.locator('.ev-intro')).toHaveCount(0, { timeout: 3000 });
  });
});

test.describe('every launch preset', () => {
  for (const preset of LAUNCH_PRESETS) {
    test(`${preset.id}: AA tokens in light and dark, no sideways scroll on a phone`, async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
        await page.goto(`/e/theme_preview/${preset.id}?mode=${scheme}`);
        const t = await tokens(page);
        expect(ratio(t.text, t.bg), `${scheme} text/bg`).toBeGreaterThanOrEqual(4.5);
        expect(ratio(t.muted, t.bg), `${scheme} muted/bg`).toBeGreaterThanOrEqual(4.5);
        expect(ratio(t.text, t.surface), `${scheme} text/surface`).toBeGreaterThanOrEqual(4.5);
        expect(ratio(t.accentFg, t.accent), `${scheme} button`).toBeGreaterThanOrEqual(4.5);
        expect(ratio(t.rootColor, t.rootBg), `${scheme} rendered root`).toBeGreaterThanOrEqual(4.5);
        // The cover title is never invisible (a clipped-text effect over a transparent colour).
        const title = await page
          .locator('[data-block="hero"] .ev-headline')
          .first()
          .evaluate((el) => {
            const cs = getComputedStyle(el);
            return { fill: cs.webkitTextFillColor, color: cs.color, image: cs.backgroundImage };
          });
        if (title.fill === 'rgba(0, 0, 0, 0)') {
          expect(title.image, `${scheme} clipped title`).not.toBe('none');
          expect(title.image, `${scheme} clipped title`).not.toContain('rgba(0, 0, 0, 0)');
        } else {
          expect(title.color, `${scheme} title colour`).not.toBe('rgba(0, 0, 0, 0)');
        }
        if (t.bandText && t.bandBg) {
          expect(ratio(t.bandText, t.bandBg), `${scheme} accent band`).toBeGreaterThanOrEqual(4.5);
        }
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`/e/theme_preview/${preset.id}`);
      await page.waitForTimeout(300);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, 'horizontal overflow at 390px').toBeLessThanOrEqual(1);
      expect(errors).toEqual([]);
    });
  }

  test('wave-2 presets render too', async ({ page }) => {
    for (const preset of THEME_PRESETS.filter((p) => p.wave === 'wave2')) {
      const res = await page.goto(`/e/theme_preview/${preset.id}`);
      expect(res?.status(), preset.id).toBe(200);
      await expect(page.locator(`[data-event-root][data-preset="${preset.id}"]`)).toBeVisible();
    }
  });
});
