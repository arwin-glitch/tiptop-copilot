import path from 'node:path';
import { devices, expect, test, type Browser, type Locator, type Page } from '@playwright/test';

/**
 * The booking page assistant (D-078) in a browser, over the demo, with
 * nobody signed in, at 1440 and at a 390px phone: booking a call and an
 * in-person coffee in the chat (guests included), answers from the written
 * list, the fallback while AI answers are off, and the wait for a routine
 * answer. No paid AI anywhere: the demo has no routine set up, and the
 * routine's answer is played by an intercepted poll. Copy never says a
 * person confirms. Screenshots land in test-results/booking-chat-*.png and,
 * when BOOKING_SHOTS_DIR is set, there as booking-v2-*.png.
 */

const shot = (name: string) =>
  process.env.BOOKING_SHOTS_DIR
    ? path.join(process.env.BOOKING_SHOTS_DIR, `booking-v2-${name}.png`)
    : path.resolve('test-results', `booking-chat-${name}.png`);

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const PERSON_CONFIRMS = /will confirm|until .* confirms|someone will review|Arwin will reply/i;

test.describe.configure({ mode: 'serial' });

let address = 70;

/** A visitor from its own invented address, so other specs' per-address brakes never trip. */
async function visitor(
  browser: Browser,
  baseURL: string | undefined,
  viewport = DESKTOP,
  device: Record<string, unknown> = {},
) {
  address += 1;
  const context = await browser.newContext({
    ...device,
    baseURL,
    viewport,
    storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: { 'cf-connecting-ip': `198.51.100.${address}` },
    timezoneId: 'America/New_York',
  });
  return { context, page: await context.newPage() };
}

async function openChat(page: Page): Promise<Locator> {
  await page.goto('/meet/nick');
  await page.getByRole('button', { name: /Ask Arwin/ }).click();
  const chat = page.getByRole('dialog', { name: /Arwin/ });
  await expect(chat).toBeVisible();
  await expect(
    chat.getByText("Hi, I'm Arwin, Nick's AI scheduling assistant.", { exact: false }),
  ).toBeVisible();
  return chat;
}

async function fillDetails(chat: Locator, name: string, email: string) {
  const form = chat.getByRole('form', { name: /Your details|Your message/ });
  await form.getByLabel('Name', { exact: true }).fill(name);
  await form.getByLabel('Email', { exact: true }).fill(email);
  await form.getByLabel('Company (optional)').fill('Fernhill Labs');
  return form;
}

async function expectNoPersonConfirms(chat: Locator) {
  await expect(chat).not.toContainText(PERSON_CONFIRMS);
}

test('books a 30-minute call in the chat', async ({ browser }, testInfo) => {
  const { context, page } = await visitor(browser, testInfo.project.use.baseURL);
  const chat = await openChat(page);
  await expect(chat.getByText('Arwin is an AI assistant.', { exact: false })).toBeVisible();

  await chat.getByRole('button', { name: 'Book a 30-min call' }).click();
  const times = chat.getByRole('group', { name: 'Open times' }).last();
  await expect(times.getByRole('button').first()).toBeVisible();
  // Out of the way of the other booking specs' times: the third offered.
  const pick = times.getByRole('button').nth(2);
  const label = (await pick.textContent())!.trim();
  await pick.click();
  const form = await fillDetails(chat, 'Avery Quinn', 'avery.quinn@example.com');
  await form.getByLabel('What would you like to talk about? (optional)').fill('A short intro.');
  await page.screenshot({ animations: 'disabled', path: shot('chat-details-1440') });
  await form.getByRole('button', { name: `Book ${label}` }).click();

  const card = chat.locator('[data-booking-status]');
  await expect(card).toBeVisible();
  // Instant booking answers "booked" (or "held" without calendar editing);
  // with approve-first on, "pending". Never a person confirming.
  await expect(card).toHaveAttribute('data-booking-status', /^(booked|held|pending)$/);
  await expect(card).toContainText(label);
  await expectNoPersonConfirms(chat);
  await page.screenshot({ animations: 'disabled', path: shot('chat-booked-1440') });
  // Cancelled from its own page when it was booked, so the shared demo
  // calendar is left as it was for the calendar specs.
  const manage = card.getByRole('link', { name: 'Reschedule or cancel' });
  if ((await card.getAttribute('data-booking-status')) !== 'pending' && (await manage.count())) {
    await manage.click();
    await page.getByRole('button', { name: 'Cancel meeting' }).click();
    await page.getByRole('button', { name: 'Cancel meeting' }).click();
    await expect(page.getByRole('heading', { name: 'This meeting was cancelled' })).toBeVisible();
  }
  await context.close();
});

test('books coffee at a listed place with a guest, and shows the manage link', async ({
  browser,
}, testInfo) => {
  const { context, page } = await visitor(browser, testInfo.project.use.baseURL);
  let sent: Record<string, unknown> | null = null;
  // The response the instant-booking route gives (D-078), played here so the
  // card's booked and held copy are both checked on any calendar.
  await page.route('**/api/meet/nick/request', async (route) => {
    sent = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, status: 'booked', manageUrl: '/meet/nick/manage/demo-1' }),
    });
  });
  const chat = await openChat(page);
  await chat.getByRole('button', { name: 'Meet in person' }).click();
  await chat
    .getByRole('group', { name: 'Coffee, lunch or dinner?' })
    .getByRole('button', { name: 'Coffee' })
    .click();
  const times = chat.getByRole('group', { name: 'Open times' }).last();
  await times.getByRole('button').first().click();
  await chat
    .getByRole('group', { name: 'Places' })
    .getByRole('button', { name: /Juniper & Rye Coffee/ })
    .click();
  const form = await fillDetails(chat, 'Sam Ortiz', 'sam.ortiz@example.com');
  await form.getByRole('button', { name: 'Add guest' }).click();
  await form.getByLabel('Guest 1 email').fill('kit.lane@example.com');
  await form.getByRole('button', { name: /^Book / }).click();

  const card = chat.locator('[data-booking-status="booked"]');
  await expect(card).toContainText('You’re booked.');
  await expect(card).toContainText('Coffee, 1 hour in person');
  await expect(card).toContainText('Juniper & Rye Coffee');
  await expect(card).toContainText(
    'The calendar invitation is on its way to sam.ortiz@example.com and 1 guest.',
  );
  await expect(card.getByRole('link', { name: 'Reschedule or cancel' })).toHaveAttribute(
    'href',
    '/meet/nick/manage/demo-1',
  );
  expect(sent).toMatchObject({
    type: 'in_person',
    kind: 'coffee',
    placeId: 'juniper-rye',
    source: 'chatbot',
    guests: ['kit.lane@example.com'],
    website: '',
  });
  await expectNoPersonConfirms(chat);

  // Held (no calendar editing yet): neutral, no person named.
  await page.unroute('**/api/meet/nick/request');
  await page.route('**/api/meet/nick/request', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, status: 'held' }),
    }),
  );
  await chat.getByRole('button', { name: 'Start over' }).click();
  await chat.getByRole('button', { name: 'Book a 30-min call' }).last().click();
  await expect(chat.getByText(/next open times for a 30-minute call/)).toBeVisible();
  await chat.getByRole('group', { name: 'Open times' }).last().getByRole('button').first().click();
  const again = await fillDetails(chat, 'Sam Ortiz', 'sam.ortiz@example.com');
  await again.getByRole('button', { name: /^Book / }).click();
  await expect(chat.locator('[data-booking-status="held"]')).toContainText(
    'Your time is held. The calendar invitation is on its way.',
  );
  await context.close();
});

test('answers from the written list, and offers a message while AI answers are off', async ({
  browser,
}, testInfo) => {
  const { context, page } = await visitor(browser, testInfo.project.use.baseURL);
  const chat = await openChat(page);
  const input = chat.getByRole('textbox', { name: 'Ask Arwin a question' });

  await input.fill('What stage do you invest in?');
  await input.press('Enter');
  await expect(chat.getByText('Stage: pre-seed and seed software companies.')).toBeVisible();
  await expect(chat.getByText('Answer to: Stage')).toBeVisible();

  await input.fill('Can I bring my cofounder?');
  await input.press('Enter');
  await expect(chat.getByText(/^Yes\. Add up to 5 guests/)).toBeVisible();

  // Nothing written covers it and the demo has no routine: a message instead.
  await input.fill('Do you invest in climate hardware?');
  await input.press('Enter');
  await expect(
    chat.getByText('I don’t have an answer for that one. You can leave it as a message for Nick', {
      exact: false,
    }),
  ).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: shot('chat-faq-1440') });
  await chat.getByRole('button', { name: 'Leave this as a message for Nick' }).click();
  const form = await fillDetails(chat, 'Rowan Hale', 'rowan.hale@example.com');
  await expect(form.getByLabel('Message for Nick')).toHaveValue(
    'Do you invest in climate hardware?',
  );
  await form.getByRole('button', { name: 'Send message' }).click();
  await expect(chat.locator('[data-booking-status="message"]')).toContainText(
    'Your message is on its way to Nick.',
  );
  await expectNoPersonConfirms(chat);
  await context.close();
});

test('waits for a routine answer while the visitor keeps going', async ({ browser }, testInfo) => {
  const { context, page } = await visitor(browser, testInfo.project.use.baseURL);
  const QUESTION_ID = '0b5e7a52-4c1d-4e8f-9a3b-6c7d8e9f0a1b';
  // The routine is not set up in the demo: its two answers are played here.
  await page.route('**/api/meet/nick/chat', async (route) => {
    const body = route.request().postDataJSON() as { action?: string };
    if (body.action !== 'ask') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        action: 'ask',
        kind: 'pending',
        questionId: QUESTION_ID,
        reply:
          'Arwin is looking into it - this can take a minute or two. You can keep booking meanwhile.',
        suggestions: ['Stage'],
      }),
    });
  });
  let polls = 0;
  await page.route('**/api/meet/nick/chat/answer**', async (route) => {
    polls += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        polls < 2
          ? { ok: true, status: 'pending', answer: null }
          : {
              ok: true,
              status: 'answered',
              answer: 'Climate hardware is not on the written list.',
            },
      ),
    });
  });
  const chat = await openChat(page);
  const input = chat.getByRole('textbox', { name: 'Ask Arwin a question' });
  await input.fill('Do you invest in climate hardware?');
  await input.press('Enter');
  await expect(
    chat.getByText('Arwin is looking into it - this can take a minute or two.', { exact: false }),
  ).toBeVisible();
  // Booking still works while it waits.
  await chat.getByRole('button', { name: 'Book a 30-min call' }).click();
  await expect(chat.getByRole('group', { name: 'Open times' }).last()).toBeVisible();
  await expect(chat.getByText('Climate hardware is not on the written list.')).toBeVisible({
    timeout: 20_000,
  });
  await expect(chat.getByText('Answered by Arwin', { exact: false })).toBeVisible();
  expect(polls).toBeGreaterThanOrEqual(2);
  await context.close();
});

test('works on a 390px phone', async ({ browser }, testInfo) => {
  // A touch phone (mobile browser, touch), narrowed to 390px.
  const { context, page } = await visitor(
    browser,
    testInfo.project.use.baseURL,
    PHONE,
    devices['Pixel 7'],
  );
  const chat = await openChat(page);
  const box = await chat.boundingBox();
  expect(box?.width).toBeLessThanOrEqual(PHONE.width);
  await page.screenshot({ animations: 'disabled', path: shot('chat-open-390') });

  await chat.getByRole('button', { name: 'Book a 30-min call' }).click();
  await expect(chat.getByRole('group', { name: 'Open times' }).last()).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: shot('chat-times-390') });
  await chat.getByRole('group', { name: 'Open times' }).last().getByRole('button').nth(1).click();
  await fillDetails(chat, 'Jo Park', 'jo.park@example.com');
  await expect(chat.getByRole('button', { name: 'Add guest' })).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: shot('chat-details-390') });

  const input = chat.getByRole('textbox', { name: 'Ask Arwin a question' });
  await input.fill('How much do you invest?');
  await input.press('Enter');
  await expect(chat.getByText('Check size: an invented $250K to $500K first check.')).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: shot('chat-faq-390') });

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await expectNoPersonConfirms(chat);
  await context.close();
});
