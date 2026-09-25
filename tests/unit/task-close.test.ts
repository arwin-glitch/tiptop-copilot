import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { DEFAULT_TASK_RELAY_POSTER_IDS, resetEnvCache } from '@/lib/config/env';
import type { DataStore, QueryOptions } from '@/lib/db/store';
import { collectRelayMessages } from '@/lib/services/deal-relay';
import type { SlackMessage } from '@/lib/slack/relay-history';
import {
  applyTaskCloses,
  autoCheckStatusLine,
  autoCloseInfo,
  autoCloseView,
  collectTaskCloses,
  evidenceTime,
  gmailMessageHref,
  parseTaskCloseMessage,
  snapshotTitle,
  writeAutoClose,
  TASK_CLOSE_MARKER,
  TASK_CLOSE_PREVIEW_MARKER,
  TASK_CLOSER_PREVIEW_RUN_MARKER,
  TASK_CLOSER_RUN_MARKER,
  type TaskCloserRun,
} from '@/lib/services/task-close';
import { ingestTasks, ingestTasksFromSlack } from '@/lib/services/task-ingest';
import { mentionsNickOnly } from '@/lib/tasks/nick-only';
import {
  isRealReply,
  replyCheckClock,
  resetReplyCheckState,
  runReplyCheck,
} from '@/lib/services/task-reply-check';
import {
  createTask,
  dueAndOverdue,
  listOpenTasks,
  listSnoozedTasks,
  restoreTask,
  snoozeTask,
  updateTaskStatus,
} from '@/lib/services/tasks';
import type { AuditEvent, EmailMessage, EmailThread, Task } from '@/lib/types/domain';

// A made-up counterparty stands in for the real Nick-only ones.
vi.mock('@/lib/tasks/nick-only', async () => {
  const { wordMatcher } =
    await vi.importActual<typeof import('@/lib/tasks/nick-only')>('@/lib/tasks/nick-only');
  const { sha256 } = await vi.importActual<typeof import('@/lib/util/hash')>('@/lib/util/hash');
  return { wordMatcher, mentionsNickOnly: wordMatcher(new Set([sha256('zzfund')])) };
});

/**
 * Closing tasks from the task-closer's posts, and the app's own "Reply to"
 * check. The property that matters most is that a person always wins: a
 * Reopen, an Undo, a snooze or creating a task by hand outranks any evidence
 * older than it, however often the same window is re-read. Every name,
 * address and id here is invented.
 */

const TICK = String.fromCharCode(96);
const POSTER = DEFAULT_TASK_RELAY_POSTER_IDS[0]!;
const CHICAGO = 'America/Chicago';
const SAVED = { ...process.env };

let harness: Harness;
let org: string;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-22T15:00:00.000Z'));
  harness = await createHarness();
  org = harness.auth.organizationId;
  resetReplyCheckState();
});

afterEach(async () => {
  vi.useRealTimers();
  await harness.dispose();
  for (const key of Object.keys(process.env)) {
    if (!(key in SAVED)) delete process.env[key];
  }
  Object.assign(process.env, SAVED);
  resetEnvCache();
  resetReplyCheckState();
});

/* ---------------------------------------------------------------- helpers */

const at = (iso: string) => vi.setSystemTime(new Date(iso));
const slackTs = (iso: string) => `${Math.floor(Date.parse(iso) / 1000)}.000100`;

interface CloseInput {
  title: string;
  evidence_at: string;
  task_id?: string;
  evidenceId?: string;
  kind?: string;
}

function close(input: CloseInput): Record<string, unknown> {
  return {
    ...(input.task_id ? { task_id: input.task_id } : {}),
    title: input.title,
    kind: input.kind ?? 'reply',
    evidence_at: input.evidence_at,
    evidence: {
      type: 'gmail_sent',
      id: input.evidenceId ?? 'abc0000000000001',
      thread_id: 'abc0000000000000',
      to: ['zed@zz-close.example'],
    },
    reason: 'Sent the answer the founder asked for.',
  };
}

function text(marker: string, body: unknown): string {
  return `${marker}\n${TICK}${JSON.stringify(body)}${TICK}`;
}

function closeMessage(
  closes: unknown[],
  postedAt: string,
  extra: { user?: string; subtype?: string; marker?: string } = {},
): SlackMessage {
  const body = { v: 1, source: 'task-closer', batch: postedAt, part: 1, parts: 1, closes };
  return {
    ts: slackTs(postedAt),
    user: extra.user ?? POSTER,
    ...(extra.subtype ? { subtype: extra.subtype } : {}),
    text: text(extra.marker ?? TASK_CLOSE_MARKER, body),
  };
}

function runMessage(
  run: Partial<TaskCloserRun>,
  postedAt: string,
  marker = TASK_CLOSER_RUN_MARKER,
) {
  const body = {
    v: 1,
    source: 'task-closer',
    run_at: postedAt,
    local_date: '2026-09-22',
    list: 'suggested',
    snapshot_batch: null,
    checked: 10,
    closed: 2,
    near_misses: 3,
    excluded: 0,
    unchecked: 0,
    ...run,
  };
  return { ts: slackTs(postedAt), user: POSTER, text: text(marker, body) };
}

/** Collects a window given oldest first (Slack serves newest first) and applies it. */
async function applyWindow(messages: SlackMessage[]) {
  const collected = collectTaskCloses([...messages].reverse(), [POSTER]);
  return applyTaskCloses(harness.store, org, collected.closes, {
    rejected: collected.rejected.messages + collected.rejected.closes,
  });
}

async function taskById(id: string): Promise<Task> {
  const task = (await harness.store.get('tasks', org, id)) as Task | null;
  if (!task) throw new Error(`no task ${id}`);
  return task;
}

async function suggested(title: string): Promise<Task> {
  await ingestTasks(harness.store, org, { source: 'test', tasks: [{ title }] });
  const all = (await harness.store.list('tasks', org, { eq: { title } })) as Task[];
  return all[0]!;
}

async function human(title: string): Promise<Task> {
  const created = await createTask(harness.auth, { title });
  if (!created.ok) throw new Error('could not create');
  return created.value;
}

async function autoRows(taskId: string): Promise<AuditEvent[]> {
  return (await harness.store.list('audit_events', org, {
    eq: { action: 'task.auto_completed', entity_id: taskId },
  })) as AuditEvent[];
}

/* ---------------------------------------------------------------- parsing */

describe('parseTaskCloseMessage', () => {
  const body = {
    v: 1,
    source: 'task-closer',
    batch: '2026-09-25T21:08:03Z',
    part: 1,
    parts: 1,
    closes: [close({ title: 'ZZ Send the deck', evidence_at: '2026-09-22T20:43:15Z' })],
  };

  it('needs the exact marker alone on the first line', () => {
    expect(parseTaskCloseMessage(text(TASK_CLOSE_MARKER, body))?.kind).toBe('close');
    expect(parseTaskCloseMessage(`TASK_CLOSE_V1 ${TICK}${JSON.stringify(body)}${TICK}`)).toBeNull();
    expect(parseTaskCloseMessage(text('TASK_CLOSE_V1x', body))).toBeNull();
    expect(parseTaskCloseMessage(text('XTASK_CLOSE_V1', body))).toBeNull();
    expect(parseTaskCloseMessage(text('TASK_ADD_V1', body))).toBeNull();
    expect(parseTaskCloseMessage(42)).toBeNull();
  });

  it('ignores the preview markers, which a person checks and the app never applies', () => {
    expect(parseTaskCloseMessage(text(TASK_CLOSE_PREVIEW_MARKER, body))).toBeNull();
    const run = { v: 1, source: 'task-closer', local_date: '2026-09-25', closed: 1 };
    expect(parseTaskCloseMessage(text(TASK_CLOSER_PREVIEW_RUN_MARKER, run))).toBeNull();
    const collected = collectTaskCloses(
      [
        closeMessage(body.closes, '2026-09-25T21:08:03Z', { marker: TASK_CLOSE_PREVIEW_MARKER }),
        runMessage({}, '2026-09-25T21:09:00Z', TASK_CLOSER_PREVIEW_RUN_MARKER),
      ],
      [POSTER],
    );
    expect(collected.closes).toEqual([]);
    expect(collected.lastRun).toBeNull();
    expect(collected.rejected).toEqual({ messages: 0, closes: 0 });
  });

  it('unwraps Slack entities and mailto links before parsing', () => {
    const raw = text(TASK_CLOSE_MARKER, {
      ...body,
      closes: [
        {
          ...close({ title: 'ZZ Intro A <> B', evidence_at: '2026-09-22T20:43:15Z' }),
          evidence: {
            type: 'gmail_sent',
            id: 'abc0000000000001',
            to: ['<mailto:zed@zz-close.example|zed@zz-close.example>'],
          },
          reason: 'Intro sent & confirmed',
        },
      ],
    })
      .replaceAll('&', '&amp;')
      .replaceAll(' <> ', ' &lt;&gt; ')
      .replace('"<mailto:', '"<mailto:');
    const parsed = parseTaskCloseMessage(raw);
    expect(parsed?.kind).toBe('close');
    if (parsed?.kind !== 'close') return;
    expect(parsed.closes[0]?.title).toBe('ZZ Intro A <> B');
    expect(parsed.closes[0]?.reason).toBe('Intro sent & confirmed');
    expect(parsed.closes[0]?.evidence.to).toEqual(['zed@zz-close.example']);
  });

  it('gives null for a body that is not JSON', () => {
    expect(parseTaskCloseMessage(`TASK_CLOSE_V1\n${TICK}{not json${TICK}`)).toBeNull();
    expect(parseTaskCloseMessage('TASK_CLOSE_V1\nno backticks here')).toBeNull();
    expect(parseTaskCloseMessage(text(TASK_CLOSE_MARKER, [1, 2]))).toBeNull();
  });

  it('drops one bad close and keeps the rest', () => {
    const parsed = parseTaskCloseMessage(
      text(TASK_CLOSE_MARKER, {
        ...body,
        closes: [
          close({ title: 'ZZ One', evidence_at: '2026-09-22T20:43:15Z' }),
          { ...close({ title: 'ZZ Two', evidence_at: 'yesterday' }) },
          { ...close({ title: 'ZZ Three', evidence_at: '2026-09-22T20:43:15Z' }), kind: 'vibes' },
          close({ title: 'ZZ Four', evidence_at: '2026-09-22T20:43:15-05:00' }),
          { ...close({ title: 'ZZ Five', evidence_at: '2026-09-22T20:43:15Z' }), task_id: 'nope' },
          { ...close({ title: 'ZZ Six', evidence_at: '2026-09-22T20:43:15Z' }), task_id: null },
        ],
      }),
    );
    expect(parsed?.kind).toBe('close');
    if (parsed?.kind !== 'close') return;
    expect(parsed.closes.map((c) => c.title)).toEqual(['ZZ One', 'ZZ Four', 'ZZ Six']);
    expect(parsed.rejected).toBe(3);
  });

  it('rejects a message with more than 20 closes, or none, or the wrong source', () => {
    const many = Array.from({ length: 21 }, (_, i) =>
      close({ title: `ZZ ${i}`, evidence_at: '2026-09-22T20:43:15Z' }),
    );
    expect(parseTaskCloseMessage(text(TASK_CLOSE_MARKER, { ...body, closes: many }))).toBeNull();
    expect(parseTaskCloseMessage(text(TASK_CLOSE_MARKER, { ...body, closes: [] }))).toBeNull();
    expect(
      parseTaskCloseMessage(text(TASK_CLOSE_MARKER, { ...body, source: 'someone-else' })),
    ).toBeNull();
    expect(parseTaskCloseMessage(text(TASK_CLOSE_MARKER, { ...body, v: 2 }))).toBeNull();
  });

  it('reads a run record leniently', () => {
    const parsed = parseTaskCloseMessage(
      text(TASK_CLOSER_RUN_MARKER, {
        v: 1,
        source: 'task-closer',
        run_at: '2026-09-25T21:08:03Z',
        local_date: '2026-09-25',
        list: 'suggested',
        checked: 10,
        closed: 'four',
      }),
    );
    expect(parsed).toMatchObject({
      kind: 'run',
      run: { local_date: '2026-09-25', list: 'suggested', checked: 10, closed: 0 },
    });
  });
});

describe('collectTaskCloses', () => {
  it('reads only the allowed poster, never a message with a subtype, oldest first', () => {
    const c = (title: string) => [close({ title, evidence_at: '2026-09-22T20:00:00Z' })];
    const collected = collectTaskCloses(
      [
        closeMessage(c('ZZ Newest'), '2026-09-22T22:00:00Z'),
        closeMessage(c('ZZ Stranger'), '2026-09-22T21:30:00Z', { user: 'U0SOMEONE1' }),
        closeMessage(c('ZZ Edited'), '2026-09-22T21:20:00Z', { subtype: 'message_changed' }),
        { ts: slackTs('2026-09-22T21:10:00Z'), text: 'no user at all' },
        closeMessage(c('ZZ Oldest'), '2026-09-22T21:00:00Z'),
      ],
      [POSTER],
    );
    expect(collected.closes.map((x) => x.close.title)).toEqual(['ZZ Oldest', 'ZZ Newest']);
    expect(collected.closes[0]?.postedAt).toBe('2026-09-22T21:00:00.000Z');
  });

  it('counts an unreadable message that carries the marker, and keeps the newest run record', () => {
    const collected = collectTaskCloses(
      [
        runMessage({ closed: 4 }, '2026-09-23T21:08:00Z'),
        { ts: slackTs('2026-09-23T21:07:00Z'), user: POSTER, text: 'TASK_CLOSE_V1\n`{oops`' },
        runMessage({ closed: 1 }, '2026-09-22T21:08:00Z'),
        { ts: slackTs('2026-09-22T21:00:00Z'), user: POSTER, text: 'ordinary chatter' },
      ],
      [POSTER],
    );
    expect(collected.rejected.messages).toBe(1);
    expect(collected.lastRun?.run.closed).toBe(4);
    expect(collected.lastRun?.ts).toBe('2026-09-23T21:08:00.000Z');
  });
});

describe('the deal relay reads the same channel', () => {
  it('neither parses nor rejects task-closer posts', () => {
    const body = {
      v: 1,
      source: 'task-closer',
      closes: [close({ title: 'ZZ Task', evidence_at: '2026-09-22T20:00:00Z' })],
    };
    const collected = collectRelayMessages([
      { ts: '1790000100.000100', user: POSTER, text: text(TASK_CLOSE_MARKER, body) },
      { ts: '1790000101.000100', user: POSTER, text: text(TASK_CLOSER_RUN_MARKER, { v: 1 }) },
      { ts: '1790000102.000100', user: POSTER, text: text(TASK_CLOSE_PREVIEW_MARKER, body) },
      { ts: '1790000103.000100', user: 'U0BOT00001', text: text('TASK_OPEN_V1', { v: 1 }) },
    ]);
    expect(collected.rejected.total).toBe(0);
    expect(collected.parsedMessages).toBe(0);
    expect(collected.observations).toEqual([]);
  });
});

/* --------------------------------------------------------------- matching */

describe('matching a close to a task', () => {
  it('closes by task_id when the title agrees, however it is spaced or cased', async () => {
    const task = await human('ZZ Send Pia the data room');
    at('2026-09-22T18:00:00Z');
    const counts = await applyWindow([
      closeMessage(
        [
          close({
            task_id: task.id,
            title: '  zz send pia   the data room ',
            evidence_at: '2026-09-22T17:00:00Z',
          }),
        ],
        '2026-09-22T17:30:00Z',
      ),
    ]);
    expect(counts.closed).toBe(1);
    expect((await taskById(task.id)).status).toBe('complete');
    const [row] = await autoRows(task.id);
    expect(row).toMatchObject({ user_id: null, entity_type: 'task' });
    expect(row?.metadata).toMatchObject({
      source: 'task-closer',
      match: 'id',
      kind: 'reply',
      evidence_type: 'gmail_sent',
      evidence_id: 'abc0000000000001',
      evidence_at: '2026-09-22T17:00:00.000Z',
      slack_ts: slackTs('2026-09-22T17:30:00Z'),
    });
  });

  it('skips a task_id whose task has a different title', async () => {
    const task = await human('ZZ Book the Arbor call');
    at('2026-09-22T18:00:00Z');
    const counts = await applyWindow([
      closeMessage(
        [close({ task_id: task.id, title: 'ZZ Something else', evidence_at: '2026-09-22T17:00Z' })],
        '2026-09-22T17:30:00Z',
      ),
    ]);
    expect(counts).toMatchObject({ closed: 0, skipped: { id_title_mismatch: 1 } });
    expect((await taskById(task.id)).status).toBe('open');
  });

  it('closes the one suggested task with that title, and falls back to it from an unknown id', async () => {
    const one = await suggested('ZZ Send Bo the shortlist');
    const two = await suggested('ZZ Tell Cy about the tax form');
    at('2026-09-22T18:00:00Z');
    const counts = await applyWindow([
      closeMessage(
        [
          close({ title: 'ZZ Send Bo the shortlist', evidence_at: '2026-09-22T16:00:00Z' }),
          close({
            task_id: '99999999-9999-4999-8999-999999999999',
            title: 'ZZ Tell Cy about the tax form',
            evidence_at: '2026-09-22T16:00:00Z',
            evidenceId: 'abc0000000000002',
          }),
        ],
        '2026-09-22T17:00:00Z',
      ),
    ]);
    expect(counts.closed).toBe(2);
    expect((await taskById(one.id)).status).toBe('complete');
    expect((await taskById(two.id)).status).toBe('complete');
    expect((await autoRows(two.id))[0]?.metadata.match).toBe('title');
  });

  it('skips a title that more than one open suggested task has', async () => {
    const first = await suggested('ZZ Nudge for the SAFE');
    await harness.store.insert('tasks', {
      ...first,
      id: '99999999-9999-4999-8999-000000000001',
      title: 'zz nudge  for the SAFE',
    });
    at('2026-09-22T18:00:00Z');
    const counts = await applyWindow([
      closeMessage(
        [close({ title: 'ZZ Nudge for the SAFE', evidence_at: '2026-09-22T16:00Z' })],
        '2026-09-22T17:00Z',
      ),
    ]);
    expect(counts).toMatchObject({ closed: 0, skipped: { ambiguous: 1 } });
  });

  it('accepts a title as the snapshot clipped it, or as Slack auto-linked it', async () => {
    const long = await human(`ZZ Send the ${TICK}v2${TICK} deck ${'and the appendix '.repeat(15)}`);
    const linked = await human('ZZ Send the deck to zeta.example');
    const bare = await suggested('ZZ Share the memo on zz-memo.example');
    expect(snapshotTitle(long.title)).toHaveLength(200);
    expect(snapshotTitle(long.title)).toContain("'v2'");
    at('2026-09-22T18:00:00Z');
    const counts = await applyWindow([
      closeMessage(
        [
          close({
            task_id: long.id,
            title: snapshotTitle(long.title),
            evidence_at: '2026-09-22T17:00Z',
          }),
          close({
            task_id: linked.id,
            title: 'ZZ Send the deck to http://zeta.example',
            evidence_at: '2026-09-22T17:00Z',
            evidenceId: 'abc0000000000011',
          }),
          close({
            title: 'ZZ Share the memo on http://zz-memo.example',
            evidence_at: '2026-09-22T17:00Z',
            evidenceId: 'abc0000000000012',
          }),
        ],
        '2026-09-22T17:30:00Z',
      ),
    ]);
    expect(counts).toMatchObject({ closed: 3, skipped: {} });
    for (const task of [long, linked, bare]) {
      expect((await taskById(task.id)).status).toBe('complete');
    }
  });

  it('never closes a task a person created by its title alone', async () => {
    const task = await human('ZZ Reply to Dana');
    at('2026-09-22T18:00:00Z');
    const counts = await applyWindow([
      closeMessage(
        [close({ title: 'ZZ Reply to Dana', evidence_at: '2026-09-22T16:00Z' })],
        '2026-09-22T17:00Z',
      ),
    ]);
    expect(counts).toMatchObject({ closed: 0, skipped: { no_open_match: 1 } });
    expect((await taskById(task.id)).status).toBe('open');
  });

  it('leaves a task a person already completed alone', async () => {
    const task = await human('ZZ Pay the invoice');
    await updateTaskStatus(harness.auth, task.id, 'complete');
    at('2026-09-22T18:00:00Z');
    const counts = await applyWindow([
      closeMessage(
        [close({ task_id: task.id, title: task.title, evidence_at: '2026-09-22T17:00Z' })],
        '2026-09-22T17:30Z',
      ),
    ]);
    expect(counts).toMatchObject({ closed: 0, skipped: { not_open: 1 } });
    expect(await autoRows(task.id)).toEqual([]);
  });
});

/* -------------------------------------------------------- the person wins */

describe('a person always wins', () => {
  it('does not re-close a task reopened after an auto-close, until newer evidence arrives', async () => {
    const task = await suggested('ZZ Send Dee the decks');
    const first = closeMessage(
      [close({ title: task.title, evidence_at: '2026-09-22T16:00Z' })],
      '2026-09-22T21:00Z',
    );
    at('2026-09-22T21:05:00Z');
    expect((await applyWindow([first])).closed).toBe(1);

    at('2026-09-23T09:00:00Z');
    await updateTaskStatus(harness.auth, task.id, 'open');
    at('2026-09-23T09:05:00Z');
    const again = await applyWindow([first]);
    expect(again).toMatchObject({ closed: 0, skipped: { person_newer: 1 } });
    expect((await taskById(task.id)).status).toBe('open');

    const newer = closeMessage(
      [
        close({
          task_id: task.id,
          title: task.title,
          evidence_at: '2026-09-23T15:00Z',
          evidenceId: 'abc0000000000009',
        }),
      ],
      '2026-09-23T21:00Z',
    );
    at('2026-09-23T21:05:00Z');
    expect((await applyWindow([first, newer])).closed).toBe(1);
    expect((await taskById(task.id)).status).toBe('complete');
    expect(await autoRows(task.id)).toHaveLength(2);
  });

  it('keeps a task open after a manual complete and Undo, against older evidence', async () => {
    const task = await suggested('ZZ Answer the LP');
    at('2026-09-22T17:00:00Z');
    await updateTaskStatus(harness.auth, task.id, 'complete');
    at('2026-09-22T17:00:05Z');
    await restoreTask(harness.auth, task.id, { status: 'open' });
    at('2026-09-22T21:05:00Z');
    const counts = await applyWindow([
      closeMessage(
        [close({ title: task.title, evidence_at: '2026-09-22T16:30Z' })],
        '2026-09-22T21:00Z',
      ),
    ]);
    expect(counts).toMatchObject({ closed: 0, skipped: { person_newer: 1 } });
    expect((await taskById(task.id)).status).toBe('open');
  });

  it('closes a snoozed task only on evidence after the snooze, even one still asleep', async () => {
    const task = await suggested('ZZ Follow up with Eli');
    at('2026-09-22T17:00:00Z');
    await snoozeTask(harness.auth, task.id, '2026-09-29T14:00:00.000Z');
    at('2026-09-22T21:05:00Z');
    const before = closeMessage(
      [close({ title: task.title, evidence_at: '2026-09-22T16:59Z' })],
      '2026-09-22T21:00Z',
    );
    expect(await applyWindow([before])).toMatchObject({ skipped: { person_newer: 1 } });
    expect((await taskById(task.id)).status).toBe('snoozed');

    const after = closeMessage(
      [
        close({
          title: task.title,
          evidence_at: '2026-09-22T18:00Z',
          evidenceId: 'abc0000000000003',
        }),
      ],
      '2026-09-22T21:01Z',
    );
    expect((await applyWindow([before, after])).closed).toBe(1);
    const closed = await taskById(task.id);
    expect(closed).toMatchObject({ status: 'complete', snoozed_until: null });
  });

  it('never counts evidence from before a person created the task', async () => {
    at('2026-09-22T17:00:00Z');
    const task = await human('ZZ Introduce Fay to Gus');
    at('2026-09-22T21:05:00Z');
    const counts = await applyWindow([
      closeMessage(
        [close({ task_id: task.id, title: task.title, evidence_at: '2026-09-22T16:00Z' })],
        '2026-09-22T21:00Z',
      ),
    ]);
    expect(counts).toMatchObject({ closed: 0, skipped: { person_newer: 1 } });
  });

  it('clamps evidence dated in the future to the time it was posted', async () => {
    expect(evidenceTime('2026-10-01T00:00:00Z', '2026-09-22T21:00:00.000Z')).toBe(
      Date.parse('2026-09-22T21:00:00Z'),
    );
    const task = await suggested('ZZ Book the Zephyr call');
    at('2026-09-22T21:30:00Z');
    await snoozeTask(harness.auth, task.id, '2026-09-24T14:00:00.000Z');
    at('2026-09-22T22:00:00Z');
    // Posted before the snooze, "dated" after it: it counts from the post, so the snooze wins.
    const future = closeMessage(
      [close({ title: task.title, evidence_at: '2026-10-01T00:00Z' })],
      '2026-09-22T21:00Z',
    );
    expect(await applyWindow([future])).toMatchObject({ skipped: { person_newer: 1 } });

    const other = await suggested('ZZ Send the pipeline list');
    at('2026-09-22T22:10:00Z');
    await applyWindow([
      closeMessage(
        [close({ title: other.title, evidence_at: '2026-10-01T00:00Z' })],
        '2026-09-22T22:05Z',
      ),
    ]);
    expect((await autoRows(other.id))[0]?.metadata.evidence_at).toBe('2026-09-22T22:05:00.000Z');
  });

  it('closes a suggested task on evidence a little before its post, not a week before', async () => {
    at('2026-09-22T20:36:00Z');
    const recent = await suggested('ZZ Send Hal a shortlist');
    const stale = await suggested('ZZ Send Carla the old memo');
    at('2026-09-22T21:05:00Z');
    const counts = await applyWindow([
      closeMessage(
        [
          close({ title: recent.title, evidence_at: '2026-09-22T20:30:00Z' }),
          close({
            title: stale.title,
            evidence_at: '2026-09-14T20:30:00Z',
            evidenceId: 'abc0000000000004',
          }),
        ],
        '2026-09-22T21:00Z',
      ),
    ]);
    expect(counts).toMatchObject({ closed: 1, skipped: { evidence_too_old: 1 } });
    expect((await taskById(recent.id)).status).toBe('complete');
    expect((await taskById(stale.id)).status).toBe('open');
  });

  it('changes a task once however often the same window is read', async () => {
    const task = await suggested('ZZ Intro Ivy to Jo');
    const window = [
      closeMessage(
        [close({ title: task.title, evidence_at: '2026-09-22T16:00Z' })],
        '2026-09-22T21:00Z',
      ),
    ];
    at('2026-09-22T21:05:00Z');
    expect((await applyWindow(window)).closed).toBe(1);
    at('2026-09-22T21:06:00Z');
    expect((await applyWindow(window)).closed).toBe(0);
    expect(await autoRows(task.id)).toHaveLength(1);
    const updates = (await harness.store.list('audit_events', org, {
      eq: { entity_id: task.id },
    })) as AuditEvent[];
    expect(updates.map((u) => u.action).sort()).toEqual(['task.auto_completed', 'task.created']);
  });

  it('counts from the latest touch: a snooze, then the evidence, then an unsnooze keeps it open', async () => {
    const task = await suggested('ZZ Send Kai the notes');
    at('2026-09-22T16:00:00Z');
    await snoozeTask(harness.auth, task.id, '2026-09-29T14:00:00.000Z');
    at('2026-09-22T18:00:00Z');
    await updateTaskStatus(harness.auth, task.id, 'open');
    at('2026-09-22T21:05:00Z');
    const counts = await applyWindow([
      closeMessage(
        [close({ title: task.title, evidence_at: '2026-09-22T17:00Z' })],
        '2026-09-22T21:00Z',
      ),
    ]);
    expect(counts).toMatchObject({ closed: 0, skipped: { person_newer: 1 } });
    expect((await taskById(task.id)).status).toBe('open');
  });

  it('needs evidence strictly after the touch, not at the same instant', async () => {
    const task = await suggested('ZZ Send Lu the terms');
    at('2026-09-22T17:00:00Z');
    await snoozeTask(harness.auth, task.id, '2026-09-29T14:00:00.000Z');
    at('2026-09-22T21:05:00Z');
    const counts = await applyWindow([
      closeMessage(
        [close({ title: task.title, evidence_at: '2026-09-22T17:00:00Z' })],
        '2026-09-22T21:00Z',
      ),
    ]);
    expect(counts).toMatchObject({ closed: 0, skipped: { person_newer: 1 } });
  });

  it('never applies the same evidence twice, even if a Reopen left no audit row', async () => {
    const task = await suggested('ZZ Send Mo the model');
    const window = [
      closeMessage(
        [close({ title: task.title, evidence_at: '2026-09-22T16:00Z' })],
        '2026-09-22T21:00Z',
      ),
    ];
    at('2026-09-22T21:05:00Z');
    expect((await applyWindow(window)).closed).toBe(1);
    // A Reopen whose audit write was lost: open again, with no person's row.
    await harness.store.update('tasks', org, task.id, { status: 'open', completed_at: null });
    at('2026-09-22T21:10:00Z');
    expect(await applyWindow(window)).toMatchObject({
      closed: 0,
      skipped: { already_applied: 1 },
    });
    expect((await taskById(task.id)).status).toBe('open');
  });

  it('re-reads the task just before writing, and leaves a completed one alone', async () => {
    const task = await suggested('ZZ Send Nia the list');
    await updateTaskStatus(harness.auth, task.id, 'complete');
    const written = await writeAutoClose(
      harness.store,
      org,
      task.id,
      {
        source: 'task-closer',
        match: 'title',
        kind: 'send_doc',
        evidence_type: 'gmail_sent',
        evidence_id: 'abc0000000000021',
        thread_id: null,
        evidence_at: '2026-09-22T16:00:00.000Z',
        reason: 'Sent the list.',
        slack_ts: null,
      },
      new Date('2026-09-22T21:00:00Z'),
    );
    expect(written).toBe('not_open');
    expect(await autoRows(task.id)).toEqual([]);
  });
});

/* ------------------------------------------------ Completed and the status */

describe('what the Completed tab shows', () => {
  it('labels an auto-close with its evidence, until a person reopens and completes it', async () => {
    const task = await suggested('ZZ Send Cy the tax answer');
    const book = await suggested('ZZ Book the Arbor call');
    at('2026-09-22T21:05:00Z');
    await applyWindow([
      closeMessage(
        [
          close({ title: task.title, evidence_at: '2026-09-22T20:43:15Z' }),
          {
            ...close({ title: book.title, evidence_at: '2026-09-23T02:00:00Z', kind: 'meeting' }),
            evidence: { type: 'calendar_event', id: 'zzevent01' },
          },
        ],
        '2026-09-23T03:00Z',
      ),
    ]);
    let info = await autoCloseInfo(harness.store, org, [task.id, book.id]);
    const record = info.get(task.id)!;
    expect(autoCloseView(record, CHICAGO, 'nick@tiptop.demo')).toEqual({
      label: 'Closed automatically · email sent Sep 22',
      href: 'https://mail.google.com/mail/?authuser=nick@tiptop.demo#all/abc0000000000001',
      reason: 'Sent the answer the founder asked for.',
    });
    // 02:00 UTC on the 23rd is still the 22nd in Chicago.
    expect(autoCloseView(info.get(book.id)!, CHICAGO, 'nick@tiptop.demo')).toMatchObject({
      label: 'Closed automatically · meeting booked Sep 22',
      href: null,
    });

    at('2026-09-23T10:00:00Z');
    await updateTaskStatus(harness.auth, task.id, 'open');
    at('2026-09-23T11:00:00Z');
    await updateTaskStatus(harness.auth, task.id, 'complete');
    info = await autoCloseInfo(harness.store, org, [task.id, book.id]);
    expect(info.has(task.id)).toBe(false);
    expect(info.has(book.id)).toBe(true);
  });

  it('links a Gmail message by account, and nothing for an id that is not one', () => {
    expect(gmailMessageHref('nick@tiptop.demo', '1f2e3d4c5b6a7980')).toBe(
      'https://mail.google.com/mail/?authuser=nick@tiptop.demo#all/1f2e3d4c5b6a7980',
    );
    expect(gmailMessageHref('nick@tiptop.demo', 'javascript:alert(1)')).toBeNull();
    expect(gmailMessageHref('nick@tiptop.demo', null)).toBeNull();
  });
});

describe('the status line on To do', () => {
  const run = (over: Partial<TaskCloserRun> = {}): { run: TaskCloserRun; ts: string } => ({
    run: {
      run_at: '2026-09-25T21:08:03Z',
      local_date: '2026-09-25',
      list: 'suggested',
      snapshot_batch: null,
      checked: 10,
      closed: 2,
      near_misses: 3,
      excluded: 0,
      unchecked: 0,
      ...over,
    },
    ts: '2026-09-25T21:08:30.000Z',
  });

  it('says when today’s check ran and what it closed', () => {
    expect(autoCheckStatusLine(run(), new Date('2026-09-25T21:30:00Z'), CHICAGO)).toBe(
      "Auto-check ran today at 4:08 PM · closed 2 · only suggested and 'Reply to' tasks are checked",
    );
    expect(
      autoCheckStatusLine(run({ list: 'snapshot' }), new Date('2026-09-25T21:30:00Z'), CHICAGO),
    ).toBe('Auto-check ran today at 4:08 PM · closed 2');
  });

  it('says so after 5:30 PM Central with no run today, and shows the last run before then', () => {
    const yesterday = run({ run_at: '2026-09-24T21:08:03Z', local_date: '2026-09-24', closed: 1 });
    expect(autoCheckStatusLine(yesterday, new Date('2026-09-25T22:29:00Z'), CHICAGO)).toBe(
      "Auto-check last ran Sep 24 at 4:08 PM · closed 1 · only suggested and 'Reply to' tasks are checked",
    );
    expect(autoCheckStatusLine(yesterday, new Date('2026-09-25T22:30:00Z'), CHICAGO)).toBe(
      "Today's 4 PM Central auto-check hasn't reported yet · only suggested and 'Reply to' tasks are checked",
    );
    expect(autoCheckStatusLine(null, new Date('2026-09-25T23:00:00Z'), CHICAGO)).toBeNull();
  });
});

/* ------------------------------------------------------------ reply check */

describe('the app’s own "Reply to" check', () => {
  const NICK = 'nick@tiptop.vc';
  let n = 0;

  beforeEach(async () => {
    const [integration] = await harness.store.list('integrations', org, {});
    await harness.store.update('integrations', org, integration!.id, { account_email: NICK });
  });

  function message(
    threadId: string,
    over: Partial<EmailMessage> & { sent_at: string },
  ): EmailMessage {
    n++;
    return {
      id: `99999999-0000-4000-8000-${String(n).padStart(12, '0')}`,
      organization_id: org,
      thread_id: threadId,
      provider: 'google',
      provider_message_id: `abcd${String(n).padStart(12, '0')}`,
      subject: 'Re: Question',
      snippet: 'Here are the numbers you asked for.',
      from_name: null,
      from_address: NICK,
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
  }

  /** A thread with an inbound question from `sender`, and a "Reply to" task made from it. */
  async function inboxTask(name: string, sender: string, reply?: Partial<EmailMessage>) {
    const threadId = `99999999-1111-4000-8000-${String(++n).padStart(12, '0')}`;
    const thread: EmailThread = {
      id: threadId,
      organization_id: org,
      provider: 'google',
      provider_thread_id: `feed${String(n).padStart(12, '0')}`,
      subject: `Question from ${name}`,
      last_message_at: '2026-09-25T15:00:00.000Z',
      message_count: 2,
      created_at: '2026-09-25T15:00:00.000Z',
      updated_at: '2026-09-25T15:00:00.000Z',
    };
    await harness.store.insert('email_threads', thread);
    const source = message(threadId, {
      sent_at: '2026-09-25T15:00:00.000Z',
      from_address: sender,
      to_addresses: [NICK],
      labels: ['INBOX'],
    });
    await harness.store.insert('email_messages', source);
    at('2026-09-25T15:30:00Z');
    const created = await createTask(harness.auth, {
      title: `Reply to ${name}`,
      emailMessageId: source.id,
    });
    if (!created.ok) throw new Error('no task');
    if (reply) {
      await harness.store.insert(
        'email_messages',
        message(threadId, {
          sent_at: '2026-09-25T18:00:00.000Z',
          to_addresses: [sender],
          ...reply,
        }),
      );
    }
    return created.value;
  }

  it('closes on a real sent reply, and nothing that only looks like one', async () => {
    const real = await inboxTask('Zed', 'zed@zz-reply.example', {});
    const cases = await Promise.all([
      inboxTask('Draft', 'a@zz-reply.example', { labels: ['DRAFT'] }),
      inboxTask('SentDraft', 'b@zz-reply.example', { labels: ['SENT', 'DRAFT'] }),
      inboxTask('Auto', 'c@zz-reply.example', { subject: 'Slow to respond Re: Question' }),
      inboxTask('Ooo', 'd@zz-reply.example', {
        snippet:
          "Thank you for your email. I'm currently out of the office as we welcome our first",
      }),
      inboxTask('Holding', 'e@zz-reply.example', {
        snippet: "Arwin here, Nick's EA. I've flagged this for him and he'll follow up.",
      }),
      inboxTask('Early', 'f@zz-reply.example', { sent_at: '2026-09-25T15:10:00.000Z' }),
      inboxTask('Elsewhere', 'g@zz-reply.example', { to_addresses: ['other@zz-reply.example'] }),
      inboxTask('FromOther', 'h@zz-reply.example', { from_address: 'arwin@zz-reply.example' }),
    ]);
    // A task made from the mailbox's own message is never "a reply owed".
    const own = await inboxTask('Self', NICK, {});

    at('2026-09-25T21:05:00Z');
    const outcome = await runReplyCheck(harness.store, org, {
      now: new Date('2026-09-25T21:05:00Z'),
      enabled: true,
    });
    expect(outcome).toMatchObject({
      state: 'ran',
      localDate: '2026-09-25',
      checked: 10,
      closed: 1,
    });
    expect((await taskById(real.id)).status).toBe('complete');
    for (const task of [...cases, own]) expect((await taskById(task.id)).status).toBe('open');
    expect((await autoRows(real.id))[0]?.metadata).toMatchObject({
      source: 'app-reply-check',
      match: 'thread',
      kind: 'reply',
      evidence_type: 'gmail_sent',
      evidence_at: '2026-09-25T18:00:00.000Z',
      reason: 'Reply sent in the same email thread',
    });
  });

  it('runs at 4:00 PM Central, not 3:59, and once a day', async () => {
    const task = await inboxTask('Zed', 'zed@zz-reply.example', {});
    const check = (iso: string) =>
      runReplyCheck(harness.store, org, { now: new Date(iso), enabled: true });
    expect((await check('2026-09-25T20:59:00Z')).state).toBe('not_yet');
    expect((await taskById(task.id)).status).toBe('open');
    expect((await check('2026-09-25T21:00:00Z')).state).toBe('ran');
    expect((await taskById(task.id)).status).toBe('complete');

    await updateTaskStatus(harness.auth, task.id, 'open');
    resetReplyCheckState(); // the day is also remembered in the audit trail
    expect((await check('2026-09-25T23:00:00Z')).state).toBe('done_today');
    const sweeps = await harness.store.list('audit_events', org, {
      eq: { action: 'task.autoclose_sweep' },
    });
    expect(sweeps).toHaveLength(1);
    expect(sweeps[0]).toMatchObject({ user_id: null, entity_type: 'organization', entity_id: org });
  });

  it('keeps to 4pm Central across daylight saving', () => {
    expect(replyCheckClock(new Date('2026-11-01T21:30:00Z')).due).toBe(false); // 15:30 CST
    expect(replyCheckClock(new Date('2026-11-01T22:05:00Z')).due).toBe(true); // 16:05 CST
    expect(replyCheckClock(new Date('2027-03-14T21:05:00Z')).due).toBe(true); // 16:05 CDT
    expect(replyCheckClock(new Date('2027-03-14T21:05:00Z')).localDate).toBe('2027-03-14');
  });

  it('does nothing when switched off, or when another mailbox is connected', async () => {
    const task = await inboxTask('Zed', 'zed@zz-reply.example', {});
    const now = new Date('2026-09-25T21:05:00Z');
    expect((await runReplyCheck(harness.store, org, { now, enabled: false })).state).toBe('off');
    const [integration] = await harness.store.list('integrations', org, {});
    await harness.store.update('integrations', org, integration!.id, {
      account_email: 'someone@zz-other.example',
    });
    expect((await runReplyCheck(harness.store, org, { now, enabled: true })).state).toBe(
      'wrong_mailbox',
    );
    expect((await taskById(task.id)).status).toBe('open');
  });

  it('judges one message on its own', () => {
    const base = message('t', {
      sent_at: '2026-09-25T18:00:00.000Z',
      to_addresses: ['Zed@ZZ-Reply.example'],
    });
    const after = Date.parse('2026-09-25T17:00:00Z');
    expect(isRealReply(base, NICK, 'zed@zz-reply.example', after)).toBe(true);
    expect(
      isRealReply(
        { ...base, cc_addresses: ['zed@zz-reply.example'], to_addresses: [] },
        NICK,
        'zed@zz-reply.example',
        after,
      ),
    ).toBe(true);
    expect(
      isRealReply(base, NICK, 'zed@zz-reply.example', Date.parse('2026-09-25T18:00:00Z')),
    ).toBe(false);
    expect(
      isRealReply(
        { ...base, snippet: 'Let me check with Nick.' },
        NICK,
        'zed@zz-reply.example',
        after,
      ),
    ).toBe(false);
    expect(
      isRealReply(
        { ...base, snippet: 'I’ll circle back next week.' },
        NICK,
        'zed@zz-reply.example',
        after,
      ),
    ).toBe(false);
  });

  it('never counts a holding reply, a hand-off or a question back', () => {
    const base = message('t', {
      sent_at: '2026-09-25T18:00:00.000Z',
      to_addresses: ['zed@zz-reply.example'],
    });
    const after = Date.parse('2026-09-25T17:00:00Z');
    const real = (snippet: string, body_text: string | null = null) =>
      isRealReply({ ...base, snippet, body_text }, NICK, 'zed@zz-reply.example', after);
    for (const snippet of [
      "I'll flag this to Nick so it's on his radar.",
      'I’ll flag it to Nick.',
      "I'll flag this with Nick.",
      "Nick's away until mid-October, so I've passed this along and he may reach out.",
      'Looping in our fund admin, who can help with the statement.',
      "I'll make sure Nick sees this today.",
      "I can't speak to the allocation, but I've passed it along to Nick.",
      "I'll send Zed a note right now.",
      'Thanks for the note. Could you resend the deck? The link has expired.',
      'Thanks Zed, which quarter did you mean?',
      'Arwin here, Nick’s EA. Happy to help with the logistics.',
    ]) {
      expect(real(snippet), snippet).toBe(false);
    }
    const opener = `Hi Zed, thanks so much for the kind words about the portfolio update. ${'It was great to hear from you. '.repeat(5)}`;
    expect(real(opener)).toBe(true);
    expect(real(opener, `${opener}\nI've flagged this for him.\n\nBest,\nNick`)).toBe(false);
    expect(
      real(
        opener,
        `${opener}\nHere are the numbers.\n\nOn Tue, Zed wrote:\n> Could you flag this?`,
      ),
    ).toBe(true);
  });

  it('never checks a task that involves a Nick-only counterparty', async () => {
    const byAddress = await inboxTask('Bo', 'bo@zzfund.example', {});
    const byName = await inboxTask('Zzfund about the SPV', 'cy@zz-reply.example', {});
    const other = await inboxTask('Di', 'di@zz-reply.example', {});
    expect(mentionsNickOnly('Reply to Bo', 'bo@zzfund.example')).toBe(true);
    const outcome = await runReplyCheck(harness.store, org, {
      now: new Date('2026-09-25T21:05:00Z'),
      enabled: true,
    });
    expect(outcome).toMatchObject({ state: 'ran', closed: 1 });
    expect((await taskById(byAddress.id)).status).toBe('open');
    expect((await taskById(byName.id)).status).toBe('open');
    expect((await taskById(other.id)).status).toBe('complete');
  });

  it('never closes a task twice on the same reply, even if a Reopen left no audit row', async () => {
    const task = await inboxTask('Zed', 'zed@zz-reply.example', {});
    const check = (iso: string) =>
      runReplyCheck(harness.store, org, { now: new Date(iso), enabled: true });
    expect((await check('2026-09-25T21:05:00Z')).closed).toBe(1);
    await harness.store.update('tasks', org, task.id, { status: 'open', completed_at: null });
    expect(await check('2026-09-26T21:05:00Z')).toMatchObject({ state: 'ran', closed: 0 });
    expect((await taskById(task.id)).status).toBe('open');
    expect(await autoRows(task.id)).toHaveLength(1);
  });
});

/* ------------------------------------------------------ snoozes that wake */

describe('snoozed tasks come back', () => {
  async function put(id: string, over: Partial<Task>) {
    const base = await human(`ZZ ${id}`);
    await harness.store.update('tasks', org, base.id, over);
    return base.id;
  }

  it('lists an awake snooze on To do, a sleeping one and one with no wake date on Snoozed', async () => {
    const awake = await put('awake', {
      status: 'snoozed',
      snoozed_until: '2026-09-22T14:00:00.000Z',
      due_at: '2026-09-21T00:00:00.000Z',
    });
    const asleep = await put('asleep', {
      status: 'snoozed',
      snoozed_until: '2026-09-29T14:00:00.000Z',
    });
    const never = await put('never', { status: 'snoozed', snoozed_until: null });
    const now = new Date('2026-09-22T15:00:00.000Z');

    const open = (await listOpenTasks(org, now)).map((t) => t.id);
    expect(open).toContain(awake);
    expect(open).not.toContain(asleep);
    expect(open).not.toContain(never);
    const { overdue } = await dueAndOverdue(org, now);
    expect(overdue.map((t) => t.id)).toContain(awake);

    const snoozed = (await listSnoozedTasks(org, now)).map((t) => t.id);
    expect(snoozed).toEqual(expect.arrayContaining([asleep, never]));
    expect(snoozed).not.toContain(awake);
    expect(snoozed.indexOf(asleep)).toBeLessThan(snoozed.indexOf(never));
  });

  it('puts a task back where Undo says: snoozed to the same time, or open once that has passed', async () => {
    const task = await human('ZZ Undo me');
    await restoreTask(harness.auth, task.id, {
      status: 'snoozed',
      snoozedUntil: '2026-09-29T14:00:00.000Z',
    });
    expect(await taskById(task.id)).toMatchObject({
      status: 'snoozed',
      snoozed_until: '2026-09-29T14:00:00.000Z',
    });
    await restoreTask(harness.auth, task.id, {
      status: 'snoozed',
      snoozedUntil: '2026-09-21T14:00:00.000Z',
    });
    expect(await taskById(task.id)).toMatchObject({ status: 'open', snoozed_until: null });
    await restoreTask(harness.auth, task.id, { status: 'snoozed', snoozedUntil: null });
    expect(await taskById(task.id)).toMatchObject({ status: 'snoozed', snoozed_until: null });
    await restoreTask(harness.auth, task.id, { status: 'open' });
    expect((await taskById(task.id)).status).toBe('open');
  });
});

/* ----------------------------------------------------------------- ingest */

describe('task additions', () => {
  it('knows a title past the first 1,000 rows', async () => {
    const template = await human('ZZ Template');
    const rows: Task[] = Array.from({ length: 1_005 }, (_, i) => ({
      ...template,
      id: `ffffffff-0000-4000-8000-${String(i).padStart(12, '0')}`,
      title: `ZZ Bulk task ${i}`,
      status: 'complete',
    }));
    await harness.store.insertMany('tasks', rows);
    // PostgREST's cap: a list returns at most 1,000 rows, whatever it asks for.
    const capped = new Proxy(harness.store, {
      get(target, prop, receiver) {
        if (prop !== 'list') return Reflect.get(target, prop, receiver);
        return async (table: never, orgId: string, filter: never, options: QueryOptions = {}) => {
          const all = await target.list(table, orgId, filter, {
            ...options,
            limit: undefined,
            offset: undefined,
          });
          const offset = options.offset ?? 0;
          return all.slice(offset, offset + Math.min(options.limit ?? 1000, 1000));
        };
      },
    }) as DataStore;
    const result = await ingestTasks(capped, org, {
      source: 'test',
      tasks: [{ title: 'ZZ Bulk task 1004' }],
    });
    expect(result).toEqual({ created: [], existing: ['ZZ Bulk task 1004'] });
  });

  it('reads TASK_ADD_V1 only from the routines’ account', async () => {
    process.env.ASK_RELAY_SLACK_TOKEN = 'xoxb-test';
    resetEnvCache();
    const add = (title: string, user?: string, subtype?: string) => ({
      ...(user ? { user } : {}),
      ...(subtype ? { subtype } : {}),
      text: `TASK_ADD_V1\n${TICK}{"source":"task-auto-suggest","tasks":[{"title":"${title}"}]}${TICK}`,
    });
    const slack = (messages: unknown[]) =>
      (async () => new Response(JSON.stringify({ ok: true, messages }))) as unknown as typeof fetch;
    const result = await ingestTasksFromSlack(
      harness.store,
      org,
      slack([
        add('ZZ From the routine', POSTER),
        add('ZZ From a stranger', 'U0SOMEONE1'),
        add('ZZ From nobody'),
        add('ZZ Edited', POSTER, 'message_changed'),
      ]),
    );
    expect(result?.created).toEqual(['ZZ From the routine']);

    process.env.TASK_RELAY_POSTER_IDS = 'U0SOMEONE1, U0OTHER002';
    resetEnvCache();
    const second = await ingestTasksFromSlack(
      harness.store,
      org,
      slack([add('ZZ From a stranger', 'U0SOMEONE1'), add('ZZ Routine again', POSTER)]),
    );
    expect(second?.created).toEqual(['ZZ From a stranger']);
  });
});
