import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * The Events tab (D-075, WS5), over the invented demo workspace: the menu
 * entry, the library and its tabs, the new-event dialog, one event's subtabs,
 * messages drafted as campaigns (and nothing sent), the reminder schedule,
 * the Manage forms, Today's line and the Help tour.
 *
 * Demo fixtures (lib/demo/events-fixtures.ts): "Harborview Annual Meeting",
 * published and invite-only, two sessions, 4 going and 1 pending; "Founders
 * Putting Night", a draft. WS4's guest service is still the contract stub
 * here, so a drafted invite has nobody on it yet: the flow is what is checked.
 */

const SIGNED_IN = path.resolve('test-results', 'events-tab-state.json');
const HARBORVIEW = '00000000-0000-4000-8000-0000e7e00001';

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

const library = (page: Page) => page.getByRole('list', { name: 'Events', exact: true });
const tabs = (page: Page) => page.getByRole('navigation', { name: 'Event library sections' });
const eventTabs = (page: Page) => page.getByRole('navigation', { name: 'Event sections' });

test('Events is in the menu, after Calendar, and opens the library', async ({ page }) => {
  await page.goto('/today');
  const nav = page.getByRole('navigation', { name: 'Main' }).first();
  const working = nav.getByRole('list', { name: 'Working' });
  await working.getByRole('link', { name: 'Events', exact: true }).click();
  await page.waitForURL(/\/events$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Events' })).toBeVisible();
  await expect(working.getByRole('link', { name: 'Events', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const card = library(page).getByRole('listitem').filter({ hasText: 'Harborview Annual Meeting' });
  await expect(card).toContainText('Invite-only');
  await expect(card).toContainText('4 going · 1 pending');
  await expect(card.getByRole('link', { name: 'Edit page' })).toHaveAttribute(
    'href',
    `/events/${HARBORVIEW}/studio`,
  );
  await expect(card.getByRole('link', { name: 'Guests' })).toHaveAttribute(
    'href',
    `/events/${HARBORVIEW}?tab=guests`,
  );
});

test('the library tabs live in the URL, and search filters by title', async ({ page }) => {
  await page.goto('/events');
  await tabs(page).getByRole('link', { name: 'Drafts' }).click();
  await page.waitForURL(/\/events\?tab=drafts$/);
  await expect(tabs(page).getByRole('link', { name: 'Drafts' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(library(page)).toContainText('Founders Putting Night');
  await expect(library(page)).not.toContainText('Harborview Annual Meeting');

  await page.getByRole('searchbox', { name: 'Search events by title' }).fill('nothing like it');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.waitForURL(/tab=drafts&q=nothing/);
  await expect(page.getByText('No events match “nothing like it”')).toBeVisible();

  await page.goto('/events?tab=templates');
  await expect(page.getByText('No templates yet')).toBeVisible();
});

test('a new event starts from a starter and a theme, as a private draft', async ({ page }) => {
  await page.goto('/events');
  await page.getByRole('button', { name: 'New event', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New event' });
  await expect(dialog.getByRole('radiogroup', { name: 'Starter' })).toBeVisible();
  await dialog.getByRole('radio').first().click();
  await dialog.getByRole('button', { name: 'Next: theme' }).click();
  await expect(dialog.getByRole('radio', { name: /TipTop Signature/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await dialog.getByRole('button', { name: 'Next: details' }).click();
  await dialog.getByLabel('Name').fill('Spring Founders Dinner');
  await expect(dialog).toContainText('/e/spring-founders-dinner');
  await dialog.getByLabel('Date').fill('2031-04-10');
  await dialog.getByRole('button', { name: 'Create draft' }).click();
  await page.waitForURL(/\/events\/[0-9a-f-]{36}$/);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Spring Founders Dinner' }),
  ).toBeVisible();
  await expect(page.getByRole('main')).toContainText('Thu, Apr 10, 2031');
  await expect(page.getByRole('main').getByText('Draft', { exact: true }).first()).toBeVisible();

  await page.goto('/events?tab=drafts');
  await expect(library(page)).toContainText('Spring Founders Dinner');
});

test('one event: overview, subtabs in the URL, and the other workstreams’ panels', async ({
  page,
}) => {
  await page.goto(`/events/${HARBORVIEW}`);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Harborview Annual Meeting' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Ready' })).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Ready checklist' })).toBeVisible();
  const next = page.locator('[data-panel="overview"]');
  await expect(
    next.getByRole('link', { name: '1 person is waiting for approval' }),
  ).toHaveAttribute('href', `/events/${HARBORVIEW}?tab=guests`);
  await expect(page.getByRole('list', { name: 'Going per session' })).toContainText(
    'Evening Reception',
  );

  for (const [label, panel] of [
    ['Guests', 'guests'],
    ['Registration', 'registration'],
    ['Check-in', 'checkin'],
    ['Sharing', 'sharing'],
  ] as const) {
    await eventTabs(page).getByRole('link', { name: label, exact: true }).click();
    await page.waitForURL(new RegExp(`tab=${panel}$`));
    await expect(page.locator(`[data-panel="${panel}"]`)).toBeVisible();
  }

  await eventTabs(page).getByRole('link', { name: 'Page', exact: true }).click();
  await page.waitForURL(/tab=page$/);
  const outline = page.locator('[data-panel="page"]');
  await expect(outline.getByRole('heading', { name: 'Sections in the draft' })).toBeVisible();
  await expect(outline.getByRole('link', { name: 'Open Studio' })).toHaveAttribute(
    'href',
    `/events/${HARBORVIEW}/studio`,
  );
  // The live page opens as a full page load in a new tab, never inside Copilot.
  const live = outline.getByRole('link', { name: 'View live page' });
  await expect(live).toHaveAttribute('href', '/e/harborview-annual-meeting');
  await expect(live).toHaveAttribute('target', '_blank');
});

test('an invite is a campaign draft: nothing is sent, and the review leads back', async ({
  page,
}) => {
  await page.goto(`/events/${HARBORVIEW}?tab=messages`);
  await expect(page.getByRole('heading', { name: 'New message' })).toBeVisible();
  await expect(page.getByLabel('To', { exact: true })).toHaveValue('status:invited');
  await page.getByRole('button', { name: 'Draft the invite' }).click();
  await page.waitForURL(/\/fund-ii\/campaigns\/[0-9a-f-]{36}$/);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Harborview Annual Meeting · Invite' }),
  ).toBeVisible();
  await expect(page.getByText('Event message · Campaign')).toBeVisible();
  // Still a draft: the composer, not a report.
  await expect(page.getByRole('button', { name: 'Delete draft' })).toBeVisible();

  await page.getByRole('link', { name: 'Event messages' }).click();
  await page.waitForURL(new RegExp(`/events/${HARBORVIEW}\\?tab=messages$`));
  const sent = page.getByRole('list', { name: 'Drafts and sent messages' });
  const row = sent.getByRole('listitem').filter({ hasText: 'Harborview Annual Meeting · Invite' });
  await expect(row).toContainText('Invite');
  await expect(row).toContainText('Draft');
  await expect(row.getByRole('link', { name: /Review and send/ })).toBeVisible();
});

test('the reminder schedule changes when drafts fall due, and drafts nothing by itself', async ({
  page,
}) => {
  await page.goto(`/events/${HARBORVIEW}?tab=messages&view=reminders`);
  const schedule = page.getByRole('list', { name: 'Reminders before each session' });
  await expect(schedule).toContainText('1 week before');
  await expect(schedule).toContainText('1 day before');
  await expect(schedule).toContainText('3 hours before');
  await expect(page.getByRole('button', { name: 'Prepare the draft' })).toHaveCount(6);

  await page.getByRole('button', { name: 'Remove the reminder 3 hours before' }).click();
  await page.getByRole('button', { name: 'Save schedule' }).click();
  await expect(page.getByText('Reminder schedule saved.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Prepare the draft' })).toHaveCount(4);
});

test('Manage: the link checks itself and search text saves to the draft', async ({ page }) => {
  await page.goto(`/events/${HARBORVIEW}?tab=settings`);
  await expect(eventTabs(page).getByRole('link', { name: 'Manage' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const slug = page.getByLabel('Address');
  await slug.fill('Bad Slug');
  await expect(page.getByRole('button', { name: 'Save link' })).toBeDisabled();
  await slug.fill('edit');
  await expect(page.getByText('That word is reserved.')).toBeVisible();

  await page.getByLabel('Description').fill('An afternoon on the year, then a reception.');
  await page.getByRole('button', { name: 'Save to draft' }).click();
  await expect(page.getByText('Saved to the draft. It goes live when you publish.')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Description')).toHaveValue(
    'An afternoon on the year, then a reception.',
  );
});

test('Today has a line for the event that wants something', async ({ page }) => {
  await page.goto('/today');
  const line = page.getByRole('list', { name: 'Events that need you' });
  await expect(line).toContainText('Harborview Annual Meeting');
  await expect(line.getByRole('link', { name: '1 pending' })).toHaveAttribute(
    'href',
    `/events/${HARBORVIEW}?tab=guests`,
  );
});

test('Help has an Events card and its tour walks the library', async ({ page }) => {
  await page.goto('/help');
  const entry = page.getByRole('main').getByRole('group', { name: 'Events', exact: true });
  await expect(entry).toBeVisible();
  await entry.getByRole('link', { name: 'Show me Events' }).click();
  await page.waitForURL(/\/events/);
  const card = page.locator('[data-tour-card]');
  await expect(card).toContainText(/Events · 1 of 5/);
  await expect(card.getByRole('heading', { name: 'Your event library' })).toBeVisible();
  await card.getByRole('button', { name: 'Next' }).click();
  await expect(card.getByRole('heading', { name: 'Switch sections' })).toBeVisible();
  await card.getByRole('button', { name: 'Next' }).click();
  await expect(card.getByRole('heading', { name: 'Start from a starter' })).toBeVisible();
});
