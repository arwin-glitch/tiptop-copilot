import path from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Events Studio (D-075), over the fictional demo event "Harborview Annual
 * Meeting": an owner editing, an outside editor joining by a personal link
 * (fragment secret, explicit claim, path-scoped cookie), the two of them
 * editing at once with a conflict, and the owner revoking the link while
 * the outsider is still in Studio. Fictional people only.
 */

const EVENT = '00000000-0000-4000-8000-0000e7e00001';
const STUDIO = `/events/${EVENT}/studio`;
const SIGNED_IN = path.resolve('test-results', 'events-studio-state.json');

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

/** The section of a block type inside Studio's canvas (EventPage's DOM contract). */
function canvasSection(page: Page, block: string) {
  return page.locator(`[data-studio-frame] [data-block="${block}"]`).first();
}

function headlineInput(page: Page) {
  return page.locator('[data-field-key="headline"] input');
}

async function saved(page: Page) {
  await expect(page.locator('[data-save-state]')).toHaveAttribute('data-save-state', 'saved', {
    timeout: 20_000,
  });
}

/**
 * A fetch from inside the page, so the browser applies its own cookie rules
 * (Secure cookies on 127.0.0.1, path-scoped grant cookies) exactly as Studio does.
 */
async function api(
  page: Page,
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  return page.evaluate(
    async ({ method, url, body }) => {
      const response = await fetch(url, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, json: await response.json().catch(() => null) };
    },
    { method, url, body },
  );
}

/** Make an outside link as the signed-in owner; returns its id and secret path. */
async function makeLink(
  page: Page,
  body: Record<string, unknown>,
): Promise<{ id: string; path: string }> {
  if (!page.url().startsWith('http')) await page.goto(STUDIO);
  const response = await api(page, 'POST', `/api/events/${EVENT}/editors`, body);
  expect(response.status).toBe(200);
  const json = response.json as { link: { id: string }; path: string };
  return { id: json.link.id, path: json.path };
}

async function outsider(browser: Browser, baseURL: string) {
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  return { context, page: await context.newPage() };
}

test('an owner edits the page and the change is saved to the draft', async ({ page }) => {
  await page.goto(STUDIO);
  await expect(
    page.getByRole('banner').getByRole('heading', { level: 1, name: 'Harborview Annual Meeting' }),
  ).toBeVisible();
  await expect(page.getByRole('list', { name: 'Page sections' }).getByRole('listitem')).toHaveCount(
    7,
  );
  await canvasSection(page, 'hero').click();
  await headlineInput(page).fill('Harborview Annual Meeting 2031');
  await expect(page.locator('[data-save-state]')).toHaveAttribute(
    'data-save-state',
    /saving|saved/,
  );
  await saved(page);
  await page.reload();
  await canvasSection(page, 'hero').click();
  await expect(headlineInput(page)).toHaveValue('Harborview Annual Meeting 2031');
  // Undo is per person, empty after a reload, and sends a new rev-checked change.
  const undo = page.getByRole('button', { name: /^Undo/ });
  await expect(undo).toBeDisabled();
  await headlineInput(page).fill('A headline to undo');
  await saved(page);
  await undo.click();
  await expect(headlineInput(page)).toHaveValue('Harborview Annual Meeting 2031');
  await saved(page);
  await expect(page.getByRole('button', { name: /^Redo/ })).toBeEnabled();
});

test('two editors: outside link, presence, a conflict, then a revoke mid-session', async ({
  page,
  browser,
}, testInfo) => {
  const baseURL = String(testInfo.project.use.baseURL);
  const link = await makeLink(page, {
    label: 'Morgan – Example Partners',
    role: 'editor',
    scope: { design: true, content: true, sections: 'all', brand_locked: true },
  });
  expect(link.path).toMatch(/^\/e\/edit#k=[A-Za-z0-9_-]{43}$/);

  // --- The outsider joins: side-effect-free entry, explicit claim.
  const out = await outsider(browser, baseURL);
  // Under the strict /e nonce policy nothing of Studio may be refused.
  const cspErrors: string[] = [];
  out.page.on('console', (message) => {
    if (message.type() === 'error' && /Content Security Policy|Refused to/i.test(message.text())) {
      cspErrors.push(message.text());
    }
  });
  const entry = await out.page.goto(link.path);
  const headers = entry!.headers();
  expect(headers['content-security-policy']).toContain("'nonce-");
  expect(headers['content-security-policy']).toContain("'strict-dynamic'");
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['x-robots-tag']).toContain('noindex');
  await expect(
    out.page.getByRole('heading', {
      name: /invited to edit Harborview Annual Meeting as Morgan – Example Partners/,
    }),
  ).toBeVisible();
  // The secret left the address bar before anything else.
  expect(out.page.url()).not.toContain('#k=');
  const openButton = out.page.getByRole('button', { name: 'Open editor' });
  await expect(openButton).toBeDisabled();
  await out.page.getByLabel(/Yes, I'm Morgan/).check();
  await openButton.click();
  await out.page.waitForURL(new RegExp(`/e/edit/${EVENT}$`));
  await expect(
    out.page.getByText('Outside editor · changes go live only when TipTop publishes'),
  ).toBeVisible();
  expect(cspErrors).toEqual([]);

  const cookies = (await out.context.cookies()).filter((c) => c.name === 'tiptop_ev_grant');
  expect(cookies.map((c) => c.path).sort()).toEqual([`/api/e/edit/${EVENT}`, `/e/edit/${EVENT}`]);
  for (const c of cookies) {
    expect(c.httpOnly).toBe(true);
    expect(c.sameSite).toBe('Strict');
  }
  // The link reaches nothing else in Kraken.
  expect((await api(out.page, 'GET', `/api/events/${EVENT}/draft`)).status).toBe(401);
  expect((await api(out.page, 'GET', `/api/events/${EVENT}/editors`)).status).toBe(401);
  expect((await api(out.page, 'GET', `/api/e/edit/${EVENT}/draft`)).status).toBe(200);
  expect(
    (await api(out.page, 'GET', '/api/e/edit/00000000-0000-4000-8000-0000e7e00002/draft')).status,
  ).toBe(404);
  // Brand locks show as locks.
  await out.page.getByRole('tab', { name: 'Brand' }).click();
  await expect(out.page.getByText('Brand locked by TipTop').first()).toBeVisible();
  await out.page.getByRole('tab', { name: 'Sections' }).click();

  // --- The outsider focuses the hero; the owner sees them there.
  await canvasSection(out.page, 'hero').click();
  await page.goto(STUDIO);
  await expect(
    page.getByRole('button', { name: /people in Studio: .*Morgan – Example Partners \(outside\)/ }),
  ).toBeVisible({ timeout: 15_000 });
  // ...and on the hero itself (their next poll carries the focus).
  await expect(
    page.getByRole('list', { name: 'Page sections' }).getByLabel(/^Here: Morgan/),
  ).toBeVisible({ timeout: 15_000 });

  // --- A conflict: the outsider edits offline, the owner edits the same field.
  await out.context.setOffline(true);
  await headlineInput(out.page).fill('Headline from Morgan');
  await expect(out.page.locator('[data-save-state]')).toHaveAttribute(
    'data-save-state',
    'offline',
    {
      timeout: 20_000,
    },
  );

  await canvasSection(page, 'hero').click();
  // Morgan is in this section: an advisory lock the owner may override at once.
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  const editAnyway = inspector.getByRole('button', { name: 'Edit anyway' });
  await expect(editAnyway).toBeVisible({ timeout: 15_000 });
  await editAnyway.click();
  await headlineInput(page).fill('Headline from the owner');
  await saved(page);

  await out.context.setOffline(false);
  const dialog = out.page.getByRole('dialog', { name: /changed headline in/i });
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await dialog.getByRole('button', { name: 'Compare side by side' }).click();
  await expect(dialog.getByText('Headline from the owner')).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep mine' }).click();
  await saved(out.page);
  await expect(headlineInput(page)).toHaveValue('Headline from Morgan', { timeout: 15_000 });

  expect(cspErrors).toEqual([]);

  // --- The owner revokes the link while Morgan is still in Studio.
  const revoked = await api(page, 'DELETE', `/api/events/${EVENT}/editors?link=${link.id}`);
  expect(revoked.status).toBe(200);
  await expect(
    out.page.getByRole('heading', { name: 'This link is no longer active' }),
  ).toBeVisible({
    timeout: 15_000,
  });
  expect((await api(out.page, 'GET', `/api/e/edit/${EVENT}/draft`)).status).toBe(404);
  const reopened = await out.page.goto(`/e/edit/${EVENT}`);
  expect(reopened?.status()).toBe(404);
  await out.context.close();
});

test('a content-only link for chosen sections cannot touch the rest', async ({
  page,
  browser,
}, testInfo) => {
  const baseURL = String(testInfo.project.use.baseURL);
  await page.goto(STUDIO);
  const draft = (await api(page, 'GET', `/api/events/${EVENT}/draft`)).json as {
    doc: { sections: { id: string; type: string }[] };
  };
  const agenda = draft.doc.sections.find((s) => s.type === 'agenda')!;
  const link = await makeLink(page, {
    label: 'Agenda helper',
    role: 'editor',
    scope: { design: false, content: true, sections: [agenda.id] },
  });
  const out = await outsider(browser, baseURL);
  await out.page.goto(link.path);
  await out.page.getByLabel(/Yes, I'm Agenda helper/).check();
  await out.page.getByRole('button', { name: 'Open editor' }).click();
  await out.page.waitForURL(new RegExp(`/e/edit/${EVENT}$`));
  // No structure changes, and other sections are locked.
  await expect(out.page.getByRole('button', { name: 'Add section' })).toHaveCount(0);
  await canvasSection(out.page, 'hero').click();
  await expect(headlineInput(out.page)).toBeDisabled();
  await expect(out.page.getByText('Outside your scope').first()).toBeVisible();
  // The server refuses it anyway.
  const hero = draft.doc.sections.find((s) => s.type === 'hero')!;
  const forced = await api(out.page, 'POST', `/api/e/edit/${EVENT}/ops`, {
    baseVersion: 0,
    ops: [
      {
        kind: 'section.update',
        opId: 'x1',
        id: hero.id,
        baseRev: 999,
        set: { 'props.headline': 'Hijack' },
      },
    ],
  });
  expect(forced.status).toBe(200);
  const result = forced.json as { applied: string[]; conflicts: { kind: string }[] };
  expect(result.applied).toEqual([]);
  expect(result.conflicts[0]?.kind).toBe('forbidden');
  await out.context.close();
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('Studio switches panes and never scrolls sideways', async ({ page }) => {
    await page.goto(STUDIO);
    await expect(page.getByRole('banner').getByRole('heading', { level: 1 })).toBeVisible();
    const panes = page.getByRole('navigation', { name: 'Studio panes' });
    await expect(panes).toBeVisible();
    await panes.getByRole('button', { name: 'Sections' }).click();
    await expect(page.getByRole('list', { name: 'Page sections' })).toBeVisible();
    await panes.getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByRole('heading', { name: 'Page settings' })).toBeVisible();
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 2);
  });
});
