import { expect, test, type Page } from '@playwright/test';
import { MOCK_CALL_LINES } from '../../src/lib/transcribe/mock-script';

/**
 * The web recorder in a real Chromium (D-076, WS3), against the demo speech
 * engine. Chromium's fake devices stand in for the microphone and the
 * shared screen (a beeping tone on each), so the whole path runs: consent
 * step, both tracks through the AudioWorklet at 16 kHz, the demo engine
 * hearing them, finished lines posted with a rising seq, going offline,
 * pause, and the silence auto-stop. The demo call plays 8x faster than real
 * time. The on-device Whisper engine has its own spec (capture-whisper.spec.ts).
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

const ALL_LINES = MOCK_CALL_LINES.map((l) => l.text);

interface StoredSegment {
  seq: number;
  track: string;
  clusterKey: string;
  startMs: number;
  text: string;
}

async function enterDemo(page: Page) {
  await page.goto('/login');
  const enter = page.getByRole('button', { name: 'Enter demo workspace' });
  if (await enter.isVisible().catch(() => false)) await enter.click();
  await page.waitForURL(/\/today/);
}

async function prepare(page: Page, query = '', mode: 'call' | 'mic_only' = 'call') {
  await page.goto(`/sound-check?speed=8&upload=500${query}`);
  if (mode === 'mic_only') await page.getByRole('button', { name: /Mic only/ }).click();
  await page.getByRole('button', { name: 'Prepare a demo meeting' }).click();
  const recorder = page.getByTestId('demo-recorder');
  await expect(recorder).toBeVisible();
  const meetingId = await recorder.getAttribute('data-meeting-id');
  expect(meetingId).toBeTruthy();
  return meetingId as string;
}

async function startRecording(page: Page) {
  const start = page.getByRole('button', { name: 'Start recording' });
  // The consent step gates Start.
  await expect(start).toBeDisabled();
  await page.getByLabel("I've told everyone / posted the notice").check();
  await expect(start).toBeEnabled();
  await start.click();
  await expect(page.getByTestId('recorder-controls')).toHaveAttribute('data-status', 'recording');
}

/**
 * A GET from inside the page. The session cookie is Secure (production build),
 * which the browser sends to 127.0.0.1 but Playwright's own request client does not.
 */
async function getJson<T>(page: Page, url: string): Promise<T> {
  const result = await page.evaluate(async (u) => {
    const response = await fetch(u, { cache: 'no-store' });
    return { status: response.status, body: await response.text() };
  }, url);
  expect(result.status, result.body).toBe(200);
  return JSON.parse(result.body) as T;
}

async function segments(page: Page, meetingId: string): Promise<StoredSegment[]> {
  const body = await getJson<{ segments: StoredSegment[] }>(
    page,
    `/api/notes/meetings/${meetingId}/segments?after=-1&limit=1000`,
  );
  return body.segments;
}

async function meetingOf(page: Page, meetingId: string) {
  const body = await getJson<{ meeting: { status: string; recordedMs: number } }>(
    page,
    `/api/notes/meetings/${meetingId}`,
  );
  return body.meeting;
}

/** The highest level a meter showed over a short watch (the fake devices beep about once a second). */
async function peakLevel(page: Page, testId: string, ms = 2500): Promise<number> {
  return page.evaluate(
    async ({ id, duration }) => {
      let peak = 0;
      const until = Date.now() + duration;
      while (Date.now() < until) {
        const el = document.querySelector(`[data-testid="${id}"]`);
        peak = Math.max(peak, Number(el?.getAttribute('data-level') ?? 0));
        await new Promise((r) => setTimeout(r, 40));
      }
      return peak;
    },
    { id: testId, duration: ms },
  );
}

function expectContiguous(rows: StoredSegment[]) {
  const seqs = rows.map((r) => r.seq);
  expect(seqs).toEqual(seqs.map((_, i) => i));
}

test.beforeEach(async ({ page }) => {
  await enterDemo(page);
});

test('records a call: consent first, both meters move, lines upload in order', async ({ page }) => {
  const meetingId = await prepare(page);
  await startRecording(page);
  await expect(page.getByTestId('recording-pill')).toContainText('Recording');
  await expect(page.getByTestId('recorder-provider')).toHaveText('Demo speech');

  expect(await peakLevel(page, 'meter-mic')).toBeGreaterThan(0);
  expect(await peakLevel(page, 'meter-system')).toBeGreaterThan(0);
  await expect(page.getByTestId('engine-mic')).toHaveAttribute('data-engine', 'open');
  await expect(page.getByTestId('engine-system')).toHaveAttribute('data-engine', 'open');

  // The whole call: 134 s at 8x, about 17 s.
  await expect
    .poll(async () => (await segments(page, meetingId)).length, { timeout: 45_000 })
    .toBe(ALL_LINES.length);
  const rows = await segments(page, meetingId);
  expectContiguous(rows);
  expect(new Set(rows.map((r) => r.text))).toEqual(new Set(ALL_LINES));
  expect(rows.filter((r) => r.track === 'mic').every((r) => r.clusterKey === 'mic')).toBe(true);
  expect(rows.some((r) => r.clusterKey === 'sys:S1')).toBe(true);
  // The live view shows names from the server's speakers once lines are saved.
  await expect(page.getByTestId('live-line').first()).toBeVisible();

  await page.getByRole('button', { name: 'Stop recording' }).click();
  await expect(page.getByTestId('recorder-controls')).toHaveAttribute('data-status', 'stopped');
  const meeting = await meetingOf(page, meetingId);
  expect(['processing', 'ready']).toContain(meeting.status);
  expect(meeting.recordedMs).toBeGreaterThan(10_000);
});

test('going offline keeps transcribing here; lines save when the network is back', async ({
  page,
  context,
}) => {
  let setupRequests = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/speech-setup')) setupRequests += 1;
  });
  const meetingId = await prepare(page);
  await startRecording(page);
  await expect.poll(async () => (await segments(page, meetingId)).length).toBeGreaterThan(2);
  expect(setupRequests).toBe(1);

  await context.setOffline(true);
  await expect(page.getByTestId('warning-offline')).toBeVisible();
  // Speech runs on this computer: the engines stay open while offline.
  await page.waitForTimeout(2500); // 20 s of the call while offline
  await expect(page.getByTestId('engine-mic')).toHaveAttribute('data-engine', 'open');
  await expect(page.getByTestId('engine-system')).toHaveAttribute('data-engine', 'open');
  await context.setOffline(false);
  await expect(page.getByTestId('warning-offline')).toBeHidden();
  // Nothing to ask the server again: the settings were kept.
  expect(setupRequests).toBe(1);

  await expect
    .poll(async () => (await segments(page, meetingId)).length, { timeout: 45_000 })
    .toBe(ALL_LINES.length);
  const rows = await segments(page, meetingId);
  expectContiguous(rows);
  const texts = rows.map((r) => r.text);
  expect(new Set(texts).size).toBe(texts.length);
  expect(new Set(texts)).toEqual(new Set(ALL_LINES));
  await expect(page.getByTestId('warning-audio_gap')).toHaveCount(0);
  await page.getByRole('button', { name: 'Stop recording' }).click();
  await expect(page.getByTestId('recorder-controls')).toHaveAttribute('data-status', 'stopped');
});

test('pause finishes the engines and hears nothing; resume carries on', async ({ page }) => {
  let pauses = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/pause')) pauses += 1;
  });
  const meetingId = await prepare(page);
  await startRecording(page);
  await expect.poll(async () => (await segments(page, meetingId)).length).toBeGreaterThan(1);

  await page.getByRole('button', { name: 'Pause recording' }).click();
  const controls = page.getByTestId('recorder-controls');
  await expect(controls).toHaveAttribute('data-status', 'paused');
  await expect(page.getByTestId('engine-mic')).toHaveAttribute('data-engine', 'closed');
  await expect(page.getByTestId('engine-system')).toHaveAttribute('data-engine', 'closed');
  await expect.poll(() => pauses).toBe(1);
  await page.waitForTimeout(1000); // let the last lines land
  const atPause = (await segments(page, meetingId)).length;
  const timeAtPause = await page.getByTestId('recording-time').textContent();
  await page.waitForTimeout(2500);
  expect((await segments(page, meetingId)).length).toBe(atPause);
  await expect(page.getByTestId('recording-time')).toHaveText(timeAtPause ?? '');

  await page.getByRole('button', { name: 'Resume recording' }).click();
  await expect(controls).toHaveAttribute('data-status', 'recording');
  await expect(page.getByTestId('engine-mic')).toHaveAttribute('data-engine', 'open');
  await expect
    .poll(async () => (await segments(page, meetingId)).length, { timeout: 20_000 })
    .toBeGreaterThan(atPause);
  expectContiguous(await segments(page, meetingId));
  await page.getByRole('button', { name: 'Stop recording' }).click();
  await expect(controls).toHaveAttribute('data-status', 'stopped');
});

test('silence stops the recording by itself', async ({ page }) => {
  // Everything counts as silence (the fake tone sits far below 1.0); stop after 3 s of it.
  const meetingId = await prepare(page, '&threshold=1&silence=3000');
  await startRecording(page);
  await expect(page.getByTestId('recorder-controls')).toHaveAttribute('data-status', 'stopped', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('demo-stopped')).toHaveAttribute('data-reason', 'silence');
  const meeting = await meetingOf(page, meetingId);
  expect(['processing', 'ready']).toContain(meeting.status);
});

test('warns when no meeting audio is heard', async ({ page }) => {
  await prepare(page, '&threshold=1&nomeeting=1500');
  await startRecording(page);
  await expect(page.getByTestId('warning-no_meeting_audio')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('warning-no_meeting_audio')).toContainText(
    'No meeting audio detected',
  );
  await page.getByRole('button', { name: 'Stop recording' }).click();
  await expect(page.getByTestId('recorder-controls')).toHaveAttribute('data-status', 'stopped');
});

test('mic-only mode records one diarized track', async ({ page }) => {
  let setupBody = '';
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/speech-setup')) setupBody = r.postData() ?? '';
  });
  const meetingId = await prepare(page, '', 'mic_only');
  await startRecording(page);
  await expect(page.getByTestId('meter-mixed')).toBeVisible();
  await expect(page.getByTestId('meter-system')).toHaveCount(0);
  expect(JSON.parse(setupBody)).toEqual({ tracks: ['mixed'] });
  await expect.poll(async () => (await segments(page, meetingId)).length).toBeGreaterThan(3);
  const rows = await segments(page, meetingId);
  expect(rows.every((r) => r.track === 'mixed' && r.clusterKey.startsWith('mix:'))).toBe(true);
  await page.getByRole('button', { name: 'Stop recording' }).click();
  await expect(page.getByTestId('recorder-controls')).toHaveAttribute('data-status', 'stopped');
});

test('the sound check hears the mic and the meeting, and sends nothing', async ({ page }) => {
  const api: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/notes/')) api.push(r.url());
  });
  await page.goto('/sound-check');
  await page.getByRole('button', { name: 'Test your microphone' }).click();
  await expect(page.getByTestId('sound-check-mic').getByText('Heard it')).toBeVisible({
    timeout: 10_000,
  });
  await page.getByRole('button', { name: 'Test meeting audio' }).click();
  await expect(page.getByTestId('sound-check-meeting').getByText('Heard it')).toBeVisible({
    timeout: 10_000,
  });
  expect(api).toEqual([]);
});

test('the sound check fits a phone screen', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/sound-check');
  await expect(page.getByTestId('sound-check')).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});
