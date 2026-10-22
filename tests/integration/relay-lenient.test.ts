import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env, resetEnvCache, type AppEnv } from '@/lib/config/env';
import { feedRowSummary } from '@/lib/feeds/words';
import type { StaticFeedId } from '@/lib/feeds/registry';
import {
  ingestRoutineBriefing,
  getCurrentBrief,
  parseBriefingRelayMessage,
} from '@/lib/services/briefing';
import { buildFeedReport, readFeedInputs, resetFeedHealthState } from '@/lib/services/feed-health';
import { readFollowUps, resetFollowUpsCache } from '@/lib/services/follow-ups';
import { readPortfolioJobs, resetPortfolioJobsCache } from '@/lib/services/portfolio-jobs';
import { ingestPortfolioFromSlack } from '@/lib/services/portfolio-ingest';
import { parseTaskCloseMessage } from '@/lib/services/task-close';
import { ingestTasksFromSlack } from '@/lib/services/task-ingest';
import { parseTaskProofMessage } from '@/lib/services/task-proof-relay';
import type { PortfolioCompany, Task } from '@/lib/types/domain';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * A routine's post that runs a little long, or carries one item the app
 * cannot read, no longer costs the whole post (D-073). The week-ahead post
 * below has the shape of the one that left the Week ahead card and the
 * Calendar prep notes on the day before's copy: two numbered parts sharing
 * one run_at, several prep notes of 250 to 340 characters where 240 fit, and
 * one meeting of a kind the app does not know. Every name and word in it is
 * invented. Read here the way the app reads it live: the relay channel
 * through a fake Slack, the cards' own readers, and Diagnostics > Feeds.
 */

const SAVED = { ...process.env };
const NOW = new Date('2026-10-21T15:00:00Z');
const TZ = 'America/Chicago';
const RUN = '2026-10-21T11:21:01Z';
const TICK = String.fromCharCode(96);

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness({ now: NOW });
  resetFollowUpsCache();
  resetFeedHealthState();
  resetPortfolioJobsCache();
});

afterEach(async () => {
  await harness.dispose();
  for (const key of Object.keys(process.env)) {
    if (!(key in SAVED)) delete process.env[key];
  }
  Object.assign(process.env, SAVED);
  resetEnvCache();
  resetFollowUpsCache();
  resetFeedHealthState();
  resetPortfolioJobsCache();
});

function live(): AppEnv {
  return {
    ...env(),
    demoMode: false,
    askRelaySlackToken: 'xoxb-test',
    authAllowedDomains: ['tiptop.example'],
    dealRelayPosterIds: [],
    taskRelayPosterIds: [],
  };
}

const at = (iso: string) => `${Date.parse(iso) / 1000}.000100`;
const relay = (marker: string, body: unknown, postedAt: string) => ({
  ts: at(postedAt),
  user: 'U0ROUTINE1',
  text: `${marker}\n${TICK}${JSON.stringify(body)}${TICK}`,
});

/** conversations.history, one page per channel, newest first. */
function fakeSlack(byChannel: Record<string, unknown[]>) {
  return (async (input: RequestInfo | URL) => {
    const channel = new URL(String(input)).searchParams.get('channel') ?? '';
    return new Response(JSON.stringify({ ok: true, messages: byChannel[channel] ?? [] }));
  }) as unknown as typeof fetch;
}

/** Invented prep prose, exactly `n` characters, with word breaks throughout. */
function prose(n: number): string {
  const words =
    'Ask how the Northwind pilot is converting, whether the second engineer has started, ' +
    'and what the bridge would need to close; bring the September numbers and the open intro. ';
  return words.repeat(6).slice(0, n).padEnd(n, '.');
}

function expectCut(value: unknown, max: number) {
  expect(typeof value).toBe('string');
  const s = value as string;
  expect(s.length).toBeLessThanOrEqual(max);
  expect(s.endsWith('…')).toBe(true);
  expect(s).not.toMatch(/[\s,;:.]…$/);
}

async function feedRows(e: AppEnv, fetchImpl: typeof fetch) {
  const inputs = await readFeedInputs(harness.store, harness.auth.organizationId, {
    now: NOW,
    fetchImpl,
    e,
  });
  return buildFeedReport(inputs, NOW, TZ).rows;
}

/* ------------------------------------------------- the Oct 21 week ahead */

const event = (
  starts: string,
  kind: string,
  prep: string | null,
  title = 'Example meeting',
  withWho = ['Avery Example'],
) => ({
  title,
  starts_at: starts,
  ends_at: null,
  with_who: withWho,
  kind,
  prep,
  thread_id: null,
});

const YESTERDAY = relay(
  'WEEK_AHEAD_V1',
  {
    run_at: '2026-10-20T11:20:04Z',
    events: [event('2026-10-21T16:00:00Z', 'founder', 'The copy from the day before.')],
  },
  '2026-10-20T11:22:00Z',
);
const PART_1 = relay(
  'WEEK_AHEAD_V1',
  {
    run_at: RUN,
    part: 1,
    events: [
      event('2026-10-21T16:00:00Z', 'founder', prose(252), 'Northwind Robotics check-in'),
      event('2026-10-21T19:30:00Z', 'lp', prose(301), 'Coffee with an example LP'),
      event('2026-10-22T14:00:00Z', 'offsite', 'A kind the app does not know.', 'Team offsite'),
      event('2026-10-22T17:00:00Z', 'portfolio', prose(338), 'Zeta Labs board call'),
    ],
  },
  '2026-10-21T11:24:10Z',
);
const PART_2 = relay(
  'WEEK_AHEAD_V1',
  {
    run_at: RUN,
    part: 2,
    events: [
      event('2026-10-23T15:00:00Z', 'investor', prose(276), 'Co-investor sync'),
      event('2026-10-23T18:00:00Z', 'internal', 'Short prep.', 'Weekly team sync', []),
    ],
  },
  '2026-10-21T11:24:12Z',
);

describe('the week ahead, posted in two parts with long preps and one unknown kind', () => {
  it('shows the newest run: both parts joined, preps cut to fit, the bad meeting left out', async () => {
    const e = live();
    const fetchImpl = fakeSlack({ [e.dealRelayChannelId]: [PART_2, PART_1, YESTERDAY] });
    const read = await readFollowUps(harness.store, harness.auth.organizationId, {
      now: NOW,
      fetchImpl,
      e,
    });
    expect(read.state).toBe('ok');
    const week = read.snapshot.weekAhead;
    expect(week?.run_at).toBe(RUN);
    expect(week?.events.map((ev) => ev.title)).toEqual([
      'Northwind Robotics check-in',
      'Coffee with an example LP',
      'Zeta Labs board call',
      'Co-investor sync',
      'Weekly team sync',
    ]);
    const [first, second, third, fourth, fifth] = week!.events;
    for (const ev of [first, second, third, fourth]) expectCut(ev!.prep, 240);
    expect(fifth?.prep).toBe('Short prep.');
    // Calendar matches a prep note to its meeting by the start time, never cut.
    expect(first?.starts_at).toBe('2026-10-21T16:00:00Z');
    expect(week?.events.some((ev) => ev.prep === 'The copy from the day before.')).toBe(false);
  });

  it('says on Diagnostics that one item was skipped, not that the post could not be read', async () => {
    const e = live();
    const fetchImpl = fakeSlack({ [e.dealRelayChannelId]: [PART_2, PART_1, YESTERDAY] });
    const row = (await feedRows(e, fetchImpl)).find((r) => r.id === 'week-ahead')!;
    expect(row).toMatchObject({
      status: 'ok',
      lastSeen: '2026-10-21T11:24:12.000Z',
      unreadableAt: null,
      skipped: 1,
    });
    const words = feedRowSummary(row, NOW, TZ);
    expect(words).toContain(
      '1 item in the newest post was skipped because it could not be read; the rest of the post is showing.',
    );
    expect(words).not.toContain('could not be read, so its card kept the older copy');
  });

  it('still says "could not be read" for a post that is not readable at all', async () => {
    const e = live();
    const broken = {
      ts: at('2026-10-21T12:00:00Z'),
      user: 'U0ROUTINE1',
      text: `WEEK_AHEAD_V1\n${TICK}{"run_at": "${RUN}", "events": [${TICK}`,
    };
    const fetchImpl = fakeSlack({ [e.dealRelayChannelId]: [broken, PART_2, PART_1] });
    const row = (await feedRows(e, fetchImpl)).find((r) => r.id === 'week-ahead')!;
    expect(row.unreadableAt).toBe('2026-10-21T12:00:00.000Z');
    expect(feedRowSummary(row, NOW, TZ)).toContain(
      'could not be read, so its card kept the older copy',
    );
    // The card shows the run it could read.
    const read = await readFollowUps(harness.store, harness.auth.organizationId, {
      now: NOW,
      fetchImpl,
      e,
      force: true,
    });
    expect(read.snapshot.weekAhead?.events).toHaveLength(5);
  });
});

/* ------------------------------------------- every other snapshot reader */

describe('every follow-up snapshot: long text cut, one bad item left out and counted', () => {
  const posted = (minute: number) => `2026-10-21T11:${String(minute).padStart(2, '0')}:00Z`;
  const POSTS = [
    relay(
      'PRIORITIES_V1',
      {
        run_at: RUN,
        source: 'morning',
        items: [
          { title: prose(180), why: prose(330), kind: 'money' },
          { title: 'Example item', why: 'Unknown kind', kind: 'errand' },
        ],
      },
      posted(30),
    ),
    relay(
      'FOLLOWUPS_V1',
      {
        run_at: RUN,
        items: [
          {
            thread_id: '1a0000000000aaaa',
            who: 'Jane Roe',
            subject: prose(320),
            last_sent_at: '2026-10-14T15:00:00Z',
            days_waiting: 7,
            draft: false,
            note: prose(430),
          },
          { thread_id: 'not-a-thread', who: 'Sam Poe', subject: 'x', days_waiting: 2 },
        ],
      },
      posted(31),
    ),
    relay(
      'RELATIONSHIPS_V1',
      {
        run_at: RUN,
        waiting: [
          {
            who: 'Grace Example',
            kind: 'prospective_lp',
            since: '2026-10-18T15:00:00Z',
            days: 3,
            note: prose(310),
          },
        ],
        cold: [{ who: 'Ivy Example', kind: 'friend', since: '2026-08-01T15:00:00Z', days: 80 }],
      },
      posted(32),
    ),
    relay(
      'LP_PIPELINE_V1',
      {
        run_at: RUN,
        fund: 'Fund II',
        lps: [
          { who: 'Grace Example', kind: 'family_office', stage: 'materials', note: prose(320) },
          { who: 'Sam Example', kind: 'fund_of_funds', stage: 'wired' },
        ],
      },
      posted(33),
    ),
    relay(
      'PORTFOLIO_HEALTH_V1',
      {
        run_at: RUN,
        companies: [
          { name: 'Zeta Labs', flag: 'watch', headline: prose(250), asks: [prose(240)] },
          { name: 'Quill Example', flag: 'great' },
        ],
      },
      posted(34),
    ),
    relay(
      'INTROS_V1',
      {
        run_at: RUN,
        intros: [
          { for_who: 'Zeta Labs', to_who: 'Ivy Example', status: 'owed', note: prose(260) },
          { for_who: 'Quill Example', to_who: 'Bo Example', status: 'maybe' },
        ],
      },
      posted(35),
    ),
    relay(
      'EMAIL_QUEUE_V1',
      {
        run_at: RUN,
        items: [
          {
            id: '1a0000000000bbbb',
            who: 'Jane Roe',
            about: prose(220),
            group: 'money',
            call: 'reply',
            flags: ['wire'],
            draft: 'none',
            why: prose(560),
          },
          { id: '1a0000000000cccc', who: 'Sam Poe', about: 'x', group: 'someday', call: 'reply' },
        ],
      },
      posted(36),
    ),
    relay(
      'SCHEDULING_V1',
      {
        run_at: RUN,
        items: [
          {
            thread_id: '1a0000000000dddd',
            who: 'Bo Example',
            subject: prose(330),
            slots: ['2026-10-27T15:00:00Z'],
            draft: true,
          },
          {
            thread_id: '1a0000000000eeee',
            who: 'Cy Example',
            subject: 'x',
            slots: ['next Tuesday'],
            draft: true,
          },
        ],
      },
      posted(37),
    ),
  ];

  it('fills each card from the newest post, with the readable items', async () => {
    const e = live();
    const fetchImpl = fakeSlack({ [e.dealRelayChannelId]: [...POSTS].reverse() });
    const { snapshot } = await readFollowUps(harness.store, harness.auth.organizationId, {
      now: NOW,
      fetchImpl,
      e,
    });
    expect(snapshot.priorities?.items).toHaveLength(1);
    expectCut(snapshot.priorities?.items[0]?.title, 160);
    expectCut(snapshot.priorities?.items[0]?.why, 300);
    expect(snapshot.waiting?.items).toHaveLength(1);
    expectCut(snapshot.waiting?.items[0]?.subject, 300);
    expectCut(snapshot.waiting?.items[0]?.note, 400);
    expect(snapshot.relationships?.waiting).toHaveLength(1);
    expect(snapshot.relationships?.cold).toEqual([]);
    expectCut(snapshot.relationships?.waiting[0]?.note, 300);
    expect(snapshot.lpPipeline?.lps).toHaveLength(1);
    expectCut(snapshot.lpPipeline?.lps[0]?.note, 300);
    expect(snapshot.portfolioHealth?.companies.map((c) => c.name)).toEqual(['Zeta Labs']);
    expectCut(snapshot.portfolioHealth?.companies[0]?.headline, 200);
    expectCut(snapshot.portfolioHealth?.companies[0]?.asks[0], 200);
    expect(snapshot.intros?.intros).toHaveLength(1);
    expectCut(snapshot.intros?.intros[0]?.note, 200);
    expect(snapshot.emailQueue?.items.map((i) => i.id)).toEqual(['1a0000000000bbbb']);
    expectCut(snapshot.emailQueue?.items[0]?.about, 200);
    expectCut(snapshot.emailQueue?.items[0]?.why, 500);
    expect(snapshot.scheduling.map((s) => s.thread_id)).toEqual(['1a0000000000dddd']);
    expectCut(snapshot.scheduling[0]?.subject, 300);
  });

  it('lists each feed on Diagnostics as read, with one item skipped', async () => {
    const e = live();
    const fetchImpl = fakeSlack({ [e.dealRelayChannelId]: [...POSTS].reverse() });
    const rows = await feedRows(e, fetchImpl);
    const feeds: StaticFeedId[] = [
      'priorities',
      'follow-ups',
      'relationships',
      'lp-pipeline',
      'portfolio-health',
      'intros',
      'email-queue',
      'scheduling',
    ];
    for (const id of feeds) {
      const row = rows.find((r) => r.id === id)!;
      expect(row.lastSeen, id).not.toBeNull();
      expect(row.unreadableAt, id).toBeNull();
      expect(row.skipped, id).toBe(1);
      expect(feedRowSummary(row, NOW, TZ), id).toContain('1 item in the newest post was skipped');
    }
  });
});

/* ------------------------------------------------- Jobs, from its own read */

describe('Jobs: a long source subject is cut, a bad role still counted', () => {
  const role = {
    company: 'Example Robotics',
    title: 'Backend Engineer',
    function: 'engineering',
    status: 'active',
    first_seen: '2026-09-01',
    last_seen: '2026-10-15',
    sources: [{ message_id: '1a0000000000aaaa', date: '2026-10-15', subject: prose(380) }],
  };
  const POST = relay(
    'JOBS_V1',
    { run_at: '2026-10-19T13:00:00Z', roles: [role, { ...role, title: 'Designer', status: 'x' }] },
    '2026-10-19T13:20:00Z',
  );

  it('keeps the role, its subject cut, and Diagnostics says one was skipped', async () => {
    const e = live();
    const fetchImpl = fakeSlack({ [e.dealRelayChannelId]: [POST] });
    const read = await readPortfolioJobs(harness.store, harness.auth.organizationId, {
      now: NOW,
      fetchImpl,
      e,
    });
    expect(read.snapshot?.roles.map((r) => r.title)).toEqual(['Backend Engineer']);
    expect(read.snapshot?.dropped).toBe(1);
    expectCut(read.snapshot?.roles[0]?.sources[0]?.subject, 300);
    const row = (await feedRows(e, fetchImpl)).find((r) => r.id === 'portfolio-jobs')!;
    expect(row.skipped).toBe(1);
    expect(feedRowSummary(row, NOW, TZ)).toContain('1 item in the newest post was skipped');
  });
});

/* ------------------------------------ the ask-relay and task-closer readers */

describe('the other relay readers: a long display field is cut, never fatal', () => {
  beforeEach(() => {
    process.env.ASK_RELAY_SLACK_TOKEN = 'xoxb-test';
    process.env.TASK_RELAY_POSTER_IDS = 'U0ROUTINE1';
    resetEnvCache();
  });
  const slack = (messages: unknown[]) =>
    (async () => new Response(JSON.stringify({ ok: true, messages }))) as unknown as typeof fetch;

  it('adds a suggested task with its long detail cut, rather than lost', async () => {
    const message = relay(
      'TASK_ADD_V1',
      {
        source: 'example-watcher',
        tasks: [{ title: 'ZZ Send the pilot recap', detail: prose(2400) }],
      },
      '2026-10-21T13:00:00Z',
    );
    const result = await ingestTasksFromSlack(
      harness.store,
      harness.auth.organizationId,
      slack([message]),
    );
    expect(result?.created).toEqual(['ZZ Send the pilot recap']);
    const tasks = (await harness.store.list('tasks', harness.auth.organizationId, {})) as Task[];
    const task = tasks.find((t) => t.title === 'ZZ Send the pilot recap');
    expectCut(task?.detail, 2000);
  });

  it('adds a new portfolio company with its long description cut', async () => {
    const message = relay(
      'PORTFOLIO_ADD_V1',
      {
        source: 'closed-deal-mailbox',
        companies: [{ name: 'ZZ Example Relay Co', description: prose(650), sector: prose(230) }],
      },
      '2026-10-21T13:00:00Z',
    );
    const result = await ingestPortfolioFromSlack(
      harness.store,
      harness.auth.organizationId,
      slack([message]),
    );
    expect(result?.created).toEqual(['ZZ Example Relay Co']);
    const companies = (await harness.store.list(
      'portfolio_companies',
      harness.auth.organizationId,
      {},
    )) as PortfolioCompany[];
    const company = companies.find((c) => c.name === 'ZZ Example Relay Co');
    expectCut(company?.description, 500);
  });

  it('keeps a briefing whose title runs long, with the title cut', async () => {
    const payload = parseBriefingRelayMessage(
      relay(
        'BRIEFING_PAYLOAD_V1',
        {
          kind: 'morning',
          date_key: '2026-10-21',
          title: `Morning brief — ${prose(240)}`,
          summary: 'Two invented items.',
        },
        '2026-10-21T11:05:00Z',
      ).text,
    );
    expect(payload).not.toBeNull();
    expectCut(payload?.title, 200);
    await ingestRoutineBriefing(harness.store, harness.auth.organizationId, payload!);
    const brief = await getCurrentBrief(harness.store, harness.auth.organizationId);
    expect(brief?.title).toBe(payload?.title);
  });

  it('keeps a task-closer close or proof whose reason runs long', () => {
    const evidence = {
      type: 'gmail_sent',
      id: 'abc0000000000001',
      thread_id: 'abc0000000000000',
      to: ['zed@zz-close.example'],
    };
    const item = {
      title: 'ZZ Reply to the founder',
      kind: 'reply',
      evidence_at: '2026-10-21T14:00:00Z',
      evidence,
      reason: prose(420),
    };
    const body = (key: string) => ({
      v: 1,
      source: 'task-closer',
      part: 1,
      parts: 1,
      [key]: [item],
    });
    const closes = parseTaskCloseMessage(relay('TASK_CLOSE_V1', body('closes'), RUN).text);
    if (closes?.kind !== 'close') throw new Error('expected closes');
    expect(closes.rejected).toBe(0);
    expectCut(closes.closes[0]?.reason, 300);
    const proofs = parseTaskProofMessage(relay('TASK_PROOF_V1', body('proofs'), RUN).text);
    expect(proofs?.rejected).toBe(0);
    expectCut(proofs?.proofs[0]?.reason, 300);
    // The title a close is matched by stays strict.
    const long = { ...item, title: 'x'.repeat(301) };
    const strict = parseTaskCloseMessage(
      relay('TASK_CLOSE_V1', { ...body('closes'), closes: [long] }, RUN).text,
    );
    if (strict?.kind !== 'close') throw new Error('expected closes');
    expect(strict.rejected).toBe(1);
  });
});
