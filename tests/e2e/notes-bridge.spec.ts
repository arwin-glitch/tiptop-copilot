import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Copilot Notes through Arwin's Claude routine (D-076, zero spend), in demo
 * mode: Stop → Quick notes at once and "Arwin is writing your notes" → the
 * routine's NOTES_RESULT_V1 lands in the relay → Arwin's notes with their
 * sources, the action items filed as tasks → a chat question goes through the
 * Ask bridge and its answer cites the transcript. The routine is played
 * through the demo relay (POST /api/notes/demo/relay, demo mode only): no
 * Slack, no model, no vendor. At 1440 and at 390 pixels. Fictional people
 * only.
 */

const SIGNED_IN = path.resolve('test-results', 'notes-bridge-state.json');

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

const LINES: [string, string, string][] = [
  ['mic', 'mic', 'Thanks for joining. Everyone knows this call is transcribed.'],
  ['system', 'sys:S1', "I'm Dana, I run Acme Robotics."],
  ['mic', 'mic', 'Dana, what does net revenue retention look like?'],
  ['system', 'sys:S1', 'Net revenue retention is 130 percent across 19 customers.'],
  ['system', 'sys:S1', 'We are raising four million on a SAFE and want to close by mid-November.'],
  ['mic', 'mic', "Great. I'll send you an intro to our operations lead by Friday."],
];

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
  };
}

/** A meeting recorded and stopped through the API, the way the recorder does it. */
async function recordedMeeting(page: Page, title: string): Promise<string> {
  const call = api(page);
  const made = await call.post('/api/notes/meetings', {
    source: 'adhoc',
    title,
    attendees: [{ email: 'dana@acmerobotics.example', name: 'Dana Reyes' }],
  });
  expect(made.status).toBe(200);
  const id = (made.body.meeting as { id: string }).id;
  const base = `/api/notes/meetings/${id}`;
  expect(
    (
      await call.post(`${base}/start`, {
        consent: { confirmed: true, method: 'verbal' },
        captureSource: 'web',
      })
    ).status,
  ).toBe(200);
  const uploaded = await call.post(`${base}/segments`, {
    segments: LINES.map(([track, clusterKey, text], seq) => ({
      seq,
      track,
      clusterKey,
      startMs: seq * 5_000,
      endMs: seq * 5_000 + 4_000,
      text,
      isFinal: true,
    })),
  });
  expect(uploaded.status).toBe(200);
  const stopped = await call.post(`${base}/stop`, { reason: 'user' });
  expect((stopped.body.meeting as { status: string }).status).toBe('ready');
  return id;
}

/** What the routine posts: one NOTES_RESULT_V1 citing the ids it was sent. */
function notesResult(requestId: string): string {
  return `NOTES_RESULT_V1\n\`${JSON.stringify({
    request_id: requestId,
    part: 1,
    of: 1,
    notes: {
      summary: 'A first meeting about a four million SAFE; retention is strong.',
      sections: [
        {
          heading: 'Traction',
          bullets: [
            { text: 'Net revenue retention is 130 percent across 19 customers', sources: [3] },
          ],
        },
      ],
      action_items: [
        {
          text: 'Send the pricing playbook from the operations lead',
          owner_name: 'Nick Tippmann',
          due: null,
          is_nick_promise: true,
          sources: [5],
        },
      ],
      open_questions: [{ text: 'Who leads the round?', sources: [3] }],
    },
  })}\``;
}

/**
 * Delete the tasks a meeting filed (their detail names the meeting), so the
 * specs after this one see the demo's own tasks only.
 */
async function deleteMeetingTasks(page: Page, meetingTitle: string) {
  await page.goto('/tasks');
  const rows = page
    .getByRole('tabpanel', { name: /^To do/ })
    .getByRole('listitem')
    .filter({ hasText: `From the meeting "${meetingTitle}"` });
  for (let left = await rows.count(); left > 0; left--) {
    await rows.first().getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).press('Enter');
    await expect(rows).toHaveCount(left - 1);
  }
}

async function noSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 2);
}

for (const viewport of [
  { label: 'desktop', width: 1440, height: 900 },
  { label: 'phone', width: 390, height: 844 },
]) {
  test(`Arwin writes the notes and answers a question, through the bridge (${viewport.width}px)`, async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/meetings?tab=notes');
    const call = api(page);
    const id = await recordedMeeting(page, `Acme bridge check (${viewport.label})`);

    try {
      // 1. Stop gave Quick notes at once, and Arwin is writing his.
      await page.goto(`/meetings/${id}`);
      const notes = page.locator('[data-enhanced-notes]');
      await expect(notes).toBeVisible();
      await expect(notes).toHaveAttribute('data-notes-kind', 'quick');
      await expect(notes).toContainText('Quick notes');
      const status = page.locator('[data-arwin-status="pending"]');
      await expect(status).toContainText('Arwin is writing your notes - usually 1-3 minutes');
      await expect(status).toContainText('Quick notes');
      // The transcript is usable meanwhile.
      await page.getByRole('tab', { name: /^Transcript/ }).click();
      await expect(page.locator('[data-seq]').filter({ hasText: '130 percent' })).toBeVisible();
      await page.getByRole('tab', { name: 'Notes' }).click();

      // 2. The routine posts its notes to the relay; the page's poll picks them up.
      const detail = await call.get(`/api/notes/meetings/${id}`);
      const requestId = (detail.body.note as { request: { id: string } }).request.id;
      expect(
        (await call.post('/api/notes/demo/relay', { text: notesResult(requestId) })).status,
      ).toBe(200);
      await expect(page.locator('[data-arwin-status]')).toHaveCount(0, { timeout: 30_000 });
      await expect(notes).toHaveAttribute('data-notes-kind', 'arwin');
      await expect(notes).toContainText('Written by Arwin');
      const point = notes
        .locator('[data-source="ai"]')
        .filter({ hasText: 'Net revenue retention is 130 percent across 19 customers' });
      await expect(point).toBeVisible();

      // 3. Its source opens the transcript lines behind it.
      await point.locator('[data-source-trigger]').click();
      const popover = page.locator('[data-source-popover]');
      await expect(popover).toContainText('From the transcript');
      await expect(popover).toContainText('across 19 customers');
      await page.keyboard.press('Escape');

      // 4. The action item was filed as a task, once, for the principal.
      const actions = page.locator('[data-action-items]');
      await expect(actions).toContainText('Send the pricing playbook from the operations lead');
      await expect(actions.getByRole('link', { name: 'In Tasks' }).first()).toBeVisible();
      await noSidewaysScroll(page);

      // 5. Chat through the Ask bridge: pending, then an answer citing the moment.
      await call.post('/api/notes/demo/relay', { bridge: true });
      await page.getByRole('tab', { name: 'Chat' }).click();
      const chat = page.locator('[data-chat]');
      await chat.getByLabel('Your question').fill('What is the net revenue retention?');
      const asked = page.waitForResponse(
        (r) =>
          r.url().endsWith(`/api/notes/meetings/${id}/chat`) && r.request().method() === 'POST',
      );
      await chat.getByRole('button', { name: 'Ask', exact: true }).click();
      const body = (await (await asked).json()) as { status: string; messageId: string };
      expect(body.status).toBe('pending');
      await expect(chat.locator('[data-chat-message="arwin"][data-pending]')).toContainText(
        'Arwin is looking through the meeting',
      );
      await call.post('/api/notes/demo/relay', {
        text: `ASK_ANSWER_V1\n\`${JSON.stringify({
          message_id: body.messageId,
          answer: 'Net revenue retention is 130 percent across 19 customers [M1.3].',
        })}\``,
      });
      const answer = chat.locator('[data-chat-message="arwin"]').last();
      const citation = answer.locator('[data-citation]').first();
      await expect(citation).toHaveText(/^\[0:15 [^\]]+\]$/, { timeout: 20_000 });
      await citation.click();
      await expect(page.getByRole('tab', { name: /^Transcript/ })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await noSidewaysScroll(page);
    } finally {
      await call.post('/api/notes/demo/relay', { bridge: false });
      await deleteMeetingTasks(page, `Acme bridge check (${viewport.label})`);
    }
  });
}
