import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { CONSENT_BANNER_TEXT, CONSENT_CHECKBOX_LABEL } from '../../src/lib/types/notes';
import { MOCK_CALL_LINES } from '../../src/lib/transcribe/mock-script';

/**
 * Kraken Notes (D-076) with the browser recorder mounted behind the meeting
 * page: the integration of the screens (notes-ui) and the web recorder
 * (notes-capture) on the core. Chromium's fake microphone and an auto-picked
 * shared screen stand in for the devices, the recorder's worklets and engines
 * run for real, and demo mode's speech engine hears them (?capture=live
 * picks the recorder over the scripted call; outside demo mode it is the
 * only engine). Fictional people only; nothing reaches a speech service or a model.
 *
 * Desktop: the calendar's "Take notes" → consent → both tracks recording →
 * the live transcript with names → a voice named from the invite → typed
 * notes → Stop → notes with sources → shared with the team → on the
 * portfolio company's page. Phone (390px): "In the room" (one microphone,
 * the iPhone path) records, a voice is named, Stop writes the notes, and
 * nothing scrolls sideways.
 */

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--auto-select-desktop-capture-source=Entire screen',
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
  permissions: ['microphone'],
});

const SIGNED_IN = path.resolve('test-results', 'notes-live-capture-state.json');
const TZ = 'America/Chicago';
const LEDGERLY = '00000000-0000-4000-8000-0000000000c8';
const PHONE = { width: 390, height: 844 };
const ALL_LINES = MOCK_CALL_LINES.map((l) => l.text);

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

function today(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

interface StoredSegment {
  seq: number;
  track: string;
  clusterKey: string;
  text: string;
}

/** A GET from inside the page: the session cookie is Secure, which Playwright's own client does not send to 127.0.0.1. */
async function getJson<T>(page: Page, url: string): Promise<T> {
  const result = await page.evaluate(async (u) => {
    const response = await fetch(u, { cache: 'no-store' });
    return { status: response.status, body: await response.text() };
  }, url);
  expect(result.status, result.body).toBe(200);
  return JSON.parse(result.body) as T;
}

async function stored(page: Page, meetingId: string): Promise<StoredSegment[]> {
  const body = await getJson<{ segments: StoredSegment[] }>(
    page,
    `/api/notes/meetings/${meetingId}/segments?after=-1&limit=1000`,
  );
  return body.segments;
}

async function noSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 2);
}

const consentDialog = (page: Page) => page.getByRole('dialog', { name: CONSENT_BANNER_TEXT });
const transcript = (page: Page) => page.getByRole('log', { name: 'Live transcript' });

test('the calendar to notes on a company page, with the browser recorder', async ({ page }) => {
  test.setTimeout(180_000);

  // The guest agreed in writing to have her voice remembered (Notes settings, Voices).
  await page.goto('/meetings/settings?tab=voices');
  const others = page.getByRole('region', { name: 'Someone else’s voice' });
  await others.getByLabel('Name').fill('Maya Chen');
  await others.getByLabel('Email').fill('maya@ledgerly.demo');
  await others.getByRole('button', { name: 'Record their consent' }).click();
  await expect(others.getByRole('listitem').filter({ hasText: 'Maya Chen' })).toContainText(
    'Consent on file',
  );

  // The calendar's "Take notes" on a portfolio board prep (one guest on the invite).
  await page.goto(`/calendar?view=week&date=${today()}`);
  const title = 'Ledgerly board prep';
  const card = page.getByRole('dialog', { name: title });
  await expect(async () => {
    await page.locator('[data-event-chip]').filter({ hasText: title }).first().click();
    await expect(card).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await card
    .locator('[data-meeting-notes-slot]')
    .getByRole('button', { name: 'Take notes' })
    .click();
  await page.waitForURL(/\/meetings\/[0-9a-f-]{36}\?start=1/);
  const meetingId = new URL(page.url()).pathname.split('/').pop() as string;

  // The same page with the browser recorder against the demo speech engine.
  await page.goto(`/meetings/${meetingId}?start=1&capture=live&mockSpeed=12`);
  const consent = consentDialog(page);
  await expect(consent).toBeVisible();
  // The recorder is the live one: it offers the local sound check.
  await expect(consent.getByRole('link', { name: 'Run a sound check' })).toHaveAttribute(
    'href',
    '/sound-check',
  );
  const start = consent.getByRole('button', { name: 'Start' });
  await expect(start).toBeDisabled();
  await consent.getByRole('checkbox', { name: CONSENT_CHECKBOX_LABEL }).check();
  await expect(start).toBeEnabled();
  await start.click();
  await expect(consent).toHaveCount(0);

  // Both tracks capture: the recorder's meters and engines, under the page's own pill.
  await expect(page.locator('[data-recording-pill="recording"]')).toBeVisible();
  const controls = page.getByTestId('recorder-controls');
  await expect(controls).toHaveAttribute('data-status', 'recording');
  await expect(controls.getByTestId('recorder-provider')).toHaveText('Demo speech');
  await expect(controls.getByTestId('engine-mic')).toHaveAttribute('data-engine', 'open');
  await expect(controls.getByTestId('engine-system')).toHaveAttribute('data-engine', 'open');
  // The page has the one Pause / Stop: the recorder's own buttons are not drawn twice.
  await expect(controls.getByRole('button', { name: 'Stop recording' })).toHaveCount(0);

  // The live transcript fills in from the stored lines: the mic under the recorder's name.
  const live = transcript(page);
  await expect(live).toContainText("I'm Dana, I run Acme Robotics", { timeout: 45_000 });
  await expect(live.locator('[data-speaker="mic"]').first()).not.toContainText('Guest');
  // More voices than guests on the invite: the calendar cannot be sure, so it names nobody.
  const guest = live.getByRole('button', { name: /^Guest \d: who is this\?$/ }).first();
  await expect(guest).toBeVisible({ timeout: 45_000 });
  const guestLabel = (await guest.getAttribute('aria-label')) ?? '';

  // Name it: every line of that voice reads the new name, the later ones too.
  await guest.click();
  const sheet = page.getByRole('dialog', { name: 'This is…' });
  await sheet
    .getByRole('region', { name: 'On the invite' })
    .getByRole('button', { name: /Maya Chen/ })
    .click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByText(/Updated \d+ lines?/)).toBeVisible();
  await expect(live.getByRole('button', { name: guestLabel })).toHaveCount(0);
  await expect(live.getByRole('button', { name: /^Maya Chen/ }).first()).toBeVisible();

  // Her consent is on file: open her name again and remember her voice from
  // the live session (that one voice's voiceprint from this computer, sealed).
  await live.getByRole('button', { name: 'Maya Chen: change who this is' }).first().click();
  const again = page.getByRole('dialog', { name: 'This is…' });
  await again.getByRole('checkbox', { name: /Remember this voice/ }).check();
  await again
    .getByRole('region', { name: 'On the invite' })
    .getByRole('button', { name: /Maya Chen/ })
    .click();
  await expect(
    page.getByText('Voice remembered: Kraken will know Maya Chen next time.'),
  ).toBeVisible();

  // Typed notes, saved as they are typed.
  const notepad = page.getByRole('combobox', { name: 'Your notes' });
  await notepad.click();
  await notepad.pressSequentially('- Board wants the hiring plan by Friday', { delay: 5 });
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();

  // The whole call reaches the server, each line once, in order.
  await expect
    .poll(async () => (await stored(page, meetingId)).length, { timeout: 60_000 })
    .toBe(ALL_LINES.length);
  const rows = await stored(page, meetingId);
  expect(rows.map((r) => r.seq)).toEqual(rows.map((_, i) => i));
  expect(new Set(rows.map((r) => r.text))).toEqual(new Set(ALL_LINES));
  expect(rows.filter((r) => r.track === 'mic').every((r) => r.clusterKey === 'mic')).toBe(true);

  // Stop: the recorder finishes, the notes are written from both.
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  const notes = page.locator('[data-enhanced-notes]');
  await expect(notes).toBeVisible({ timeout: 45_000 });
  await expect(
    notes.locator('[data-source="typed"]').filter({ hasText: 'hiring plan by Friday' }),
  ).toBeVisible();
  await expect(notes.locator('[data-source-trigger]').first()).toBeVisible();
  await expect(page.locator('[data-meeting-workspace]')).toHaveAttribute('data-status', 'ready');

  // Shared with the team, the notes show on the portfolio company's page.
  await page.getByRole('tab', { name: 'Share' }).click();
  await page.getByLabel('Who can see it').selectOption('team');
  await expect(page.getByText('Saved.')).toBeVisible();
  await page.goto(`/portfolio/${LEDGERLY}`);
  const fromCopilot = page.locator('li').filter({ hasText: 'from Kraken' }).filter({
    hasText: title,
  });
  await expect(fromCopilot.first()).toBeVisible();
  await fromCopilot
    .first()
    .getByRole('link', { name: /Open the meeting/ })
    .click();
  await page.waitForURL(new RegExp(`/meetings/${meetingId}`));
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();

  // Her voice is on file, encrypted, for the next meeting.
  await page.goto('/meetings/settings?tab=voices');
  await expect(
    page
      .getByRole('region', { name: 'Someone else’s voice' })
      .getByRole('listitem')
      .filter({ hasText: 'Maya Chen' }),
  ).toContainText('enrolled');
});

test.describe('on a 390px phone', () => {
  test.use({ viewport: PHONE, hasTouch: true });

  test('in the room, one microphone: record, name a voice, stop', async ({ page }) => {
    test.setTimeout(150_000);
    await page.goto('/meetings/new');
    await page.getByLabel('What is the meeting?').fill('Coffee with Priya about the Acme pilot');
    await page.getByRole('button', { name: 'Open notes' }).click();
    await page.waitForURL(/\/meetings\/[0-9a-f-]{36}/);
    const meetingId = new URL(page.url()).pathname.split('/').pop() as string;

    await page.goto(`/meetings/${meetingId}?start=1&capture=live&mockSpeed=12`);
    const consent = consentDialog(page);
    await expect(consent).toBeVisible();
    await noSidewaysScroll(page);
    await consent.getByRole('radio', { name: /In the room/ }).check();
    await consent.getByRole('checkbox', { name: CONSENT_CHECKBOX_LABEL }).check();
    await consent.getByRole('button', { name: 'Start' }).click();
    await expect(consent).toHaveCount(0);

    // One diarized track: the microphone hears everyone.
    const controls = page.getByTestId('recorder-controls');
    await expect(controls).toHaveAttribute('data-status', 'recording');
    await expect(controls.getByTestId('engine-mixed')).toHaveAttribute('data-engine', 'open');
    await expect(controls.getByTestId('engine-system')).toHaveCount(0);

    const live = transcript(page);
    await expect(live).toBeVisible();
    const guest = live.getByRole('button', { name: /^Guest \d: who is this\?$/ }).first();
    await expect(guest).toBeVisible({ timeout: 45_000 });
    await guest.click();
    const sheet = page.getByRole('dialog', { name: 'This is…' });
    // A bottom sheet on a phone.
    const box = (await sheet.boundingBox())!;
    expect(Math.round(box.y + box.height)).toBeGreaterThanOrEqual(PHONE.height - 2);
    await sheet.getByLabel('Search your network, or type a name').fill('Priya Shah');
    await sheet.getByRole('button', { name: 'Use “Priya Shah”' }).click();
    await expect(sheet).toHaveCount(0);
    await expect(live.getByRole('button', { name: /^Priya Shah/ }).first()).toBeVisible();
    await noSidewaysScroll(page);

    await expect
      .poll(async () => (await stored(page, meetingId)).length, { timeout: 60_000 })
      .toBeGreaterThan(5);
    const rows = await stored(page, meetingId);
    expect(rows.every((r) => r.track === 'mixed')).toBe(true);

    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.locator('[data-enhanced-notes]')).toBeVisible({ timeout: 45_000 });
    await noSidewaysScroll(page);
  });
});
