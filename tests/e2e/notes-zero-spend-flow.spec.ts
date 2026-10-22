import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { CONSENT_BANNER_TEXT, CONSENT_CHECKBOX_LABEL } from '../../src/lib/types/notes';

/**
 * Copilot Notes at zero spend (D-076), the whole chain in one go, at 1440 and
 * at 390 pixels, in demo mode:
 *
 *   Calendar → an event → "Take notes" → the consent step (the server refuses
 *   a start without it too) → the recorder (the scripted mock speech engine;
 *   the on-device Whisper sits behind the same interface) → live lines with
 *   names (the mic is the recorder; a guest voice is tapped and named, and the
 *   whole meeting relabels) → typed notes → Stop → Quick notes at once and
 *   "Arwin is writing your notes" → a template → Arwin's NOTES_RESULT_V1
 *   through the demo relay → his notes with sources in the template's
 *   sections → the action item is a Task → chat through the Ask bridge cites
 *   a line → a summary-only share link, revoked → the notes on the company
 *   and person pages and in search → the MCP meeting tools return them.
 *
 * The routine is played through POST /api/notes/demo/relay (demo mode only):
 * no Slack, no model, no speech vendor, no key. Fictional people only.
 */

const SIGNED_IN = path.resolve('test-results', 'notes-zero-spend-state.json');
const TZ = 'America/Chicago';
/** Girder AI, the deal the Girder event's guest works at (lib/demo/ids.ts dealGirder). */
const GIRDER_DEAL = '00000000-0000-4000-8000-000000000065';
/** Ledgerly, the portfolio company on the board-prep invite (lib/demo/ids.ts pcLedgerly). */
const LEDGERLY = '00000000-0000-4000-8000-0000000000c8';
/** Maya Chen's CRM profile (lib/demo/fixtures.ts demoCrm, record 31). */
const MAYA_RECORD = '00000000-0000-4000-8000-0000000006c3';

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

/** Calls from inside the page, as the screens make them (cookie and Origin included). */
function api(page: Page) {
  const send = (url: string, method: string, body?: unknown) =>
    page.evaluate(
      async ({ url, method, body }) => {
        const res = await fetch(url, {
          method,
          headers: { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
      },
      { url, method, body },
    );
  return {
    get: (url: string) => send(url, 'GET'),
    post: (url: string, data: unknown) => send(url, 'POST', data),
    del: (url: string) => send(url, 'DELETE'),
  };
}

/** Today's event card, opened from the calendar grid. */
async function openCard(page: Page, flow: Flow) {
  await page.goto(`/calendar?view=${flow.view}&date=${today()}`);
  const card = page.getByRole('dialog', { name: flow.event });
  // The grid draws its chips before it is interactive: click until the card opens.
  await expect(async () => {
    await page.locator('[data-event-chip]').filter({ hasText: flow.event }).first().click();
    await expect(card).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  return card.locator('[data-meeting-notes-slot]');
}

/** Stop (if needed) and move a meeting to the trash, so the event offers "Take notes" again. */
async function trashMeeting(page: Page, meetingId: string) {
  const call = api(page);
  const base = `/api/notes/meetings/${meetingId}`;
  await call.post(`${base}/stop`, { reason: 'user' }).catch(() => undefined);
  await call.del(base).catch(() => undefined);
}

async function noSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 2);
}

interface Flow {
  label: string;
  width: number;
  height: number;
  /** The calendar view that shows today's event chips at this width. */
  view: 'week' | 'day';
  event: string;
  /** Who the tapped guest voice turns out to be. */
  guestName: string;
  /** A voice the calendar invite names with no tap, if any. */
  calendarNamed: string | null;
  /** Where the shared notes must show up afterwards: [url, the tab to open, if any]. */
  pages: [string, string | null][];
  task: string;
}

const FLOWS: Flow[] = [
  {
    label: 'desktop',
    width: 1440,
    height: 900,
    view: 'week',
    event: 'Girder AI — reference call debrief',
    guestName: 'Priya Shah',
    calendarNamed: null,
    pages: [[`/deals/${GIRDER_DEAL}`, 'Sources']],
    task: 'Send Acme the hardware pricing notes (desktop run)',
  },
  {
    label: 'phone',
    width: 390,
    height: 844,
    view: 'day',
    event: 'Ledgerly board prep',
    guestName: 'Priya Shah',
    // The invite's one guest, named from the calendar while one guest voice speaks.
    calendarNamed: 'Maya Chen',
    pages: [
      [`/portfolio/${LEDGERLY}`, null],
      [`/lists/records/${MAYA_RECORD}`, null],
    ],
    task: 'Send Acme the hardware pricing notes (phone run)',
  },
];

for (const flow of FLOWS) {
  test(`Copilot Notes at zero spend, calendar to MCP (${flow.width}px)`, async ({
    page,
    browser,
  }, testInfo) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: flow.width, height: flow.height });
    const call = api(page);

    // 1. Calendar → the event → Take notes. (Another spec may have taken
    // notes on this event already: its meeting goes to the trash first.)
    let slot = await openCard(page, flow);
    const earlier = slot.getByRole('link', { name: 'Open notes' });
    if (await earlier.count()) {
      const href = (await earlier.first().getAttribute('href')) ?? '';
      await trashMeeting(page, href.split('/').pop()?.split('?')[0] ?? '');
      slot = await openCard(page, flow);
    }
    await slot.getByRole('button', { name: 'Take notes' }).click();
    await page.waitForURL(/\/meetings\/[0-9a-f-]{36}\?start=1/);
    const meetingId = new URL(page.url()).pathname.split('/').pop() as string;
    const base = `/api/notes/meetings/${meetingId}`;

    try {
      // 2. Consent: the server refuses a start without it, and Start stays off until the box is ticked.
      const refused = await call.post(`${base}/start`, { captureSource: 'web' });
      expect(refused.status).toBeGreaterThanOrEqual(400);
      // A faster scripted call, so the whole chain fits one test.
      await page.goto(`/meetings/${meetingId}?start=1&mockSpeed=14`);
      const consent = page.getByRole('dialog', { name: CONSENT_BANNER_TEXT });
      await expect(consent).toBeVisible();
      const start = consent.getByRole('button', { name: 'Start' });
      await expect(start).toBeDisabled();
      await consent.getByRole('checkbox', { name: CONSENT_CHECKBOX_LABEL }).check();
      await start.click();
      await expect(consent).toHaveCount(0);
      await expect(page.locator('[data-recording-pill="recording"]')).toBeVisible();
      await expect(page.getByRole('heading', { level: 1, name: flow.event })).toBeVisible();

      // 3. Live lines with names: the mic is the recorder from the first word.
      const live = page.getByRole('log', { name: 'Live transcript' });
      await expect(live).toBeVisible();
      await expect(live).toContainText("I'm Dana, I run Acme Robotics");
      const mic = live.locator('[data-speaker="mic"]').first();
      await expect(mic).toBeVisible();
      await expect(mic).not.toContainText('Guest');
      if (flow.calendarNamed) {
        await expect(
          live.getByRole('button', { name: `${flow.calendarNamed}: change who this is` }).first(),
        ).toBeVisible();
      }

      // 4. Tap an unnamed guest voice and name it: every line of that voice relabels.
      const guest = live.getByRole('button', { name: /^Guest \d: who is this\?$/ }).first();
      await expect(guest).toBeVisible({ timeout: 30_000 });
      const guestLabel = (await guest.getAttribute('aria-label')) ?? '';
      await guest.click();
      const sheet = page.getByRole('dialog', { name: 'This is…' });
      await expect(sheet).toBeVisible();
      await sheet.getByLabel('Search your network, or type a name').fill(flow.guestName);
      await sheet.getByRole('button', { name: `Use “${flow.guestName}”` }).click();
      await expect(sheet).toHaveCount(0);
      await expect(page.getByText(/Updated \d+ lines?/)).toBeVisible();
      await expect(live.getByRole('button', { name: guestLabel })).toHaveCount(0);
      await expect(
        live.getByRole('button', { name: new RegExp(`^${flow.guestName}`) }).first(),
      ).toBeVisible();

      // 5. Typed notes (on a phone, the notepad is its own pane).
      if (flow.width < 768)
        await page.getByRole('button', { name: 'Notepad', exact: true }).click();
      const notepad = page.getByRole('combobox', { name: 'Your notes' });
      await notepad.click();
      await notepad.pressSequentially('## Our take\n- Retention is the story', { delay: 5 });
      await expect(page.getByText('Saved', { exact: true })).toBeVisible();
      if (flow.width < 768) {
        await page.getByRole('button', { name: 'Transcript', exact: true }).click();
      }
      // Let the call reach the promises (a stored line, not the half-heard preview).
      await expect(
        live.locator('[data-seq]').filter({ hasText: "I'll send you an intro" }),
      ).toBeVisible({ timeout: 60_000 });

      // 6. Stop: Quick notes at once, and Arwin is writing his.
      await page.getByRole('button', { name: 'Stop', exact: true }).click();
      const notes = page.locator('[data-enhanced-notes]');
      await expect(notes).toBeVisible({ timeout: 30_000 });
      await expect(notes).toHaveAttribute('data-notes-kind', 'quick');
      await expect(
        notes.locator('[data-source="typed"]').filter({ hasText: 'Retention is the story' }),
      ).toBeVisible();
      await expect(page.locator('[data-arwin-status="pending"]')).toContainText(
        'Arwin is writing your notes - usually 1-3 minutes',
      );

      // 7. A template: Arwin is asked to write them in its sections.
      await notes.getByLabel('Template').selectOption({ label: 'Founder pitch' });
      await expect(
        page.getByText('Arwin is rewriting the notes with Founder pitch.'),
      ).toBeVisible();
      await expect(notes.getByLabel('Template')).toHaveValue('builtin:founder_pitch');

      // 8. Arwin's routine answers through the relay (here, the demo relay), citing line ids.
      const lines = (await call.get(`${base}/segments?limit=200`)).body.segments as {
        seq: number;
        text: string;
      }[];
      const seqOf = (words: string) => {
        const found = lines.find((l) => l.text.includes(words));
        expect(found, words).toBeTruthy();
        return found!.seq;
      };
      const retention = seqOf('130 percent');
      const round = seqOf('Four million on a SAFE');
      const promise = seqOf("I'll send you an intro");
      const detail = await call.get(base);
      const request = (detail.body.note as { request: { id: string; status: string } }).request;
      expect(request.status).toBe('pending');
      const summary = `Acme Robotics is raising four million on a SAFE (${flow.label} run).`;
      const result = {
        request_id: request.id,
        part: 1,
        of: 1,
        notes: {
          summary,
          sections: [
            {
              heading: 'Traction',
              bullets: [
                {
                  text: 'Net revenue retention is 130 percent across 19 customers',
                  sources: [retention],
                },
              ],
            },
            {
              heading: 'Round',
              bullets: [{ text: 'Four million on a SAFE at a 22 million cap', sources: [round] }],
            },
          ],
          action_items: [
            {
              text: flow.task,
              owner_name: 'Nick Tippmann',
              due: null,
              is_nick_promise: true,
              sources: [promise],
            },
          ],
          open_questions: [{ text: 'Who leads the round?', sources: [round] }],
        },
      };
      expect(
        (
          await call.post('/api/notes/demo/relay', {
            text: `NOTES_RESULT_V1\n\`${JSON.stringify(result)}\``,
          })
        ).status,
      ).toBe(200);

      // 9. His notes replace the Quick notes: the template's sections, a source behind each point.
      await expect(page.locator('[data-arwin-status]')).toHaveCount(0, { timeout: 30_000 });
      await expect(notes).toHaveAttribute('data-notes-kind', 'arwin');
      await expect(notes).toContainText('Written by Arwin');
      await expect(notes).toContainText(summary);
      await expect(notes.getByRole('heading', { name: 'Traction' })).toBeVisible();
      await expect(notes.getByRole('heading', { name: 'Round' })).toBeVisible();
      // The typed line stays word for word.
      await expect(
        notes.locator('[data-source="typed"]').filter({ hasText: 'Retention is the story' }),
      ).toBeVisible();
      const point = notes
        .locator('[data-source="ai"]')
        .filter({ hasText: 'Net revenue retention is 130 percent' });
      await point.locator('[data-source-trigger]').click();
      const popover = page.locator('[data-source-popover]');
      await expect(popover).toContainText('From the transcript');
      await expect(popover).toContainText('130 percent');
      await page.keyboard.press('Escape');

      // 10. The action item is a Task, the principal's promise marked.
      const actions = page.locator('[data-action-items]');
      await expect(actions).toContainText(flow.task);
      await expect(actions.getByText('Your promise').first()).toBeVisible();
      await expect(actions.getByRole('link', { name: 'In Tasks' }).first()).toBeVisible();
      await noSidewaysScroll(page);
      await page.screenshot({ path: `test-results/notes-zero-spend-${flow.label}-notes.png` });

      try {
        // 11. Chat through the Ask bridge: pending, then an answer citing the line.
        await call.post('/api/notes/demo/relay', { bridge: true });
        await page.getByRole('tab', { name: 'Chat' }).click();
        const chat = page.locator('[data-chat]');
        await chat.getByLabel('Your question').fill('What is the net revenue retention?');
        const asked = page.waitForResponse(
          (r) => r.url().endsWith(`${base}/chat`) && r.request().method() === 'POST',
        );
        await chat.getByRole('button', { name: 'Ask', exact: true }).click();
        const body = (await (await asked).json()) as { status: string; messageId: string };
        expect(body.status).toBe('pending');
        await expect(chat.locator('[data-chat-message="arwin"][data-pending]')).toBeVisible();
        await call.post('/api/notes/demo/relay', {
          text: `ASK_ANSWER_V1\n\`${JSON.stringify({
            message_id: body.messageId,
            answer: `Net revenue retention is 130 percent [M1.${retention}].`,
          })}\``,
        });
        const citation = chat
          .locator('[data-chat-message="arwin"]')
          .last()
          .locator('[data-citation]')
          .first();
        await expect(citation).toHaveText(/^\[\d+:\d\d [^\]]+\]$/, { timeout: 20_000 });
        await citation.click();
        await expect(page.getByRole('tab', { name: /^Transcript/ })).toHaveAttribute(
          'aria-selected',
          'true',
        );
      } finally {
        await call.post('/api/notes/demo/relay', { bridge: false });
      }

      // 12. A share link: the summary only, then revoked.
      await page.getByRole('tab', { name: 'Share' }).click();
      await page.getByRole('button', { name: 'Create share link' }).click();
      const share = page.getByRole('dialog', { name: 'Share these notes' });
      await expect(share.getByLabel('Include transcript')).not.toBeChecked();
      await share.getByRole('button', { name: 'Create link' }).click();
      const sharedPath = new URL(await share.locator('[data-share-url]').inputValue()).pathname;
      expect(sharedPath).toMatch(/^\/n\/[A-Za-z0-9_-]{32}$/);
      await share.getByRole('button', { name: 'Done' }).click();
      const outsider = await browser.newContext({
        baseURL: testInfo.project.use.baseURL,
        storageState: { cookies: [], origins: [] },
        viewport: { width: flow.width, height: flow.height },
      });
      const reader = await outsider.newPage();
      expect((await reader.goto(sharedPath))?.status()).toBe(200);
      await expect(reader.getByRole('heading', { name: 'Summary' })).toBeVisible();
      await expect(reader.locator('body')).toContainText(summary);
      await expect(reader.getByRole('heading', { name: 'Transcript' })).toHaveCount(0);
      expect(await reader.locator('body').innerText()).not.toMatch(/@[a-z0-9-]+\.[a-z]/i);
      await page
        .locator('[data-share-link="active"]')
        .first()
        .getByRole('button', { name: 'Revoke' })
        .click();
      await expect(page.locator('[data-share-link="revoked"]').first()).toBeVisible();
      expect((await reader.goto(sharedPath))?.status()).toBe(404);
      await outsider.close();

      // 13. Shared with the team, the notes reach the company and person pages.
      await page.getByLabel('Who can see it').selectOption('team');
      await expect(page.getByText('Saved.')).toBeVisible();
      for (const [url, tab] of flow.pages) {
        await page.goto(url);
        if (tab) await page.getByRole('tab', { name: tab }).click();
        const listed = page
          .locator('li')
          .filter({ hasText: 'from Copilot' })
          .filter({ hasText: flow.event })
          .first();
        await expect(listed, url).toBeVisible();
        await expect(listed.getByRole('link', { name: /Open the meeting/ })).toHaveAttribute(
          'href',
          `/meetings/${meetingId}`,
        );
        await noSidewaysScroll(page);
        await listed.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: `test-results/notes-zero-spend-${flow.label}-${url.split('/')[1]}.png`,
        });
      }

      // The task is on the Tasks page.
      await page.goto('/tasks');
      await expect(
        page
          .getByRole('tabpanel', { name: /^To do/ })
          .getByRole('listitem')
          .filter({
            hasText: flow.task,
          }),
      ).toBeVisible();

      // 14. Search finds the words said and opens the meeting at that moment.
      await page.goto('/meetings?tab=notes&source=copilot');
      await page.getByRole('searchbox', { name: 'Search meetings' }).fill('22 million cap');
      await page.waitForURL(/q=22/);
      const hit = page.locator('[data-search-hit]').filter({ hasText: flow.event }).first();
      await expect(hit).toBeVisible();
      await noSidewaysScroll(page);

      // 15. The routines read it through the MCP meeting tools, shaped like Granola's.
      await page.goto('/settings?tab=integrations');
      await page.getByLabel('Connection name').fill(`notes zero spend ${flow.label} ${Date.now()}`);
      await page.getByRole('button', { name: 'Create token' }).click();
      const fresh = page.getByRole('region', { name: 'New token' });
      const token = await fresh.getByLabel('Token', { exact: true }).inputValue();
      const mcp = async (name: string, args: Record<string, unknown>) => {
        const res = await page.request.post('/api/mcp', {
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
        });
        expect(res.status()).toBe(200);
        const json = (await res.json()) as { result: { content: { text: string }[] } };
        return json.result.content.map((c) => c.text).join('\n');
      };
      const listed = await mcp('list_meetings', {});
      expect(listed).toContain(`copilot:${meetingId}`);
      const got = await mcp('get_meetings', { meeting_ids: [`copilot:${meetingId}`] });
      expect(got).toContain(summary);
      expect(got).toContain(flow.task);
      const said = await mcp('get_meeting_transcript', { meeting_id: `copilot:${meetingId}` });
      expect(said).toContain('Net revenue retention is 130 percent');
      expect(said).toContain(flow.guestName);
      await fresh.getByRole('button', { name: 'Done, I have copied it' }).click();
    } finally {
      // Leave the demo as it was for the specs after this one: the meeting
      // to the trash (the event offers "Take notes" again) and the task gone.
      await trashMeeting(page, meetingId);
      await page.goto('/tasks');
      const rows = page
        .getByRole('tabpanel', { name: /^To do/ })
        .getByRole('listitem')
        .filter({ hasText: flow.task });
      for (let left = await rows.count(); left > 0; left--) {
        await rows.first().getByRole('button', { name: 'More actions' }).click();
        await page.getByRole('menuitem', { name: 'Delete' }).press('Enter');
        await expect(rows).toHaveCount(left - 1);
      }
    }
  });
}

/** The scheduled demo meeting (lib/demo/notes-fixtures.ts). */
const FOLLOW_UP = '00000000-0000-4000-8000-0000000d000b';

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`the Notes tour: five pictures, speech on this computer and Arwin writing (${viewport.width}px)`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto(`/meetings/${FOLLOW_UP}`);
    const banner = page.locator('[data-notes-tour-banner]');
    await expect(banner).toContainText('Five pictures show how it works.');
    await banner.getByRole('button', { name: 'Show me' }).click();
    const titles = [
      'Before you start',
      'Heard on this computer',
      'Fix a name',
      'Arwin writes the notes',
      'Share',
    ];
    for (const [i, title] of titles.entries()) {
      const step = page.getByRole('dialog', { name: `${i + 1} of 5: ${title}` });
      await expect(step).toBeVisible();
      await noSidewaysScroll(page);
      await step.getByRole('button', { name: i < titles.length - 1 ? 'Next' : 'Got it' }).click();
    }
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // Seen once, the banner becomes a quiet "How it works".
    await expect(banner).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'How it works' })).toBeVisible();
  });
}
