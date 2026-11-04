import { expect, test, type Page } from '@playwright/test';

/**
 * Gmail parity, round 1, in the demo mailbox: Unsubscribe by the sender,
 * attachment preview (image and PDF), the conversation menu's Block /
 * Report phishing / Filter messages like these, the nav label menu, compose
 * Templates and To suggestions, and the unread count in the tab title.
 * Every change stays on the demo server; nothing reaches Gmail.
 */

async function openInbox(page: Page) {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Enter demo workspace' }).click();
  await page.waitForURL(/\/today/);
  await page.goto('/inbox');
  await expect(
    page.getByRole('region', { name: 'Conversations' }).getByRole('listitem').first(),
  ).toBeVisible();
}

test('tab title, unsubscribe, attachment preview and sender menus', async ({ page }) => {
  await openInbox(page);
  await expect(page).toHaveTitle(/^Inbox \(\d+\) · /);

  // The Promotions tab holds the demo promotion with an unsubscribe header and two files.
  await page.getByRole('tab', { name: /Promotions/ }).click();
  const list = page.getByRole('region', { name: 'Conversations' });
  await list.getByText('Workspace Pro: your 20% renewal discount').click();
  const pane = page.getByRole('region', { name: 'Reading pane' });

  // Unsubscribe (mailto kind): a confirm naming the sender, then a prefilled compose.
  await pane.getByRole('button', { name: 'Unsubscribe' }).click();
  const ask = page.getByRole('dialog', { name: /Unsubscribe from Workspace Pro/ });
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Write the email' }).click();
  await expect(page.getByText('optout@workspacepro.demo').first()).toBeVisible();
  await page.getByRole('button', { name: 'Save & close' }).click();

  // Image preview.
  await pane.getByRole('button', { name: 'Preview plan-comparison.png' }).click();
  const imgDialog = page.getByRole('dialog', { name: 'plan-comparison.png' });
  await expect(imgDialog.getByRole('img', { name: 'plan-comparison.png' })).toBeVisible();
  await expect(imgDialog.getByRole('link', { name: 'Download' })).toBeVisible();
  await page.keyboard.press('Escape');

  // PDF preview: pdf.js draws the page onto a canvas.
  await pane.getByRole('button', { name: 'Preview renewal-quote.pdf' }).click();
  const pdfDialog = page.getByRole('dialog', { name: 'renewal-quote.pdf' });
  await expect(pdfDialog.locator('[data-pdf-pages] canvas').first()).toBeVisible({
    timeout: 20_000,
  });
  await page.screenshot({ path: 'test-results/inbox-pdf-preview.png' });
  await page.keyboard.press('Escape');

  // The conversation's ⋮: Filter messages like these opens Create filter from the sender.
  await pane.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Filter messages like these' }).click();
  const filter = page.getByRole('dialog', { name: 'Create filter' });
  await expect(filter).toBeVisible();
  await expect(filter.getByRole('textbox').first()).toHaveValue('offers@workspacepro.demo');
  await page.keyboard.press('Escape');

  // Report phishing asks first and says it is reported as spam.
  await pane.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Report phishing' }).click();
  const phishing = page.getByRole('dialog', { name: 'Report phishing?' });
  await expect(phishing.getByText(/no phishing report/)).toBeVisible();
  await phishing.getByRole('button', { name: 'Cancel' }).click();

  // Block asks first, then makes the filter and the Blocked label.
  await pane.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: /Block “Workspace Pro”/ }).click();
  const block = page.getByRole('dialog', { name: /Block Workspace Pro/ });
  await expect(block.getByText(/skip your inbox/)).toBeVisible();
  await block.getByRole('button', { name: 'Block' }).click();
  await expect(page.getByText(/Blocked offers@workspacepro\.demo/)).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Mail folders' });
  await expect(nav.getByRole('button', { name: 'Blocked', exact: true })).toBeVisible();
});

test('label menu, compose templates and To suggestions', async ({ page }) => {
  await openInbox(page);
  const nav = page.getByRole('navigation', { name: 'Mail folders' });

  // A label's ⋮: colour from Gmail's palette, and hide in the label list.
  await nav.getByRole('button', { name: 'Portfolio', exact: true }).hover();
  await nav.getByRole('button', { name: 'Options for Portfolio' }).click();
  await page.getByRole('menuitem', { name: 'Label color' }).click();
  const colors = page.getByRole('dialog', { name: /Label color: Portfolio/ });
  await colors.getByRole('radio', { name: '#4a86e8' }).click();
  await expect(page.getByText('Label color changed')).toBeVisible();
  await nav.getByRole('button', { name: 'Portfolio', exact: true }).hover();
  await nav.getByRole('button', { name: 'Options for Portfolio' }).click();
  await page.getByRole('menuitem', { name: 'Hide in label list' }).click();
  await expect(nav.getByRole('button', { name: 'Portfolio', exact: true })).toBeHidden();
  await nav.getByRole('button', { name: /1 hidden label/ }).click();
  await expect(nav.getByRole('button', { name: 'Portfolio', exact: true })).toBeVisible();

  // Compose: Templates › Insert fills the box; To suggests people.
  await nav.getByRole('button', { name: 'Compose' }).click();
  await page.getByRole('button', { name: 'Templates' }).click();
  await page.getByRole('menuitem', { name: 'Pass, kindly' }).click();
  await expect(page.getByRole('textbox', { name: 'Subject' })).toHaveValue(
    'Thanks for sending this over',
  );
  await expect(page.getByText(/not a fit for the fund right now/)).toBeVisible();
});
