import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { makeLiveTeam } from '../helpers/live-team';
import type { AuthContext } from '@/lib/auth/session';
import { listAllPages } from '@/lib/db/paging';
import { DEMO_TEAMMATE, DEMO_USER } from '@/lib/demo/fixtures';
import { DEMO_IDS } from '@/lib/demo/ids';
import { completeTaskWithProof, proofView, readMoneyLegal } from '@/lib/services/money-legal';
import { ingestTasks } from '@/lib/services/task-ingest';
import { assignTask, createTask, listOpenTasks, listTaskPeople } from '@/lib/services/tasks';
import { readTeam } from '@/lib/tasks/principal';
import { DEFAULT_OWNER_FIX_REASON, planDefaultOwnerFix } from '@/lib/tasks/principal-backfill';
import { defaultConfirmer } from '@/lib/tasks/task-people';
import { matchesWho } from '@/lib/tasks/tasks-view';
import type { AuditEvent, Integration, Task } from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';

/**
 * Whose work the organization's tasks are, on the demo store shaped like a
 * real team: the teammate set the organization up (its only owner) and
 * connected the mailbox, which is the demo user's, a member. Every task the
 * code files by default goes to the demo user, the principal; the owner gets
 * only what a person hands them. Every title here is invented.
 */

const PRINCIPAL = DEMO_IDS.user;
const ASSISTANT = DEMO_TEAMMATE.id;
const PRINCIPAL_FIRST = DEMO_USER.name.split(' ')[0]!;
const WIRE = 'Confirm the Tidewell pro-rata wire went out'; // the demo's one task for the teammate

let harness: Harness;
let org: string;
let principal: AuthContext;
let assistant: AuthContext;

beforeEach(async () => {
  harness = await createHarness();
  org = harness.auth.organizationId;
  ({ principal, assistant } = await makeLiveTeam(harness.store, harness.auth));
});

afterEach(async () => {
  await harness.dispose();
});

async function taskByTitle(title: string): Promise<Task> {
  const task = ((await harness.store.list('tasks', org, {})) as Task[]).find(
    (t) => t.title === title,
  );
  if (!task) throw new Error(`no task "${title}"`);
  return task;
}

async function openTitlesFor(userId: string): Promise<string[]> {
  return (await listOpenTasks(org))
    .filter((t) => matchesWho(t.assigned_to, userId))
    .map((t) => t.title)
    .sort();
}

describe('the principal', () => {
  it('is the mailbox person, found by address, not the owner who connected it', async () => {
    const team = await readTeam(harness.store, org);
    expect(team.principal).toEqual({ userId: PRINCIPAL, basis: 'mailbox_address' });
    expect(team.members.map((m) => [m.userId, m.role])).toEqual([
      [ASSISTANT, 'owner'],
      [PRINCIPAL, 'member'],
    ]);
  });
});

describe('tasks the code files by default', () => {
  it("a routine's suggestion goes to the principal; the owner stays its attribution", async () => {
    const result = await ingestTasks(harness.store, org, {
      source: 'test-routine',
      tasks: [{ title: 'ZZ Send Avery the term sheet redlines' }],
    });
    expect(result.created).toEqual(['ZZ Send Avery the term sheet redlines']);
    expect(await taskByTitle('ZZ Send Avery the term sheet redlines')).toMatchObject({
      source: 'suggested',
      assigned_to: PRINCIPAL,
      created_by: ASSISTANT,
    });
  });

  it('still goes to the principal while their mailbox needs reconnecting', async () => {
    // Google's grant lapses by itself (the sync marks it needs_reauth); the
    // routines go on reading the same person's mail meanwhile.
    for (const status of ['needs_reauth', 'disconnected'] as const) {
      await harness.store.update('integrations', org, DEMO_IDS.integrationGoogle, { status });
      const title = `ZZ Send Kit the deck (${status})`;
      await ingestTasks(harness.store, org, { source: 'test-routine', tasks: [{ title }] });
      expect((await taskByTitle(title)).assigned_to, status).toBe(PRINCIPAL);
    }
  });

  it('a follow-up the owner adds goes to the principal, made by the owner', async () => {
    const created = await createTask(assistant, { title: 'ZZ Book the LP dinner venue' });
    expect(created.ok && created.value).toMatchObject({
      source: 'human',
      assigned_to: PRINCIPAL,
      created_by: ASSISTANT,
    });
    const own = await createTask(principal, { title: 'ZZ Read the Brightkiln memo' });
    expect(own.ok && own.value.assigned_to).toBe(PRINCIPAL);
  });

  it("the owner's list holds only what a person handed them, and keeps it", async () => {
    await ingestTasks(harness.store, org, {
      source: 'test-routine',
      tasks: [{ title: 'ZZ Reply to Kit about the data room' }],
    });
    const handed = await createTask(principal, { title: 'ZZ Collect the offsite RSVPs' });
    if (!handed.ok) throw new Error('could not create');
    expect((await assignTask(principal, handed.value.id, ASSISTANT)).ok).toBe(true);

    expect(await openTitlesFor(ASSISTANT)).toEqual(['ZZ Collect the offsite RSVPs', WIRE].sort());
    expect(await openTitlesFor(PRINCIPAL)).toContain('ZZ Reply to Kit about the data room');
    expect(await openTitlesFor(PRINCIPAL)).not.toContain('ZZ Collect the offsite RSVPs');

    // A routine posting the same title again changes nothing a person chose.
    await ingestTasks(harness.store, org, {
      source: 'test-routine',
      tasks: [{ title: 'ZZ Collect the offsite RSVPs' }],
    });
    expect((await taskByTitle('ZZ Collect the offsite RSVPs')).assigned_to).toBe(ASSISTANT);
  });
});

describe('the people on Tasks', () => {
  it('list the principal first, and a money or legal close asks for their confirmation', async () => {
    const people = await listTaskPeople(org);
    expect(people.map((p) => [p.id, p.principal])).toEqual([
      [PRINCIPAL, true],
      [ASSISTANT, false],
    ]);
    expect(defaultConfirmer(people)).toBe(PRINCIPAL);

    const wire = await taskByTitle(WIRE);
    const closed = await completeTaskWithProof(assistant, wire.id, {
      kind: 'confirmed',
      confirmedBy: defaultConfirmer(people),
    });
    expect(closed.ok).toBe(true);
    const read = await readMoneyLegal(harness.store, org, [await taskByTitle(WIRE)]);
    expect(proofView(read.proofs.get(wire.id)!, people).label).toBe(
      `Closed · ${PRINCIPAL_FIRST} confirmed`,
    );
  });
});

describe('the backfill for tasks already filed under the owner', () => {
  /** A task as the old code filed it: on the owner, by default. */
  async function oldTask(title: string, over: Partial<Task> = {}): Promise<Task> {
    const now = new Date().toISOString();
    const task: Task = {
      id: newId(),
      organization_id: org,
      title,
      detail: null,
      status: 'open',
      due_at: null,
      snoozed_until: null,
      deal_id: null,
      portfolio_company_id: null,
      email_message_id: null,
      assigned_to: ASSISTANT,
      created_by: ASSISTANT,
      source: 'suggested',
      completed_at: null,
      created_at: now,
      updated_at: now,
      ...over,
    };
    await harness.store.insert('tasks', task);
    return task;
  }

  async function plan() {
    const [team, integrations, tasks, assignedRows] = await Promise.all([
      readTeam(harness.store, org),
      harness.store.list('integrations', org, {}) as Promise<Integration[]>,
      listAllPages(harness.store, 'tasks', org) as Promise<Task[]>,
      harness.store.list('audit_events', org, {
        eq: { action: 'task.assigned', entity_type: 'task' },
      }) as Promise<AuditEvent[]>,
    ]);
    return planDefaultOwnerFix({
      organizations: [{ id: org, members: team.members, integrations }],
      tasks,
      assigned: new Set(assignedRows.map((row) => row.entity_id ?? '')),
    });
  }

  /** What the SQL does with a plan: the new assignee, and the audit row. */
  async function apply(moves: Awaited<ReturnType<typeof plan>>) {
    for (const move of moves) {
      await harness.store.update('tasks', org, move.taskId, { assigned_to: move.to });
      await harness.store.insert('audit_events', {
        id: newId(),
        ...move.audit,
        ip_hash: null,
        created_at: new Date().toISOString(),
      });
    }
  }

  it('moves only what the code put on the owner by default, once', async () => {
    const open = await oldTask('ZZ Follow up with Dana on the SAFE');
    const snoozed = await oldTask('ZZ Chase the K-1s', { status: 'snoozed' });
    const done = await oldTask('ZZ Send the Q3 letter', {
      status: 'complete',
      completed_at: new Date().toISOString(),
    });
    const deleted = await oldTask('ZZ An old duplicate', { status: 'cancelled' });
    const typed = await oldTask('ZZ Order the offsite badges', { source: 'human' });
    // Handed to the principal and back by a person: that choice stands.
    const chosen = await oldTask('ZZ Book the venue walkthrough');
    expect((await assignTask(principal, chosen.id, PRINCIPAL)).ok).toBe(true);
    expect((await assignTask(principal, chosen.id, ASSISTANT)).ok).toBe(true);
    const already = await oldTask('ZZ Read the board deck', { assigned_to: PRINCIPAL });
    const wire = await taskByTitle(WIRE);

    const moves = await plan();
    expect(moves.map((m) => m.taskId).sort()).toEqual(
      [open.id, snoozed.id, done.id, wire.id].sort(),
    );
    for (const move of moves) {
      expect(move).toMatchObject({ from: ASSISTANT, to: PRINCIPAL });
      expect(move.audit).toEqual({
        organization_id: org,
        user_id: null,
        action: 'task.assigned',
        entity_type: 'task',
        entity_id: move.taskId,
        metadata: { from: ASSISTANT, to: PRINCIPAL, reason: DEFAULT_OWNER_FIX_REASON },
      });
    }
    for (const kept of [deleted, typed, chosen]) {
      expect(moves.some((m) => m.taskId === kept.id)).toBe(false);
    }
    expect(moves.some((m) => m.taskId === already.id)).toBe(false);

    await apply(moves);
    expect((await taskByTitle('ZZ Follow up with Dana on the SAFE')).assigned_to).toBe(PRINCIPAL);
    expect(await plan()).toEqual([]);
  });

  it('moves nothing when the principal is the owner, or there is no owner to move from', async () => {
    await oldTask('ZZ Follow up with Dana on the SAFE');
    // No mailbox (the one Google connection reads only the calendar): the
    // owner is the principal.
    await harness.store.update('integrations', org, DEMO_IDS.integrationGoogle, {
      kinds: ['calendar'],
    });
    expect(await plan()).toEqual([]);
    // A mailbox again, but no one holds the owner role.
    await harness.store.update('integrations', org, DEMO_IDS.integrationGoogle, {
      kinds: ['gmail', 'calendar'],
    });
    const team = await readTeam(harness.store, org);
    expect(team.principal?.userId).toBe(PRINCIPAL);
    const members = await harness.store.list('organization_members', org, {
      eq: { organization_id: org },
    });
    for (const member of members) {
      await harness.store.update('organization_members', org, member.id, { role: 'admin' });
    }
    expect(await plan()).toEqual([]);
  });

  it("leaves the owner's list with only what a person handed them", async () => {
    await oldTask('ZZ Follow up with Dana on the pilot');
    expect(await openTitlesFor(ASSISTANT)).toEqual(
      ['ZZ Follow up with Dana on the pilot', WIRE].sort(),
    );
    await apply(await plan());
    expect(await openTitlesFor(ASSISTANT)).toEqual([]);
    expect(await openTitlesFor(PRINCIPAL)).toContain('ZZ Follow up with Dana on the pilot');
  });
});
