import { expect, test, type Page } from '@playwright/test';

/**
 * Copilot Notes' core API (D-076) against the demo server, the way the
 * screens and the recorder will call it: make a meeting from an event, refuse
 * to start before consent, start, get a speech session (the mock in demo
 * mode), post lines, stop (the notes job with the offline model), rename a
 * voice, ask a question, and find the words said through the app's search.
 * Fictional people only; no vendor is ever called.
 */

async function enterDemo(page: Page) {
  await page.goto('/login');
  const enter = page.getByRole('button', { name: 'Enter demo workspace' });
  if (await enter.isVisible().catch(() => false)) await enter.click();
  await page.waitForURL(/\/today/);
}

const LINES: {
  track: 'mic' | 'system';
  label: string | null;
  text: string;
  start: number;
  end: number;
}[] = [
  {
    track: 'mic',
    label: null,
    text: 'Thanks for joining. Everyone knows this call is transcribed.',
    start: 0,
    end: 4000,
  },
  { track: 'system', label: 'S1', text: "I'm Dana, I run Acme Robotics.", start: 4500, end: 8000 },
  {
    track: 'mic',
    label: null,
    text: 'Dana, what does net revenue retention look like?',
    start: 8500,
    end: 12_000,
  },
  {
    track: 'system',
    label: 'S1',
    text: 'Net revenue retention is 130 percent across 19 customers.',
    start: 12_500,
    end: 18_000,
  },
  {
    track: 'system',
    label: 'S2',
    text: 'Sorry I am late, I can cover deployments.',
    start: 18_500,
    end: 22_000,
  },
  {
    track: 'mic',
    label: null,
    text: "Great. I'll send you an intro to our operations lead by Friday.",
    start: 22_500,
    end: 27_000,
  },
];

function segments() {
  return LINES.map((l, seq) => ({
    seq,
    track: l.track,
    clusterKey: l.track === 'mic' ? 'mic' : `sys:${l.label}`,
    vendorLabel: l.label,
    startMs: l.start,
    endMs: l.end,
    text: l.text,
    isFinal: true,
  }));
}

/**
 * Calls from inside the page, as the screens make them: the browser sends the
 * session cookie and the Origin header itself.
 */
function api(page: Page) {
  const send = (path: string, method: string, body?: unknown) =>
    page.evaluate(
      async ({ path, method, body }) => {
        const res = await fetch(path, {
          method,
          headers: { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
      },
      { path, method, body },
    );
  return {
    get: (path: string) => send(path, 'GET'),
    post: (path: string, data: unknown) => send(path, 'POST', data),
    patch: (path: string, data: unknown) => send(path, 'PATCH', data),
  };
}

test('a meeting from event to notes, through the API', async ({ page }) => {
  await enterDemo(page);
  const call = api(page);

  const access = await call.get('/api/notes/beta');
  expect(access.body).toMatchObject({ ok: true, enabled: true });

  const made = await call.post('/api/notes/meetings', {
    source: 'calendar',
    providerEventId: `e2e-acme-${Date.now()}`,
    title: 'Acme Robotics intro (e2e)',
    attendees: [{ email: 'dana@acmerobotics.example', name: 'Dana Reyes' }],
  });
  expect(made.status).toBe(200);
  const meetingId = (made.body.meeting as { id: string }).id;
  const base = `/api/notes/meetings/${meetingId}`;

  // No consent, no recording.
  const refused = await call.post(`${base}/start`, {
    consent: { confirmed: false, method: 'verbal' },
    captureSource: 'web',
  });
  expect(refused.status).toBe(400);
  const started = await call.post(`${base}/start`, {
    consent: { confirmed: true, method: 'verbal' },
    captureSource: 'web',
  });
  expect(started.status).toBe(200);

  const stt = (await call.post(`${base}/stt-token`, { tracks: ['mic', 'system'] })).body as {
    provider: string;
    sessions: { wsUrl: string | null }[];
  };
  expect(stt.provider).toBe('mock');
  expect(stt.sessions.every((s) => s.wsUrl === null)).toBe(true);

  type Speakers = { speakers: { clusterKey: string; displayName: string }[] };
  const uploaded = (await call.post(`${base}/segments`, { segments: segments() })).body as {
    accepted: number;
  } & Speakers;
  expect(uploaded.accepted).toBe(LINES.length);
  // One invited guest and two voices besides the mic: nobody is named by elimination yet.
  expect(uploaded.speakers.find((s) => s.clusterKey === 'mic')?.displayName).toBe('Nick Tippmann');
  expect(uploaded.speakers.find((s) => s.clusterKey === 'sys:S1')?.displayName).toBe('Guest 1');

  // Naming the late joiner by hand leaves one guest and one voice: Dana is named.
  const renamed = (
    await call.patch(`${base}/speakers/${encodeURIComponent('sys:S2')}`, {
      person: { name: 'Sam Lee' },
    })
  ).body as Speakers;
  expect(renamed.speakers.find((s) => s.clusterKey === 'sys:S1')?.displayName).toBe('Dana Reyes');

  const stopped = (await call.post(`${base}/stop`, { reason: 'user' })).body as {
    meeting: { status: string };
  };
  expect(stopped.meeting.status).toBe('ready');
  const detail = (await call.get(base)).body as {
    note: { model: string; actionItems: { isPrincipalPromise: boolean; ownerName: string }[] };
  };
  expect(detail.note.model).toBe('demo-offline-model');
  expect(detail.note.actionItems.find((a) => a.isPrincipalPromise)?.ownerName).toBe(
    'Nick Tippmann',
  );

  const chat = (
    await call.post(`${base}/chat`, {
      scope: 'meeting',
      question: 'What is the net revenue retention?',
    })
  ).body as { answer: string; citations: { label: string }[] };
  // The question and the answer both say the words; the answer is Dana's line.
  expect(chat.citations.map((c) => c.label)).toContainEqual(
    expect.stringMatching(/^\[\d+:\d{2} Dana Reyes\]$/),
  );
});

test('search finds words said in a team meeting and opens the transcript there', async ({
  page,
}) => {
  await enterDemo(page);
  const found = (await api(page).get('/api/search?q=retention')).body as {
    results: { href: string; sub: string | null }[];
  };
  const hit = found.results.find((r) => r.href.includes('tab=transcript'));
  expect(hit?.href).toMatch(/^\/meetings\/[0-9a-f-]{36}\?tab=transcript&t=\d+$/);
  expect(hit?.sub).toMatch(/^Transcript · /);
});

test('the event card lookup finds earlier notes with the same guests', async ({ page }) => {
  await enterDemo(page);
  const res = await api(page).get(
    `/api/notes/by-event?eventId=demo-notes-acme-follow-up&emails=${encodeURIComponent('dana@acmerobotics.example')}`,
  );
  const body = res.body as { meeting: { title: string } | null; pastNotes: { title: string }[] };
  expect(body.meeting?.title).toBe('Acme Robotics follow-up: full team');
  expect(body.pastNotes[0]?.title).toMatch(/^Acme Robotics intro/);
});
