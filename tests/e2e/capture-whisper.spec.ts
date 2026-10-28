import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * The on-device speech engine in a real Chromium (D-076): the real Web
 * Worker, the real voice-activity chunking, queue and speaker clustering,
 * with the fake model in place of Whisper (demo mode's ?engine=fake), so no
 * model downloads and nothing leaves the browser but lines of text.
 *
 * Chromium's fake microphone plays a made-up "speech" file: a tone that rises
 * and falls like syllables, three seconds on and two off, written here at run
 * time (never committed). The fake model numbers each stretch it hears and
 * alternates two made-up voices, so voices can be told apart end to end.
 */

function speechWav(): string {
  const rate = 48_000;
  const seconds = 60;
  const samples = rate * seconds;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const t = i / rate;
    const inSpeech = t % 5 < 3;
    const envelope = 0.1 + 0.9 * Math.abs(Math.sin(Math.PI * 4 * t));
    const v = inSpeech ? Math.sin(2 * Math.PI * 220 * t) * 9000 * envelope : 0;
    data.writeInt16LE(Math.round(v), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  const dir = path.join(tmpdir(), 'copilot-speech-e2e');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'speech-pattern.wav');
  writeFileSync(file, Buffer.concat([header, data]));
  return file;
}

const WAV = speechWav();

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--auto-select-desktop-capture-source=Entire screen',
      '--autoplay-policy=no-user-gesture-required',
      `--use-file-for-fake-audio-capture=${WAV}`,
    ],
  },
  permissions: ['microphone'],
});

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

async function peakLevel(page: Page, testId: string, ms = 3000): Promise<number> {
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

async function record(page: Page, mode: 'call' | 'mic_only'): Promise<string> {
  await page.goto('/sound-check?engine=fake&upload=500');
  if (mode === 'mic_only') await page.getByRole('button', { name: /Mic only/ }).click();
  await page.getByRole('button', { name: 'Prepare a demo meeting' }).click();
  const recorder = page.getByTestId('demo-recorder');
  await expect(recorder).toBeVisible();
  const meetingId = (await recorder.getAttribute('data-meeting-id')) as string;
  await page.getByLabel("I've told everyone / posted the notice").check();
  await page.getByRole('button', { name: 'Start recording' }).click();
  await expect(page.getByTestId('recorder-controls')).toHaveAttribute('data-status', 'recording');
  return meetingId;
}

test.beforeEach(async ({ page }) => {
  await enterDemo(page);
});

test('records a call on this computer: both meters move, lines arrive in order', async ({
  page,
}) => {
  const outside: string[] = [];
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) outside.push(r.url());
  });
  const meetingId = await record(page, 'call');
  await expect(page.getByTestId('recorder-provider')).toHaveText('On this computer');
  await expect(page.getByTestId('speech-status')).toHaveAttribute('data-phase', 'ready');
  await expect(page.getByTestId('speech-status')).toContainText('Audio never leaves this computer');
  expect(await peakLevel(page, 'meter-mic')).toBeGreaterThan(0);
  expect(await peakLevel(page, 'meter-system')).toBeGreaterThan(0);
  await expect(page.getByTestId('engine-mic')).toHaveAttribute('data-engine', 'open');

  await expect
    .poll(
      async () => (await segments(page, meetingId)).filter((r) => r.track === 'system').length,
      { timeout: 45_000 },
    )
    .toBeGreaterThanOrEqual(4);
  const rows = await segments(page, meetingId);
  // A rising seq (the mic's echoes keep their seq when the server drops them).
  const seqs = rows.map((r) => r.seq);
  expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  expect(new Set(seqs).size).toBe(seqs.length);
  const system = rows.filter((r) => r.track === 'system');
  expect(system.every((r) => /heard on this computer/.test(r.text))).toBe(true);
  // The meeting's voices told apart on this computer.
  expect(new Set(system.map((r) => r.clusterKey))).toEqual(new Set(['sys:A', 'sys:B']));
  // In the order they were said.
  const starts = system.map((r) => r.startMs);
  expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  // Chromium plays the same file into the mic and the shared screen, so the
  // mic hears the meeting: the server drops those lines as echo. Whatever is
  // kept from the mic is the recorder's.
  expect(rows.filter((r) => r.track === 'mic').every((r) => r.clusterKey === 'mic')).toBe(true);
  await expect(page.getByTestId('live-line').first()).toBeVisible();

  await page.getByRole('button', { name: 'Stop recording' }).click();
  await expect(page.getByTestId('recorder-controls')).toHaveAttribute('data-status', 'stopped', {
    timeout: 30_000,
  });
  // Text only, to Kraken only: no model download (the fake), no speech service.
  expect(outside).toEqual([]);
});

test('in the room: one track, the voices told apart and each named', async ({ page }) => {
  const meetingId = await record(page, 'mic_only');
  await expect(page.getByTestId('meter-mixed')).toBeVisible();
  await expect
    .poll(async () => new Set((await segments(page, meetingId)).map((r) => r.clusterKey)).size, {
      timeout: 45_000,
    })
    .toBeGreaterThanOrEqual(2);
  const rows = await segments(page, meetingId);
  expect(rows.every((r) => r.track === 'mixed')).toBe(true);
  expect(new Set(rows.map((r) => r.clusterKey))).toEqual(new Set(['mix:A', 'mix:B']));
  // The live view names each voice the way the server does: two voices, two names.
  const lines = page.getByTestId('live-line');
  await expect(lines.filter({ hasText: /Line/ }).nth(1)).toBeVisible();
  await expect
    .poll(async () => {
      const texts = await lines.allTextContents();
      return new Set(texts.map((t) => t.replace(/^\s*\d+:\d+\s*/, '').split(':')[0])).size;
    })
    .toBeGreaterThanOrEqual(2);
  await page.getByRole('button', { name: 'Stop recording' }).click();
  await expect(page.getByTestId('recorder-controls')).toHaveAttribute('data-status', 'stopped', {
    timeout: 30_000,
  });
});

test('Settings, Speech: three models with their download sizes; the choice stays in this browser', async ({
  page,
}) => {
  const hf: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('huggingface.co')) hf.push(r.url());
  });
  await page.goto('/meetings/settings?tab=speech');
  const settings = page.getByTestId('speech-settings');
  await expect(settings).toBeVisible();
  for (const choice of ['fast', 'better', 'best']) {
    await expect(page.getByTestId(`speech-model-${choice}`)).toBeVisible();
  }
  await expect(page.getByTestId('speech-model-fast')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('speech-model-fast')).toContainText(/\d+ MB once/);
  await expect(page.getByRole('button', { name: 'Test my setup' })).toBeVisible();
  await expect(page.getByTestId('speech-hardware')).not.toContainText('Checking');

  await page.getByTestId('speech-model-better').click();
  await expect(page.getByTestId('speech-model-better')).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(page.getByTestId('speech-model-better')).toHaveAttribute('aria-pressed', 'true');
  // Looking at the settings downloads nothing.
  expect(hf).toEqual([]);
});

test('Settings, Speech fits a phone screen', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/meetings/settings?tab=speech');
  await expect(page.getByTestId('speech-settings')).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});
