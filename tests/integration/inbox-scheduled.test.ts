import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { DEMO_IDS } from '@/lib/demo/ids';
import { SEND_SCOPES } from '@/lib/google/send-scopes';
import {
  cancelScheduled,
  dispatchDueScheduled,
  MAX_ATTEMPTS,
  scheduleSend,
  sendScheduledNow,
  STALE_SENDING_MS,
  updateScheduled,
  type ScheduleActor,
  type Sender,
} from '@/lib/services/inbox-scheduled';
import type { InboxScheduledSend, Integration } from '@/lib/types/domain';
import { err, ok } from '@/lib/util/result';

/**
 * Schedule send: a scheduled email goes out once at its time, never twice
 * (two runners racing get one winner), never after a cancel, and a send left
 * half-done is closed as failed, never sent again. The sender is a stub
 * here: no network, no Gmail.
 */

let harness: Harness;
let live = false;

const INTEGRATION: Integration = {
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
};

vi.mock('@/lib/services/email-session-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/email-session-auth')>()),
  sessionAuth: async () => ({
    ok: true,
    auth: { ...harness.auth, isDemo: !live },
    integration: live ? INTEGRATION : null,
  }),
}));

const { POST, GET } = await import('@/app/api/inbox/scheduled/route');

const NOW = new Date('2026-11-04T15:00:00.000Z');
const LATER = new Date('2026-11-05T14:00:00.000Z');

const content = {
  to: 'sam@example.test',
  cc: '',
  bcc: '',
  subject: 'Thursday',
  html: '<div>See you <b>Thursday</b>.</div><script>x()</script>',
  signature: 'nick' as const,
};

const actor = (): ScheduleActor => ({
  organizationId: DEMO_IDS.org,
  userId: DEMO_IDS.user,
  integration: INTEGRATION,
  demo: false,
});

function countingSender(result: 'ok' | 'retry' | 'fail' = 'ok') {
  const sent: string[] = [];
  const send: Sender = async (_store, _integration, row) => {
    sent.push(row.id);
    // Let a racing claim run while this send is "on the wire".
    await new Promise((r) => setTimeout(r, 5));
    if (result === 'retry')
      return err('provider_unavailable', 'Gmail is busy.', { retryable: true });
    if (result === 'fail') return err('invalid_input', 'Bad address.');
    return ok({ messageId: `m-${row.id.slice(0, 6)}` });
  };
  return { send, sent };
}

const rowOf = async (id: string) =>
  (await harness.store.get('inbox_scheduled_sends', DEMO_IDS.org, id)) as InboxScheduledSend;

const call = (body: unknown) =>
  POST(
    new NextRequest('http://localhost/api/inbox/scheduled', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

beforeEach(async () => {
  live = false;
  harness = await createHarness({ now: NOW });
  // The demo's own scheduled email would come due in these tests too.
  await harness.store.removeWhere('inbox_scheduled_sends', DEMO_IDS.org, {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await harness.dispose();
});

describe('scheduling', () => {
  it('keeps the email, sanitized, and sends nothing before its time', async () => {
    const made = await scheduleSend(harness.store, actor(), content, LATER.toISOString(), NOW);
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.value.status).toBe('scheduled');
    expect(made.value.body_html).toBe('<div>See you <b>Thursday</b>.</div>');
    const { send, sent } = countingSender();
    const early = await dispatchDueScheduled(harness.store, DEMO_IDS.org, {
      demo: false,
      integration: INTEGRATION,
      now: NOW,
      send,
    });
    expect(early.sent).toBe(0);
    expect(sent).toEqual([]);
  });

  it('refuses a time in the past or over a year ahead, and needs sending on', async () => {
    expect(
      (await scheduleSend(harness.store, actor(), content, '2026-11-04T14:00:00Z', NOW)).ok,
    ).toBe(false);
    expect(
      (await scheduleSend(harness.store, actor(), content, '2028-01-01T00:00:00Z', NOW)).ok,
    ).toBe(false);
    const off = await scheduleSend(
      harness.store,
      { ...actor(), integration: { ...INTEGRATION, scopes: [] } },
      content,
      LATER.toISOString(),
      NOW,
    );
    expect(off.ok).toBe(false);
  });
});

describe('sending at the time, once', () => {
  it('sends a due email exactly once, even with two runners racing', async () => {
    const made = await scheduleSend(harness.store, actor(), content, LATER.toISOString(), NOW);
    if (!made.ok) throw new Error('not scheduled');
    const { send, sent } = countingSender();
    const after = new Date(LATER.getTime() + 60_000);
    const opts = { demo: false, integration: INTEGRATION, now: after, send };
    const [a, b] = await Promise.all([
      dispatchDueScheduled(harness.store, DEMO_IDS.org, opts),
      dispatchDueScheduled(harness.store, DEMO_IDS.org, opts),
    ]);
    expect(a.sent + b.sent).toBe(1);
    expect(sent).toEqual([made.value.id]);
    const row = await rowOf(made.value.id);
    expect(row.status).toBe('sent');
    expect(row.sent_message_id).toMatch(/^m-/);
    // And never again on a later pass.
    await dispatchDueScheduled(harness.store, DEMO_IDS.org, opts);
    expect(sent).toHaveLength(1);
  });

  it('never sends after a cancel, and a cancel after the send is refused', async () => {
    const made = await scheduleSend(harness.store, actor(), content, LATER.toISOString(), NOW);
    if (!made.ok) throw new Error('not scheduled');
    expect((await cancelScheduled(harness.store, actor(), made.value.id, NOW)).ok).toBe(true);
    const { send, sent } = countingSender();
    await dispatchDueScheduled(harness.store, DEMO_IDS.org, {
      demo: false,
      integration: INTEGRATION,
      now: new Date(LATER.getTime() + 60_000),
      send,
    });
    expect(sent).toEqual([]);
    expect((await rowOf(made.value.id)).status).toBe('cancelled');
    // A cancelled one cannot be edited, sent now, or cancelled again.
    expect(
      (
        await updateScheduled(
          harness.store,
          actor(),
          made.value.id,
          content,
          LATER.toISOString(),
          NOW,
        )
      ).ok,
    ).toBe(false);
    expect(
      (await sendScheduledNow(harness.store, actor(), made.value.id, content, { send })).ok,
    ).toBe(false);
    expect((await cancelScheduled(harness.store, actor(), made.value.id, NOW)).ok).toBe(false);
    expect(sent).toEqual([]);
  });

  it('lets only one of a cancel and a send win when they race', async () => {
    const made = await scheduleSend(harness.store, actor(), content, LATER.toISOString(), NOW);
    if (!made.ok) throw new Error('not scheduled');
    const { send, sent } = countingSender();
    const [dispatched, cancelled] = await Promise.all([
      dispatchDueScheduled(harness.store, DEMO_IDS.org, {
        demo: false,
        integration: INTEGRATION,
        now: new Date(LATER.getTime() + 60_000),
        send,
      }),
      cancelScheduled(harness.store, actor(), made.value.id, NOW),
    ]);
    expect(dispatched.sent + (cancelled.ok ? 1 : 0)).toBe(1);
    expect(sent.length).toBe(cancelled.ok ? 0 : 1);
  });

  it('send now claims it, so the loop cannot send it too', async () => {
    const made = await scheduleSend(harness.store, actor(), content, LATER.toISOString(), NOW);
    if (!made.ok) throw new Error('not scheduled');
    const { send, sent } = countingSender();
    const [now, loop] = await Promise.all([
      sendScheduledNow(
        harness.store,
        actor(),
        made.value.id,
        { ...content, subject: 'Edited' },
        {
          send,
        },
      ),
      dispatchDueScheduled(harness.store, DEMO_IDS.org, {
        demo: false,
        integration: INTEGRATION,
        now: new Date(LATER.getTime() + 60_000),
        send,
      }),
    ]);
    expect(sent).toHaveLength(1);
    expect((now.ok ? 1 : 0) + loop.sent).toBe(1);
    expect((await rowOf(made.value.id)).status).toBe('sent');
  });

  it('retries a passing failure up to the limit, then stops; a hard failure stops at once', async () => {
    const made = await scheduleSend(harness.store, actor(), content, LATER.toISOString(), NOW);
    if (!made.ok) throw new Error('not scheduled');
    const busy = countingSender('retry');
    const after = new Date(LATER.getTime() + 60_000);
    for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
      await dispatchDueScheduled(harness.store, DEMO_IDS.org, {
        demo: false,
        integration: INTEGRATION,
        now: after,
        send: busy.send,
      });
    }
    expect(busy.sent).toHaveLength(MAX_ATTEMPTS);
    expect((await rowOf(made.value.id)).status).toBe('failed');

    const hard = await scheduleSend(harness.store, actor(), content, LATER.toISOString(), NOW);
    if (!hard.ok) throw new Error('not scheduled');
    const bad = countingSender('fail');
    await dispatchDueScheduled(harness.store, DEMO_IDS.org, {
      demo: false,
      integration: INTEGRATION,
      now: after,
      send: bad.send,
    });
    await dispatchDueScheduled(harness.store, DEMO_IDS.org, {
      demo: false,
      integration: INTEGRATION,
      now: after,
      send: bad.send,
    });
    expect(bad.sent).toHaveLength(1);
    expect((await rowOf(hard.value.id)).status).toBe('failed');
  });

  it('closes a send left half-done as failed, and never sends it again', async () => {
    const made = await scheduleSend(harness.store, actor(), content, LATER.toISOString(), NOW);
    if (!made.ok) throw new Error('not scheduled');
    await harness.store.update('inbox_scheduled_sends', DEMO_IDS.org, made.value.id, {
      status: 'sending',
      claim_token: 'crashed',
      claimed_at: LATER.toISOString(),
    });
    const { send, sent } = countingSender();
    await dispatchDueScheduled(harness.store, DEMO_IDS.org, {
      demo: false,
      integration: INTEGRATION,
      now: new Date(LATER.getTime() + STALE_SENDING_MS + 60_000),
      send,
    });
    expect(sent).toEqual([]);
    const row = await rowOf(made.value.id);
    expect(row.status).toBe('failed');
    expect(row.last_error).toMatch(/Check Sent/);
  });

  it('sends nothing in the demo, and nothing without the send grant', async () => {
    const made = await scheduleSend(harness.store, actor(), content, LATER.toISOString(), NOW);
    if (!made.ok) throw new Error('not scheduled');
    const { send, sent } = countingSender();
    const after = new Date(LATER.getTime() + 60_000);
    const demo = await dispatchDueScheduled(harness.store, DEMO_IDS.org, {
      demo: true,
      now: after,
      send,
    });
    expect(demo.state).toBe('skipped');
    const off = await dispatchDueScheduled(harness.store, DEMO_IDS.org, {
      demo: false,
      integration: { ...INTEGRATION, scopes: [] },
      now: after,
      send,
    });
    expect(off.state).toBe('not_connected');
    expect(sent).toEqual([]);
    expect((await rowOf(made.value.id)).status).toBe('scheduled');
  });
});

describe('the route', () => {
  it('schedules in the demo, lists it, opens it, and cancels it back into Drafts', async () => {
    const res = await call({ action: 'schedule', sendAt: '2027-01-05T14:00:00.000Z', ...content });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    const opened = await GET(new NextRequest(`http://localhost/api/inbox/scheduled?id=${id}`));
    expect(opened.status).toBe(200);
    const body = (await opened.json()) as { scheduled: { subject: string; html: string } };
    expect(body.scheduled.subject).toBe('Thursday');
    expect(body.scheduled.html).not.toMatch(/script/);
    const cancelled = await call({ action: 'cancel', id });
    expect(cancelled.status).toBe(200);
    expect((await cancelled.json()) as { draft: boolean }).toMatchObject({ draft: true });
    expect((await call({ action: 'cancel', id })).status).toBe(409);
  });

  it('refuses a bad address, and never sends from the demo', async () => {
    expect(
      (await call({ action: 'schedule', sendAt: '2027-01-05T14:00:00Z', ...content, to: 'nope' }))
        .status,
    ).toBe(400);
    const res = await call({ action: 'schedule', sendAt: '2027-01-05T14:00:00Z', ...content });
    const { id } = (await res.json()) as { id: string };
    expect((await call({ action: 'sendNow', id, ...content })).status).toBe(403);
  });

  it('says it needs a database update before the migration, and stores nothing', async () => {
    const original = harness.store.list.bind(harness.store);
    vi.spyOn(harness.store, 'list').mockImplementation((async (
      table: string,
      ...rest: unknown[]
    ) => {
      if (table === 'inbox_scheduled_sends') {
        throw Object.assign(new Error('relation "inbox_scheduled_sends" does not exist'), {
          code: '42P01',
        });
      }
      return (original as (...a: unknown[]) => Promise<unknown>)(table, ...rest);
    }) as never);
    const insert = vi.spyOn(harness.store, 'insert');
    const res = await call({ action: 'schedule', sendAt: '2027-01-05T14:00:00Z', ...content });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { message: string; details?: object } };
    expect(body.error.message).toMatch(/database update/);
    expect(body.error.details).toMatchObject({ needsMigration: true });
    expect(insert).not.toHaveBeenCalledWith('inbox_scheduled_sends', expect.anything());
  });
});
