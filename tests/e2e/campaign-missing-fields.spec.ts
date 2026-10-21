import path from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * Campaign review: each "N people have no …" line opens to who they are, and
 * filling a value in there drops them off the line, moves the count, and
 * changes their email. Over the invented demo workspace, where nothing sends.
 */

const SIGNED_IN = path.resolve('test-results', 'campaign-missing-fields-state.json');

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

test('the review lists who is missing a field, and filling one in drops the count', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/fund-ii?tab=campaigns');
  await page.getByRole('button', { name: 'New campaign' }).first().click();
  await page.waitForURL(/\/fund-ii\/campaigns\/[0-9a-f-]{36}$/);

  // A CRM person with no company, and two bare addresses with nothing on file.
  await page
    .getByLabel('Email addresses')
    .fill('lucia.ferraro@mail.example\ndana.new@fill.example\neli.new@fill.example');
  await page.getByRole('button', { name: 'Add 3 pasted' }).click();
  await expect(page.getByText('Added 3 people.')).toBeVisible();
  await page.getByRole('button', { name: 'Next: the message' }).click();
  await page.getByLabel('Campaign name').fill('Missing fields (e2e)');
  await page.getByLabel('Subject').fill('Hello {{first_name|there}}');
  await page.getByLabel('Email', { exact: true }).fill('A note for {{company|your firm}}.');
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next: review' }).click();

  const review = page.getByRole('region', { name: 'Send to 3 people?' });
  await expect(review).toBeVisible();

  // First names: the line opens to the two people without one.
  const firstNames = review.getByRole('button', { name: /^2 people have no first name on file/ });
  await expect(firstNames).toHaveAttribute('aria-expanded', 'false');
  await firstNames.click();
  await expect(firstNames).toHaveAttribute('aria-expanded', 'true');
  const noFirst = review.getByRole('list', { name: 'People with no first name' });
  await expect(noFirst.getByRole('listitem')).toHaveCount(2);
  await expect(noFirst).toContainText('dana.new@fill.example');
  await expect(noFirst).toContainText('eli.new@fill.example');

  // Dana: a first name, saved with Enter. She drops off and the count follows.
  const dana = noFirst.getByRole('form', { name: 'Fill in dana.new@fill.example' });
  await dana.getByLabel('First name').fill('Dana');
  await dana.getByLabel('First name').press('Enter');
  await expect(page.getByText('Saved for dana.new@fill.example.')).toBeVisible();
  await expect(
    review.getByRole('button', { name: /^1 person has no first name on file/ }),
  ).toBeVisible();
  await expect(noFirst.getByRole('listitem')).toHaveCount(1);
  await expect(noFirst).not.toContainText('dana.new@fill.example');

  // Companies: Lucia is linked to a contact, so she gets the checkbox, ticked.
  const companies = review.getByRole('button', { name: /^3 people have no company on file/ });
  await companies.click();
  const noCompany = review.getByRole('list', { name: 'People with no company' });
  const lucia = noCompany.getByRole('listitem').filter({ hasText: 'lucia.ferraro@mail.example' });
  await expect(lucia).toContainText('Lucia Ferraro');
  const toContact = lucia.getByRole('checkbox', { name: 'Also save to their contact' });
  await expect(toContact).toBeChecked();
  // The bare addresses have no contact to save to.
  await expect(
    noCompany
      .getByRole('listitem')
      .filter({ hasText: 'eli.new@fill.example' })
      .getByRole('checkbox'),
  ).toHaveCount(0);
  // Kept off here, so the shared demo contact stays as other tests expect it.
  await toContact.uncheck();
  await lucia.getByLabel('Company').fill('Ferro Partners');
  await lucia.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved for Lucia Ferraro.')).toBeVisible();
  await expect(
    review.getByRole('button', { name: /^2 people have no company on file/ }),
  ).toBeVisible();
  await expect(noCompany).not.toContainText('lucia.ferraro@mail.example');

  // The sample is Lucia's email, which now names her company.
  await expect(review.getByRole('region', { name: /Sample/ })).toContainText(
    'A note for Ferro Partners.',
  );
  await expect(review.getByRole('button', { name: 'Send to 3 people' })).toBeEnabled();

  // Back on the message, the preview has Dana's first name too.
  await review.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByLabel('Preview as').selectOption({ label: 'dana.new@fill.example' });
  await expect(page.getByRole('region', { name: 'Preview' })).toContainText('Hello Dana');
});
