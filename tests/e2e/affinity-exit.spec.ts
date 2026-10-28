import { expect, test, type Page } from '@playwright/test';

/**
 * The Affinity exit checklist (Knowledge → Affinity import → Exit checklist),
 * in demo mode, end to end: the notice date is set on the page (nothing is
 * assumed), counted down, and reminded on Today in the last two weeks; the
 * outside tools are a checklist kept in the database; a copy runs on a press;
 * and "Cancelled" ends the countdown and the Today line.
 *
 * The spec puts the checklist back as it found it (no date, no tools, not
 * cancelled), so no other spec's Today page carries the reminder line.
 */

async function enterDemo(page: Page) {
  await page.goto('/login');
  const enter = page.getByRole('button', { name: 'Enter demo workspace' });
  if (await enter.isVisible().catch(() => false)) await enter.click();
  await page.waitForURL(/\/today/);
}

/** A calendar day `days` from now, as the date input takes it. */
function dayFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

test.beforeEach(async ({ page }) => {
  await enterDemo(page);
});

test('the exit checklist counts down, keeps its tools, reminds on Today and stops when cancelled', async ({
  page,
}) => {
  await page.goto('/knowledge?tab=import');
  // The import is still what the tab opens on; the checklist is one chip away.
  await expect(page.getByRole('heading', { name: 'Import from Affinity', level: 2 })).toBeVisible();
  const views = page.getByRole('navigation', { name: 'Affinity import views' });
  await views.getByRole('link', { name: /^Exit checklist/ }).click();
  await page.waitForURL(/\/knowledge\?tab=import&view=exit$/);
  await expect(views.getByRole('link', { name: /^Exit checklist/ })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('heading', { name: 'Affinity exit', level: 2 })).toBeVisible();

  // What Kraken has, counted from its records, and what is not copied.
  const status = page.getByRole('list', { name: 'What Kraken has from Affinity' });
  await expect(status).toContainText('Daily sync');
  await expect(status).toContainText('Running every morning');
  await expect(status).toContainText(/Lists synced\s*\d+ lists?/);
  await expect(status).toContainText('Contacts on no list');
  await expect(status).toContainText('Files');
  await expect(status).toContainText('count unknown');

  // No date yet: the page asks for one.
  await expect(page.getByText('When does Affinity need notice by?')).toBeVisible();
  await page.getByLabel('Notice date').fill(dayFromNow(10));
  await page.getByRole('button', { name: 'Save date' }).click();
  await expect(page.getByTestId('affinity-exit-countdown')).toContainText(
    'days left to give Affinity notice',
  );
  await expect(views.getByRole('link', { name: /^Exit checklist · \d+ days$/ })).toBeVisible();

  // The outside tools: added, ticked, and still there after a reload.
  await page.getByLabel('Tool that uses Affinity').fill('Example notes bridge');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  const tool = page.getByRole('checkbox', { name: 'Example notes bridge' });
  await expect(tool).not.toBeChecked();
  await tool.check();
  await expect(tool).toBeChecked();
  await expect(page.getByText('1 of 1 done')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('checkbox', { name: 'Example notes bridge' })).toBeChecked();

  // The final archive is the whole-CRM export.
  await expect(page.getByRole('link', { name: 'Download final archive' })).toHaveAttribute(
    'href',
    '/api/crm/export',
  );

  // A copy runs only on a press, after a yes (the demo invents its result).
  await page.getByRole('button', { name: 'Copy open reminders as tasks' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Done: 3 copied' })).toBeVisible();

  // Today has one quiet line, in the last two weeks, that leads back here.
  await page.goto('/today');
  const line = page.getByRole('link', { name: 'Affinity exit checklist →' });
  await expect(line).toBeVisible();
  await expect(page.getByText(/Affinity notice is due in \d+ days/)).toBeVisible();
  await line.click();
  await page.waitForURL(/\/knowledge\?tab=import&view=exit$/);

  // Cancelled: the countdown and the Today line stop.
  await page.getByRole('switch', { name: 'Cancelled' }).click();
  await expect(page.getByText('The countdown and the reminder on Today are off.')).toBeVisible();
  await expect(page.getByTestId('affinity-exit-countdown')).toHaveCount(0);
  await page.goto('/today');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Affinity exit checklist →' })).toHaveCount(0);

  // Back as it was: not cancelled, no date, no tools.
  await page.goto('/knowledge?tab=import&view=exit');
  await page.getByRole('switch', { name: 'Cancelled' }).click();
  await expect(page.getByTestId('affinity-exit-countdown')).toBeVisible();
  await page.getByRole('button', { name: 'Change', exact: true }).click();
  await page.getByRole('button', { name: 'Clear date' }).click();
  await expect(page.getByText('When does Affinity need notice by?')).toBeVisible();
  await page.getByRole('button', { name: 'Remove Example notes bridge' }).click();
  await expect(page.getByRole('checkbox', { name: 'Example notes bridge' })).toHaveCount(0);
  await expect(page.getByText('Nothing listed yet.')).toBeVisible();
});
