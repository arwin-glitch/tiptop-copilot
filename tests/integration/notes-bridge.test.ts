import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '@/lib/auth/session';
import { resetEnvCache } from '@/lib/config/env';
import { NOTES_RESULT_MARKER } from '@/lib/notes/bridge-protocol';
import { resetDemoRelay } from '@/lib/notes/relay';
import { resetSettleThrottle } from '@/lib/services/ask-routine';
import { resetNotesSettleThrottle, settleNotesFromRelay } from '@/lib/services/notes-bridge';
import type { AuditEvent, ChatMessage, Task } from '@/lib/types/domain';
import type {
  CreateMeetingResponse,
  MeetingDetailResponse,
  NotesChatResponse,
  NotesRequest,
  SegmentUpload,
} from '@/lib/types/notes';
import { err, ok } from '@/lib/util/result';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * Copilot Notes through Arwin's Claude routine (D-076, zero spend), end to
 * end in the demo store with the routine played by a stubbed fetch: Stop
 * writes Quick notes and fires NOTES_REQUEST_V1; a NOTES_RESULT_V1 in the
 * simulated relay becomes the notes, with sources and tasks filed once;
 * Regenerate, a failing trigger, expiry, an error from the routine, a rename,
 * and the meeting chat through the Ask bridge. No paid API anywhere.
 * Fictional people only.
 */

let harness: Harness;
let caller: AuthContext | null = null;

vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  authOrError: async () => (caller ? ok(caller) : err('unauthenticated', 'Sign in.')),
}));

const meetingsRoute = await import('@/app/api/notes/meetings/route');
const meetingRoute = await import('@/app/api/notes/meetings/[id]/route');
const startRoute = await import('@/app/api/notes/meetings/[id]/start/route');
const stopRoute = await import('@/app/api/notes/meetings/[id]/stop/route');
const segmentsRoute = await import('@/app/api/notes/meetings/[id]/segments/route');
const generateRoute = await import('@/app/api/notes/meetings/[id]/generate/route');
const chatRoute = await import('@/app/api/notes/meetings/[id]/chat/route');
const speakerRoute = await import('@/app/api/notes/meetings/[id]/speakers/[clusterKey]/route');

const ORIGIN = 'http://localhost:3000';
const SAVED = { ...process.env };
const FIRE_URL = 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';

function req(path: string, method = 'GET', body?: unknown): NextRequest {
  return new NextRequest(`${ORIGIN}${path}`, {
    method,
    headers: { origin: ORIGIN, host: 'localhost:3000', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });
async function json<T = Record<string, unknown>>(response: Response): Promise<T & { ok: boolean }> {
  return (await response.json()) as T & { ok: boolean };
}

const LINES: [string, string, string][] = [
  ['mic', 'mic', 'Thanks for joining. Everyone knows this call is transcribed.'],
  ['system', 'sys:S1', "I'm Dana, I run Acme Robotics."],
  ['mic', 'mic', 'Dana, what does net revenue retention look like?'],
  ['system', 'sys:S1', 'Net revenue retention is 130 percent across 19 customers.'],
  ['system', 'sys:S1', 'We are raising four million on a SAFE and want to close by mid-November.'],
  ['system', 'sys:S2', 'Sorry I am late, I can cover deployments.'],
  ['mic', 'mic', "Great. I'll send you an intro to our operations lead by Friday."],
];

function uploads(): SegmentUpload[] {
  return LINES.map(([track, clusterKey, text], seq) => ({
    seq,
    track: track as SegmentUpload['track'],
    clusterKey,
    startMs: seq * 5_000,
    endMs: seq * 5_000 + 4_000,
    text,
    isFinal: true,
  }));
}

async function recordedAndStopped(typed?: string) {
  const made = await json<CreateMeetingResponse>(
    await meetingsRoute.POST(
      req('/api/notes/meetings', 'POST', {
        source: 'calendar',
        providerEventId: `evt-${Math.random().toString(36).slice(2)}`,
        title: 'Acme Robotics intro',
        attendees: [
          { email: 'dana@acmerobotics.example', name: 'Dana Reyes' },
          { email: 'nick@tiptop.demo', name: 'Nick Tippmann' },
        ],
      }),
    ),
  );
  const id = made.meeting.id;
  if (typed) {
    await meetingRoute.PATCH(
      req(`/api/notes/meetings/${id}`, 'PATCH', { userNotes: typed }),
      ctx({ id }),
    );
  }
  await startRoute.POST(
    req(`/api/notes/meetings/${id}/start`, 'POST', {
      consent: { confirmed: true, method: 'chat_notice' },
      captureSource: 'web',
    }),
    ctx({ id }),
  );
  await segmentsRoute.POST(
    req(`/api/notes/meetings/${id}/segments`, 'POST', { segments: uploads() }),
    ctx({ id }),
  );
  const stopped = await json<{ meeting: { status: string }; finalize: { queued: boolean } }>(
    await stopRoute.POST(
      req(`/api/notes/meetings/${id}/stop`, 'POST', { reason: 'user' }),
      ctx({ id }),
    ),
  );
  return { id, stopped };
}

async function detail(id: string, settle = false) {
  return json<MeetingDetailResponse>(
    await meetingRoute.GET(
      req(`/api/notes/meetings/${id}${settle ? '?settle=1' : ''}`),
      ctx({ id }),
    ),
  );
}

/** The routine's side: what fired, and a relay channel it "posts" to. */
interface Routine {
  fired: string[];
  relay: { text: string; ts: string }[];
  failFire: boolean;
  slackReads: number;
}
let routine: Routine;

function stubRoutine() {
  routine = { fired: [], relay: [], failFire: false, slackReads: 0 };
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (href === FIRE_URL) {
      if (routine.failFire) return { ok: false, status: 503 } as Response;
      routine.fired.push((JSON.parse(String(init?.body)) as { text: string }).text);
      return { ok: true, status: 200 } as Response;
    }
    if (href.startsWith('https://slack.com/api/conversations.history')) {
      routine.slackReads += 1;
      return {
        ok: true,
        json: async () => ({ ok: true, messages: [...routine.relay].reverse(), has_more: false }),
      } as unknown as Response;
    }
    throw new Error(`unexpected fetch ${href}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Post as the routine does: newest last, timestamps after the request. */
function post(text: string) {
  routine.relay.push({ text, ts: (Date.now() / 1000 + routine.relay.length).toFixed(6) });
}

const resultPart = (requestId: string, body: Record<string, unknown>) =>
  `${NOTES_RESULT_MARKER}\n\`${JSON.stringify({ request_id: requestId, ...body })}\``;

function lastRequest(): {
  request_id: string;
  attendees: { name: string; role: string }[];
  transcript: [number | null, string, string, string][];
  typed_notes: string;
  template: { name: string } | null;
} {
  const text = routine.fired[routine.fired.length - 1] ?? '';
  expect(text.startsWith('NOTES_REQUEST_V1\n`')).toBe(true);
  return JSON.parse(text.slice(text.indexOf('`') + 1, text.lastIndexOf('`')));
}

beforeEach(async () => {
  process.env.NOTES_ENABLED = 'on';
  // The routine's trigger and the relay are "set up"; demo mode is off so the
  // app really calls them (the stubbed fetch answers).
  process.env.DEMO_MODE = 'false';
  process.env.ASK_ROUTINE_FIRE_URL = FIRE_URL;
  process.env.ASK_ROUTINE_TOKEN = 'routine-token-for-tests';
  process.env.ASK_RELAY_SLACK_TOKEN = 'xoxb-test-read-only';
  resetEnvCache();
  resetNotesSettleThrottle();
  resetSettleThrottle();
  resetDemoRelay();
  harness = await createHarness({ now: new Date() });
  caller = harness.auth;
  stubRoutine();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  caller = null;
  await harness.dispose();
  for (const key of Object.keys(process.env)) if (!(key in SAVED)) delete process.env[key];
  Object.assign(process.env, SAVED);
  resetEnvCache();
});

afterAll(() => {
  Object.assign(process.env, SAVED);
  resetEnvCache();
});

/* ===================================================================== */

describe('Stop: Quick notes at once, and a request to Arwin', () => {
  it('fires NOTES_REQUEST_V1 with names and roles only, the lines with their ids, the typed notes', async () => {
    const { id, stopped } = await recordedAndStopped('## Our take\n- Retention is the story');
    expect(stopped).toMatchObject({ meeting: { status: 'ready' }, finalize: { queued: true } });

    const d = await detail(id);
    expect(d.note?.model).toBe('none');
    expect(d.note?.blocks.filter((b) => b.source === 'typed').map((b) => b.text)).toEqual([
      'Our take',
      'Retention is the story',
    ]);
    expect(d.note?.request).toMatchObject({ status: 'pending', reason: 'stop', fired: true });

    expect(routine.fired).toHaveLength(1);
    const payload = lastRequest();
    expect(payload.request_id).toBe(d.note?.request?.id);
    expect(payload.attendees).toContainEqual({ name: 'Dana Reyes', role: 'guest' });
    expect(payload.attendees.some((a) => a.role === 'principal')).toBe(true);
    expect(routine.fired[0]).not.toMatch(/@/);
    expect(payload.typed_notes).toContain('Retention is the story');
    // Dana's two lines in a row are one entry, cited by the first line's id.
    const dana = payload.transcript.find((r) => r[3].startsWith('Net revenue retention'));
    expect(dana?.[0]).toBe(3);
    expect(dana?.[3]).toContain('mid-November');

    // Nothing was billed: no AI usage row, and the only calls were the routine's trigger.
    const usage = await harness.store.list('ai_usage', harness.auth.organizationId);
    expect(usage.filter((u) => /meeting/.test(u.operation))).toHaveLength(0);
  });

  it('settles from the relay: notes with sources, typed lines first, tasks filed once', async () => {
    const { id } = await recordedAndStopped('## Our take\n- Retention is the story');
    const requestId = lastRequest().request_id;
    // Before the routine posts, a poll changes nothing.
    expect((await detail(id, true)).note?.request?.status).toBe('pending');

    post(
      resultPart(requestId, {
        part: 2,
        of: 2,
        notes: {
          action_items: [
            {
              text: 'Intro to the operations lead',
              owner_name: 'Nick Tippmann',
              due: 'by Friday',
              is_nick_promise: true,
              sources: [6],
            },
            {
              text: 'Send the data room',
              owner_name: 'Dana Reyes',
              due: '2026-12-01',
              sources: [3],
            },
          ],
        },
      }),
    );
    post(
      resultPart(requestId, {
        part: 1,
        of: 2,
        notes: {
          summary: 'A strong first meeting about a four million SAFE.',
          sections: [
            {
              heading: 'Traction',
              bullets: [
                {
                  text: 'Net revenue retention is 130 percent across 19 customers',
                  sources: [3, 999],
                },
              ],
            },
          ],
          decisions: [],
          open_questions: [{ text: 'Who leads the round?', sources: [3] }],
        },
      }),
    );
    resetNotesSettleThrottle();
    const d = await detail(id, true);
    expect(d.note?.model).toBe('arwin-routine');
    expect(d.note?.request).toMatchObject({ status: 'ready' });
    expect(d.note?.blocks.slice(0, 2).map((b) => b.source)).toEqual(['typed', 'typed']);
    const traction = d.note?.blocks.find((b) => b.text.startsWith('Net revenue retention'));
    // Id 3 stands for lines 3 and 4 (merged); 999 was never sent and is dropped.
    expect(traction?.sources).toEqual([{ fromSeq: 3, toSeq: 4 }]);
    const promise = d.note?.actionItems.find((a) => a.isPrincipalPromise);
    expect(promise).toMatchObject({ ownerName: 'Nick Tippmann', ownerClusterKey: 'mic' });
    expect(promise?.taskId).toBeTruthy();
    expect(d.note?.actionItems.every((a) => a.taskId)).toBe(true);

    const tasks = (await harness.store.list('tasks', harness.auth.organizationId)) as Task[];
    const filed = tasks.filter((t) => /operations lead|data room/.test(t.title));
    expect(filed.map((t) => t.title).sort()).toEqual([
      'Dana Reyes: Send the data room',
      'Intro to the operations lead',
    ]);
    expect(filed.find((t) => t.title === 'Intro to the operations lead')?.detail).toContain(
      'Your promise',
    );

    // Read again (another poll, the daily job): nothing is filed twice.
    resetNotesSettleThrottle();
    await detail(id, true);
    await settleNotesFromRelay(harness.store, harness.auth.organizationId, { force: true });
    const again = (await harness.store.list('tasks', harness.auth.organizationId)) as Task[];
    expect(again.filter((t) => /operations lead|data room/.test(t.title))).toHaveLength(2);
    const applied = (await harness.store.list('audit_events', harness.auth.organizationId, {
      eq: { action: 'notes.result_applied', entity_id: id },
    })) as AuditEvent[];
    expect(applied).toHaveLength(1);
  });

  it('keeps waiting while a part is missing', async () => {
    const { id } = await recordedAndStopped();
    const requestId = lastRequest().request_id;
    post(resultPart(requestId, { part: 2, of: 2, notes: { sections: [] } }));
    resetNotesSettleThrottle();
    const d = await detail(id, true);
    expect(d.note?.request?.status).toBe('pending');
    const stored = (await harness.store.get(
      'notes_requests',
      harness.auth.organizationId,
      requestId,
    )) as NotesRequest;
    expect(Object.keys((stored.parts as { got: object }).got)).toEqual(['2']);
  });
});

describe('Regenerate, failures and expiry', () => {
  async function landed(id: string, requestId: string, summary = 'First version.') {
    post(
      resultPart(requestId, {
        notes: {
          summary,
          sections: [
            { heading: 'Round', bullets: [{ text: 'Four million on a SAFE', sources: [3] }] },
          ],
        },
      }),
    );
    resetNotesSettleThrottle();
    return detail(id, true);
  }

  it('another template asks again; the notes stay until the new ones land; a late old answer is ignored', async () => {
    const { id } = await recordedAndStopped();
    const first = lastRequest().request_id;
    expect((await landed(id, first)).note?.model).toBe('arwin-routine');

    const regen = await json<{ note: MeetingDetailResponse['note'] }>(
      await generateRoute.POST(
        req(`/api/notes/meetings/${id}/generate`, 'POST', { templateId: 'builtin:founder_pitch' }),
        ctx({ id }),
      ),
    );
    expect(regen.note?.model).toBe('arwin-routine');
    expect(regen.note?.request).toMatchObject({ status: 'pending', reason: 'template' });
    expect(lastRequest().template?.name).toBe('Founder pitch');
    const second = lastRequest().request_id;
    expect(second).not.toBe(first);

    // A third request replaces the second; the second's answer, when it comes, is ignored.
    await generateRoute.POST(req(`/api/notes/meetings/${id}/generate`, 'POST', {}), ctx({ id }));
    const third = lastRequest().request_id;
    const old = (await harness.store.get(
      'notes_requests',
      harness.auth.organizationId,
      second,
    )) as NotesRequest;
    expect(old.status).toBe('expired');
    const afterOld = await landed(id, second, 'Stale version.');
    expect(afterOld.note?.blocks.some((b) => b.text === 'Stale version.')).toBe(false);
    const afterNew = await landed(id, third, 'Newest version.');
    expect(afterNew.note?.blocks.some((b) => b.text === 'Newest version.')).toBe(true);
  });

  it('a trigger that fails leaves it pending; a later poll fires it again after a back-off', async () => {
    routine.failFire = true;
    const { id } = await recordedAndStopped();
    let d = await detail(id);
    expect(d.note?.request).toMatchObject({ status: 'pending', fired: false });
    expect(routine.fired).toHaveLength(0);

    routine.failFire = false;
    const later = new Date(Date.now() + 2 * 60_000);
    await settleNotesFromRelay(harness.store, harness.auth.organizationId, {
      ctx: { store: harness.store, auth: harness.auth, now: later },
      now: later,
      force: true,
    });
    expect(routine.fired).toHaveLength(1);
    d = await detail(id);
    expect(d.note?.request?.fired).toBe(true);
  });

  it('expires a request no answer came back for, and keeps the Quick notes', async () => {
    const { id } = await recordedAndStopped();
    const tomorrow = new Date(Date.now() + 25 * 60 * 60_000);
    const outcome = await settleNotesFromRelay(harness.store, harness.auth.organizationId, {
      now: tomorrow,
      force: true,
    });
    expect(outcome.expired).toBe(1);
    const d = await detail(id);
    expect(d.note?.model).toBe('none');
    expect(d.note?.request).toMatchObject({
      status: 'expired',
      error: 'No notes came back within a day.',
    });
  });

  it('the routine saying it could not write them fails the request, in plain words', async () => {
    const { id } = await recordedAndStopped();
    post(resultPart(lastRequest().request_id, { error: 'The transcript was **empty**.' }));
    resetNotesSettleThrottle();
    const d = await detail(id, true);
    expect(d.note?.request?.status).toBe('failed');
    expect(d.note?.request?.error).toBe(
      'Arwin could not write these notes: The transcript was empty.',
    );
    expect(d.note?.model).toBe('none');
  });

  it('a rename puts the new name into Arwin’s notes in place, with no new request', async () => {
    const { id } = await recordedAndStopped();
    const requestId = lastRequest().request_id;
    post(
      resultPart(requestId, {
        notes: {
          sections: [
            { heading: 'Team', bullets: [{ text: 'Guest 2 covers deployments', sources: [5] }] },
          ],
        },
      }),
    );
    resetNotesSettleThrottle();
    const ready = await detail(id, true);
    const late = ready.speakers.find((s) => s.clusterKey === 'sys:S2');
    expect(late?.displayName).toBe('Guest 2');
    const fires = routine.fired.length;

    await speakerRoute.PATCH(
      req(`/api/notes/meetings/${id}/speakers/${encodeURIComponent('sys:S2')}`, 'PATCH', {
        person: { name: 'Sam Lee' },
      }),
      ctx({ id, clusterKey: encodeURIComponent('sys:S2') }),
    );
    const d = await detail(id);
    expect(d.note?.blocks.some((b) => b.text === 'Sam Lee covers deployments')).toBe(true);
    expect(d.note?.stale).toBe(false);
    expect(routine.fired.length).toBe(fires);
  });
});

describe('chat over meetings through the Ask bridge', () => {
  it('asks with the lines it is about, and the answer’s ids become "[0:15 …]" labels', async () => {
    process.env.ASK_BRIDGE_TOKEN = 'ask-bridge-token-for-tests-0000000000';
    resetEnvCache();
    const { id } = await recordedAndStopped();
    routine.fired = [];

    const asked = await json<NotesChatResponse>(
      await chatRoute.POST(
        req(`/api/notes/meetings/${id}/chat`, 'POST', {
          scope: 'meeting',
          question: 'What is the net revenue retention?',
        }),
        ctx({ id }),
      ),
    );
    expect(asked).toMatchObject({ ok: true, status: 'pending', answer: '' });
    expect(asked.messageId).toBeTruthy();
    expect(routine.fired).toHaveLength(1);
    const fired = routine.fired[0] as string;
    expect(fired.startsWith('ASK_QUESTION_V1\n`')).toBe(true);
    const body = JSON.parse(fired.slice(fired.indexOf('`') + 1, fired.lastIndexOf('`'))) as {
      message_id: string;
      context: {
        scope: string;
        excerpts: [string, string, string, string][];
        meeting_titles: string[];
      };
    };
    expect(body.message_id).toBe(asked.messageId);
    expect(body.context.scope).toBe('meeting');
    expect(body.context.meeting_titles[0]).toMatch(/^M1: Acme Robotics intro/);
    const hit = body.context.excerpts.find((e) => e[3].startsWith('Net revenue retention'));
    expect(hit?.[0]).toBe('M1.3');

    // Still on its way.
    const waiting = await json<NotesChatResponse>(
      await chatRoute.GET(
        req(`/api/notes/meetings/${id}/chat?messageId=${asked.messageId}`),
        ctx({ id }),
      ),
    );
    expect(waiting.status).toBe('pending');

    post(
      `ASK_ANSWER_V1\n\`${JSON.stringify({
        message_id: asked.messageId,
        answer: 'Net revenue retention is 130 percent [M1.3]. Unknown [M4.4].',
      })}\``,
    );
    resetSettleThrottle();
    const answer = await json<NotesChatResponse>(
      await chatRoute.GET(
        req(`/api/notes/meetings/${id}/chat?messageId=${asked.messageId}`),
        ctx({ id }),
      ),
    );
    expect(answer.status).toBe('answered');
    expect(answer.answer).toMatch(
      /^Net revenue retention is 130 percent \[0:15 [^\]]+\]\. Unknown\.$/,
    );
    expect(answer.citations).toHaveLength(1);
    expect(answer.citations[0]).toMatchObject({ meetingId: id, seq: 3, startMs: 15_000 });
    // Ask Arwin shows the same labels: the stored answer was rewritten.
    const stored = (await harness.store.get(
      'chat_messages',
      harness.auth.organizationId,
      asked.messageId as string,
    )) as ChatMessage;
    expect(stored.content).toBe(answer.answer);
  });

  it('without the bridge, the matching lines are quoted at once, and nothing is fired', async () => {
    const { id } = await recordedAndStopped();
    routine.fired = [];
    const answer = await json<NotesChatResponse>(
      await chatRoute.POST(
        req(`/api/notes/meetings/${id}/chat`, 'POST', {
          scope: 'meeting',
          question: 'What is the net revenue retention?',
        }),
        ctx({ id }),
      ),
    );
    expect(answer.status).toBe('answered');
    expect(answer.citations[0]?.label).toMatch(/^\[\d+:\d{2} [^\]]+\]$/);
    expect(routine.fired).toHaveLength(0);
  });

  it('only the asker reads a pending answer', async () => {
    process.env.ASK_BRIDGE_TOKEN = 'ask-bridge-token-for-tests-0000000000';
    resetEnvCache();
    const { id } = await recordedAndStopped();
    const asked = await json<NotesChatResponse>(
      await chatRoute.POST(
        req(`/api/notes/meetings/${id}/chat`, 'POST', { scope: 'meeting', question: 'retention' }),
        ctx({ id }),
      ),
    );
    const res = await chatRoute.GET(
      req(`/api/notes/meetings/${id}/chat?messageId=00000000-0000-4000-8000-0000000000ff`),
      ctx({ id }),
    );
    expect(res.status).toBe(404);
    expect(asked.status).toBe('pending');
  });
});
