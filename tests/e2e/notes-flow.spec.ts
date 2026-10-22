import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  CONSENT_BANNER_TEXT,
  CONSENT_CHECKBOX_LABEL,
  NEVER_RECORD_MESSAGE,
} from '../../src/lib/types/notes';

/**
 * Copilot Notes (D-076), the whole demo flow as the principal meets it, in demo mode
 * against the mock transcriber (a scripted, fictional call: Dana Reyes and
 * Priya Shah of Acme Robotics, and a late joiner nobody names). Nothing here
 * reaches a speech vendor, a model, Google or Slack.
 *
 *  1. Calendar → an event → "Take notes".
 *  2. The consent step blocks Start until its box is ticked.
 *  3. The live transcript fills in, the mic line under the recorder's name.
 *  4. "Guest 2 · Who is this?" → Priya Shah: every line of that voice relabels.
 *  5. Typed notes, then Stop.
 *  6. Enhanced notes: typed lines highlighted, a source popover opens.
 *  7. The Founder pitch template is applied.
 *  8. A share link opens in another browser, is revoked, then 404s.
 *  9. Search finds a transcript phrase and jumps to its moment.
 * Then the same on a 390px phone, with the guests on the invite, and axe.
 */

const SIGNED_IN = path.resolve('test-results', 'notes-flow-state.json');
const TZ = 'America/Chicago';
/** The scheduled demo meeting (lib/demo/notes-fixtures.ts): Dana and Priya are on its invite. */
const FOLLOW_UP = '00000000-0000-4000-8000-0000000d000b';
const PHONE = { width: 390, height: 844 };
/** Girder AI, the deal the event's guest works at (lib/demo/ids.ts dealGirder). */
const GIRDER_DEAL = '00000000-0000-4000-8000-000000000065';

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

const consentDialog = (page: Page) => page.getByRole('dialog', { name: CONSENT_BANNER_TEXT });
const transcript = (page: Page) => page.getByRole('log', { name: 'Live transcript' });

/** axe-core (eslint's jsx-a11y already brings it), run on part of the page. */
async function axe(page: Page, selector: string) {
  await page.addScriptTag({ path: path.resolve('node_modules/axe-core/axe.min.js') });
  const violations = await page.evaluate(async (include) => {
    // @ts-expect-error axe is added to the page above.
    const result = await window.axe.run(
      { include: [include] },
      { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } },
    );
    return (result.violations as { id: string; nodes: { target: string[] }[] }[]).map(
      (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
    );
  }, selector);
  expect(violations, `axe on ${selector}`).toEqual([]);
}

async function noSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 2);
}

test('Copilot Notes, from the calendar to a revoked share link', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(180_000);

  // 1. Calendar → a fictional event → Take notes.
  await page.goto(`/calendar?view=week&date=${today()}`);
  const title = 'Girder AI — reference call debrief';
  const card = page.getByRole('dialog', { name: title });
  // The week view draws its chips before it is interactive: click until the card opens.
  await expect(async () => {
    await page.locator('[data-event-chip]').filter({ hasText: title }).first().click();
    await expect(card).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  const slot = card.locator('[data-meeting-notes-slot]');
  await expect(slot.getByRole('button', { name: 'Take notes' })).toBeVisible();
  await slot.getByRole('button', { name: 'Take notes' }).click();
  await page.waitForURL(/\/meetings\/[0-9a-f-]{36}\?start=1/);
  const meetingId = new URL(page.url()).pathname.split('/').pop() as string;

  // 2. The consent step: Start stays off until the box is ticked.
  const consent = consentDialog(page);
  await expect(consent).toBeVisible();
  await expect(consent.getByText(/I'm using TipTop Copilot to transcribe/)).toBeVisible();
  const start = consent.getByRole('button', { name: 'Start' });
  await expect(start).toBeDisabled();
  await consent.getByRole('checkbox', { name: CONSENT_CHECKBOX_LABEL }).check();
  await expect(start).toBeEnabled();
  await start.click();
  await expect(consent).toHaveCount(0);
  // The meeting carries the event's title and guest.
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  await expect(page.locator('[data-recording-pill="recording"]')).toBeVisible();
  await expect(page.locator('[data-consent-status="confirmed"]')).toContainText('notice posted');

  // 3. The live transcript fills in: the mic under the recorder's name, the rest as guests.
  const live = transcript(page);
  await expect(live).toContainText("I'm Dana, I run Acme Robotics");
  // The mic is the person recording: named (by the demo profile) from the first word.
  const mic = live.locator('[data-speaker="mic"]').first();
  await expect(mic).toBeVisible();
  await expect(mic).not.toContainText('Guest');
  await expect(live.getByRole('button', { name: 'Guest 2: who is this?' }).first()).toBeVisible();

  // 4. Name Guest 2: every line of that voice says Priya Shah.
  await live.getByRole('button', { name: 'Guest 2: who is this?' }).first().click();
  const sheet = page.getByRole('dialog', { name: 'This is…' });
  await expect(sheet).toBeVisible();
  // The invite's guests come first (here, the Girder guest), then search or a typed name.
  await expect(sheet.getByRole('region', { name: 'On the invite' })).toContainText('Tom Whitfield');
  await sheet.getByLabel('Search your network, or type a name').fill('Priya Shah');
  await sheet.getByRole('button', { name: 'Use “Priya Shah”' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByText(/Updated \d+ lines?/)).toBeVisible();
  await expect(live.getByRole('button', { name: 'Guest 2: who is this?' })).toHaveCount(0);
  await expect(live.getByRole('button', { name: /^Priya Shah/ }).first()).toBeVisible();
  // Later lines from that voice arrive already named.
  await expect(live).toContainText('Average deployment is down to eleven days');
  await expect(live.getByRole('button', { name: 'Guest 2: who is this?' })).toHaveCount(0);

  // 5. Typed notes, then Stop.
  const notepad = page.getByRole('combobox', { name: 'Your notes' });
  await notepad.click();
  await notepad.pressSequentially('## Our take\n- Retention is the story', { delay: 5 });
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await expect(live).toContainText('Net revenue retention is 130 percent');
  // Let the call reach the promises, so there are action items to file.
  // (A stored line, not the half-heard preview.)
  await expect(
    live.locator('[data-seq]').filter({ hasText: "I'll send you an intro" }),
  ).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Stop', exact: true }).click();

  // 6. Enhanced notes: the typed line in full ink with a gold rule, sources behind the rest.
  const notes = page.locator('[data-enhanced-notes]');
  await expect(notes).toBeVisible({ timeout: 30_000 });
  const typed = notes
    .locator('[data-source="typed"]')
    .filter({ hasText: 'Retention is the story' });
  await expect(typed).toBeVisible();
  await expect(typed).not.toHaveCSS('border-left-color', 'rgba(0, 0, 0, 0)');
  await expect(notes.locator('[data-source="ai"]').first()).toBeVisible();
  await notes.locator('[data-source-trigger]').first().click();
  const popover = page.locator('[data-source-popover]');
  await expect(popover).toContainText('From the transcript');
  await page.keyboard.press('Escape');
  const actions = page.locator('[data-action-items]');
  await expect(actions).toContainText("I'll send you an intro");
  await expect(actions.getByText('Your promise').first()).toBeVisible();
  await actions.getByRole('button', { name: 'Add to Tasks' }).first().click();
  await expect(page.getByText('Added to Tasks.')).toBeVisible();
  await expect(actions.getByRole('link', { name: 'In Tasks' }).first()).toBeVisible();

  // 7. The Founder pitch template.
  await notes.getByLabel('Template').selectOption({ label: 'Founder pitch' });
  await expect(page.getByText('Notes rewritten with Founder pitch.')).toBeVisible();
  await expect(notes.getByLabel('Template')).toHaveValue('builtin:founder_pitch');

  await axe(page, '[data-meeting-workspace]');

  // 8. Share: a link opens in another browser, is revoked, then shows nothing.
  await page.getByRole('tab', { name: 'Share' }).click();
  await page.getByRole('button', { name: 'Create share link' }).click();
  const share = page.getByRole('dialog', { name: 'Share these notes' });
  await expect(share.getByLabel('Include transcript')).not.toBeChecked();
  await share.getByRole('button', { name: 'Create link' }).click();
  const url = await share.locator('[data-share-url]').inputValue();
  const sharedPath = new URL(url).pathname;
  expect(sharedPath).toMatch(/^\/n\/[A-Za-z0-9_-]{32}$/);
  await share.getByRole('button', { name: 'Done' }).click();

  const outsider = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    storageState: { cookies: [], origins: [] },
  });
  const reader = await outsider.newPage();
  const opened = await reader.goto(sharedPath);
  expect(opened?.status()).toBe(200);
  expect(opened?.headers()['x-robots-tag']).toContain('noindex');
  await expect(reader.getByRole('heading', { level: 1, name: title })).toBeVisible();
  await expect(reader.getByRole('heading', { name: 'Summary' })).toBeVisible();
  // Summary only: no transcript, and no address anywhere on the page.
  await expect(reader.getByRole('heading', { name: 'Transcript' })).toHaveCount(0);
  expect(await reader.locator('body').innerText()).not.toMatch(/@[a-z0-9-]+\.[a-z]/i);

  const row = page.locator('[data-share-link="active"]').first();
  await row.getByRole('button', { name: 'Revoke' }).click();
  await expect(page.locator('[data-share-link="revoked"]').first()).toBeVisible();
  const after = await reader.goto(sharedPath);
  expect(after?.status()).toBe(404);
  await outsider.close();

  // Chat: Ask Arwin about this meeting; the answer's citation opens that line.
  await page.getByRole('tab', { name: 'Chat' }).click();
  const chat = page.locator('[data-chat]');
  await expect(chat.getByRole('radio', { name: 'This meeting' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await chat.getByLabel('Your question').fill('retention');
  await chat.getByRole('button', { name: 'Ask', exact: true }).click();
  const answer = chat.locator('[data-chat-message="arwin"]').last();
  await expect(answer.locator('[data-citation]').first()).toBeVisible();
  await answer.locator('[data-citation]').first().click();
  await expect(page.getByRole('tab', { name: /^Transcript/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );

  // 9. Search finds a phrase from the transcript and opens the meeting at that moment.
  await page.goto('/meetings?tab=notes&source=all');
  await page.getByRole('searchbox', { name: 'Search meetings' }).fill('eleven days');
  await page.waitForURL(/q=eleven/);
  const hit = page.locator('[data-search-hit="transcript"]').first();
  await expect(hit).toContainText('Average deployment is down to eleven days');
  await hit.click();
  await page.waitForURL(/tab=transcript&t=\d+/);
  const moment = page.locator('[data-seq]').filter({ hasText: 'eleven days' }).first();
  await expect(moment).toBeVisible();
  await expect(moment.locator('p').first()).toHaveClass(/ring-2/);

  // 10. Shared with the team, the meeting reaches the pages the team reads.
  // (The search above may open the earlier Acme meeting: the same words were said there.)
  await page.goto(`/meetings/${meetingId}?tab=share`);
  await page.getByLabel('Who can see it').selectOption('team');
  await expect(page.getByText('Saved.')).toBeVisible();

  // The deal page (the guest's domain) lists it from Copilot, and it opens the meeting.
  await page.goto(`/deals/${GIRDER_DEAL}`);
  await page.getByRole('tab', { name: 'Sources' }).click();
  const onDeal = page
    .locator('li')
    .filter({ hasText: 'from Copilot' })
    .filter({ hasText: title })
    .first();
  await expect(onDeal).toBeVisible();
  await expect(onDeal.getByRole('link', { name: /Open the meeting/ })).toHaveAttribute(
    'href',
    `/meetings/${meetingId}`,
  );

  // Ctrl+K finds words said in it and opens the transcript at that moment.
  await page.keyboard.press('Control+k');
  await page.getByRole('searchbox', { name: 'Search everything' }).fill('eleven days');
  const said = page
    .getByRole('listbox', { name: 'Results' })
    .getByRole('option', { name: /eleven days/ })
    .filter({ hasText: title })
    .first();
  await expect(said).toBeVisible();
  await said.getByRole('button').first().click();
  await page.waitForURL(new RegExp(`/meetings/${meetingId}\\?.*t=\\d+`));
  await expect(page.locator('[data-seq]').filter({ hasText: 'eleven days' }).first()).toBeVisible();

  // 11. The routines read it through Copilot's MCP meeting tools (shaped like Granola's).
  await page.goto('/settings');
  await page.getByRole('tab', { name: 'Integrations' }).click();
  await page.getByLabel('Connection name').fill(`notes e2e ${Date.now()}`);
  await page.getByRole('button', { name: 'Create token' }).click();
  const fresh = page.getByRole('region', { name: 'New token' });
  const token = await fresh.getByLabel('Token', { exact: true }).inputValue();
  const mcp = async (name: string, args: Record<string, unknown>) => {
    const res = await page.request.post('/api/mcp', {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { result: { content: { text: string }[] } };
    return body.result.content.map((c) => c.text).join('\n');
  };
  const listed = await mcp('list_meetings', {});
  expect(listed).toContain(`copilot:${meetingId}`);
  expect(listed).toContain(title);
  const lines = await mcp('get_meeting_transcript', { meeting_id: `copilot:${meetingId}` });
  expect(lines).toContain('Average deployment is down to eleven days');
  expect(lines).toContain('Priya Shah');
  const found = await mcp('query_meetings', { query: 'net revenue retention' });
  expect(found).toContain(title);
  await fresh.getByRole('button', { name: 'Done, I have copied it' }).click();
});

test('a never-record meeting cannot start', async ({ page }) => {
  await page.goto('/meetings/new');
  await page.getByLabel('What is the meeting?').fill('Call with counsel about the side letter');
  await expect(page.locator('main').getByRole('alert')).toContainText(NEVER_RECORD_MESSAGE);
  await page.getByRole('button', { name: 'Open notes' }).click();
  await page.waitForURL(/\/meetings\/[0-9a-f-]{36}/);
  const consent = consentDialog(page);
  await expect(consent).toBeVisible();
  await expect(consent.getByText(NEVER_RECORD_MESSAGE)).toBeVisible();
  await expect(consent.getByRole('button', { name: 'Start' })).toHaveCount(0);
});

test.describe('on a 390px phone', () => {
  test.use({ viewport: PHONE, hasTouch: true });

  test('record, name a voice from the invite, stop: nothing scrolls sideways', async ({ page }) => {
    test.setTimeout(150_000);
    await page.goto(`/meetings/${FOLLOW_UP}?start=1&mockSpeed=12`);
    const consent = consentDialog(page);
    await expect(consent).toBeVisible();
    await noSidewaysScroll(page);
    await consent.getByRole('checkbox', { name: CONSENT_CHECKBOX_LABEL }).check();
    await consent.getByRole('button', { name: 'Start' }).click();
    await expect(page.locator('[data-recording-pill="recording"]')).toBeVisible();

    // One pane at a time: the transcript first.
    const live = transcript(page);
    await expect(live).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Your notes' })).toBeHidden();
    // Dana and Priya are on the invite, and as many voices as guests are
    // talking with the cues agreeing ("Priya leads engineering"): the naming
    // ladder names them both with no tap.
    await expect(
      live.getByRole('button', { name: /^Priya Shah: change who this is$/ }).first(),
    ).toBeVisible();
    await expect(
      live.getByRole('button', { name: /^Dana Reyes: change who this is$/ }).first(),
    ).toBeVisible();
    // The late joiner is on nobody's invite: "Who is this?", the invite's guests marked as taken.
    const guest = live.getByRole('button', { name: /^Guest \d: who is this\?$/ }).first();
    await expect(guest).toBeVisible({ timeout: 45_000 });
    const guestLabel = (await guest.getAttribute('aria-label')) ?? '';
    await guest.click();
    const sheet = page.getByRole('dialog', { name: 'This is…' });
    // A bottom sheet on a phone, the invite's guests first.
    const box = (await sheet.boundingBox())!;
    expect(Math.round(box.y + box.height)).toBeGreaterThanOrEqual(PHONE.height - 2);
    await expect(sheet.getByRole('region', { name: 'On the invite' })).toContainText('Priya Shah');
    await sheet.getByLabel('Search your network, or type a name').fill('Sam Okafor');
    await sheet.getByRole('button', { name: 'Use “Sam Okafor”' }).click();
    await expect(sheet).toHaveCount(0);
    await expect(live.getByRole('button', { name: guestLabel })).toHaveCount(0);
    await expect(live.getByRole('button', { name: /^Sam Okafor/ }).first()).toBeVisible();
    await noSidewaysScroll(page);

    await page.getByRole('button', { name: 'Notepad', exact: true }).click();
    const notepad = page.getByRole('combobox', { name: 'Your notes' });
    await expect(notepad).toBeVisible();
    await notepad.click();
    await notepad.pressSequentially('- Ask for the deployment case study', { delay: 5 });
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.locator('[data-enhanced-notes]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-enhanced-notes] [data-source="typed"]').first()).toContainText(
      'Ask for the deployment case study',
    );
    await noSidewaysScroll(page);
    await axe(page, '[data-meeting-workspace]');
  });

  test('the notes list and the settings fit the screen and pass axe', async ({ page }) => {
    for (const path of [
      '/meetings?tab=notes&source=all',
      '/meetings?tab=notes&source=copilot&q=retention',
      '/meetings/new',
      '/meetings/settings',
      '/meetings/settings?tab=rules',
      '/meetings/settings?tab=voices',
      `/meetings/${FOLLOW_UP}?tab=people`,
    ]) {
      await page.goto(path);
      await expect(page.locator('h1')).toHaveCount(1);
      await noSidewaysScroll(page);
    }
    for (const path of [
      '/meetings?tab=notes&source=all',
      '/meetings/settings',
      '/meetings/settings?tab=rules',
      '/meetings/settings?tab=voices',
    ]) {
      await page.goto(path);
      await axe(page, 'main');
    }
  });
});
