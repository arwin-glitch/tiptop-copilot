import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { ingestTasks, parseTaskRelayMessage } from '@/lib/services/task-ingest';
import { applyTaskCloses, type RelayClose } from '@/lib/services/task-close';
import {
  GLANCE_ACTION,
  readGlanceMeta,
  readTodayGlance,
  setTaskGlance,
} from '@/lib/services/task-glance';
import { updateTaskStatus } from '@/lib/services/tasks';
import { todayLead, type FollowUpsResult } from '@/lib/services/follow-ups';
import { demoFollowUps } from '@/lib/demo/follow-ups-fixtures';
import { todayGlanceCards, type Glance, type GlanceBucket } from '@/lib/tasks/glance';
import { TaskActionHost } from '@/components/tasks/task-action-host';
import { TodayGlance } from '@/components/today/today-glance';
import type { AuditEvent, Task } from '@/lib/types/domain';

/**
 * Today's "At a glance" on the demo store: what the routine's TASK_ADD_V1
 * labels write, that a label never decides whether a task exists, how odd
 * dates and malformed relay posts are read, that a tick and a card move behave with the
 * task-closer as the plan says, and the demo's own cards. Every title, name
 * and id is invented.
 */

const TICK = String.fromCharCode(96);
let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.dispose();
});

const org = () => harness.auth.organizationId;

async function taskByTitle(title: string): Promise<Task> {
  const rows = (await harness.store.list('tasks', org(), { eq: { title } })) as Task[];
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function glanceRows(taskId: string): Promise<AuditEvent[]> {
  return (await harness.store.list('audit_events', org(), {
    eq: { action: GLANCE_ACTION, entity_id: taskId },
  })) as AuditEvent[];
}

function relay(body: unknown) {
  const parsed = parseTaskRelayMessage(`TASK_ADD_V1\n${TICK}${JSON.stringify(body)}${TICK}`);
  expect(parsed).not.toBeNull();
  return parsed!;
}

/** The glance row's markup as Today renders it: no browser, so no effects run. */
function renderGlance(glance: Glance, cards: readonly GlanceBucket[]): string {
  const noop = () => undefined;
  const router = {
    back: noop,
    forward: noop,
    refresh: noop,
    push: noop,
    replace: noop,
    prefetch: noop,
  } as unknown as AppRouterInstance;
  return renderToStaticMarkup(
    createElement(
      AppRouterContext.Provider,
      { value: router },
      createElement(
        TaskActionHost,
        null,
        createElement(TodayGlance, { glance, cards, footnote: 'Checked at 3 PM.' }),
      ),
    ),
  );
}

const count = (markup: string, pattern: RegExp) => markup.match(pattern)?.length ?? 0;

function closeFor(task: Task, at: string): RelayClose {
  return {
    close: {
      task_id: task.id,
      title: task.title,
      kind: 'intro',
      evidence_at: at,
      evidence: { type: 'gmail_sent', id: 'abc0000000000091' },
      reason: 'Sent the intro with both on To.',
    },
    postedAt: at,
    slackTs: '1760000000.000100',
  };
}

describe('TASK_ADD_V1 with glance fields', () => {
  it('adds the task and one glance row, and a repost adds neither again', async () => {
    const payload = relay({
      source: 'task-auto-suggest',
      tasks: [
        {
          title: 'ZZ Intro Kit Moss to Pat Lane',
          short: 'Kit → Pat',
          bucket: 'intro',
        },
        {
          title: 'ZZ Write the Northwind LP note',
          short: 'Northwind note',
          bucket: 'upcoming',
          due_at: '2026-10-19T09:00:00-05:00',
          due_precision: 'week',
        },
        { title: 'ZZ Plain old task' },
      ],
    });
    const first = await ingestTasks(harness.store, org(), payload);
    expect(first.created).toHaveLength(3);

    const intro = await taskByTitle('ZZ Intro Kit Moss to Pat Lane');
    const note = await taskByTitle('ZZ Write the Northwind LP note');
    const plain = await taskByTitle('ZZ Plain old task');
    // An offset date is stored as UTC.
    expect(note.due_at).toBe('2026-10-19T14:00:00.000Z');

    const introRows = await glanceRows(intro.id);
    expect(introRows).toHaveLength(1);
    expect(introRows[0]).toMatchObject({ user_id: null, entity_type: 'task' });
    expect(introRows[0]!.metadata).toMatchObject({
      v: 1,
      by: 'routine',
      source: 'task-auto-suggest',
      short: 'Kit → Pat',
      bucket: 'intro',
    });
    expect((await glanceRows(note.id))[0]!.metadata).toMatchObject({
      bucket: 'upcoming',
      due_precision: 'week',
    });
    // No glance field, no glance row.
    expect(await glanceRows(plain.id)).toHaveLength(0);

    const again = await ingestTasks(harness.store, org(), payload);
    expect(again.created).toEqual([]);
    expect(again.existing).toHaveLength(3);
    expect(await glanceRows(intro.id)).toHaveLength(1);
  });

  it('keeps the task when its label is bad', async () => {
    const result = await ingestTasks(
      harness.store,
      org(),
      relay({
        source: 'task-auto-suggest',
        tasks: [
          {
            title: 'ZZ Reply to Halyard',
            short: 'far too many words for one glance line',
            bucket: 'later',
          },
        ],
      }),
    );
    expect(result.created).toEqual(['ZZ Reply to Halyard']);
    expect(await glanceRows((await taskByTitle('ZZ Reply to Halyard')).id)).toHaveLength(0);
  });

  it('never drops an intro because its label matches another one', async () => {
    await ingestTasks(harness.store, org(), {
      source: 'task-auto-suggest',
      tasks: [
        { title: 'ZZ Intro Chris Dalton to Sam Park', short: 'Chris → Sam', bucket: 'intro' },
      ],
    });
    const made = await taskByTitle('ZZ Intro Chris Dalton to Sam Park');
    await updateTaskStatus(harness.auth, made.id, 'complete');

    // A different pair with the same first names, twice in one post with
    // another, and an earlier title read by the shortener: every one is new.
    await ingestTasks(harness.store, org(), {
      source: 'test',
      tasks: [{ title: 'Intro Rowan Hale to Mira Stone (from the dinner)' }],
    });
    const later = await ingestTasks(harness.store, org(), {
      source: 'task-auto-suggest',
      tasks: [
        { title: 'ZZ Intro Chris Okafor to Sam Lee', short: 'Chris → Sam', bucket: 'intro' },
        { title: 'ZZ Intro Chris Bell to Sam Ortiz', short: 'chris -> sam', bucket: 'intro' },
        { title: 'ZZ Rowan Vale and Mira Cho, finally', short: 'Rowan → Mira', bucket: 'intro' },
      ],
    });
    expect(later.created).toEqual([
      'ZZ Intro Chris Okafor to Sam Lee',
      'ZZ Intro Chris Bell to Sam Ortiz',
      'ZZ Rowan Vale and Mira Cho, finally',
    ]);
    expect(later.existing).toEqual([]);
  });
});

describe('TASK_ADD_V1 dates and malformed messages', () => {
  it('reads a bare date as 09:00 Central and a time with no offset as Central', async () => {
    const result = await ingestTasks(
      harness.store,
      org(),
      relay({
        source: 'task-auto-suggest',
        tasks: [
          { title: 'ZZ Week of the LP update', bucket: 'upcoming', due_at: '2026-10-26' },
          { title: 'ZZ Board pack due', bucket: 'upcoming', due_at: '2026-10-27T13:30' },
          // Winter time: 09:00 Central is 15:00 UTC.
          { title: 'ZZ Winter deadline', bucket: 'upcoming', due_at: '2026-12-07' },
        ],
      }),
    );
    expect(result.created).toHaveLength(3);
    expect((await taskByTitle('ZZ Week of the LP update')).due_at).toBe('2026-10-26T14:00:00.000Z');
    expect((await taskByTitle('ZZ Board pack due')).due_at).toBe('2026-10-27T18:30:00.000Z');
    expect((await taskByTitle('ZZ Winter deadline')).due_at).toBe('2026-12-07T15:00:00.000Z');
  });

  it('keeps every other task, and the task itself, when one date is unreadable', async () => {
    const payload = parseTaskRelayMessage(
      `TASK_ADD_V1\n${TICK}${JSON.stringify({
        source: 'task-auto-suggest',
        tasks: [
          { title: 'ZZ Reply to Halyard', bucket: 'now' },
          {
            title: 'ZZ Prep the Lumen walkthrough',
            detail: 'From the calendar.',
            bucket: 'upcoming',
            due_at: 'the Monday after next',
          },
          { title: 'ZZ Intro Kit Moss to Pat Lane', short: 'Kit → Pat', bucket: 'intro' },
          // No usable title: the only one left out.
          { title: '   ', bucket: 'now' },
        ],
      })}${TICK}`,
    );
    expect(payload).not.toBeNull();
    expect(payload!.tasks.map((t) => t.title)).toEqual([
      'ZZ Reply to Halyard',
      'ZZ Prep the Lumen walkthrough',
      'ZZ Intro Kit Moss to Pat Lane',
    ]);
    const result = await ingestTasks(harness.store, org(), payload!);
    expect(result.created).toHaveLength(3);
    const prep = await taskByTitle('ZZ Prep the Lumen walkthrough');
    // The bad date is gone; the rest of the task, and its card, stay.
    expect(prep.due_at).toBeNull();
    expect(prep.detail).toBe('From the calendar.');
    expect((await glanceRows(prep.id))[0]!.metadata).toMatchObject({ bucket: 'upcoming' });
  });

  it('reads the JSON past a backtick inside a value, and inside a code fence', () => {
    const body = {
      source: 'task-auto-suggest',
      tasks: [{ title: 'ZZ Send the `deck` link', short: 'Halyard: `deck`', bucket: 'now' }],
    };
    const inline = parseTaskRelayMessage(`TASK_ADD_V1\n${TICK}${JSON.stringify(body)}${TICK}`);
    expect(inline?.tasks[0]).toMatchObject({ title: 'ZZ Send the `deck` link', short: null });
    const fence = TICK.repeat(3);
    const fenced = parseTaskRelayMessage(
      `TASK_ADD_V1\n${fence}json\n${JSON.stringify(body, null, 2)}\n${fence}`,
    );
    expect(fenced?.tasks).toHaveLength(1);
    expect(parseTaskRelayMessage('TASK_ADD_V1 nothing to read here')).toBeNull();
    expect(parseTaskRelayMessage(`TASK_ADD_V1 ${TICK}{"source":"x","tasks":[]}${TICK}`)).toBeNull();
  });
});

describe('ticks, card moves and the task-closer', () => {
  it('a tick is a person completing it, so a later close finds it not open', async () => {
    await ingestTasks(harness.store, org(), {
      source: 'task-auto-suggest',
      tasks: [{ title: 'ZZ Intro Kit to Pat', short: 'Kit → Pat', bucket: 'intro' }],
    });
    const task = await taskByTitle('ZZ Intro Kit to Pat');
    await updateTaskStatus(harness.auth, task.id, 'complete');

    const counts = await applyTaskCloses(harness.store, org(), [
      closeFor(task, new Date(Date.now() + 1_000).toISOString()),
    ]);
    expect(counts.closed).toBe(0);
    expect(counts.skipped).toEqual({ not_open: 1 });
  });

  it("moving a task between cards doesn't stop it closing itself", async () => {
    await ingestTasks(harness.store, org(), {
      source: 'task-auto-suggest',
      tasks: [{ title: 'ZZ Intro Ivy to Sam', short: 'Ivy → Sam', bucket: 'intro' }],
    });
    const task = await taskByTitle('ZZ Intro Ivy to Sam');
    const moved = await setTaskGlance(harness.auth, task.id, { bucket: 'now', short: 'Ivy + Sam' });
    expect(moved.ok && moved.value).toEqual({
      short: 'Ivy + Sam',
      bucket: 'now',
      bucketBy: 'person',
    });

    const counts = await applyTaskCloses(harness.store, org(), [
      closeFor(task, new Date(Date.now() + 1_000).toISOString()),
    ]);
    expect(counts.closed).toBe(1);
    expect(((await harness.store.get('tasks', org(), task.id)) as Task).status).toBe('complete');
  });

  it('refuses a bad person patch and an unknown task', async () => {
    const task = await taskByTitle('Send LoomStack pass note');
    const tooLong = await setTaskGlance(harness.auth, task.id, { short: 'x'.repeat(50) });
    expect(tooLong.ok).toBe(false);
    const nothing = await setTaskGlance(harness.auth, task.id, {});
    expect(nothing.ok).toBe(false);
    const missing = await setTaskGlance(harness.auth, '00000000-0000-4000-8000-0000000fffff', {
      bucket: 'now',
    });
    expect(missing.ok || missing.error.code).toBe('not_found');
  });
});

describe('readTodayGlance on the demo workspace', () => {
  it('buckets, labels and counts the demo tasks', async () => {
    const glance = await readTodayGlance(harness.store, org(), {
      now: new Date(),
      timeZone: harness.auth.profile.timezone,
    });

    // The two overdue fixture tasks lead Do now, oldest first.
    expect(glance.now.total).toBe(7);
    expect(glance.now.items).toHaveLength(4);
    expect(glance.now.items.slice(0, 2).map((i) => [i.label, i.overdue])).toEqual([
      ['Girder AI: reference calls', true],
      ['LoomStack: pass note', true],
    ]);

    expect(glance.intro.total).toBe(6);
    expect(glance.intro.items.map((i) => i.label)).toEqual([
      'Priya → Omar',
      'Elena → Ben',
      'Chris → Ivy + Sam P.',
      // A fixture task with no label: the shortener's, led by its portfolio company.
      'Ledgerly: Series A intros',
    ]);

    expect(glance.upcoming.total).toBe(4);
    expect(glance.upcoming.items.map((i) => i.label)).toEqual([
      'Northwind note',
      'Lumen walkthrough',
      'Cobalt Ridge: board prep',
      'Field guide',
    ]);
    expect(glance.upcoming.items[0]!.when).toMatch(/^[A-Z][a-z]{2} \d{1,2} wk$/);

    // Neither the snoozed nor the completed demo task is on a card.
    const titles = [glance.now, glance.intro, glance.upcoming].flatMap((c) =>
      c.items.map((i) => i.fullTitle),
    );
    expect(titles).not.toContain('Ask Tom for the Girder AI onboarding numbers');
    expect(titles).not.toContain('Answer the LP question on the Q3 reporting timeline');
  });

  it("Today hides Do now under the demo's list for today, and shows it again without one", async () => {
    const now = new Date();
    const clock = { now, timeZone: harness.auth.profile.timezone };
    const glance = await readTodayGlance(harness.store, org(), clock);
    const read = (state: FollowUpsResult['state'], snapshot = demoFollowUps(now)) => ({
      state,
      snapshot,
      readAt: now.toISOString(),
    });

    // The demo's ranked list is always today's: Intros owed and Coming up stay.
    const lead = todayLead(read('ok'), clock);
    expect(lead.priorities?.items.length).toBeGreaterThan(0);
    expect(lead.hideNow).toBe(true);
    expect(todayGlanceCards(glance, { hideNow: lead.hideNow })).toEqual(['intro', 'upcoming']);

    // Yesterday's list still leads, but Do now comes back beside it.
    const demo = demoFollowUps(now);
    const dayOld = new Date(now.getTime() - 86_400_000).toISOString();
    const stale = todayLead(
      read('ok', { ...demo, priorities: { ...demo.priorities!, run_at: dayOld } }),
      clock,
    );
    expect(stale.priorities).not.toBeNull();
    expect(todayGlanceCards(glance, { hideNow: stale.hideNow })).toEqual([
      'now',
      'intro',
      'upcoming',
    ]);

    // No list (Slack not set up, or a failed read): all three, Do now with its seven.
    for (const fallback of [read('not_configured'), read('error'), null]) {
      const none = todayLead(fallback, clock);
      expect(none.priorities).toBeNull();
      expect(todayGlanceCards(glance, { hideNow: none.hideNow })).toEqual([
        'now',
        'intro',
        'upcoming',
      ]);
    }
    expect(glance.now.total).toBe(7);
  });

  it('renders three cards across with the overdue marks, or two without Do now', async () => {
    const glance = await readTodayGlance(harness.store, org(), {
      now: new Date(),
      timeZone: harness.auth.profile.timezone,
    });

    // No list for today: three across at the cards' 56rem column, and the
    // demo's two overdue tasks marked on Do now.
    const three = renderGlance(glance, todayGlanceCards(glance));
    expect(three).toContain('@4xl:grid-cols-3');
    expect(three).not.toContain('sm:grid-cols-2');
    expect(count(three, /<h3[\s>]/g)).toBe(3);
    expect(three).toMatch(/Do now/);
    expect(count(three, /aria-label="overdue"/g)).toBe(2);
    expect(count(three, /type="checkbox"/g)).toBe(12);

    // Today's list showing: two across from the small breakpoint, no Do now.
    const two = renderGlance(glance, todayGlanceCards(glance, { hideNow: true }));
    expect(two).toContain('sm:grid-cols-2');
    expect(two).not.toContain('@4xl:grid-cols-3');
    expect(count(two, /<h3[\s>]/g)).toBe(2);
    expect(two).not.toMatch(/Do now/);
    expect(count(two, /aria-label="overdue"/g)).toBe(0);
    expect(count(two, /type="checkbox"/g)).toBe(8);
  });

  it('a person moving a task outranks the routine on the cards', async () => {
    const note = await taskByTitle('Northwind: write the quarterly LP note');
    await setTaskGlance(harness.auth, note.id, { bucket: 'now' });
    const meta = await readGlanceMeta(harness.store, org(), [note.id]);
    expect(meta.get(note.id)).toMatchObject({
      short: 'Northwind note',
      bucket: 'now',
      bucketBy: 'person',
    });
    const glance = await readTodayGlance(harness.store, org(), {
      now: new Date(),
      timeZone: harness.auth.profile.timezone,
    });
    expect(glance.upcoming.total).toBe(3);
    expect(glance.now.total).toBe(8);
  });
});
