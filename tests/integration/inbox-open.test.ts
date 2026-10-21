import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { DEMO_IDS } from '@/lib/demo/ids';
import {
  gmailHrefForLink,
  listLiveThreads,
  openFromLink,
  openLiveThread,
} from '@/lib/services/inbox-live';
import { err, ok } from '@/lib/util/result';

/**
 * The Inbox's deep link over the demo store: `/inbox?thread=<id>` opens a
 * thread from the demo mailbox, or one of the emails behind the demo's
 * Follow-ups, Jobs and Students (by thread or message id), and anything else
 * says it couldn't. All names and addresses are fictional.
 */

let harness: Harness;
let signedIn = true;
vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  authOrError: async () => (signedIn ? ok(harness.auth) : err('unauthenticated', 'Sign in.')),
}));

const { GET } = await import('@/app/api/inbox/thread/route');

beforeEach(async () => {
  signedIn = true;
  harness = await createHarness();
});

afterEach(async () => {
  await harness.dispose();
});

describe('opening a demo conversation from a link', () => {
  it("opens a thread from the demo mailbox's own list", async () => {
    const { store, auth } = harness;
    const list = await listLiveThreads(store, auth.organizationId, { tab: 'primary' });
    const row = list.rows[0]!;
    const res = await openLiveThread(store, auth.organizationId, row.id);
    expect(res.ok && res.value.subject).toBe(row.subject);
  });

  it('opens the emails behind Follow-ups, Jobs and Students, by thread or message id', async () => {
    const { store, auth } = harness;
    const org = auth.organizationId;
    const followUp = await openLiveThread(store, org, '0f0000000000c101');
    expect(followUp.ok).toBe(true);

    const job = await openLiveThread(store, org, '0f0000000000b201');
    expect(job.ok && job.value.subject).toBe("We're hiring a founding engineer - know anyone?");

    // Rafael's thread, asked for by Nick's reply (a message id); archived, not in the inbox.
    const byMessage = await openFromLink(store, org, '0f00000000005302');
    expect(byMessage.error).toBeUndefined();
    expect(byMessage.row).toMatchObject({ id: '0f00000000005301', inInbox: false });
    expect(byMessage.thread?.messages.map((m) => m.fromName)).toEqual([
      'Rafael Ortiz',
      'Nick Tippmann',
    ]);
  });

  it("says it couldn't open a malformed or unknown id, never throwing", async () => {
    const { store, auth } = harness;
    expect(await openFromLink(store, auth.organizationId, 'not-an-email')).toEqual({
      requested: 'not-an-email',
      error: "That link doesn't point at an email.",
    });
    const unknown = await openFromLink(store, auth.organizationId, '0f00000000009999');
    expect(unknown.error).toMatch(/^That email isn't in the mailbox/);
  });

  it("opens a synced email by Copilot's own id, as Today, a deal's sources and citations hold", async () => {
    const { store, auth } = harness;
    const org = auth.organizationId;
    // The demo Inbox's id for a thread: the last 16 hex digits of its UUID.
    const demoThreadId = DEMO_IDS.threadVetrix.replace(/-/g, '').slice(-16);

    const byMessage = await openFromLink(store, org, DEMO_IDS.msgVetrixIntro);
    expect(byMessage.error).toBeUndefined();
    expect(byMessage.requested).toBe(DEMO_IDS.msgVetrixIntro);
    expect(byMessage.row?.id).toBe(demoThreadId);

    const byThread = await openFromLink(store, org, DEMO_IDS.threadVetrix);
    expect(byThread.row?.id).toBe(demoThreadId);

    // A UUID nothing synced has: said plainly, never a throw.
    const unknown = await openFromLink(store, org, '00000000-0000-4000-8000-00000000ffff');
    expect(unknown.error).toMatch(/^That email isn't in the mailbox/);
  });

  it("sends a 'Gmail' link on to Gmail, looking up a synced email's Gmail id", async () => {
    const { store, auth } = harness;
    const org = auth.organizationId;
    const demoThreadId = DEMO_IDS.threadVetrix.replace(/-/g, '').slice(-16);
    const href = await gmailHrefForLink(store, org, DEMO_IDS.msgVetrixIntro);
    expect(href?.startsWith('https://mail.google.com/mail/?authuser=')).toBe(true);
    expect(href?.endsWith(`#all/${demoThreadId}`)).toBe(true);
    expect(await gmailHrefForLink(store, org, '0f00000000005201')).toMatch(
      /#all\/0f00000000005201$/,
    );
    expect(await gmailHrefForLink(store, org, '00000000-0000-4000-8000-00000000ffff')).toBeNull();
    expect(await gmailHrefForLink(store, org, 'not-an-email')).toBeNull();
  });

  it('serves the same emails to the reading pane route', async () => {
    const call = (id: string) => GET(new NextRequest(`http://localhost/api/inbox/thread?id=${id}`));
    const res = await call('0f00000000005201');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { thread: { subject: string } };
    expect(body.thread.subject).toBe('Invitation: Brightwater Venture Capital Lab, spring cohort');
    expect((await call('0f00000000009999')).status).toBe(404);
    signedIn = false;
    expect((await call('0f00000000005201')).status).toBe(401);
  });
});
