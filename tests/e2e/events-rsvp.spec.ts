import path from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Event RSVPs end to end (D-075), on the demo store's invented "Harborview
 * Annual Meeting" (published, invite-only, two sessions): a personal link
 * answering with a plus-one and opening the ticket; the invite-only page's
 * "Request an invite"; then, switching the event's access with the host's
 * own API, an open registration remembered by the browser, an approval
 * request approved by the host, a waitlisted RSVP when full, and a check-in
 * through the QR's URL (the host's browser checks in; anyone else sees the
 * ticket). Guests browse in fresh contexts with no Kraken session. Settings
 * are put back at the end. Every person here is fictional.
 */

const EVENT = '00000000-0000-4000-8000-0000e7e00001';
const SLUG = 'harborview-annual-meeting';
const MEETING = '00000000-0000-4000-8000-0000e7e00011';
const RECEPTION = '00000000-0000-4000-8000-0000e7e00012';
const CARLOS = '00000000-0000-4000-8000-0000e7e00103'; // invited to the reception, no answer yet
const AVERY = '00000000-0000-4000-8000-0000e7e00101'; // going to both

const SIGNED_IN = path.resolve('test-results', 'events-rsvp-state.json');

test.describe.configure({ mode: 'serial' });

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

test.afterAll(async ({ browser }, testInfo) => {
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    storageState: SIGNED_IN,
  });
  const page = await context.newPage();
  await setRegistration(page, { access: 'invite_only' });
  await setSession(page, MEETING, { capacity: 80 });
  await context.close();
});

/**
 * A host API call from the signed-in page itself, so the browser sends the
 * session cookie exactly as Kraken's own screens do.
 */
async function host(
  page: Page,
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, any> }> {
  if (!page.url().startsWith('http')) await page.goto('/robots.txt');
  return page.evaluate(
    async ({ method, url, body }) => {
      const res = await fetch(url, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, json: await res.json().catch(() => ({})) };
    },
    { method, url, body },
  );
}

async function setRegistration(page: Page, body: Record<string, unknown>) {
  const res = await host(page, 'PUT', `/api/events/${EVENT}/registration`, body);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
}

async function setSession(page: Page, sessionId: string, body: Record<string, unknown>) {
  const res = await host(
    page,
    'PATCH',
    `/api/events/${EVENT}/registration/sessions/${sessionId}`,
    body,
  );
  expect(res.status, JSON.stringify(res.json)).toBe(200);
}

async function links(page: Page, guestId: string) {
  const res = await host(page, 'GET', `/api/events/${EVENT}/guests/${guestId}/link`);
  expect(res.status).toBe(200);
  // The API answers with APP_URL's origin; the test server runs on its own port.
  const pathOf = (url: string) => new URL(url).pathname;
  return {
    invite: pathOf(res.json.invite),
    ticket: pathOf(res.json.ticket),
    checkin: pathOf(res.json.checkin),
  };
}

/** A guest's browser: no Kraken session at all. */
async function guestPage(browser: Browser, baseURL: string | undefined): Promise<Page> {
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  return context.newPage();
}

async function fillPublicForm(page: Page, email: string, sessionName?: string) {
  const form = page.locator('form[data-rsvp-form="public"]');
  await expect(form).toBeVisible();
  await form.getByLabel('First name').fill('Jamie');
  await form.getByLabel('Last name').fill('Fictional');
  await form.getByLabel('Email').fill(email);
  if (sessionName) {
    await form
      .locator('label.evu-choice', { hasText: sessionName })
      .locator('input[type="checkbox"]')
      .check();
  }
  // The server refuses a form sent within two seconds of rendering.
  await page.waitForTimeout(2_200);
  return form;
}

test('a personal invite answers per session with a plus-one, then shows the ticket', async ({
  browser,
  page: hostPage,
}, testInfo) => {
  const { invite } = await links(hostPage, CARLOS);
  const page = await guestPage(browser, testInfo.project.use.baseURL);
  const response = await page.goto(invite);
  expect(response?.headers()['x-robots-tag']).toContain('noindex');
  expect(response?.headers()['referrer-policy']).toBe('no-referrer');

  const form = page.locator('form[data-rsvp-form="invite"]');
  await expect(form).toBeVisible();
  // Invite-only: only the session he was invited to.
  await expect(form.locator('[data-session]')).toHaveCount(1);
  await form
    .getByRole('group', { name: /Your answer for Evening Reception/ })
    .getByRole('button', { name: 'Count me in' })
    .click();
  await form.getByRole('button', { name: '+ Add a guest' }).click();
  await form.locator('[data-plus-one]').getByLabel('First name').fill('Jo');
  await form.locator('[data-plus-one]').getByLabel('Last name').fill('Example');
  await form.getByRole('button', { name: 'Send my RSVP' }).click();

  await expect(page.locator('[data-rsvp-result="ok"]')).toContainText('You’re going');
  await page.getByRole('link', { name: 'View my ticket' }).click();
  await page.waitForURL(/\/ticket$/);
  const ticket = page.locator('[data-ticket]');
  await expect(ticket).toContainText('Carlos Ferro');
  await expect(ticket.getByRole('tab', { name: /Jo Example/ })).toBeVisible();
  await expect(ticket.getByRole('img', { name: 'Check-in code for Carlos Ferro' })).toBeVisible();
  // Going to the reception reveals the registered-only address.
  await expect(page.locator('[data-ticket-venue]')).toContainText('100 Example Avenue');
  const ics = await page.request.get(
    (await ticket.getByRole('link', { name: 'Calendar file (.ics)' }).getAttribute('href')) ?? '',
  );
  expect(ics.headers()['content-type']).toContain('text/calendar');
  expect(await ics.text()).toContain('METHOD:PUBLISH');

  // Back on the public page, the browser is remembered.
  await page.goto(`/e/${SLUG}`);
  await expect(page.locator('[data-rsvp-remembered]')).toContainText('You’re going');
  await page.context().close();
});

test('an invite-only page offers "Request an invite", which waits for approval', async ({
  browser,
  page: hostPage,
}, testInfo) => {
  const page = await guestPage(browser, testInfo.project.use.baseURL);
  await page.goto(`/e/${SLUG}`);
  const slot = page.locator('[data-rsvp-invite-only]');
  await expect(slot).toContainText('By invitation');
  // The address is for registered guests only: not on the public page.
  await expect(page.locator('body')).not.toContainText('100 Example Avenue');
  await slot.getByRole('button', { name: 'Request an invite' }).click();
  const form = await fillPublicForm(page, 'jamie.request@example.com', 'Annual Meeting');
  await form.getByRole('button', { name: 'Request an invite' }).click();
  await expect(page.locator('[data-rsvp-result]')).toContainText('Request received');
  // A pending request is not a place: the remembered page still hides the address.
  await page.goto(`/e/${SLUG}`);
  await expect(page.locator('body')).not.toContainText('100 Example Avenue');
  await page.context().close();

  // Their own personal link cannot skip the host: Maybe, then Going, stays a request.
  const roster = await host(hostPage, 'GET', `/api/events/${EVENT}/guests`);
  const jamie = roster.json.roster.guests.find(
    (g: { email: string }) => g.email === 'jamie.request@example.com',
  );
  const { invite } = await links(hostPage, jamie.id);
  const own = await guestPage(browser, testInfo.project.use.baseURL);
  for (const answer of ['Maybe', 'Count me in']) {
    await own.goto(invite);
    const change = own.getByRole('button', { name: 'Change my RSVP' });
    if (await change.isVisible().catch(() => false)) await change.click();
    const mine = own.locator('form[data-rsvp-form="invite"]');
    await mine
      .getByRole('group', { name: /Your answer for Annual Meeting/ })
      .getByRole('button', { name: answer })
      .click();
    await mine.getByRole('button', { name: /^(Send|Update) my RSVP$/ }).click();
    await expect(own.locator('[data-rsvp-result]')).toContainText('Request received');
  }
  await own.context().close();
  const after = await host(hostPage, 'GET', `/api/events/${EVENT}/guests/${jamie.id}`);
  expect(after.json.detail.guest.sessions[MEETING].status).toBe('pending');
});

test('an open event registers people and remembers them', async ({
  browser,
  page: hostPage,
}, testInfo) => {
  await setRegistration(hostPage, { access: 'open' });
  const page = await guestPage(browser, testInfo.project.use.baseURL);
  await page.goto(`/e/${SLUG}`);
  const form = await fillPublicForm(page, 'jamie.open@example.com', 'Annual Meeting');
  // The honeypot is there for bots and invisible to people.
  await expect(page.locator('#rsvp-website')).not.toBeInViewport();
  await form.getByRole('button', { name: 'Register' }).click();
  await expect(page.locator('[data-rsvp-result="ok"]')).toContainText('You’re going');
  await page.reload();
  await expect(page.locator('[data-rsvp-remembered]')).toContainText('You’re going');
  await page.context().close();
});

test('an approval event holds the request until the host approves it', async ({
  browser,
  page: hostPage,
}, testInfo) => {
  await setRegistration(hostPage, { access: 'approval' });
  const page = await guestPage(browser, testInfo.project.use.baseURL);
  await page.goto(`/e/${SLUG}`);
  const form = await fillPublicForm(page, 'jamie.approval@example.com', 'Annual Meeting');
  await form.getByRole('button', { name: 'Request to join' }).click();
  await expect(page.locator('[data-rsvp-result]')).toContainText('Request received');
  await page.context().close();

  const roster = await host(hostPage, 'GET', `/api/events/${EVENT}/guests`);
  const jamie = roster.json.roster.guests.find(
    (g: { email: string }) => g.email === 'jamie.approval@example.com',
  );
  expect(jamie.sessions[MEETING].status).toBe('pending');
  const approved = await host(hostPage, 'PATCH', `/api/events/${EVENT}/guests`, {
    action: 'approve',
    guestIds: [jamie.id],
    note: 'Welcome',
  });
  expect(approved.json.changed).toBe(1);
  const after = await host(hostPage, 'GET', `/api/events/${EVENT}/guests/${jamie.id}`);
  expect(after.json.detail.guest.sessions[MEETING].status).toBe('going');
});

test('a full session puts the next person on its waitlist', async ({
  browser,
  page: hostPage,
}, testInfo) => {
  await setRegistration(hostPage, { access: 'open' });
  const reg = await host(hostPage, 'GET', `/api/events/${EVENT}/registration`);
  await setSession(hostPage, MEETING, { capacity: reg.json.registration.going[MEETING] });
  const page = await guestPage(browser, testInfo.project.use.baseURL);
  await page.goto(`/e/${SLUG}`);
  const form = await fillPublicForm(page, 'jamie.waitlist@example.com', 'Annual Meeting');
  await expect(form.locator('[data-session]', { hasText: 'Annual Meeting' })).toContainText(
    'Full – join the waitlist',
  );
  await form.getByRole('button', { name: 'Join the waitlist' }).click();
  await expect(page.locator('[data-rsvp-result="warn"]')).toContainText('waitlist');
  await page.context().close();
});

test('the QR code checks a guest in from the host’s phone, and only shows the ticket to others', async ({
  browser,
  page,
}, testInfo) => {
  const { checkin } = await links(page, AVERY);

  const stranger = await guestPage(browser, testInfo.project.use.baseURL);
  await stranger.goto(checkin);
  await expect(stranger.locator('[data-ticket]')).toContainText('Avery Quill');
  await expect(stranger.locator('[data-checkin-landing]')).toHaveCount(0);
  await stranger.context().close();

  await page.goto(checkin);
  const landing = page.locator('[data-checkin-landing]');
  await expect(landing).toContainText('Avery Quill');
  const reception = landing.locator(`[data-checkin-session="${RECEPTION}"]`);
  await reception.getByRole('button', { name: /^Check in Avery/ }).click();
  await expect(page.locator('[data-checkin-answer="ok"]')).toContainText('Checked in');
  // A second phone (or a second tap after a reload) gets the amber answer.
  await page.reload();
  const again = await host(page, 'POST', `/api/e/${SLUG}/c/${checkin.split('/c/')[1]}`, {
    action: 'checkin',
    sessionId: RECEPTION,
  });
  expect(again.json.result.state).toBe('already');
  await expect(page.locator(`[data-checkin-session="${RECEPTION}"]`)).toContainText('In ·');
});
