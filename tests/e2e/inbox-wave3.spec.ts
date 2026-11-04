import { expect, test, type Page } from '@playwright/test';

/**
 * Gmail parity, last round, in the demo mailbox: Signature, Undo Send time,
 * Vacation responder (confirm, banner, Turn off), suggested replies, Show
 * original, Add to Tasks, Forward as attachment, Pop out reply, Create event,
 * Translate message, and the compose emoji picker. Every change stays on the
 * demo server; nothing reaches Gmail and no model is called.
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

async function listMore(page: Page, item: string, role: 'menuitem' | 'menuitemradio' = 'menuitem') {
  await page
    .getByRole('toolbar', { name: 'List actions' })
    .getByRole('button', { name: 'More' })
    .click();
  await page.getByRole(role, { name: item }).click();
}

test('signature, Undo Send time and the vacation responder', async ({ page }) => {
  await openInbox(page);

  // Signature: the demo's fictional one, edited and saved on Save changes.
  await listMore(page, 'Signature');
  const sig = page.getByRole('dialog', { name: 'Signature' });
  const box = sig.getByRole('textbox', { name: 'Signature' });
  await expect(box).toContainText('Sam Rivera');
  await box.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' (demo)');
  await sig.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Signature saved in Gmail')).toBeVisible();

  // Undo Send: 30 seconds, shown under the compose box.
  await listMore(page, 'Undo Send: 30 seconds', 'menuitemradio');
  await page
    .getByRole('navigation', { name: 'Mail folders' })
    .getByRole('button', { name: 'Compose' })
    .click();
  await expect(page.getByText(/30s to undo/)).toBeVisible();
  await page.getByRole('button', { name: 'Save & close' }).click();

  // Vacation responder: on only after the confirm that says it auto-replies.
  await listMore(page, 'Vacation responder');
  const vac = page.getByRole('dialog', { name: 'Vacation responder' });
  await vac.getByLabel('Vacation responder on').check();
  await vac.getByLabel('Subject').fill('Out of office');
  await vac.getByRole('button', { name: 'Save changes' }).click();
  const ask = page.getByRole('dialog', { name: 'Turn on auto-replies?' });
  await expect(ask).toContainText('automatically reply to incoming mail');
  await ask.getByRole('button', { name: 'Turn on vacation responder' }).click();
  const banner = page.getByRole('status').filter({ hasText: 'Vacation responder is ON' });
  await expect(banner).toBeVisible();
  await banner.getByRole('button', { name: 'Turn off' }).click();
  await expect(page.getByText('Vacation responder turned off')).toBeVisible();
  await expect(banner).toBeHidden();
});

test('conversation: suggested replies, original, tasks, forward, pop out, event', async ({
  page,
}) => {
  await openInbox(page);
  const list = page.getByRole('region', { name: 'Conversations' });
  await list.getByRole('listitem').first().click();
  const pane = page.getByRole('region', { name: 'Reading pane' });
  await expect(pane.getByRole('list', { name: 'Messages' })).toBeVisible();

  // Suggested replies (demo: canned): a chip only fills the reply box.
  const chips = pane.getByRole('group', { name: 'Suggested replies' });
  await expect(chips.getByRole('button')).toHaveCount(3);
  await chips.getByRole('button', { name: 'Thanks, this is helpful.' }).click();
  await expect(pane.getByRole('textbox', { name: 'Reply' })).toContainText(
    'Thanks, this is helpful.',
  );
  // Pop out reply: the words move to a floating window on the same thread.
  await pane.getByRole('button', { name: 'Pop out reply' }).click();
  const win = page.getByRole('dialog', { name: /^Re:/ });
  await expect(win.getByRole('textbox', { name: 'Message Body' })).toContainText(
    'Thanks, this is helpful.',
  );
  await expect(pane.getByRole('textbox', { name: 'Reply' })).toBeHidden();
  await win.getByRole('button', { name: 'Save & close' }).click();

  // Show original: escaped, read-only source with Download.
  await pane.getByRole('button', { name: 'More message actions' }).last().click();
  await page.getByRole('menuitem', { name: 'Show original' }).click();
  const orig = page.getByRole('dialog', { name: 'Original message' });
  await expect(orig.getByLabel('Original source')).toContainText('Subject:');
  await expect(orig.getByRole('link', { name: 'Download original' })).toBeVisible();
  await page.keyboard.press('Escape');

  // Add to Tasks.
  await pane.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Add to Tasks' }).click();
  await expect(page.getByText('Added to Tasks')).toBeVisible();

  // Forward as attachment: a new window with the email attached; nothing sends.
  await pane.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Forward as attachment' }).click();
  await expect(page.getByText('attached email')).toBeVisible();
  await page.getByRole('button', { name: 'Save & close' }).last().click();

  // Create event: the Calendar's editor, prefilled; nothing saved without Save.
  await pane.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Create event' }).click();
  await page.waitForURL(/\/calendar/);
  const editor = page.getByRole('dialog', { name: 'New event' });
  await expect(editor).toBeVisible();
  await expect(editor.getByPlaceholder('Add title')).not.toHaveValue('');
  await expect(editor.getByPlaceholder('Add description')).toHaveValue(/inbox\?thread=/);
});

test('translate a Spanish email, and the compose emoji picker', async ({ page }) => {
  await openInbox(page);
  await page.getByRole('tab', { name: /Social/ }).click();
  await page
    .getByRole('region', { name: 'Conversations' })
    .getByText('Invitación: encuentro de fundadores en Madrid')
    .click();
  const pane = page.getByRole('region', { name: 'Reading pane' });
  await pane.getByRole('button', { name: 'More message actions' }).last().click();
  await page.getByRole('menuitem', { name: 'Translate message' }).click();
  await expect(pane.getByText(/Translated from Spanish by Kraken AI/)).toBeVisible();
  await pane.getByRole('button', { name: 'See original' }).click();
  await expect(pane.getByText(/te escribo para invitarte/)).toBeVisible();

  await page
    .getByRole('navigation', { name: 'Mail folders' })
    .getByRole('button', { name: 'Compose' })
    .click();
  const body = page.getByRole('textbox', { name: 'Message Body' });
  await body.click();
  await page.keyboard.type('Hi ');
  await page.getByRole('button', { name: 'Insert emoji' }).click();
  await page.getByRole('button', { name: 'Insert 🎉' }).click();
  await expect(body).toContainText('Hi 🎉');
  await expect(page.getByRole('button', { name: 'Insert photo' })).toBeVisible();
});
