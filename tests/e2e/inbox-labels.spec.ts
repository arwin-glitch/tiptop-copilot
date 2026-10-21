import { expect, test } from '@playwright/test';

/**
 * Label as, from the Inbox: the row's menu, the reading pane's menu and the
 * l key. A plain label goes on and off; a numbered one is a move. The demo
 * keeps label changes on its own messages, so a reload still shows them.
 */
test('Inbox labels a thread, moves it between numbered labels and keeps the change', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Enter demo workspace' }).click();
  await page.waitForURL(/\/today/);
  await page.goto('/inbox');

  const list = page.getByRole('region', { name: 'Conversations' });
  const first = list.getByRole('listitem').first();
  await expect(first).toBeVisible();
  const menu = page.getByRole('dialog', { name: 'Label' });

  // A plain label from the row's own menu (once the page has hydrated).
  await first.hover();
  await expect(async () => {
    await first.getByRole('button', { name: 'Label' }).click();
    await expect(menu).toBeVisible({ timeout: 1_000 });
  }).toPass();
  await menu.getByRole('checkbox', { name: 'Portfolio' }).check();
  await expect(first.getByText('Portfolio', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  // The l key opens the menu for the open thread; a numbered label is a move.
  await page.keyboard.press('j');
  const pane = page.getByRole('region', { name: 'Reading pane' });
  await expect(pane.getByRole('heading', { level: 2 })).toBeVisible();
  await page.keyboard.press('l');
  await expect(menu).toBeVisible();
  await expect(menu.getByText('A numbered label is a move', { exact: false })).toBeVisible();
  await page.screenshot({ path: 'test-results/inbox-labels-menu.png' });
  // Arrow keys only move focus: nothing is picked until a tap or Enter.
  await page.keyboard.press('ArrowDown');
  await expect(first.getByText('1: Reply today')).toHaveCount(0);
  await menu.getByRole('button', { name: '1: Reply today' }).click();
  await expect(menu).toBeHidden();
  await expect(first.getByText('1: Reply today')).toBeVisible();
  await expect(pane.getByText('1: Reply today')).toBeVisible();

  await pane.getByRole('button', { name: 'Label' }).click();
  await expect(menu.getByRole('button', { name: '1: Reply today' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const move = page.waitForRequest(
    (r) => r.url().endsWith('/api/inbox/modify') && r.method() === 'POST',
  );
  await menu.getByRole('button', { name: '2: This week' }).click();
  // The route plans the move: the tap sends only the label picked.
  const sent = (await move).postDataJSON() as { action: string; add: string[]; remove: string[] };
  expect(sent).toMatchObject({ action: 'label', remove: [] });
  expect(sent.add).toHaveLength(1);
  await expect(first.getByText('2: This week')).toBeVisible();
  await expect(first.getByText('1: Reply today')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/inbox-labels.png' });

  // Kept: a fresh load shows the same labels.
  await page.reload();
  const again = page.getByRole('region', { name: 'Conversations' }).getByRole('listitem').first();
  await expect(again.getByText('2: This week')).toBeVisible();
  await expect(again.getByText('Portfolio', { exact: true })).toBeVisible();

  // A plain label comes off again from the row.
  await again.hover();
  await expect(async () => {
    await again.getByRole('button', { name: 'Label' }).click();
    await expect(menu).toBeVisible({ timeout: 1_000 });
  }).toPass();
  await menu.getByRole('checkbox', { name: 'Portfolio' }).uncheck();
  await expect(again.getByText('Portfolio', { exact: true })).toHaveCount(0);
  await expect(again.getByText('2: This week')).toBeVisible();
});
