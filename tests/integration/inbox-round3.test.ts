import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { DEMO_IDS } from '@/lib/demo/ids';
import { listLiveThreads, readLiveThread, resetInboxLiveCache } from '@/lib/services/inbox-live';

/**
 * Gmail parity, last round, in the demo mailbox: Show original and Download
 * message. Everything stays in the demo; nothing reaches Gmail.
 */

let harness: Harness;

vi.mock('@/lib/services/email-session-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/email-session-auth')>()),
  sessionAuth: async () => ({
    ok: true,
    auth: { ...harness.auth, isDemo: true },
    integration: null,
  }),
}));

const original = await import('@/app/api/inbox/original/route');

async function demoMessage() {
  const list = await listLiveThreads(harness.store, DEMO_IDS.org, { tab: 'primary' });
  const thread = await readLiveThread(harness.store, DEMO_IDS.org, list.rows[0]!.id);
  if (!thread.ok) throw new Error('no demo thread');
  return { thread: thread.value, message: thread.value.messages.at(-1)! };
}

beforeEach(async () => {
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
