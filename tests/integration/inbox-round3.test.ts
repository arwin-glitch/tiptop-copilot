import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { DEMO_IDS } from '@/lib/demo/ids';
import { listLiveThreads, readLiveThread, resetInboxLiveCache } from '@/lib/services/inbox-live';
import { SEND_SCOPES } from '@/lib/google/send-scopes';
import type { Integration, Task } from '@/lib/types/domain';
import { taskHref } from '@/lib/tasks/tasks-view';
import { ok } from '@/lib/util/result';

/**
 * Gmail parity, last round, in the demo mailbox: Show original and Download
 * message, Forward as attachment, Add to Tasks. Everything stays in the demo or on stubs;
 * nothing reaches Gmail.
 */

let harness: Harness;
let live = false;

const INTEGRATION = (): Integration => ({
  id: '33333333-3333-4333-8333-333333333333',
  organization_id: DEMO_IDS.org,
  user_id: DEMO_IDS.user,
  provider: 'google',
  kinds: ['gmail'],
  account_email: 'partner@firm.example',
  scopes: [...SEND_SCOPES],
  status: 'connected',
  status_detail: null,
  last_sync_at: null,
  last_sync_error: null,
  sync_cursor: null,
  watch_expires_at: null,
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
});

const sendComposed = vi.fn(async (..._args: unknown[]) =>
  ok({ messageId: '18c0a1b2c3d4e5f9', threadId: '18c0a1b2c3d4e5f9' }),
);
const readOriginal = vi.fn(async (..._args: unknown[]) =>
  ok({ bytes: Buffer.from('Subject: Hi\r\n\r\nBody'), fileName: 'Hi.eml', subject: 'Hi' }),
);

vi.mock('@/lib/config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/config/env')>();
  return { ...actual, isDemoMode: () => !live && actual.isDemoMode() };
});

vi.mock('@/lib/google/gmail-send', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/google/gmail-send')>()),
  sendComposed: (...args: unknown[]) => sendComposed(...args),
  readPrimarySignature: async () => '<b>Signature</b>',
}));

vi.mock('@/lib/services/inbox-original', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/inbox-original')>();
  return {
    ...actual,
    readOriginal: (...args: Parameters<typeof actual.readOriginal>) =>
      live ? readOriginal(...args) : actual.readOriginal(...args),
  };
});

vi.mock('@/lib/services/email-session-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/email-session-auth')>()),
  sessionAuth: async () => ({
    ok: true,
    auth: { ...harness.auth, isDemo: !live },
    integration: live ? INTEGRATION() : null,
  }),
}));

const original = await import('@/app/api/inbox/original/route');
const compose = await import('@/app/api/inbox/compose/route');
const taskRoute = await import('@/app/api/inbox/task/route');
const aiRoute = await import('@/app/api/inbox/ai/route');
const { DEMO_REPLIES } = await import('@/lib/services/inbox-ai');

async function demoMessage() {
  const list = await listLiveThreads(harness.store, DEMO_IDS.org, { tab: 'primary' });
  const thread = await readLiveThread(harness.store, DEMO_IDS.org, list.rows[0]!.id);
  if (!thread.ok) throw new Error('no demo thread');
  return { thread: thread.value, message: thread.value.messages.at(-1)! };
}

beforeEach(async () => {
  live = false;
  sendComposed.mockClear();
  readOriginal.mockClear();
  resetInboxLiveCache();
  harness = await createHarness();
});

afterEach(async () => {
  await harness.dispose();
});

describe('Show original and Download message', () => {
  it('shows the demo original as text, and downloads it as .eml', async () => {
    const { thread, message } = await demoMessage();
    const url = `http://localhost/api/inbox/original?thread=${thread.id}&id=${message.id}`;
    const shown = await (await original.GET(new NextRequest(url))).json();
    expect(shown.ok).toBe(true);
    expect(shown.source).toContain(`Subject: ${thread.subject}`);
    expect(shown.summary.map((r: { name: string }) => r.name)).toContain('Message ID');

    const file = await original.GET(new NextRequest(`${url}&download=1`));
    expect(file.headers.get('Content-Type')).toBe('message/rfc822');
    expect(file.headers.get('Content-Disposition')).toMatch(/^attachment; filename=".+\.eml"/);
    expect(await file.text()).toContain(`From: ${message.from}`);
  });

  it('refuses ids that are not Gmail ids, and messages not in the thread', async () => {
    const { thread } = await demoMessage();
    const bad = await original.GET(
      new NextRequest('http://localhost/api/inbox/original?thread=x&id=y'),
    );
    expect(bad.status).toBe(400);
    const missing = await original.GET(
      new NextRequest(
        `http://localhost/api/inbox/original?thread=${thread.id}&id=ffffffffffffffff`,
      ),
    );
    expect(missing.status).toBe(404);
  });
});

describe('Forward as attachment', () => {
  it('attaches the original as message/rfc822 on Send, with no body needed', async () => {
    live = true;
    const res = await compose.POST(
      new NextRequest('http://localhost/api/inbox/compose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: 'friend@example.com',
          subject: 'Fwd: Hi',
          html: '<div><br></div>',
          signature: 'nick',
          attachMessage: { threadId: '18c0a1b2c3d4e5f6', messageId: '18c0a1b2c3d4e5f7' },
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(readOriginal).toHaveBeenCalledTimes(1);
    const input = sendComposed.mock.calls[0]![2] as {
      attachments: { filename: string; mimeType: string; data: Buffer }[];
    };
    expect(input.attachments).toHaveLength(1);
    expect(input.attachments[0]!.mimeType).toBe('message/rfc822');
    expect(input.attachments[0]!.filename).toBe('Hi.eml');
  });

  it('demo: nothing is sent', async () => {
    const res = await compose.POST(
      new NextRequest('http://localhost/api/inbox/compose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: 'friend@example.com',
          subject: 'Fwd: Hi',
          html: '',
          signature: 'nick',
          attachMessage: { threadId: '18c0a1b2c3d4e5f6', messageId: '18c0a1b2c3d4e5f7' },
        }),
      }),
    );
    expect(res.status).toBe(409);
    expect(sendComposed).not.toHaveBeenCalled();
  });
});

describe('Add to Tasks', () => {
  it('makes a Kraken task titled by the subject, linked back to the conversation', async () => {
    const { thread } = await demoMessage();
    const res = await taskRoute.POST(
      new NextRequest('http://localhost/api/inbox/task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: thread.id }),
      }),
    );
    expect(res.status).toBe(200);
    const { taskId } = await res.json();
    const task = (await harness.store.get('tasks', DEMO_IDS.org, taskId)) as Task;
    expect(task.title).toBe(thread.subject);
    expect(task.status).toBe('open');
    expect(taskHref(task)).toBe(`/inbox?thread=${thread.id}`);
  });

  it('refuses a body with anything but the conversation id', async () => {
    const res = await taskRoute.POST(
      new NextRequest('http://localhost/api/inbox/task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: '18c0a1b2c3d4e5f6', title: 'x' }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe('Suggested replies (Kraken AI)', () => {
  it('demo: three canned chips, no model call, nothing sent', async () => {
    const { thread, message } = await demoMessage();
    const res = await aiRoute.POST(
      new NextRequest('http://localhost/api/inbox/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'replies', threadId: thread.id }),
      }),
    );
    expect(res.status).toBe(200);
    const { replies } = await res.json();
    expect(replies).toEqual(message.fromUs ? [] : DEMO_REPLIES);
    expect(sendComposed).not.toHaveBeenCalled();
    const usage = await harness.store.list('ai_usage', DEMO_IDS.org);
    expect(usage.filter((u) => u.operation === 'inbox.suggest_replies')).toHaveLength(0);
  });
});

describe('Translate message (Kraken AI)', () => {
  it('demo: a canned translation, on demand, no model call', async () => {
    const { thread, message } = await demoMessage();
    const res = await aiRoute.POST(
      new NextRequest('http://localhost/api/inbox/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'translate', threadId: thread.id, messageId: message.id }),
      }),
    );
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.language).toBe('Spanish');
    expect(out.text).toMatch(/^\[Demo translation\]/);
    const usage = await harness.store.list('ai_usage', DEMO_IDS.org);
    expect(usage.filter((u) => u.operation === 'inbox.translate')).toHaveLength(0);
  });

  it('refuses a message that is not in the conversation', async () => {
    const { thread } = await demoMessage();
    const res = await aiRoute.POST(
      new NextRequest('http://localhost/api/inbox/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'translate',
          threadId: thread.id,
          messageId: 'ffffffffffffffff',
        }),
      }),
    );
    expect(res.status).toBe(404);
  });
});
