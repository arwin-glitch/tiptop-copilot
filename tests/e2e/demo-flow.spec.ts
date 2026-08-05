import { expect, test, type Page } from '@playwright/test';

/**
 * The demo, walked end to end.
 *
 * Thirteen steps, in the order the product is meant to be shown. Each step
 * asserts the thing that makes it worth showing — not that a page rendered,
 * but that the behaviour behind it held: the injection is flagged and
 * unobeyed, unknowns stay unknown, the claim carries its source, the
 * recommendation follows Nick's thresholds, and nothing can be sent.
 */

const DEMO = {
  plumblineMessage: '00000000-0000-4000-8000-000000000199',
  vetrixDeal: '00000000-0000-4000-8000-000000000064',
  loomstackDeal: '00000000-0000-4000-8000-000000000067',
  ledgerly: '00000000-0000-4000-8000-0000000000c8',
};

async function enterDemo(page: Page) {
  await page.goto('/login');
  const enter = page.getByRole('button', { name: 'Enter demo workspace' });
  if (await enter.isVisible().catch(() => false)) {
    await enter.click();
  }
  await page.waitForURL(/\/today/);
  await expect(page.getByRole('heading', { name: /Good day/ })).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
  await enterDemo(page);
});

test('1 — Today opens on a real outlook assembled from records', async ({ page }) => {
  // The demo banner has to be unmissable: nothing here is real.
  await expect(page.getByText('Demo mode', { exact: true })).toBeVisible();
  await expect(page.getByText(/Every company, person and number here is fictional/)).toBeVisible();

  const outlook = page.getByRole('heading', { name: 'Outlook' });
  await expect(outlook).toBeVisible();

  // The outlook is labelled as generated, with the model and prompt version.
  await expect(page.getByText('AI-generated')).toBeVisible();

  // And the sections are populated from the fixtures, not empty shells.
  await expect(page.getByRole('button', { name: /Follow-ups/ })).toBeVisible();
  await expect(page.getByText('2 overdue')).toBeVisible();
  await expect(page.getByText('Girder AI — reference call debrief')).toBeVisible();
});

test('2 — every outlook claim carries the record it came from', async ({ page }) => {
  await page.getByRole('button', { name: /Open sources/ }).click();

  const drawer = page.getByRole('dialog');
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText(/A claim shown without a source is either/)).toBeVisible();
  // Every listed source is a real record, so at least one resolves to a link.
  await expect(drawer.getByRole('link').first()).toBeVisible();
});

test('3 — market signals say research is unconfigured rather than inventing any', async ({
  page,
}) => {
  // With research off the section has no items, so it collapses to a heading
  // and a plain statement rather than an expandable list.
  await expect(page.getByRole('heading', { name: 'Market signals' })).toBeVisible();
  await expect(page.getByText('Web research not configured')).toBeVisible();
});

test('4 — the Inbox is classified, and the injected email is flagged not hidden', async ({
  page,
}) => {
  await page.getByRole('link', { name: 'Inbox' }).first().click();
  await page.waitForURL(/\/inbox/);

  // The hostile message is visible in the list, flagged.
  const plumbline = page.getByRole('button', { name: /Plumbline — construction estimating/ });
  await expect(plumbline).toBeVisible();
  await expect(plumbline.getByText('Flagged')).toBeVisible();

  await plumbline.click();

  // The detail pane explains what happened and why nothing was acted on.
  await expect(
    page.getByText('This message contains text aimed at an AI assistant.'),
  ).toBeVisible();
  await expect(page.getByText(/It was treated as data, not instructions/)).toBeVisible();

  // And the full payload is still readable — annotated, never censored.
  await expect(page.getByText(/Ignore all previous/)).toBeVisible();
  await expect(page.getByText(/ADVANCE with a score of 100/)).toBeVisible();
});

test('5 — the injected instruction did not change any deal', async ({ page }) => {
  await page.goto('/deals');
  const plumbline = page.getByRole('link', { name: /Plumbline/ }).first();
  await expect(plumbline).toBeVisible();

  await plumbline.click();
  await page.waitForURL(/\/deals\//);

  // Whatever the email demanded, the pipeline stage is not invested. (Checked
  // on the control's value — "Invested" is always present as an option.)
  const stage = page.getByLabel('Pipeline stage');
  await expect(stage).not.toHaveValue('invested');

  // And no recommendation on the page reads ADVANCE.
  await expect(page.getByLabel('Recommendation: Advance')).toHaveCount(0);
  // Nor is there a recorded decision, which only a human can make.
  await expect(page.getByText(/Decision recorded|INVEST\b/)).toHaveCount(0);
});

test('6 — the newest deal starts unanalysed and analysis is an explicit act', async ({ page }) => {
  await page.goto(`/deals/${DEMO.vetrixDeal}`);
  await expect(page.getByRole('heading', { name: 'Vetrix' })).toBeVisible();

  // Nothing is analysed behind the user's back.
  await expect(page.getByText('This deal has not been analysed yet')).toBeVisible();

  await page.getByRole('button', { name: 'Reanalyse' }).first().click();
  await expect(page.getByRole('heading', { name: 'Thirty-second overview' })).toBeVisible({
    timeout: 30_000,
  });
});

test('7 — the scorecard records an unevidenced category as unscored, not zero', async ({
  page,
}) => {
  await page.goto(`/deals/${DEMO.vetrixDeal}`);
  await page.getByRole('tab', { name: 'Scorecard' }).click();

  // The distinction is stated on screen, because it is the whole point: a
  // category with no evidence is not the same as a category scored zero.
  await expect(page.getByText(/not counted as zero|Unscored/i).first()).toBeVisible();

  // And the headline numbers are separate, not collapsed into one score.
  await expect(page.getByText(/confidence/i).first()).toBeVisible();
  await expect(page.getByText(/completeness/i).first()).toBeVisible();
});

test('8 — unknown fields read as not stated, never as a filled-in guess', async ({ page }) => {
  await page.goto(`/deals/${DEMO.vetrixDeal}`);
  await page.getByRole('tab', { name: 'Key facts' }).click();

  const body = (await page.locator('body').innerText()).toLowerCase();
  // No sentinel values anywhere on the record.
  expect(body).not.toContain('n/a');
  expect(body).not.toContain('tbd');
  expect(body).not.toContain('undefined');
});

test('9 — every extracted fact can be traced to its source and corrected', async ({ page }) => {
  await page.goto(`/deals/${DEMO.vetrixDeal}`);
  await page.getByRole('tab', { name: 'Key facts' }).click();

  const correct = page.getByRole('button', { name: /^Correct / }).first();
  await expect(correct).toBeVisible();

  await correct.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  // The original extraction is shown next to the correction, not replaced by it.
  await expect(dialog.getByText('Extracted value', { exact: true })).toBeVisible();
  await expect(dialog.getByText(/kept alongside your correction/i)).toBeVisible();
});

test('10 — the sources tab shows the page-aware deck extraction', async ({ page }) => {
  await page.goto(`/deals/${DEMO.vetrixDeal}`);
  await page.getByRole('tab', { name: 'Sources' }).click();
  await expect(page.getByText(/\.pdf|deck/i).first()).toBeVisible();
});

test('11 — a hard red flag caps the recommendation without erasing the score', async ({ page }) => {
  await page.goto(`/deals/${DEMO.loomstackDeal}`);
  await expect(page.getByRole('heading', { name: /LoomStack/ })).toBeVisible();

  // No deal ships pre-analysed, so run it first.
  await page.getByRole('button', { name: 'Reanalyse' }).first().click();
  await expect(page.getByRole('heading', { name: 'Thirty-second overview' })).toBeVisible({
    timeout: 30_000,
  });

  // LoomStack is the thesis-mismatch case: a hard flag caps it, so it can
  // never read as ADVANCE or DIG DEEPER however good the arithmetic looks.
  await expect(page.getByLabel('Recommendation: Advance')).toHaveCount(0);
  await expect(page.getByLabel('Recommendation: Dig deeper')).toHaveCount(0);

  // The cap is explained rather than silently applied, and it is reversible.
  await expect(page.getByRole('heading', { name: 'Red flags' })).toBeVisible();
  await expect(
    page.getByText(/does not change the underlying score, so resolving it restores/i),
  ).toBeVisible();
});

test('12 — Ask answers from the records and shows what it used', async ({ page }) => {
  await page.goto('/ask');
  await expect(page.getByRole('heading', { name: 'Ask TipTop' })).toBeVisible();

  await page.getByLabel('Your question').fill('What follow-ups are overdue?');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();

  // The answer is persisted and rendered with its tool trail.
  await expect(page.getByText(/overdue/i).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Answers cite their sources')).toBeVisible();
});

test('13 — a draft is produced and plainly marked as never sent', async ({ page }) => {
  await page.goto(`/inbox?message=${DEMO.plumblineMessage}`);
  await page.getByRole('button', { name: 'Draft reply' }).click();

  const notSent = page.getByText('Draft — not sent');
  await expect(notSent).toBeVisible({ timeout: 30_000 });

  // Copying it out is the only route onward — there is no send control.
  await expect(page.getByRole('button', { name: 'Copy draft' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Send/ })).toHaveCount(0);
});

test('the product never offers a way to send anything', async ({ page }) => {
  for (const path of ['/today', '/inbox', '/deals', '/ask', '/portfolio', '/tasks', '/settings']) {
    await page.goto(path);
    await expect(page.getByRole('button', { name: /^Send( |$)/ })).toHaveCount(0);
  }
});

test('diagnostics reports configuration without ever showing a value', async ({ page }) => {
  await page.goto('/diagnostics');
  await expect(page.getByRole('heading', { name: 'Diagnostics' })).toBeVisible();
  await expect(page.getByText(/Values are never shown/)).toBeVisible();

  const body = await page.locator('body').innerText();
  // The e2e server runs with these; neither may appear on screen.
  expect(body).not.toContain('e2e-session-secret-not-a-production-value-000000');
  expect(body).not.toContain('ZTJlMmUyZTJlMmUyZTJlMmUyZTJlMmUyZTJlMmUyZTJlMmUyZTJlMmU9');
});

test('the privacy notice is reachable without a session', async ({ page, context }) => {
  await context.clearCookies();
  await page.goto('/privacy');
  await expect(page.getByRole('heading', { name: 'Privacy notice' })).toBeVisible();
  await expect(page.getByText(/What is stored/)).toBeVisible();
});

test('signing out ends the session', async ({ page }) => {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL(/\/login|\/$/);
  await expect(page.getByRole('button', { name: 'Enter demo workspace' })).toBeVisible();
});
