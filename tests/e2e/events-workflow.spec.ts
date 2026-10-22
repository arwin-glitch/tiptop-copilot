import path from 'node:path';
import {
  expect,
  test,
  type Browser,
  type BrowserContextOptions,
  type Page,
} from '@playwright/test';

/**
 * Events, the whole workflow across the five workstreams (D-075), on a brand
 * new event so it never leans on the demo fixtures:
 *
 *   New event from the AGM starter and a theme (WS5) → designed in Studio:
 *   theme, effects, the cover headline (WS3 on WS2's renderer) → an outside
 *   editor on a design-only link changes the theme, cannot touch the words,
 *   and marks it ready for review (WS3) → Publish (WS1) → the public page
 *   /e/<slug> (WS4 + WS2) → an approval RSVP for both sessions, approved by
 *   the host in Guests → a personal invite answering per session (AGM) →
 *   check-in by the host's QR scan and by a staff link's door list → an
 *   invite drafted as a campaign that sends nothing (WS5).
 *
 * Then the guest-facing pages again at 390 px. Every person, email and
 * place here is invented.
 */

const SIGNED_IN = path.resolve('test-results', 'events-workflow-state.json');
const SHOTS = path.resolve('test-results', 'events-workflow-shots');
const TITLE = 'Northwind Annual Gathering';
const SLUG = 'northwind-annual-gathering';
const HEADLINE = 'Northwind Annual Gathering 2031';
const OUTSIDER = 'Quinn – Example Studio';
const STAFF = 'Door – Sam Example';

const PHONE: BrowserContextOptions = {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
};

/** Shared across the serial tests below: the event this run creates. */
const state = {
  eventId: '',
  meeting: '',
  reception: '',
  staffPath: '',
  jamieId: '',
  rileyId: '',
};

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

/* ----------------------------------------------------------------- helpers */

/** A same-origin fetch from the page, so the browser's own cookie rules apply. */
async function call(
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

/** A browser with no Copilot session: a guest, an outside editor, door staff. */
async function freshPage(
  browser: Browser,
  baseURL: string | undefined,
  options: BrowserContextOptions = {},
): Promise<Page> {
  const context = await browser.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
    ...options,
  });
  return context.newPage();
}

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

async function draftDoc(page: Page) {
  const res = await call(page, 'GET', `/api/events/${state.eventId}/draft`);
  expect(res.status).toBe(200);
  return res.json.doc as {
    theme: { presetId: string; overlay: { kind: string } };
    sections: { type: string; props: Record<string, unknown> }[];
  };
}

async function guestByEmail(page: Page, email: string) {
  const roster = await call(page, 'GET', `/api/events/${state.eventId}/guests`);
  expect(roster.status).toBe(200);
  const guest = roster.json.roster.guests.find((g: { email: string }) => g.email === email);
  expect(guest, `guest ${email}`).toBeTruthy();
  return guest as { id: string; sessions: Record<string, { status: string }> };
}

async function linksFor(page: Page, guestId: string) {
  const res = await call(page, 'GET', `/api/events/${state.eventId}/guests/${guestId}/link`);
  expect(res.status).toBe(200);
  // The API answers with APP_URL's origin; the test server runs on its own port.
  const pathOf = (url: string) => new URL(url).pathname;
  return {
    invite: pathOf(res.json.invite),
    ticket: pathOf(res.json.ticket),
    checkin: pathOf(res.json.checkin),
  };
}

/** Make a link in the Sharing tab; returns the once-shown path (with its #k= secret). */
async function makeSharingLink(
  page: Page,
  kind: 'editor' | 'staff',
  label: string,
  setup?: (dialog: ReturnType<Page['getByRole']>) => Promise<void>,
): Promise<string> {
  await page.goto(`/events/${state.eventId}?tab=sharing`);
  await page
    .getByRole('button', { name: kind === 'staff' ? 'Add a staff link' : 'Invite an editor' })
    .click();
  const dialog = page.getByRole('dialog', {
    name: kind === 'staff' ? 'Add a staff link' : 'Invite an editor',
  });
  await dialog.getByLabel('Who it is for').fill(label);
  if (setup) await setup(dialog);
  await dialog.getByRole('button', { name: 'Make the link' }).click();
  const issued = page.getByRole('dialog', { name: `${label}'s link` });
  const url = new URL(await issued.locator('#issued-link').inputValue());
  await issued.press('Escape');
  return `${url.pathname}${url.hash}`;
}

async function noSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 2);
}

async function fillPublicForm(page: Page, first: string, email: string, sessions: string[]) {
  const form = page.locator('form[data-rsvp-form="public"]');
  await expect(form).toBeVisible();
  await form.getByLabel('First name').fill(first);
  await form.getByLabel('Last name').fill('Fictional');
  await form.getByLabel('Email').fill(email);
  for (const name of sessions) {
    await form
      .locator('label.evu-choice', { hasText: name })
      .locator('input[type="checkbox"]')
      .check();
  }
  // The server refuses a public form sent within two seconds of rendering.
  await page.waitForTimeout(2_200);
  return form;
}

/* ------------------------------------------------------------ the workflow */

test('1. a new event from the AGM starter and a theme', async ({ page }) => {
  await page.goto('/events');
  await page.getByRole('button', { name: 'New event', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New event' });
  await dialog
    .getByRole('radiogroup', { name: 'Starter' })
    .getByRole('radio', { name: /Annual Meeting \+ Evening Reception/ })
    .click();
  await dialog.getByRole('button', { name: 'Next: theme' }).click();
  await dialog
    .getByRole('radiogroup', { name: 'Theme' })
    .getByRole('radio', { name: /Annual Letter/ })
    .click();
  await dialog.getByRole('button', { name: 'Next: details' }).click();
  await dialog.getByLabel('Name').fill(TITLE);
  await expect(dialog).toContainText(`/e/${SLUG}`);
  await dialog.getByLabel('Date').fill('2031-05-15');
  // The AGM's meeting (1–5 PM) and reception (6–9 PM): the end follows the start.
  await dialog.getByLabel('Starts').fill('13:00');
  await expect(dialog.getByLabel('Ends')).toHaveValue('21:00');
  await dialog.getByRole('button', { name: 'Create draft' }).click();
  await page.waitForURL(/\/events\/[0-9a-f-]{36}$/);
  state.eventId = page.url().split('/events/')[1]!;
  await expect(page.getByRole('heading', { level: 1, name: TITLE })).toBeVisible();

  // The starter's two sessions came with it.
  const detail = await call(page, 'GET', `/api/events/${state.eventId}`);
  const sessions = detail.json.sessions as {
    id: string;
    name: string;
    starts_at: string;
    ends_at: string;
  }[];
  expect(sessions.map((s) => s.name)).toEqual(['Annual Meeting', 'Evening Reception']);
  // 1 PM and 6–9 PM in Chicago (CDT, UTC-5); the event spans both.
  expect(sessions[0]!.starts_at).toBe('2031-05-15T18:00:00.000Z');
  expect(sessions[1]!.starts_at).toBe('2031-05-15T23:00:00.000Z');
  expect(detail.json.event.ends_at).toBe(sessions[1]!.ends_at);
  state.meeting = sessions[0]!.id;
  state.reception = sessions[1]!.id;
  expect(detail.json.event).toMatchObject({ status: 'draft', access: 'invite_only' });
  expect((await draftDoc(page)).theme.presetId).toBe('annual-letter');
  // What the AGM starter promises is set up: a plus-one per session and its questions.
  expect(detail.json.event.registration.plus_ones).toMatchObject({ max: 1, per_session: true });

  // The venue is set in Manage → Details, its address for Going guests only.
  await page.goto(`/events/${state.eventId}?tab=settings`);
  const details = page.locator('form[data-form="event-details"]');
  await details.getByLabel('Venue name').fill('The Glasshouse');
  await details.getByLabel('Street and city').fill('12 Example Street, Springfield');
  await details.getByLabel('Who sees where it is').selectOption('going');
  await details.getByRole('button', { name: 'Save details' }).click();
  await expect(page.getByText('Details saved.')).toBeVisible();
  const saved = await call(page, 'GET', `/api/events/${state.eventId}`);
  expect(saved.json.event.venue).toMatchObject({
    name: 'The Glasshouse',
    address: '12 Example Street, Springfield',
    reveal: 'going',
  });
});

test('2. the owner designs it in Studio: theme, effects and the cover', async ({ page }) => {
  await page.goto(`/events/${state.eventId}/studio`);
  await expect(
    page.getByRole('banner').getByRole('heading', { level: 1, name: TITLE }),
  ).toBeVisible();

  await page.getByRole('tab', { name: 'Theme' }).click();
  await page
    .getByRole('list', { name: 'Theme presets' })
    .getByRole('button', { name: 'TipTop Signature', exact: true })
    .click();
  await saved(page);

  await page.getByRole('tab', { name: 'Effects' }).click();
  await page.getByRole('region', { name: 'Overlay' }).getByLabel('Kind').selectOption('gold_dust');
  await saved(page);

  await page.getByRole('tab', { name: 'Sections' }).click();
  await canvasSection(page, 'hero').click();
  await headlineInput(page).fill(HEADLINE);
  await saved(page);
  await expect(canvasSection(page, 'hero')).toContainText(HEADLINE);
  await page.screenshot({ path: path.join(SHOTS, 'studio-owner-1440.png') });

  const doc = await draftDoc(page);
  expect(doc.theme.presetId).toBe('tiptop-signature');
  expect(doc.theme.overlay.kind).toBe('gold_dust');
  expect(doc.sections.find((s) => s.type === 'hero')?.props.headline).toBe(HEADLINE);
});

test('3. an outside editor on a design-only link changes the look, never the words', async ({
  page,
  browser,
}, testInfo) => {
  const link = await makeSharingLink(page, 'editor', OUTSIDER, async (dialog) => {
    await dialog.getByLabel('Content: words, photos and list items').uncheck();
    await dialog.getByLabel('Design: layouts, theme and effects').check();
  });
  expect(link).toMatch(/^\/e\/edit#k=[A-Za-z0-9_-]{43}$/);

  const out = await freshPage(browser, testInfo.project.use.baseURL);
  const cspErrors: string[] = [];
  out.on('console', (message) => {
    if (message.type() === 'error' && /Content Security Policy|Refused to/i.test(message.text())) {
      cspErrors.push(message.text());
    }
  });
  await out.goto(link);
  await out.getByLabel(new RegExp(`Yes, I'm ${OUTSIDER}`)).check();
  await out.getByRole('button', { name: 'Open editor' }).click();
  await out.waitForURL(new RegExp(`/e/edit/${state.eventId}$`));
  await expect(
    out.getByText('Outside editor · changes go live only when TipTop publishes'),
  ).toBeVisible();

  // Words are outside the link's scope: locked here, refused by the server.
  await canvasSection(out, 'hero').click();
  await expect(headlineInput(out)).toBeDisabled();
  const draft = await call(out, 'GET', `/api/e/edit/${state.eventId}/draft`);
  expect(draft.status).toBe(200);
  const hero = (draft.json.doc.sections as { id: string; type: string; rev: number }[]).find(
    (s) => s.type === 'hero',
  )!;
  const forced = await call(out, 'POST', `/api/e/edit/${state.eventId}/ops`, {
    baseVersion: draft.json.version,
    ops: [
      {
        kind: 'section.update',
        opId: 'words-1',
        id: hero.id,
        baseRev: hero.rev,
        set: { 'props.headline': 'Not yours to change' },
      },
    ],
  });
  expect(forced.json.applied).toEqual([]);
  expect(forced.json.conflicts[0]?.kind).toBe('forbidden');

  // The look is theirs to change.
  await out.getByRole('tab', { name: 'Theme' }).click();
  await out
    .getByRole('list', { name: 'Theme presets' })
    .getByRole('button', { name: 'Boardroom Noir', exact: true })
    .click();
  await saved(out);
  await out.getByRole('button', { name: 'Ready for review' }).click();
  await expect(
    out.getByText('TipTop has been told your changes are ready for review.'),
  ).toBeVisible();
  expect(cspErrors).toEqual([]);
  await out.context().close();

  const doc = await draftDoc(page);
  expect(doc.theme.presetId).toBe('boardroom-noir');
  expect(doc.sections.find((s) => s.type === 'hero')?.props.headline).toBe(HEADLINE);
  await page.goto(`/events/${state.eventId}?tab=sharing`);
  await expect(page.getByRole('list', { name: 'Link activity' })).toContainText(
    `${OUTSIDER} marked ${TITLE} ready for review`,
  );
});

test('4. the owner publishes, and /e/<slug> serves the published page', async ({
  page,
  browser,
}, testInfo) => {
  // Before Publish there is nothing to see.
  const early = await freshPage(browser, testInfo.project.use.baseURL);
  expect((await early.goto(`/e/${SLUG}`))?.status()).toBe(404);
  await early.context().close();

  await page.goto(`/events/${state.eventId}/studio`);
  await page
    .getByRole('banner')
    .getByRole('button', { name: /^Publish/ })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Publish this page' });
  await expect(dialog.getByRole('region', { name: 'What changes' })).toBeVisible();
  const anyway = dialog.getByLabel(/Publish anyway/);
  if (await anyway.count()) await anyway.check();
  await dialog.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Published. The page is live.')).toBeVisible();

  const guest = await freshPage(browser, testInfo.project.use.baseURL);
  const response = await guest.goto(`/e/${SLUG}`);
  expect(response?.status()).toBe(200);
  const csp = response?.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("'nonce-");
  expect(csp).toContain("'strict-dynamic'");
  // Unlisted (the AGM starter): kept out of search engines.
  await expect(guest.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  await expect(guest.locator('[data-event-root]')).toContainText(HEADLINE);
  await expect(guest.locator('[data-rsvp-invite-only]')).toContainText('By invitation');
  // The venue set in Manage: its name for everyone, its address only for Going guests.
  await expect(guest.locator('[data-event-root]')).toContainText('The Glasshouse');
  await expect(guest.locator('[data-event-root]')).not.toContainText('12 Example Street');
  await guest.screenshot({ path: path.join(SHOTS, 'public-1440.png'), fullPage: true });
  await guest.context().close();
});

test('5. an approval RSVP for both sessions waits until the host approves it', async ({
  page,
  browser,
}, testInfo) => {
  await page.goto(`/events/${state.eventId}?tab=registration`);
  await page.getByRole('radio', { name: /^Approval/ }).check();
  await page.getByRole('button', { name: 'Save registration settings' }).click();
  await expect(page.getByText('Registration settings saved')).toBeVisible();

  const guest = await freshPage(browser, testInfo.project.use.baseURL);
  await guest.goto(`/e/${SLUG}`);
  const form = await fillPublicForm(guest, 'Jamie', 'jamie.northwind@example.com', [
    'Annual Meeting',
    'Evening Reception',
  ]);
  await form.getByRole('button', { name: 'Request to join' }).click();
  await expect(guest.locator('[data-rsvp-result]')).toContainText('Request received');
  await guest.context().close();

  const pending = await guestByEmail(page, 'jamie.northwind@example.com');
  state.jamieId = pending.id;
  expect(pending.sessions[state.meeting]?.status).toBe('pending');
  expect(pending.sessions[state.reception]?.status).toBe('pending');

  // The host approves in the Guests tab.
  await page.goto(`/events/${state.eventId}?tab=guests`);
  await page.getByRole('checkbox', { name: 'Select Jamie Fictional' }).check();
  await page
    .getByRole('toolbar', { name: 'Bulk actions' })
    .getByRole('button', {
      name: 'Approve',
      exact: true,
    })
    .click();
  const confirm = page.getByRole('dialog', { name: 'Approve – 1 guest?' });
  await confirm.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByText('Approve: 1 guest')).toBeVisible();

  const approved = await guestByEmail(page, 'jamie.northwind@example.com');
  expect(approved.sessions[state.meeting]?.status).toBe('going');
  expect(approved.sessions[state.reception]?.status).toBe('going');
});

test('6. a personal invite answers per session: the meeting yes, the reception no', async ({
  page,
  browser,
}, testInfo) => {
  await page.goto(`/events/${state.eventId}?tab=guests`);
  for (const [first, email] of [
    ['Riley', 'riley.northwind@example.com'],
    ['Casey', 'casey.northwind@example.com'],
  ] as const) {
    await page.getByRole('button', { name: 'Add guests', exact: true }).click();
    const add = page.getByRole('dialog', { name: 'Add guests' });
    await add.getByRole('tab', { name: 'One person' }).click();
    await add.getByLabel('Email').fill(email);
    await add.getByLabel('First name').fill(first);
    await add.getByLabel('Last name').fill('Example');
    await add.getByRole('button', { name: 'Add guests', exact: true }).click();
    await expect(add).toBeHidden();
  }

  const riley = await guestByEmail(page, 'riley.northwind@example.com');
  state.rileyId = riley.id;
  expect(riley.sessions[state.meeting]?.status).toBe('invited');
  const { invite } = await linksFor(page, riley.id);

  const guest = await freshPage(browser, testInfo.project.use.baseURL);
  await guest.goto(invite);
  const form = guest.locator('form[data-rsvp-form="invite"]');
  await expect(form.locator('[data-session]')).toHaveCount(2);
  await form
    .getByRole('group', { name: 'Your answer for Annual Meeting' })
    .getByRole('button', { name: 'Count me in' })
    .click();
  await form
    .getByRole('group', { name: 'Your answer for Evening Reception' })
    .getByRole('button', { name: 'Regretfully decline' })
    .click();
  await form.getByRole('button', { name: 'Send my RSVP' }).click();
  await expect(guest.locator('[data-rsvp-result="ok"]')).toBeVisible();
  await guest.getByRole('link', { name: 'View my ticket' }).click();
  await guest.waitForURL(/\/ticket$/);
  await expect(guest.locator('[data-ticket]')).toContainText('Annual Meeting');
  // Going (to the meeting): the address is theirs now.
  await expect(guest.locator('[data-ticket]')).toContainText('12 Example Street');
  await guest.context().close();

  const answered = await guestByEmail(page, 'riley.northwind@example.com');
  expect(answered.sessions[state.meeting]?.status).toBe('going');
  expect(answered.sessions[state.reception]?.status).toBe('not_going');
});

test('7. check-in: the host scans a ticket, and door staff work from a staff link', async ({
  page,
  browser,
}, testInfo) => {
  // The host's phone camera opens Jamie's QR.
  const jamie = await linksFor(page, state.jamieId);
  await page.goto(jamie.checkin);
  const landing = page.locator('[data-checkin-landing]');
  await expect(landing).toContainText('Jamie Fictional');
  await landing
    .locator(`[data-checkin-session="${state.meeting}"]`)
    .getByRole('button', { name: /^Check in Jamie/ })
    .click();
  await expect(page.locator('[data-checkin-answer="ok"]')).toContainText('Checked in');

  // A staff link: claimed on its own device, then the door list.
  state.staffPath = await makeSharingLink(page, 'staff', STAFF);
  expect(state.staffPath).toMatch(/^\/e\/checkin#k=[A-Za-z0-9_-]{43}$/);
  const staff = await freshPage(browser, testInfo.project.use.baseURL);
  await staff.goto(state.staffPath);
  await staff.getByRole('button', { name: 'Open the door list' }).click();
  await staff.waitForURL(new RegExp(`/e/checkin/${state.eventId}$`));
  const cookiePaths = (await staff.context().cookies())
    .filter((c) => c.name === 'tiptop_ev_grant')
    .map((c) => c.path)
    .sort();
  expect(cookiePaths).toEqual(
    [
      `/api/e/${SLUG}/c`,
      `/api/e/checkin/${state.eventId}`,
      `/e/${SLUG}/c`,
      `/e/checkin/${state.eventId}`,
    ].sort(),
  );
  const door = staff.locator('[data-door-list]');
  await door.getByRole('tab', { name: 'Evening Reception' }).click();
  await door.getByRole('button', { name: 'Check in Jamie Fictional' }).click();
  await expect(
    door.getByRole('button', { name: 'Undo check-in for Jamie Fictional' }),
  ).toBeVisible();

  // The staff cookie also rides on the event's QR landing: Riley's ticket.
  const riley = await linksFor(page, state.rileyId);
  await staff.goto(riley.checkin);
  const staffLanding = staff.locator('[data-checkin-landing]');
  await staffLanding
    .locator(`[data-checkin-session="${state.meeting}"]`)
    .getByRole('button', { name: /^Check in Riley/ })
    .click();
  await expect(staff.locator('[data-checkin-answer="ok"]')).toContainText('Checked in');
  // ...and reaches nothing else in Copilot.
  expect((await call(staff, 'GET', `/api/events/${state.eventId}/guests`)).status).toBe(401);
  await staff.context().close();

  const counts = await call(page, 'GET', `/api/events/${state.eventId}/checkin`);
  expect(counts.status).toBe(200);
});

test('8. an invite is a campaign draft with personal links, and nothing is sent', async ({
  page,
}) => {
  await page.goto(`/events/${state.eventId}?tab=messages`);
  await expect(page.getByLabel('To', { exact: true })).toHaveValue('status:invited');
  await page.getByRole('button', { name: 'Draft the invite' }).click();
  await page.waitForURL(/\/fund-ii\/campaigns\/[0-9a-f-]{36}$/);
  const campaignId = page.url().split('/campaigns/')[1]!;
  await expect(page.getByRole('heading', { level: 1, name: `${TITLE} · Invite` })).toBeVisible();
  await expect(page.getByText('Event message · Campaign')).toBeVisible();

  const campaign = await call(page, 'GET', `/api/campaigns/${campaignId}`);
  expect(campaign.status).toBe(200);
  expect(campaign.json.campaign).toMatchObject({ status: 'draft', event_id: state.eventId });
  // Casey is the one guest still invited; Riley answered, Jamie was approved.
  expect(campaign.json.counts).toMatchObject({ total: 1, sent: 0 });
});

/* ----------------------------------------------------------- at 390 px */

test.describe('on a phone (390 px)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the guest page takes a request, and a personal invite shows the ticket', async ({
    page,
    browser,
  }, testInfo) => {
    const guest = await freshPage(browser, testInfo.project.use.baseURL, PHONE);
    await guest.goto(`/e/${SLUG}`);
    await expect(guest.locator('[data-event-root]')).toContainText(HEADLINE);
    await noSidewaysScroll(guest);
    const form = await fillPublicForm(guest, 'Morgan', 'morgan.northwind@example.com', [
      'Evening Reception',
    ]);
    await form.getByRole('button', { name: 'Request to join' }).click();
    await expect(guest.locator('[data-rsvp-result]')).toContainText('Request received');
    await noSidewaysScroll(guest);
    await guest.screenshot({ path: path.join(SHOTS, 'public-390.png'), fullPage: true });
    await guest.context().close();

    const casey = await guestByEmail(page, 'casey.northwind@example.com');
    const { invite } = await linksFor(page, casey.id);
    const phone = await freshPage(browser, testInfo.project.use.baseURL, PHONE);
    await phone.goto(invite);
    const answer = phone.locator('form[data-rsvp-form="invite"]');
    for (const name of ['Annual Meeting', 'Evening Reception']) {
      await answer
        .getByRole('group', { name: `Your answer for ${name}` })
        .getByRole('button', { name: 'Count me in' })
        .click();
    }
    await answer.getByRole('button', { name: 'Send my RSVP' }).click();
    await expect(phone.locator('[data-rsvp-result="ok"]')).toBeVisible();
    await phone.getByRole('link', { name: 'View my ticket' }).click();
    await phone.waitForURL(/\/ticket$/);
    await expect(phone.locator('[data-ticket]').getByRole('img').first()).toBeVisible();
    await noSidewaysScroll(phone);
    await phone.screenshot({ path: path.join(SHOTS, 'ticket-390.png'), fullPage: true });
    await phone.context().close();
  });

  test('door staff check people in from a phone', async ({ page, browser }, testInfo) => {
    const staff = await freshPage(browser, testInfo.project.use.baseURL, PHONE);
    await staff.goto(state.staffPath);
    await staff.getByRole('button', { name: 'Open the door list' }).click();
    await staff.waitForURL(new RegExp(`/e/checkin/${state.eventId}$`));
    const door = staff.locator('[data-door-list]');
    await door.getByRole('tab', { name: 'Annual Meeting' }).click();
    await door.getByRole('button', { name: 'Check in Casey Example' }).click();
    await expect(
      door.getByRole('button', { name: 'Undo check-in for Casey Example' }),
    ).toBeVisible();
    await noSidewaysScroll(staff);
    await staff.screenshot({ path: path.join(SHOTS, 'door-390.png'), fullPage: true });
    await staff.context().close();

    const checkin = await call(page, 'GET', `/api/events/${state.eventId}/checkin`);
    expect(checkin.status).toBe(200);
  });

  test('the host’s event pages and Studio fit the phone', async ({ page }) => {
    for (const tab of ['overview', 'guests', 'registration', 'messages', 'sharing']) {
      await page.goto(`/events/${state.eventId}?tab=${tab}`);
      await expect(page.getByRole('heading', { level: 1, name: TITLE })).toBeVisible();
      await noSidewaysScroll(page);
    }
    await page.goto(`/events/${state.eventId}/studio`);
    await expect(page.getByRole('navigation', { name: 'Studio panes' })).toBeVisible();
    await noSidewaysScroll(page);
    await page.screenshot({ path: path.join(SHOTS, 'studio-390.png') });
  });
});
