import { expect, test, type Page } from '@playwright/test';

/**
 * "Write the intro" on an owed intro opens the compose window on a fresh
 * thread in the intro format, addressed only to people whose email is on
 * file. The demo cannot send, so the window offers Copy for Gmail and no Send.
 */

async function enterDemo(page: Page) {
  await page.goto('/login');
  const enter = page.getByRole('button', { name: 'Enter demo workspace' });
  if (await enter.isVisible().catch(() => false)) await enter.click();
  await page.waitForURL(/\/today/);
}

test('an owed intro opens a prefilled intro email', async ({ page }) => {
  await enterDemo(page);
  await page.goto('/network?tab=intros');
  await expect(page.getByRole('heading', { name: 'Intros', exact: true })).toBeVisible();

  // Only owed intros get the button.
  await expect(page.getByRole('button', { name: /^Write the intro/ })).toHaveCount(2);

  await page
    .getByRole('button', {
      name: 'Write the intro for Ledgerly → Hana Kuroda (Riverlight Ventures)',
    })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Write the intro' });
  await expect(dialog).toBeVisible();

  await expect(dialog.getByLabel('To', { exact: true })).toHaveValue(
    'Hana Kuroda <hana@riverlight.example>, Maya Chen <maya@ledgerly.demo>',
  );
  await expect(dialog.getByLabel('Subject', { exact: true })).toHaveValue(
    'Intro: Hana (Riverlight Ventures) <> Maya (Ledgerly)',
  );
  const body = dialog.getByLabel('Message', { exact: true });
  await expect(body).toHaveValue(/^Hi Hana & Maya,\n/);
  await expect(body).toHaveValue(
    /Maya - meet \[Hana Kuroda\]\(https:\/\/www\.linkedin\.com\/in\/hana-kuroda-example\) at Riverlight Ventures\./,
  );
  // Ends at the sign-off: the real Gmail signature is added on send.
  await expect(body).toHaveValue(/\nCheers,\n[A-Z][a-z]+$/);

  const hints = dialog.getByRole('list', { name: 'Before you send' });
  await expect(hints).toContainText('No LinkedIn on file for Maya Chen');
  await expect(dialog.getByText('goes out linked to that profile')).toBeVisible();

  // Nothing sends from the demo: Copy for Gmail, never a Send button.
  await expect(dialog.getByRole('button', { name: 'Copy for Gmail' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Send', exact: true })).toHaveCount(0);
  await dialog.screenshot({ path: 'test-results/intro-draft.png' });

  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
});

test('an intro to a firm nobody knows leaves To empty and says why', async ({ page }) => {
  await enterDemo(page);
  await page.goto('/network?tab=intros');
  await page
    .getByRole('button', { name: 'Write the intro for Harbor Labs → Northwind Capital' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Write the intro' });
  await expect(dialog.getByLabel('To', { exact: true })).toHaveValue('');
  await expect(dialog.getByLabel('Subject', { exact: true })).toHaveValue(
    'Intro: Northwind Capital <> Harbor Labs',
  );
  await expect(dialog.getByRole('list', { name: 'Before you send' })).toContainText(
    "Copilot doesn't know who at Northwind Capital this goes to.",
  );
});
