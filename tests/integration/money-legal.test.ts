import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { DEFAULT_TASK_RELAY_POSTER_IDS } from '@/lib/config/env';
import { DEMO_TEAMMATE, DEMO_USER } from '@/lib/demo/fixtures';
import { DEMO_IDS } from '@/lib/demo/ids';
import type { SlackMessage } from '@/lib/slack/relay-history';
import {
  completeTaskWithProof,
  dismissNeedsProof,
  moneyLegalBadges,
  needsProofView,
  proofView,
  readMoneyLegal,
  readTaskPeople,
  setMoneyLegal,
} from '@/lib/services/money-legal';
import { NEEDS_PROOF_ACTION, PROOF_ACTION } from '@/lib/services/money-legal-records';
import {
  applyTaskCloses,
  collectTaskCloses,
  latestHumanTaskTouch,
  TASK_CLOSE_MARKER,
  writeAutoClose,
  type AutoCloseMetadata,
} from '@/lib/services/task-close';
import { ingestTasks } from '@/lib/services/task-ingest';
import { readTasksVersion } from '@/lib/services/task-relay';
import {
  assignTask,
  createTask,
  editTask,
  listOpenTasks,
  listTaskPeople,
  restoreTask,
  snoozeTask,
  updateTaskStatus,
} from '@/lib/services/tasks';
import type { AuditEvent, Task } from '@/lib/types/domain';

/**
 * Task basics (edit, delete, snooze to a day, assign) and money and legal
 * tasks, on the demo store: a money or legal task closes only on proof, by a
 * person or on an automatic close that states its own; any other automatic
 * close becomes a needs-proof claim instead. Every name, title and id here is
 * invented.
 */

const TICK = String.fromCharCode(96);
const POSTER = DEFAULT_TASK_RELAY_POSTER_IDS[0]!;
/** The demo owner's first name, from the fixtures. */
const OWNER_FIRST = DEMO_USER.name.split(' ')[0]!;
let harness: Harness;
let org: string;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-20T15:00:00.000Z'));
  harness = await createHarness();
  org = harness.auth.organizationId;
});

afterEach(async () => {
  vi.useRealTimers();
  await harness.dispose();
});

const at = (iso: string) => vi.setSystemTime(new Date(iso));
const slackTs = (iso: string) => `${Math.floor(Date.parse(iso) / 1000)}.000100`;

async function human(title: string, detail?: string): Promise<Task> {
  const created = await createTask(harness.auth, { title, detail });
  if (!created.ok) throw new Error('could not create');
  return created.value;
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

function closeMessage(
  close: { task_id: string; title: string; evidence_at: string },
  evidence: { type: 'gmail_sent' | 'calendar_event'; id: string },
  postedAt: string,
  reason = 'Done, per the thread.',
): SlackMessage {
  const body = {
    v: 1,
    source: 'task-closer',
    batch: postedAt,
    closes: [{ ...close, kind: 'payment', evidence, reason }],
  };
  return {
    ts: slackTs(postedAt),
    user: POSTER,
    text: `${TASK_CLOSE_MARKER}\n${TICK}${JSON.stringify(body)}${TICK}`,
  };
}

async function apply(messages: SlackMessage[]) {
  const collected = collectTaskCloses([...messages].reverse(), [POSTER]);
  return applyTaskCloses(harness.store, org, collected.closes);
}

/* ------------------------------------------------------------ proof gating */

describe('closing a money or legal task', () => {
  it('refuses a plain Mark complete, and takes it with proof', async () => {
    const task = await human('ZZ Send the wire for the Fernhollow round');
    const plain = await updateTaskStatus(harness.auth, task.id, 'complete');
    expect(plain.ok).toBe(false);
    if (!plain.ok) expect(plain.error.code).toBe('proof_required');
    expect((await taskById(task.id)).status).toBe('open');

    const closed = await completeTaskWithProof(harness.auth, task.id, {
      kind: 'link',
      url: 'https://mail.example.com/receipt/1',
      note: 'Bank confirmation',
    });
    expect(closed.ok).toBe(true);
    const done = await taskById(task.id);
    expect(done.status).toBe('complete');

    const [proof] = await rows(PROOF_ACTION, task.id);
    expect(proof?.user_id).toBe(harness.auth.userId);
    expect(proof?.metadata).toMatchObject({
      kind: 'link',
      url: 'https://mail.example.com/receipt/1',
      note: 'Bank confirmation',
    });

    const read = await readMoneyLegal(harness.store, org, [done]);
    const shown = read.proofs.get(task.id);
    expect(shown).toBeDefined();
    expect(proofView(shown!, [])).toEqual({
      label: 'Closed with proof · mail.example.com',
      href: 'https://mail.example.com/receipt/1',
      note: 'Bank confirmation',
    });
  });

  it('leaves an ordinary task to Mark complete', async () => {
    const task = await human('ZZ Book the offsite room');
    expect((await updateTaskStatus(harness.auth, task.id, 'complete')).ok).toBe(true);
  });

  it("follows a person's toggle over the rules, both ways", async () => {
    const plain = await human('ZZ Book the offsite room');
    await setMoneyLegal(harness.auth, plain.id, true);
    expect((await updateTaskStatus(harness.auth, plain.id, 'complete')).ok).toBe(false);

    const wire = await human('ZZ Check the wire landed');
    await setMoneyLegal(harness.auth, wire.id, false);
    expect((await updateTaskStatus(harness.auth, wire.id, 'complete')).ok).toBe(true);
  });

  it('takes a confirmation only from someone on the team', async () => {
    const task = await human('ZZ Countersign the side letter');
    const stranger = await completeTaskWithProof(harness.auth, task.id, {
      kind: 'confirmed',
      confirmedBy: '99999999-9999-4999-8999-999999999999',
    });
    expect(stranger.ok).toBe(false);
    if (!stranger.ok) expect(stranger.error.code).toBe('invalid_input');

    const people = await listTaskPeople(org);
    const ok = await completeTaskWithProof(harness.auth, task.id, {
      kind: 'confirmed',
      confirmedBy: DEMO_IDS.user,
    });
    expect(ok.ok).toBe(true);
    const read = await readMoneyLegal(harness.store, org, [await taskById(task.id)]);
    expect(proofView(read.proofs.get(task.id)!, people).label).toBe(
      `Closed · ${OWNER_FIRST} confirmed`,
    );
  });

  it('refuses a proof that is not a web link', async () => {
    const task = await human('ZZ Pay the Northwind invoice');
    const bad = await completeTaskWithProof(harness.auth, task.id, {
      kind: 'link',
      url: 'javascript:alert(1)',
    });
    expect(bad.ok).toBe(false);
    expect((await taskById(task.id)).status).toBe('open');
    expect(await rows(PROOF_ACTION, task.id)).toHaveLength(0);
  });

  it('never shows a stored link that is not a web link as a link', () => {
    const stored = {
      auditId: 'a1',
      at: '2026-10-20T15:00:00.000Z',
      userId: null,
      kind: 'link' as const,
      confirmedBy: null,
      note: null,
    };
    expect(proofView({ ...stored, url: 'javascript:alert(1)' }, [])).toEqual({
      label: 'Closed with proof',
      href: null,
      note: null,
    });
    expect(proofView({ ...stored, url: 'http://files.example.com/a.pdf' }, []).href).toBe(
      'http://files.example.com/a.pdf',
    );
  });

  it('Undo reopens it, and its old proof no longer explains anything', async () => {
    const task = await human('ZZ File the annual report');
    await completeTaskWithProof(harness.auth, task.id, {
      kind: 'link',
      url: 'https://files.example.com/filed.pdf',
    });
    at('2026-10-20T15:00:05.000Z');
    expect((await restoreTask(harness.auth, task.id, { status: 'open' })).ok).toBe(true);
    const reopened = await taskById(task.id);
    expect(reopened.status).toBe('open');
    const read = await readMoneyLegal(harness.store, org, [reopened]);
    expect(read.proofs.size).toBe(0);
    // And closing again still needs proof.
    expect((await updateTaskStatus(harness.auth, task.id, 'complete')).ok).toBe(false);
  });
});

/* ---------------------------------------------------- the automatic closes */

describe('automatic closes of money and legal tasks', () => {
  it('keeps a close with no proof as a needs-proof claim, once', async () => {
    const task = await human('ZZ Confirm the Mossgate wire went out');
    at('2026-10-20T17:00:00.000Z');
    const message = closeMessage(
      { task_id: task.id, title: task.title, evidence_at: '2026-10-20T16:00:00Z' },
      { type: 'calendar_event', id: 'evt-zz-1' },
      '2026-10-20T16:30:00Z',
      'A call about the wire is booked.',
    );
    const first = await apply([message]);
    expect(first.closed).toBe(0);
    expect(first.skipped.needs_proof).toBe(1);
    expect((await taskById(task.id)).status).toBe('open');

    const claims = await rows(NEEDS_PROOF_ACTION, task.id);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.user_id).toBeNull();

    // Every pull re-reads the window: the same evidence is claimed once.
    const again = await apply([message]);
    expect(again.skipped.already_applied).toBe(1);
    expect(await rows(NEEDS_PROOF_ACTION, task.id)).toHaveLength(1);

    const read = await readMoneyLegal(harness.store, org, [await taskById(task.id)]);
    const claim = read.claims.get(task.id);
    expect(claim).toBeDefined();
    expect(needsProofView(claim!, 'America/Chicago')).toEqual({
      label: 'The auto-check marked it done · meeting booked Oct 20',
      reason: 'A call about the wire is booked.',
    });
  });

  it('closes on a close that states its proof, keeping the reason', async () => {
    const task = await human('ZZ Send the signed NDA back');
    at('2026-10-20T17:00:00.000Z');
    const counts = await apply([
      closeMessage(
        { task_id: task.id, title: task.title, evidence_at: '2026-10-20T16:00:00Z' },
        { type: 'gmail_sent', id: 'abc0000000000042' },
        '2026-10-20T16:30:00Z',
        'Sent the countersigned NDA in the thread.',
      ),
    ]);
    expect(counts.closed).toBe(1);
    expect((await taskById(task.id)).status).toBe('complete');
    const [auto] = await rows('task.auto_completed', task.id);
    expect(auto?.metadata?.reason).toBe('Sent the countersigned NDA in the thread.');
    expect(await rows(NEEDS_PROOF_ACTION, task.id)).toHaveLength(0);
  });

  it('closes an ordinary task on a booked meeting, as before', async () => {
    const task = await human('ZZ Set up the Lumen walkthrough');
    at('2026-10-20T17:00:00.000Z');
    const counts = await apply([
      closeMessage(
        { task_id: task.id, title: task.title, evidence_at: '2026-10-20T16:00:00Z' },
        { type: 'calendar_event', id: 'evt-zz-2' },
        '2026-10-20T16:30:00Z',
      ),
    ]);
    expect(counts.closed).toBe(1);
  });

  it('applies the same rule to the app reply check', async () => {
    const task = await human('ZZ Reply to the fund admin about the capital call');
    const meta: AutoCloseMetadata = {
      source: 'app-reply-check',
      match: 'thread',
      kind: 'reply',
      evidence_type: 'gmail_sent',
      evidence_id: 'abc0000000000043',
      thread_id: null,
      evidence_at: '2026-10-20T16:00:00.000Z',
      reason: 'Reply sent in the same email thread',
      slack_ts: null,
    };
    expect(await writeAutoClose(harness.store, org, task.id, meta, new Date())).toBe('closed');

    const other = await human('ZZ Reply to the accountant about the tax form');
    expect(
      await writeAutoClose(
        harness.store,
        org,
        other.id,
        { ...meta, evidence_type: 'calendar_event', evidence_id: 'evt-zz-3' },
        new Date(),
      ),
    ).toBe('needs_proof');
  });

  it('"Not done" clears the claim, and the same evidence never claims it again', async () => {
    const task = await human('ZZ Confirm the distribution reached the account');
    at('2026-10-20T17:00:00.000Z');
    const message = closeMessage(
      { task_id: task.id, title: task.title, evidence_at: '2026-10-20T16:00:00Z' },
      { type: 'calendar_event', id: 'evt-zz-4' },
      '2026-10-20T16:30:00Z',
    );
    await apply([message]);
    at('2026-10-20T18:00:00.000Z');
    expect((await dismissNeedsProof(harness.auth, task.id)).ok).toBe(true);

    const read = await readMoneyLegal(harness.store, org, [await taskById(task.id)]);
    expect(read.claims.size).toBe(0);
    const again = await apply([message]);
    expect(again.skipped.person_newer).toBe(1);
    expect((await taskById(task.id)).status).toBe('open');
  });

  it('closing a claimed task with proof finishes it', async () => {
    const task = await human('ZZ Return the subscription docs');
    at('2026-10-20T17:00:00.000Z');
    await apply([
      closeMessage(
        { task_id: task.id, title: task.title, evidence_at: '2026-10-20T16:00:00Z' },
        { type: 'calendar_event', id: 'evt-zz-5' },
        '2026-10-20T16:30:00Z',
      ),
    ]);
    const closed = await completeTaskWithProof(harness.auth, task.id, {
      kind: 'confirmed',
      confirmedBy: DEMO_TEAMMATE.id,
    });
    expect(closed.ok).toBe(true);
    const done = await taskById(task.id);
    const read = await readMoneyLegal(harness.store, org, [done]);
    expect(read.claims.size).toBe(0);
    expect(read.proofs.get(task.id)?.confirmedBy).toBe(DEMO_TEAMMATE.id);
  });

  it('changes the open-tab fingerprint when a claim lands', async () => {
    const task = await human('ZZ Pay the Brightkiln invoice');
    const before = await readTasksVersion(harness.store, org);
    at('2026-10-20T17:00:00.000Z');
    await apply([
      closeMessage(
        { task_id: task.id, title: task.title, evidence_at: '2026-10-20T16:00:00Z' },
        { type: 'calendar_event', id: 'evt-zz-6' },
        '2026-10-20T16:30:00Z',
      ),
    ]);
    expect(await readTasksVersion(harness.store, org)).not.toBe(before);
  });
});

/* ------------------------------------------------- a store that cannot read */

describe('when the store cannot be read', () => {
  it('reads as no money or legal marks and no people, never an error', async () => {
    const open = await listOpenTasks(org, new Date());
    const broken = new Proxy(harness.store, {
      get(target, prop, receiver) {
        if (prop === 'list' || prop === 'userProfileById') {
          return () => Promise.reject(new Error('relation does not exist'));
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const read = await readMoneyLegal(broken, org, open);
    expect(read.states.size).toBe(0);
    expect(read.claims.size).toBe(0);
    expect(read.proofs.size).toBe(0);
    expect(await readTaskPeople(org, broken)).toEqual([]);
  });
});

/* ------------------------------------------------------------- the demo */

describe('the demo money and legal tasks', () => {
  it('show one claim and one task going stale', async () => {
    const now = new Date();
    const open = await listOpenTasks(org, now);
    const read = await readMoneyLegal(harness.store, org, open);
    expect([...read.claims.keys()]).toEqual([DEMO_IDS.taskWireCheck]);

    const side = open.find((t) => t.id === DEMO_IDS.taskSideLetter)!;
    expect(moneyLegalBadges(side, read.states.get(side.id), now, false)).toEqual({
      why: 'Matched signature, side letter',
      stale: 'Going stale · 10 days quiet',
    });
    // Asleep on purpose is not stale.
    expect(moneyLegalBadges(side, read.states.get(side.id), now, true)?.stale).toBeNull();
  });
});

/* ------------------------------------------------------------- task basics */

describe('editing a task', () => {
  it('changes title, detail and due date, as a person touch', async () => {
    const task = await human('ZZ Send Kit the shortlist');
    at('2026-10-20T16:00:00.000Z');
    const edited = await editTask(harness.auth, task.id, {
      title: '  ZZ Send Kit the final   shortlist ',
      detail: 'Three names, not five',
      dueAt: '2026-10-23T22:00:00.000Z',
    });
    expect(edited.ok).toBe(true);
    const fresh = await taskById(task.id);
    expect(fresh).toMatchObject({
      title: 'ZZ Send Kit the final shortlist',
      detail: 'Three names, not five',
      due_at: '2026-10-23T22:00:00.000Z',
    });
    const [row] = await rows('task.edited', task.id);
    expect(row?.metadata).toEqual({
      fields: ['title', 'detail', 'due_at'],
      previous_title: 'ZZ Send Kit the shortlist',
    });
    expect(await latestHumanTaskTouch(harness.store, org, fresh)).toBe(row?.created_at);
  });

  it('writes nothing when nothing changed, and refuses an empty title', async () => {
    const task = await human('ZZ Send Kit the shortlist');
    expect(
      (await editTask(harness.auth, task.id, { title: task.title, detail: null, dueAt: null })).ok,
    ).toBe(true);
    expect(await rows('task.edited', task.id)).toHaveLength(0);
    const empty = await editTask(harness.auth, task.id, { title: '  ', detail: null, dueAt: null });
    expect(empty.ok).toBe(false);
  });

  it('clears a due date', async () => {
    const created = await createTask(harness.auth, {
      title: 'ZZ Book the room',
      dueAt: '2026-10-22T17:00:00.000Z',
    });
    if (!created.ok) throw new Error('no task');
    await editTask(harness.auth, created.value.id, {
      title: 'ZZ Book the room',
      detail: null,
      dueAt: null,
    });
    expect((await taskById(created.value.id)).due_at).toBeNull();
  });

  it('keeps the routine from adding the old wording back', async () => {
    await ingestTasks(harness.store, org, {
      source: 'test',
      tasks: [{ title: 'ZZ Reply to Kit about the hire' }],
    });
    const [suggested] = (await harness.store.list('tasks', org, {
      eq: { title: 'ZZ Reply to Kit about the hire' },
    })) as Task[];
    await editTask(harness.auth, suggested!.id, {
      title: 'ZZ Reply to Kit: yes to the hire',
      detail: null,
      dueAt: null,
    });
    const again = await ingestTasks(harness.store, org, {
      source: 'test',
      tasks: [{ title: 'ZZ Reply to Kit about the hire' }],
    });
    expect(again.created).toEqual([]);
    expect(again.existing).toEqual(['ZZ Reply to Kit about the hire']);
  });
});

describe('deleting a task', () => {
  it('takes it off every list, Undo brings it back, and the routine never re-adds it', async () => {
    await ingestTasks(harness.store, org, { source: 'test', tasks: [{ title: 'ZZ Ping Ivy' }] });
    const [task] = (await harness.store.list('tasks', org, {
      eq: { title: 'ZZ Ping Ivy' },
    })) as Task[];
    expect((await updateTaskStatus(harness.auth, task!.id, 'cancelled')).ok).toBe(true);
    expect((await listOpenTasks(org)).some((t) => t.id === task!.id)).toBe(false);

    const again = await ingestTasks(harness.store, org, {
      source: 'test',
      tasks: [{ title: 'ZZ Ping Ivy' }],
    });
    expect(again.created).toEqual([]);

    expect((await restoreTask(harness.auth, task!.id, { status: 'open' })).ok).toBe(true);
    expect((await listOpenTasks(org)).some((t) => t.id === task!.id)).toBe(true);
  });

  it('deletes a money or legal task without asking for proof', async () => {
    const task = await human('ZZ Pay the duplicate invoice');
    expect((await updateTaskStatus(harness.auth, task.id, 'cancelled')).ok).toBe(true);
  });
});

describe('snoozing to a chosen day', () => {
  it('sleeps until that time and wakes on its own', async () => {
    const task = await human('ZZ Chase the deck');
    expect((await snoozeTask(harness.auth, task.id, '2026-10-27T14:00:00.000Z')).ok).toBe(true);
    expect(
      (await listOpenTasks(org, new Date('2026-10-26T00:00:00Z'))).some((t) => t.id === task.id),
    ).toBe(false);
    expect(
      (await listOpenTasks(org, new Date('2026-10-27T15:00:00Z'))).some((t) => t.id === task.id),
    ).toBe(true);
  });
});

describe('assigning a task', () => {
  it('lists the team owner first, by their own names', async () => {
    const people = await listTaskPeople(org);
    expect(people.map((p) => [p.short, p.owner])).toEqual([
      [OWNER_FIRST, true],
      ['Riley', false],
    ]);
  });

  it('goes to someone on the team or no one, and is not a person touch', async () => {
    const task = await human('ZZ Draft the hiring post');
    const touched = await latestHumanTaskTouch(harness.store, org, task);
    at('2026-10-20T16:00:00.000Z');
    expect((await assignTask(harness.auth, task.id, DEMO_TEAMMATE.id)).ok).toBe(true);
    expect((await taskById(task.id)).assigned_to).toBe(DEMO_TEAMMATE.id);
    expect(await latestHumanTaskTouch(harness.store, org, task)).toBe(touched);

    expect((await assignTask(harness.auth, task.id, null)).ok).toBe(true);
    expect((await taskById(task.id)).assigned_to).toBeNull();

    const stranger = await assignTask(
      harness.auth,
      task.id,
      '99999999-9999-4999-8999-999999999999',
    );
    expect(stranger.ok).toBe(false);
    const [first] = await rows('task.assigned', task.id);
    expect(first?.metadata).toMatchObject({ to: DEMO_TEAMMATE.id });
  });
});
