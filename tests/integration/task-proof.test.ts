import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { DEFAULT_TASK_RELAY_POSTER_IDS } from '@/lib/config/env';
import { DEMO_TEAMMATE } from '@/lib/demo/fixtures';
import { DEMO_IDS } from '@/lib/demo/ids';
import type { SlackMessage } from '@/lib/slack/relay-history';
import { completeTaskWithProof, setMoneyLegal } from '@/lib/services/money-legal';
import {
  applyTaskCloses,
  collectTaskCloses,
  gmailMessageHref,
  TASK_CLOSE_MARKER,
  writeAutoClose,
} from '@/lib/services/task-close';
import { ingestTasks } from '@/lib/services/task-ingest';
import {
  confirmTaskProof,
  PROOF_CONFIRMED_ACTION,
  PROOF_EXPECTED_ACTION,
  PROOF_MISSING_ACTION,
  PROOF_SEEN_ACTION,
  proofCheckView,
  readFlaggedProofTasks,
  readProofChecks,
  runProofCheck,
} from '@/lib/services/task-proof';
import {
  applyTaskProofs,
  collectTaskProofs,
  parseTaskProofMessage,
  TASK_PROOF_MARKER,
  TASK_PROOF_PREVIEW_MARKER,
} from '@/lib/services/task-proof-relay';
import { readTasksVersion } from '@/lib/services/task-relay';
import { maybePostSnapshot, resetSnapshotState } from '@/lib/services/task-snapshot';
import { createTask, updateTaskStatus } from '@/lib/services/tasks';
import type { AuditEvent, EmailMessage, NetworkContact, Task } from '@/lib/types/domain';

// A made-up counterparty stands in for the real Nick-only ones.
vi.mock('@/lib/tasks/nick-only', async () => {
  const { wordMatcher } =
    await vi.importActual<typeof import('@/lib/tasks/nick-only')>('@/lib/tasks/nick-only');
  const { sha256 } = await vi.importActual<typeof import('@/lib/util/hash')>('@/lib/util/hash');
  return { wordMatcher, mentionsNickOnly: wordMatcher(new Set([sha256('zzfund')])) };
});

/**
 * The proof check for tasks a person ticks by hand, on the demo store: a
 * ticked deliverable with a matching sent email shows "Seen sent"; one with
 * none shows "Ticked, not seen sent" after two business days, with "It's
 * done" and "Reopen"; a plain to-do is never flagged. Also the task-closer's
 * TASK_PROOF_V1 posts and its closes for ticked tasks. Every name, address,
 * title and id here is invented; the demo mailbox is the fixtures' own.
 */

const TICK = String.fromCharCode(96);
const POSTER = DEFAULT_TASK_RELAY_POSTER_IDS[0]!;
const MAILBOX = 'nick@tiptop.demo';
const RILEY = DEMO_TEAMMATE.email;
const CHICAGO = 'America/Chicago';

let harness: Harness;
let org: string;
let n = 0;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // Tuesday 10:00 in Chicago.
  vi.setSystemTime(new Date('2026-10-20T15:00:00.000Z'));
  harness = await createHarness();
  org = harness.auth.organizationId;
  resetSnapshotState();
});

afterEach(async () => {
  vi.useRealTimers();
  await harness.dispose();
});

const at = (iso: string) => vi.setSystemTime(new Date(iso));
const slackTs = (iso: string) => `${Math.floor(Date.parse(iso) / 1000)}.000100`;

async function human(title: string, extra: { emailMessageId?: string } = {}): Promise<Task> {
  const created = await createTask(harness.auth, { title, ...extra });
  if (!created.ok) throw new Error('could not create');
  return created.value;
}

async function tick(task: Task): Promise<Task> {
  const done = await updateTaskStatus(harness.auth, task.id, 'complete');
  if (!done.ok) throw new Error(`could not tick: ${done.error.code}`);
  return done.value;
}

async function taskById(id: string): Promise<Task> {
  const task = (await harness.store.get('tasks', org, id)) as Task | null;
  if (!task) throw new Error(`no task ${id}`);
  return task;
}

async function rows(action: string, taskId: string): Promise<AuditEvent[]> {
  return (await harness.store.list('audit_events', org, {
    eq: { action, entity_id: taskId },
  })) as AuditEvent[];
}

async function checkOf(taskId: string) {
  return (await readProofChecks(harness.store, org, [await taskById(taskId)])).get(taskId);
}

async function sent(over: Partial<EmailMessage> & { sent_at: string }): Promise<EmailMessage> {
  n++;
  const row = {
    id: `98989898-0000-4000-8000-${String(n).padStart(12, '0')}`,
    organization_id: org,
    thread_id: DEMO_IDS.threadGirder,
    provider: 'google',
    provider_message_id: `beef${String(n).padStart(12, '0')}`,
    subject: 'Re: the thing',
    snippet: 'Here it is, as promised.',
    from_name: null,
    from_address: MAILBOX,
    to_addresses: [],
    cc_addresses: [],
    labels: ['SENT'],
    is_unread: false,
    body_text: null,
    body_fetched_at: null,
    body_hash: null,
    has_attachments: false,
    category: 'other',
    category_confidence: null,
    category_source: null,
    importance: null,
    is_ignored: false,
    linked_deal_id: null,
    linked_portfolio_company_id: null,
    injection_flagged: false,
    created_at: over.sent_at,
    updated_at: over.sent_at,
    ...over,
  } as EmailMessage;
  await harness.store.insert('email_messages', row);
  return row;
}

async function check(iso: string) {
  at(iso);
  return runProofCheck(harness.store, org, { now: new Date(iso) });
}

const view = async (taskId: string) =>
  proofCheckView(await checkOf(taskId), {
    timeZone: CHICAGO,
    messageHref: (id) => gmailMessageHref(MAILBOX, id),
  });

/* ---------------------------------------------------------- the three cases */

describe('a ticked deliverable with a matching sent email', () => {
  it('shows "Seen sent", once, and is never flagged', async () => {
    const task = await human('Send Riley the Q4 offsite agenda');
    at('2026-10-20T16:00:00Z');
    await tick(task);

    const [expected] = await rows(PROOF_EXPECTED_ACTION, task.id);
    expect(expected?.user_id).toBe(harness.auth.userId);
    expect(expected?.metadata).toMatchObject({
      kind: 'send',
      recipients: ['Riley'],
      proof: ['gmail_sent', 'slack_message'],
      // Tuesday 11:00 Chicago plus two business days.
      judge_after: '2026-10-22T16:00:00.000Z',
    });
    expect((await checkOf(task.id))?.state).toBe('waiting');

    const email = await sent({ sent_at: '2026-10-20T17:00:00.000Z', to_addresses: [RILEY] });
    // (The demo's own Riley task counts this email too: any email to Riley after it was made.)
    const outcome = await check('2026-10-20T18:00:00Z');
    expect(outcome.state).toBe('ran');
    expect(outcome.seen).toBeGreaterThanOrEqual(1);
    expect((await checkOf(task.id))?.state).toBe('seen');
    expect(await view(task.id)).toEqual({
      state: 'seen',
      label: 'Seen sent · email to Riley, Oct 20',
      href: gmailMessageHref(MAILBOX, email.provider_message_id),
    });
    const [seen] = await rows(PROOF_SEEN_ACTION, task.id);
    expect(seen).toMatchObject({ user_id: null });
    expect(seen?.metadata).toMatchObject({
      expected_id: expected!.id,
      source: 'app-sent-check',
      evidence_type: 'gmail_sent',
      evidence_id: email.provider_message_id,
    });

    // Looked at again, and long after the window: nothing more is written.
    await check('2026-10-21T18:00:00Z');
    await check('2026-10-30T18:00:00Z');
    expect(await rows(PROOF_SEEN_ACTION, task.id)).toHaveLength(1);
    expect(await rows(PROOF_MISSING_ACTION, task.id)).toEqual([]);
    expect((await taskById(task.id)).status).toBe('complete');
  });

  it('counts only a real send to the recipient after the task was made', async () => {
    const task = await human('Give Riley feedback on the LP letter');
    await sent({ sent_at: '2026-10-20T14:00:00.000Z', to_addresses: [RILEY] }); // before the task
    at('2026-10-20T16:00:00Z');
    await tick(task);
    await sent({ sent_at: '2026-10-20T17:00:00.000Z', to_addresses: ['maya@ledgerly.demo'] });
    await sent({ sent_at: '2026-10-20T17:05:00.000Z', to_addresses: [RILEY], labels: ['DRAFT'] });
    await sent({
      sent_at: '2026-10-20T17:10:00.000Z',
      to_addresses: [RILEY],
      snippet: "I'll circle back on this tomorrow.",
    });
    await sent({
      sent_at: '2026-10-20T17:15:00.000Z',
      to_addresses: [RILEY],
      subject: 'Slow to respond Re: LP letter',
    });
    await check('2026-10-20T18:00:00Z');
    expect((await checkOf(task.id))?.state).toBe('waiting');
  });
});

describe('a ticked deliverable with no matching sent email', () => {
  /** Ticked Friday 4pm Chicago: the window ends Tuesday 4pm. */
  async function tickedFriday(title = 'Give Riley feedback on the LP letter') {
    at('2026-10-23T20:00:00Z');
    const task = await human(title);
    at('2026-10-23T21:00:00Z');
    await tick(task);
    return task;
  }

  it('waits two business days, then shows "Ticked, not seen sent", once', async () => {
    const task = await tickedFriday();
    await check('2026-10-26T21:00:00Z'); // Monday: still inside the window
    expect((await checkOf(task.id))?.state).toBe('waiting');
    expect(await rows(PROOF_MISSING_ACTION, task.id)).toEqual([]);
    expect(await view(task.id)).toBeNull();

    const outcome = await check('2026-10-27T21:01:00Z'); // Tuesday, past it
    expect(outcome.flagged).toBeGreaterThanOrEqual(1);
    expect((await checkOf(task.id))?.state).toBe('flagged');
    expect(await view(task.id)).toEqual({
      state: 'flagged',
      label: 'Ticked, not seen sent',
      detail: 'Ticked Oct 23 · no email to Riley seen since',
    });
    // Never reopened by the app: the person decides.
    expect((await taskById(task.id)).status).toBe('complete');
    const flagged = await readFlaggedProofTasks(harness.store, org, new Date());
    expect(flagged.map(({ task: t }) => t.id)).toContain(task.id);

    await check('2026-10-28T21:01:00Z');
    expect(await rows(PROOF_MISSING_ACTION, task.id)).toHaveLength(1);
  });

  it('"It\'s done" clears the flag for good', async () => {
    const task = await tickedFriday();
    await check('2026-10-27T21:01:00Z');
    expect((await checkOf(task.id))?.state).toBe('flagged');

    const done = await confirmTaskProof(harness.auth, task.id);
    expect(done.ok).toBe(true);
    const [confirmed] = await rows(PROOF_CONFIRMED_ACTION, task.id);
    expect(confirmed?.user_id).toBe(harness.auth.userId);
    expect((await checkOf(task.id))?.state).toBe('confirmed');
    expect(await view(task.id)).toBeNull();
    expect((await taskById(task.id)).status).toBe('complete');

    await check('2026-11-05T21:01:00Z');
    expect(await rows(PROOF_MISSING_ACTION, task.id)).toHaveLength(1);
    expect((await checkOf(task.id))?.state).toBe('confirmed');
    const flagged = await readFlaggedProofTasks(harness.store, org, new Date());
    expect(flagged.map(({ task: t }) => t.id)).not.toContain(task.id);
    // Saying it twice changes nothing.
    await confirmTaskProof(harness.auth, task.id);
    expect(await rows(PROOF_CONFIRMED_ACTION, task.id)).toHaveLength(1);
  });

  it('"Reopen" puts it back on To do, and a new tick starts a new window', async () => {
    const task = await tickedFriday();
    await check('2026-10-27T21:01:00Z');
    expect((await checkOf(task.id))?.state).toBe('flagged');

    at('2026-10-27T22:00:00Z');
    const reopened = await updateTaskStatus(harness.auth, task.id, 'open');
    expect(reopened.ok).toBe(true);
    expect((await taskById(task.id)).status).toBe('open');
    expect(await checkOf(task.id)).toBeUndefined();
    const flagged = await readFlaggedProofTasks(harness.store, org, new Date());
    expect(flagged.map(({ task: t }) => t.id)).not.toContain(task.id);

    at('2026-10-28T15:00:00Z');
    await tick(task);
    expect((await checkOf(task.id))?.state).toBe('waiting');
    expect(await rows(PROOF_EXPECTED_ACTION, task.id)).toHaveLength(2);
  });

  it('turns into "Seen sent" when the email turns up late', async () => {
    const task = await tickedFriday();
    await check('2026-10-27T21:01:00Z');
    await sent({ sent_at: '2026-10-28T10:00:00.000Z', to_addresses: [RILEY] });
    await check('2026-10-28T11:00:00Z');
    expect((await checkOf(task.id))?.state).toBe('seen');
  });

  it('says so when no address could be found for the recipient', async () => {
    const task = await tickedFriday('Send Quentin the onboarding deck');
    await check('2026-10-27T21:01:00Z');
    expect((await view(task.id))?.state).toBe('flagged');
    expect(await view(task.id)).toMatchObject({
      detail: 'Ticked Oct 23 · no address found for Quentin, so no email could be matched',
    });
  });

  it('never matches a first name two contacts share', async () => {
    const contact = (id: string, full_name: string, email: string): NetworkContact => ({
      id,
      organization_id: org,
      full_name,
      email,
      company: null,
      title: null,
      relationship: null,
      expertise: [],
      geography: null,
      notes: null,
      source_document_id: null,
      created_at: '2026-10-01T00:00:00.000Z',
      updated_at: '2026-10-01T00:00:00.000Z',
    });
    await harness.store.insert(
      'network_contacts',
      contact('97979797-0000-4000-8000-000000000001', 'Sam Vale', 'sam@vale.example'),
    );
    await harness.store.insert(
      'network_contacts',
      contact('97979797-0000-4000-8000-000000000002', 'Sam Orr', 'sam@orr.example'),
    );
    const task = await tickedFriday('Send Sam the onboarding deck');
    await sent({ sent_at: '2026-10-24T15:00:00.000Z', to_addresses: ['sam@vale.example'] });
    await check('2026-10-27T21:01:00Z');
    expect((await checkOf(task.id))?.state).toBe('flagged');

    // The full name is not ambiguous.
    const full = await tickedFriday('Send Sam Vale the onboarding deck');
    await sent({ sent_at: '2026-10-24T16:00:00.000Z', to_addresses: ['sam@vale.example'] });
    await check('2026-10-27T21:02:00Z');
    expect((await checkOf(full.id))?.state).toBe('seen');
  });

  it('judges nothing with no mailbox to look in', async () => {
    const task = await tickedFriday();
    for (const row of (await harness.store.list('integrations', org)) as { id: string }[]) {
      await harness.store.remove('integrations', org, row.id);
    }
    const outcome = await check('2026-10-28T21:01:00Z');
    expect(outcome.state).toBe('no_mailbox');
    expect((await checkOf(task.id))?.state).toBe('waiting');
  });
});

describe('plain to-dos are never flagged', () => {
  it('writes nothing for a task that is not a deliverable, however long it waits', async () => {
    const titles = [
      'Prepare LPAC agenda',
      'Review the Ridgeline agreement',
      'Call Bob',
      'Check email',
    ];
    const tasks: Task[] = [];
    for (const title of titles) tasks.push(await tick(await human(title)));
    await check('2026-11-10T21:00:00Z');
    for (const task of tasks) {
      expect(await rows(PROOF_EXPECTED_ACTION, task.id)).toEqual([]);
      expect(await rows(PROOF_MISSING_ACTION, task.id)).toEqual([]);
      expect(await checkOf(task.id)).toBeUndefined();
    }
  });

  it('leaves a task involving a Nick-only counterparty alone', async () => {
    const task = await tick(await human('Reply to Zed at Zzfund about the side car'));
    expect(await rows(PROOF_EXPECTED_ACTION, task.id)).toEqual([]);
  });

  it('counts a money or legal close on proof as verified, and checks nothing', async () => {
    const task = await human('Wire the funds to Fernhollow');
    const closed = await completeTaskWithProof(harness.auth, task.id, {
      kind: 'link',
      url: 'https://mail.example.com/receipt/7',
    });
    expect(closed.ok).toBe(true);
    await check('2026-11-10T21:00:00Z');
    expect(await rows(PROOF_EXPECTED_ACTION, task.id)).toEqual([]);
    expect(await checkOf(task.id)).toBeUndefined();
  });

  it('checks a money task a person took off Money & legal like any deliverable', async () => {
    const task = await human('Pay Brightline invoice');
    await setMoneyLegal(harness.auth, task.id, false);
    await tick(task);
    const [expected] = await rows(PROOF_EXPECTED_ACTION, task.id);
    expect(expected?.metadata).toMatchObject({
      kind: 'payment',
      proof: ['gmail_sent', 'payment_confirmation'],
    });
  });

  it('never notes an automatic close: only a person ticks', async () => {
    const task = await human('Send Riley the board deck');
    await writeAutoClose(
      harness.store,
      org,
      task.id,
      {
        source: 'task-closer',
        match: 'id',
        kind: 'send_doc',
        evidence_type: 'gmail_sent',
        evidence_id: 'feed00000001',
        thread_id: null,
        evidence_at: '2026-10-20T15:30:00.000Z',
        reason: 'Sent the deck.',
        slack_ts: null,
      },
      new Date(),
    );
    expect((await taskById(task.id)).status).toBe('complete');
    expect(await rows(PROOF_EXPECTED_ACTION, task.id)).toEqual([]);
  });
});

describe('who should receive it', () => {
  it('needs one email to both parties for an intro', async () => {
    const task = await human('Intro Riley to Maya');
    await tick(task);
    await sent({ sent_at: '2026-10-20T16:00:00.000Z', to_addresses: [RILEY] });
    await check('2026-10-20T17:00:00Z');
    expect((await checkOf(task.id))?.state).toBe('waiting');
    await sent({
      sent_at: '2026-10-20T18:00:00.000Z',
      to_addresses: [RILEY],
      cc_addresses: ['maya@ledgerly.demo'],
      snippet: 'Riley, meet Maya. Maya, meet Riley.',
    });
    await check('2026-10-20T19:00:00Z');
    expect((await checkOf(task.id))?.state).toBe('seen');
  });

  it('addresses a reply made from an email to its sender', async () => {
    const task = await human('Reply to the LP question on the Q3 timeline', {
      emailMessageId: DEMO_IDS.msgLpQuestion,
    });
    await tick(task);
    const [expected] = await rows(PROOF_EXPECTED_ACTION, task.id);
    expect(expected?.metadata).toMatchObject({ kind: 'reply', recipients: [] });
    await sent({ sent_at: '2026-10-20T16:00:00.000Z', to_addresses: ['elena@marchmont.demo'] });
    await check('2026-10-20T17:00:00Z');
    expect((await checkOf(task.id))?.state).toBe('seen');
  });

  it("names a reply's sender in its flag, and never judges a reply owed to no one", async () => {
    at('2026-10-23T20:00:00Z');
    const owed = await human('Reply to the LP question on the Q3 timeline', {
      emailMessageId: DEMO_IDS.msgLpQuestion,
    });
    const own = await sent({
      sent_at: '2026-10-23T19:00:00.000Z',
      to_addresses: ['elena@marchmont.demo'],
      labels: ['SENT'],
    });
    const self = await human('Reply to my own note', { emailMessageId: own.id });
    at('2026-10-23T21:00:00Z');
    await tick(owed);
    await tick(self);
    await check('2026-10-27T21:01:00Z');
    expect(await view(owed.id)).toMatchObject({
      state: 'flagged',
      detail: 'Ticked Oct 23 · no email to Elena Ward seen since',
    });
    expect((await checkOf(self.id))?.state).toBe('waiting');
    expect(await rows(PROOF_MISSING_ACTION, self.id)).toEqual([]);
  });

  it('finds someone who has written in by their first name', async () => {
    const task = await human('Get back to Tom on the pilot pricing');
    await tick(task);
    await sent({ sent_at: '2026-10-20T16:00:00.000Z', to_addresses: ['tom@girderai.demo'] });
    await check('2026-10-20T17:00:00Z');
    expect((await checkOf(task.id))?.state).toBe('seen');
  });

  it('takes any address at a company for a company', async () => {
    const task = await human('Send Ledgerly the board deck');
    await tick(task);
    await sent({ sent_at: '2026-10-20T16:00:00.000Z', to_addresses: ['maya@ledgerly.demo'] });
    await check('2026-10-20T17:00:00Z');
    expect((await checkOf(task.id))?.state).toBe('seen');
  });
});

/* ------------------------------------------------------------- the relay */

function proofMessage(
  proofs: Record<string, unknown>[],
  postedAt: string,
  opts: { user?: string; marker?: string } = {},
): SlackMessage {
  const body = { v: 1, source: 'task-closer', batch: postedAt, proofs };
  return {
    ts: slackTs(postedAt),
    user: opts.user ?? POSTER,
    text: `${opts.marker ?? TASK_PROOF_MARKER}\n${TICK}${JSON.stringify(body)}${TICK}`,
  };
}

const slackProof = (task: Task, over: Record<string, unknown> = {}) => ({
  task_id: task.id,
  title: task.title,
  kind: 'review',
  evidence_at: '2026-10-21T15:00:00Z',
  evidence: { type: 'slack_message', id: '1761058800.000200', channel: 'D0ZZTEST01' },
  reason: 'Sent Riley the edits in a DM.',
  ...over,
});

async function applyProofs(messages: SlackMessage[]) {
  const collected = collectTaskProofs([...messages].reverse(), [POSTER]);
  return applyTaskProofs(harness.store, org, collected.proofs, { rejected: collected.rejected });
}

describe('TASK_PROOF_V1 from the task-closer', () => {
  it('parses only the exact marker from the routine', () => {
    const task = { id: '0f0e0d0c-0b0a-4908-8706-050403020100', title: 'ZZ Send Riley it' } as Task;
    const good = proofMessage([slackProof(task)], '2026-10-21T20:00:00Z');
    expect(parseTaskProofMessage(good.text)?.proofs).toHaveLength(1);
    expect(
      parseTaskProofMessage(
        proofMessage([slackProof(task)], '2026-10-21T20:00:00Z', {
          marker: TASK_PROOF_PREVIEW_MARKER,
        }).text,
      ),
    ).toBeNull();
    expect(parseTaskProofMessage(`${TASK_PROOF_MARKER}\n${TICK}{not json${TICK}`)).toBeNull();
    expect(
      parseTaskProofMessage(
        `${TASK_PROOF_MARKER}\n${TICK}${JSON.stringify({ v: 1, source: 'someone', proofs: [slackProof(task)] })}${TICK}`,
      ),
    ).toBeNull();
    const mixed = parseTaskProofMessage(
      proofMessage([slackProof(task), { title: 'x' }], '2026-10-21T20:00:00Z').text,
    );
    expect(mixed).toMatchObject({ rejected: 1 });
    expect(mixed?.proofs).toHaveLength(1);
  });

  it('marks a ticked task seen, by id or by title, and nothing else', async () => {
    const byId = await human('Give Riley feedback on the LP letter');
    const byTitle = await human('Send Riley the Q4 offsite agenda');
    await tick(byId);
    await tick(byTitle);
    const counts = await applyProofs([
      proofMessage(
        [slackProof(byId), slackProof(byTitle, { task_id: undefined, kind: 'send_doc' })],
        '2026-10-21T20:00:00Z',
      ),
    ]);
    expect(counts).toMatchObject({ seen: 2, rejected: 0 });
    for (const task of [byId, byTitle]) {
      expect((await checkOf(task.id))?.state).toBe('seen');
      expect((await taskById(task.id)).status).toBe('complete');
    }
    expect(await view(byId.id)).toMatchObject({
      state: 'seen',
      label: 'Seen sent · Slack message to Riley, Oct 21',
      href: null,
    });
    const [seen] = await rows(PROOF_SEEN_ACTION, byId.id);
    expect(seen?.metadata).toMatchObject({
      source: 'task-closer',
      evidence_type: 'slack_message',
      channel: 'D0ZZTEST01',
    });
  });

  it('is harmless to read again every run', async () => {
    const task = await tick(await human('Give Riley feedback on the LP letter'));
    const message = proofMessage([slackProof(task)], '2026-10-21T20:00:00Z');
    expect((await applyProofs([message])).seen).toBe(1);
    expect(await applyProofs([message])).toMatchObject({
      seen: 0,
      skipped: { not_awaiting: 1 },
    });
    expect(await rows(PROOF_SEEN_ACTION, task.id)).toHaveLength(1);
  });

  it('never touches an open task, and trusts only the routine', async () => {
    const open = await human('Give Riley feedback on the LP letter');
    const counts = await applyProofs([proofMessage([slackProof(open)], '2026-10-21T20:00:00Z')]);
    expect(counts).toMatchObject({ seen: 0, skipped: { not_awaiting: 1 } });
    expect((await taskById(open.id)).status).toBe('open');
    expect(await rows(PROOF_SEEN_ACTION, open.id)).toEqual([]);

    const ticked = await tick(await human('Send Riley the Q4 offsite agenda'));
    const stranger = proofMessage([slackProof(ticked)], '2026-10-21T20:00:00Z', {
      user: 'U0STRANGER',
    });
    expect((await applyProofs([stranger])).seen).toBe(0);
    expect((await checkOf(ticked.id))?.state).toBe('waiting');
  });

  it('skips a wrong title for the id, and evidence older than the task', async () => {
    const task = await tick(await human('Give Riley feedback on the LP letter'));
    const counts = await applyProofs([
      proofMessage(
        [
          slackProof(task, { title: 'Something else entirely' }),
          slackProof(task, { evidence_at: '2026-10-19T15:00:00Z' }),
        ],
        '2026-10-21T20:00:00Z',
      ),
    ]);
    expect(counts).toMatchObject({
      seen: 0,
      skipped: { id_title_mismatch: 1, evidence_too_old: 1 },
    });
  });

  it('a TASK_CLOSE_V1 for a ticked task is its proof, and closes nothing', async () => {
    const task = await tick(await human('Send Riley the Q4 offsite agenda'));
    const close = {
      task_id: task.id,
      title: task.title,
      kind: 'send_doc',
      evidence_at: '2026-10-20T18:00:00Z',
      evidence: { type: 'gmail_sent', id: 'abcdef0123456789' },
      reason: 'Sent Riley the agenda.',
    };
    const message: SlackMessage = {
      ts: slackTs('2026-10-20T20:00:00Z'),
      user: POSTER,
      text: `${TASK_CLOSE_MARKER}\n${TICK}${JSON.stringify({ v: 1, source: 'task-closer', closes: [close] })}${TICK}`,
    };
    const counts = await applyTaskCloses(
      harness.store,
      org,
      collectTaskCloses([message], [POSTER]).closes,
    );
    expect(counts).toMatchObject({ closed: 0, proofs: 1 });
    expect((await checkOf(task.id))?.state).toBe('seen');
    expect(await rows('task.auto_completed', task.id)).toEqual([]);
    // The same post again is still harmless.
    const again = await applyTaskCloses(
      harness.store,
      org,
      collectTaskCloses([message], [POSTER]).closes,
    );
    expect(again).toMatchObject({ closed: 0, proofs: 0 });
  });
});

/* ------------------------------------------------- around the proof check */

describe('around the proof check', () => {
  it('never brings a ticked task back through the suggester', async () => {
    const task = await tick(await human('Give Riley feedback on the LP letter'));
    const result = await ingestTasks(harness.store, org, {
      source: 'task-auto-suggest',
      tasks: [{ title: task.title }],
    });
    expect(result.created).toEqual([]);
    expect(result.existing).toEqual([task.title]);
  });

  it('lists ticked tasks still waiting in the snapshot for the task-closer', async () => {
    const task = await tick(await human('Give Riley feedback on the LP letter'));
    const posted: string[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      posted.push(JSON.parse(String(init?.body)).text as string);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const status = await maybePostSnapshot(harness.store, org, {
      token: 'xoxb-test-only',
      channelId: 'C0ZZTEST01',
      fetchImpl,
      now: new Date(),
    });
    expect(status.state).toBe('posted');
    const listed = posted
      .map((text) => JSON.parse(text.split('\n')[1]!.slice(1, -1).replaceAll('&amp;', '&')))
      .flatMap((part: { tasks: { id: string }[] }) => part.tasks);
    expect(listed.find((t) => t.id === task.id)).toMatchObject({
      status: 'ticked',
      deliver: { kind: 'review', to: ['Riley'] },
    });
  });

  it('changes the open-tab fingerprint when a flag is written', async () => {
    at('2026-10-23T21:00:00Z');
    await tick(await human('Give Riley feedback on the LP letter'));
    const before = await readTasksVersion(harness.store, org, new Date());
    await check('2026-10-27T21:01:00Z');
    expect(await readTasksVersion(harness.store, org, new Date())).not.toBe(before);
  });

  it('flags the demo tasks that were never sent, and leaves the one seen', async () => {
    await check(new Date().toISOString());
    expect((await checkOf(DEMO_IDS.taskProofSeen))?.state).toBe('seen');
    expect((await checkOf(DEMO_IDS.taskProofFlaggedDone))?.state).toBe('flagged');
    expect((await checkOf(DEMO_IDS.taskProofFlaggedReopen))?.state).toBe('flagged');
    const flagged = await readFlaggedProofTasks(harness.store, org, new Date());
    expect(flagged.map(({ task }) => task.id)).toEqual([
      DEMO_IDS.taskProofFlaggedDone,
      DEMO_IDS.taskProofFlaggedReopen,
    ]);
  });
});
