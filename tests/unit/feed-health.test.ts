import { describe, expect, it } from 'vitest';
import { demoFeedInputs } from '@/lib/demo/feed-fixtures';
import { feedDef } from '@/lib/feeds/registry';
import {
  feedReportAllClear,
  feedReportHeadline,
  feedRowSummary,
  skippedWords,
} from '@/lib/feeds/words';
import {
  askRelayRules,
  buildFeedReport,
  collectSightings,
  dealRelayRules,
  feedNotice,
  feedNoticeKey,
  type FeedInputs,
  type FeedRow,
} from '@/lib/services/feed-health';
import type { SlackMessage } from '@/lib/slack/relay-history';

/**
 * The feed watchdog's reading half, the pure parts: which relay posts count
 * as a feed's (as its own consumer reads them), the report built from what
 * was read, the desktop notice for feeds that look stopped, and the words on
 * the Feeds tab. All data is fictional.
 */

const TZ = 'America/Chicago';
const POSTER = 'U0POSTER01';
const STRANGER = 'U0STRANGER';
const ts = (iso: string) => (Date.parse(iso) / 1000).toFixed(6);
const post = (iso: string, text: string, extra: Partial<SlackMessage> = {}): SlackMessage => ({
  ts: ts(iso),
  text,
  user: POSTER,
  ...extra,
});
const relay = (marker: string, body: unknown) => `${marker}\n\`${JSON.stringify(body)}\``;

const PRIORITIES = (runAt: string) =>
  relay('PRIORITIES_V1', { run_at: runAt, source: 'morning', items: [] });

const DEAL_RULES = dealRelayRules({ dealRelayPosterIds: [POSTER], taskRelayPosterIds: [POSTER] });
const ASK_RULES = askRelayRules({ taskRelayPosterIds: [POSTER] });

describe('relay sightings', () => {
  it('take the newest post its card can read', () => {
    const seen = collectSightings(
      [
        post('2026-10-20T11:30:00Z', PRIORITIES('2026-10-20T11:30:00Z')),
        post('2026-10-21T11:30:00Z', PRIORITIES('2026-10-21T11:30:00Z')),
      ],
      DEAL_RULES,
    );
    expect(seen.priorities).toEqual({ at: '2026-10-21T11:30:00.000Z', unreadableAt: null });
  });

  it('note a newer post its card could not read, and skip an older one', () => {
    const seen = collectSightings(
      [
        post('2026-10-21T20:30:00Z', 'PRIORITIES_V1\n`{"run_at": broken`'),
        post('2026-10-21T11:30:00Z', PRIORITIES('2026-10-21T11:30:00Z')),
        post('2026-10-20T11:30:00Z', 'PRIORITIES_V1\n`not json`'),
      ],
      DEAL_RULES,
    );
    expect(seen.priorities).toEqual({
      at: '2026-10-21T11:30:00.000Z',
      unreadableAt: '2026-10-21T20:30:00.000Z',
    });
  });

  it('count only the allowed posters, and nothing with a subtype', () => {
    const seen = collectSightings(
      [
        post('2026-10-21T12:00:00Z', PRIORITIES('2026-10-21T12:00:00Z'), { user: STRANGER }),
        post('2026-10-21T13:00:00Z', PRIORITIES('2026-10-21T13:00:00Z'), {
          subtype: 'message_changed',
        }),
        post('2026-10-20T11:30:00Z', PRIORITIES('2026-10-20T11:30:00Z')),
      ],
      DEAL_RULES,
    );
    expect(seen.priorities?.at).toBe('2026-10-20T11:30:00.000Z');
  });

  it('read the deal sorter and task closer run records, and ignore other markers', () => {
    const seen = collectSightings(
      [
        post(
          '2026-10-21T09:55:00Z',
          relay('DEAL_SORTER_RUN_V1', { v: 1, source: 'deal-sorter', phase: 'inc', posted: 2 }),
        ),
        post(
          '2026-10-20T20:05:00Z',
          relay('TASK_CLOSER_RUN_V1', { source: 'task-closer', checked: 4, closed: 1 }),
        ),
        post('2026-10-21T10:00:00Z', relay('DEAL_UPSERT_V1', { v: 1, deals: [] })),
        post('2026-10-21T10:05:00Z', 'Morning, all. Nothing to see here.'),
      ],
      DEAL_RULES,
    );
    expect(seen['deal-sorter']?.at).toBe('2026-10-21T09:55:00.000Z');
    expect(seen['task-closer']?.at).toBe('2026-10-20T20:05:00.000Z');
    expect(Object.keys(seen).sort()).toEqual(['deal-sorter', 'task-closer']);
  });

  it('read the weekly jobs scan: any readable part of a split run is the run seen', () => {
    const jobs = (body: unknown) => relay('JOBS_V1', body);
    const seen = collectSightings(
      [
        // Part 2 of 2 is in, part 1 is not yet: the routine still ran.
        post(
          '2026-10-19T13:20:00Z',
          jobs({ run_at: '2026-10-19T13:00:00Z', part: 2, parts: 2, roles: [] }),
        ),
        post('2026-10-12T13:10:00Z', jobs({ run_at: '2026-10-12T13:00:00Z', roles: [] })),
        // Not from an allowed poster, so not the routine.
        post('2026-10-20T13:10:00Z', jobs({ run_at: '2026-10-20T13:00:00Z', roles: [] }), {
          user: STRANGER,
        }),
      ],
      DEAL_RULES,
    );
    expect(seen['portfolio-jobs']).toEqual({ at: '2026-10-19T13:20:00.000Z', unreadableAt: null });

    const broken = collectSightings(
      [
        post('2026-10-19T13:20:00Z', 'JOBS_V1\n`{"run_at": broken`'),
        post('2026-10-12T13:10:00Z', jobs({ run_at: '2026-10-12T13:00:00Z', roles: [] })),
      ],
      DEAL_RULES,
    );
    expect(broken['portfolio-jobs']).toEqual({
      at: '2026-10-12T13:10:00.000Z',
      unreadableAt: '2026-10-19T13:20:00.000Z',
    });
  });

  it('read the twice-weekly students scan: any readable part of a split run is the run seen', () => {
    const students = (body: unknown) => relay('STUDENTS_V1', body);
    const seen = collectSightings(
      [
        // Part 1 of 2 is in, part 2 is not yet: the routine still ran.
        post(
          '2026-10-19T13:20:00Z',
          students({ run_at: '2026-10-19T13:00:00Z', part: 1, parts: 2, items: [] }),
        ),
        post('2026-10-15T13:10:00Z', students({ run_at: '2026-10-15T13:00:00Z', items: [] })),
        // Not from an allowed poster, so not the routine.
        post('2026-10-20T13:10:00Z', students({ run_at: '2026-10-20T13:00:00Z', items: [] }), {
          user: STRANGER,
        }),
      ],
      DEAL_RULES,
    );
    expect(seen.students).toEqual({ at: '2026-10-19T13:20:00.000Z', unreadableAt: null });
    // A Jobs post is never the students scan, and the other way round.
    expect(seen['portfolio-jobs']).toBeUndefined();

    const broken = collectSightings(
      [
        post('2026-10-19T13:20:00Z', 'STUDENTS_V1\n`{"run_at": broken`'),
        post('2026-10-15T13:10:00Z', students({ run_at: '2026-10-15T13:00:00Z', items: [] })),
      ],
      DEAL_RULES,
    );
    expect(broken.students).toEqual({
      at: '2026-10-15T13:10:00.000Z',
      unreadableAt: '2026-10-19T13:20:00.000Z',
    });
  });

  it("tell the morning brief and the afternoon recap apart, through Slack's link markup", () => {
    const briefing = (kind: string, dateKey: string) =>
      `BRIEFING_PAYLOAD_V1\n\`{"kind":"${kind}","date_key":"${dateKey}","title":"Example brief","summary":"Two fictional items.","source_url":"<https://example.com/brief|https://example.com/brief>"}\``;
    const seen = collectSightings(
      [
        post('2026-10-21T11:02:00Z', briefing('morning', '2026-10-21')),
        post('2026-10-21T11:03:00Z', briefing('dossier', '2026-10-21')),
        post('2026-10-20T20:01:00Z', briefing('afternoon', '2026-10-20')),
        post('2026-10-21T20:01:00Z', 'BRIEFING_PAYLOAD_V1\n`{"kind":"afternoon"`'),
        // One that names no kind could be either routine's: older than both here.
        post('2026-10-19T20:01:00Z', 'BRIEFING_PAYLOAD_V1\n`{}`'),
        post(
          '2026-10-21T15:00:00Z',
          relay('ASK_ANSWER_V1', { message_id: 'm-1', answer: 'A fictional answer.' }),
          { user: STRANGER },
        ),
        post(
          '2026-10-19T20:30:00Z',
          relay('PORTFOLIO_ADD_V1', { source: 'routine', companies: [{ name: 'Example Labs' }] }),
        ),
        post(
          '2026-10-21T09:35:00Z',
          relay('TASK_ADD_V1', { source: 'routine', tasks: [{ title: 'Send the example deck' }] }),
        ),
      ],
      ASK_RULES,
    );
    expect(seen.overview?.at).toBe('2026-10-21T11:03:00.000Z');
    // The broken post names its kind, so only the recap says so.
    expect(seen.overview?.unreadableAt).toBeNull();
    expect(seen.recap).toEqual({
      at: '2026-10-20T20:01:00.000Z',
      unreadableAt: '2026-10-21T20:01:00.000Z',
    });
    expect(seen['ask-answers']?.at).toBe('2026-10-21T15:00:00.000Z');
    expect(seen['portfolio-adds']?.at).toBe('2026-10-19T20:30:00.000Z');
    expect(seen['task-suggest']?.at).toBe('2026-10-21T09:35:00.000Z');
  });

  it('mark a newer briefing that names no kind against both routines', () => {
    const seen = collectSightings(
      [
        post(
          '2026-10-20T11:02:00Z',
          relay('BRIEFING_PAYLOAD_V1', {
            kind: 'morning',
            date_key: '2026-10-20',
            title: 'Example brief',
            summary: 'One fictional item.',
          }),
        ),
        post('2026-10-21T11:02:00Z', 'BRIEFING_PAYLOAD_V1\n`{"title": "cut off'),
      ],
      ASK_RULES,
    );
    expect(seen.overview).toEqual({
      at: '2026-10-20T11:02:00.000Z',
      unreadableAt: '2026-10-21T11:02:00.000Z',
    });
    expect(seen.recap).toEqual({ at: null, unreadableAt: '2026-10-21T11:02:00.000Z' });
  });
});

/** Every feed fresh at `now`, every part readable. */
function freshInputs(now: Date): FeedInputs {
  const demo = demoFeedInputs(now);
  const recent = new Date(now.getTime() - 3_600_000).toISOString();
  const fresh = (read: FeedInputs['dealRelay']): FeedInputs['dealRelay'] =>
    read.state === 'ok'
      ? {
          state: 'ok',
          seen: Object.fromEntries(
            Object.keys(read.seen).map((k) => [k, { at: recent, unreadableAt: null }]),
          ),
        }
      : read;
  return {
    ...demo,
    dealRelay: fresh(demo.dealRelay),
    askRelay: fresh(demo.askRelay),
    jobs: { 'daily-job': recent, 'push-sender': recent },
  };
}

describe('the report', () => {
  // Wednesday Oct 21, 10am in Chicago.
  const now = new Date('2026-10-21T15:00:00Z');
  const row = (rows: FeedRow[], id: string) => rows.find((r) => r.id === id);

  it('in the demo: the task closer looks stopped, the deal sorter is late, worst first', () => {
    const { rows } = buildFeedReport(demoFeedInputs(now), now, TZ);
    expect(rows.filter((r) => r.status === 'stopped').map((r) => r.id)).toEqual(['task-closer']);
    expect(rows.filter((r) => r.status === 'late').map((r) => r.id)).toEqual(['deal-sorter']);
    expect(rows[0]?.id).toBe('task-closer');
    expect(rows[1]?.id).toBe('deal-sorter');
    expect(row(rows, 'lp-update')?.status).toBe('never');
    expect(row(rows, 'portfolio-adds')?.status).toBe('never');
    expect(rows.some((r) => r.id.startsWith('reports:'))).toBe(true);
  });

  it("says it can't check a relay that could not be read, never that it stopped", () => {
    const inputs: FeedInputs = {
      ...freshInputs(now),
      dealRelay: { state: 'unknown', reason: 'Slack could not be read just now.' },
    };
    const { rows } = buildFeedReport(inputs, now, TZ);
    expect(row(rows, 'priorities')).toMatchObject({
      status: 'unknown',
      reason: 'Slack could not be read just now.',
    });
    expect(row(rows, 'overview')?.status).toBe('ok');
    expect(rows.some((r) => r.status === 'stopped')).toBe(false);
  });

  it('reads the jobs, the sync and Ask from their own inputs', () => {
    const base = freshInputs(now);
    const { rows } = buildFeedReport(
      {
        ...base,
        jobs: { 'daily-job': new Date(now.getTime() - 40 * 3_600_000).toISOString() },
        affinity: { configured: false, lastRunAt: null },
        ask: {
          configured: true,
          waitingSince: new Date(now.getTime() - 90 * 60_000).toISOString(),
        },
      },
      now,
      TZ,
    );
    expect(row(rows, 'daily-job')?.status).toBe('stopped');
    expect(row(rows, 'push-sender')?.status).toBe('never');
    expect(row(rows, 'affinity-sync')).toMatchObject({ status: 'off' });
    expect(row(rows, 'ask-answers')).toMatchObject({ status: 'stopped' });
    expect(row(rows, 'ask-answers')?.waitingSince).not.toBeNull();

    const unread = buildFeedReport({ ...base, jobs: null, affinity: null }, now, TZ).rows;
    expect(row(unread, 'daily-job')?.status).toBe('unknown');
    expect(row(unread, 'affinity-sync')?.status).toBe('unknown');

    const noAsk = buildFeedReport(
      { ...base, ask: { configured: false, waitingSince: null } },
      now,
      TZ,
    ).rows;
    expect(row(noAsk, 'ask-answers')?.status).toBe('off');
  });

  it('reads meeting notes as news: last seen, never late, off only when nothing can arrive', () => {
    const base = freshInputs(now);
    const weekAgo = new Date(now.getTime() - 7 * 24 * 3_600_000).toISOString();
    const quiet = buildFeedReport(
      { ...base, notes: { configured: true, lastAt: weekAgo } },
      now,
      TZ,
    ).rows;
    expect(row(quiet, 'meeting-notes')).toMatchObject({ status: 'ok', lastSeen: weekAgo });

    const none = (configured: boolean) =>
      row(
        buildFeedReport({ ...base, notes: { configured, lastAt: null } }, now, TZ).rows,
        'meeting-notes',
      );
    expect(none(true)?.status).toBe('never');
    expect(none(false)?.status).toBe('off');
    // Notes already in, from a delivery since turned off: still last seen.
    expect(
      row(
        buildFeedReport({ ...base, notes: { configured: false, lastAt: weekAgo } }, now, TZ).rows,
        'meeting-notes',
      )?.status,
    ).toBe('ok');
    expect(
      row(buildFeedReport({ ...base, notes: null }, now, TZ).rows, 'meeting-notes'),
    ).toMatchObject({ status: 'unknown' });
  });
});

describe('the feed notice', () => {
  // Wednesday Oct 21, 10am in Chicago.
  const now = new Date('2026-10-21T15:00:00Z');
  const report = () => buildFeedReport(demoFeedInputs(now), now, TZ);

  it('names the stopped feed, once a day, and opens Diagnostics > Feeds', () => {
    const notice = feedNotice(report(), new Set(), now, TZ);
    expect(notice).toEqual({
      keys: ['feed:task-closer:2026-10-21'],
      title: 'A feed looks stopped',
      body: 'Task closer: last seen 3 days ago',
      url: '/diagnostics?tab=feeds',
    });
    expect(feedNotice(report(), new Set(notice?.keys), now, TZ)).toBeNull();
    // The next morning it may notify again.
    const tomorrow = new Date('2026-10-22T14:00:00Z');
    expect(feedNoticeKey('task-closer', tomorrow, TZ)).toBe('feed:task-closer:2026-10-22');
    expect(
      feedNotice(
        buildFeedReport(demoFeedInputs(tomorrow), tomorrow, TZ),
        new Set(notice?.keys),
        tomorrow,
        TZ,
      )?.keys,
    ).toEqual(['feed:task-closer:2026-10-22']);
  });

  it('groups several stopped feeds into one notice', () => {
    const inputs = demoFeedInputs(now);
    const old = new Date(now.getTime() - 5 * 24 * 3_600_000).toISOString();
    const notice = feedNotice(
      buildFeedReport({ ...inputs, jobs: { 'daily-job': old, 'push-sender': old } }, now, TZ),
      new Set(),
      now,
      TZ,
    );
    expect(notice?.title).toBe('3 feeds look stopped');
    expect(notice?.keys).toHaveLength(3);
    expect(notice?.body).toMatch(/^Task closer: last seen 3 days ago \(\+2 more\)$/);
  });

  it('stays quiet before 8am and from 8pm', () => {
    const early = new Date('2026-10-21T12:30:00Z'); // 7:30am Chicago
    const late = new Date('2026-10-22T01:15:00Z'); // 8:15pm Chicago
    for (const at of [early, late]) {
      expect(feedNotice(buildFeedReport(demoFeedInputs(at), at, TZ), new Set(), at, TZ)).toBeNull();
    }
  });

  it('is never sent for a late feed, an unknown one, or one never seen', () => {
    const inputs = demoFeedInputs(now);
    const notice = feedNotice(
      buildFeedReport(
        { ...inputs, dealRelay: { state: 'unknown', reason: 'Slack could not be read just now.' } },
        now,
        TZ,
      ),
      new Set(),
      now,
      TZ,
    );
    expect(notice).toBeNull();
  });
});

describe('the Feeds tab in words', () => {
  const now = new Date('2026-10-21T15:00:00Z');
  const base = {
    def: feedDef('task-closer'),
    lastSeen: '2026-10-18T15:00:00Z',
    unreadableAt: null,
    waitingSince: null,
    reason: null,
  };

  it('says when a feed was last seen and what is missed', () => {
    expect(feedRowSummary({ ...base, status: 'stopped' }, now, TZ)).toBe(
      'Last seen 3d ago (Oct 18, 10:00 AM). Expected at least every day; at least two runs look missed.',
    );
    expect(
      feedRowSummary({ ...base, status: 'late', lastSeen: '2026-10-20T07:00:00Z' }, now, TZ),
    ).toBe(
      'Last seen 1d ago (Oct 20, 2:00 AM). Expected at least every day; one run looks missed.',
    );
  });

  it('says when a newer post could not be read', () => {
    expect(
      feedRowSummary(
        {
          ...base,
          status: 'ok',
          lastSeen: '2026-10-21T13:00:00Z',
          unreadableAt: '2026-10-21T14:00:00Z',
        },
        now,
        TZ,
      ),
    ).toBe(
      'Last seen 2h ago (Oct 21, 8:00 AM). A newer post (Oct 21, 9:00 AM) could not be read, so its card kept the older copy.',
    );
  });

  it("explains a feed that is off, can't be checked, or was never seen", () => {
    expect(feedRowSummary({ ...base, status: 'off', reason: 'No key.' }, now, TZ)).toBe('No key.');
    expect(feedRowSummary({ ...base, status: 'unknown', reason: 'Slack is down.' }, now, TZ)).toBe(
      "Can't check right now. Slack is down.",
    );
    expect(
      feedRowSummary({ ...base, def: feedDef('daily-job'), status: 'never' }, now, TZ),
    ).toMatch(/^No run noted yet/);
    expect(
      feedRowSummary({ ...base, def: feedDef('portfolio-adds'), status: 'never' }, now, TZ),
    ).toMatch(/normal when there was nothing new/);
    // A quarterly feed is outside the 30 days read for most of its quarter.
    expect(
      feedRowSummary({ ...base, def: feedDef('lp-update'), status: 'never' }, now, TZ),
    ).toMatch(/normal for a feed that runs less often than that/);
    expect(
      feedRowSummary({ ...base, def: feedDef('meeting-notes'), status: 'never' }, now, TZ),
    ).toBe('Nothing has arrived yet.');
    expect(
      feedRowSummary({ ...base, def: feedDef('priorities'), status: 'never' }, now, TZ),
    ).toMatch(/may not be set up yet, or it stopped before then/);
  });

  it('says how long a question has waited', () => {
    expect(
      feedRowSummary(
        {
          ...base,
          def: feedDef('ask-answers'),
          status: 'late',
          lastSeen: '2026-10-21T09:00:00Z',
          waitingSince: '2026-10-21T14:40:00Z',
        },
        now,
        TZ,
      ),
    ).toBe('A question has waited 20 minutes for its answer. Last seen 6h ago (Oct 21, 4:00 AM).');
  });

  it('heads the tab with what is wrong, if anything', () => {
    const rows = (statuses: FeedRow['status'][]) => statuses.map((status) => ({ status }));
    expect(feedReportHeadline(rows(['ok', 'never']))).toBeNull();
    expect(feedReportHeadline(rows(['stopped', 'ok']))).toBe('1 feed looks stopped.');
    expect(feedReportHeadline(rows(['late', 'late']))).toBe('2 feeds are late.');
    expect(feedReportHeadline(rows(['stopped', 'stopped', 'late']))).toBe(
      '2 feeds look stopped and 1 is late.',
    );
  });

  it("never calls the feeds on time while some can't be checked", () => {
    const rows = (statuses: FeedRow['status'][]) => statuses.map((status) => ({ status }));
    expect(feedReportAllClear(rows(['ok', 'never', 'off']))).toBe('Nothing looks late or stopped.');
    expect(feedReportAllClear(rows(['ok', 'unknown']))).toBe(
      "Nothing looks late or stopped, but 1 feed can't be checked right now.",
    );
    expect(feedReportAllClear(rows(['unknown', 'unknown', 'off']))).toBe(
      "Nothing looks late or stopped, but 2 feeds can't be checked right now.",
    );
  });
});

describe('items a readable post left out (D-073)', () => {
  const RUN = '2026-10-21T11:21:01Z';
  const event = (kind: string, day = 22) => ({
    title: 'Example meeting',
    starts_at: `2026-10-${day}T15:00:00Z`,
    kind,
  });
  const week = (body: Record<string, unknown>) => relay('WEEK_AHEAD_V1', body);

  it('are summed over every part of the newest run, each part once', () => {
    const seen = collectSightings(
      [
        // Part 2, with the same run_at spelled with milliseconds; one bad event.
        post(
          '2026-10-21T11:21:40Z',
          week({
            run_at: '2026-10-21T11:21:01.000Z',
            part: 2,
            events: [event('lp'), event('retreat')],
          }),
        ),
        // Part 1, posted twice (a retry): counted once.
        post(
          '2026-10-21T11:21:20Z',
          week({ run_at: RUN, part: 1, events: [event('founder'), event('x'), event('y')] }),
        ),
        post(
          '2026-10-21T11:21:10Z',
          week({ run_at: RUN, part: 1, events: [event('founder'), event('x'), event('y')] }),
        ),
        // Yesterday's run left items out too; they are not today's.
        post(
          '2026-10-20T11:20:00Z',
          week({ run_at: '2026-10-20T11:20:00Z', events: [event('founder'), event('nope')] }),
        ),
      ],
      DEAL_RULES,
    );
    expect(seen['week-ahead']).toEqual({
      at: '2026-10-21T11:21:40.000Z',
      unreadableAt: null,
      skipped: 3,
    });
  });

  it('are never counted for an unreadable post, which stays "could not be read"', () => {
    const seen = collectSightings(
      [
        post('2026-10-21T11:22:00Z', 'WEEK_AHEAD_V1\n`{"run_at": broken`'),
        // Every event unreadable: the whole post is.
        post('2026-10-21T11:21:30Z', week({ run_at: RUN, part: 2, events: [event('x')] })),
        post('2026-10-21T11:21:00Z', week({ run_at: RUN, part: 1, events: [event('lp')] })),
      ],
      DEAL_RULES,
    );
    expect(seen['week-ahead']).toEqual({
      at: '2026-10-21T11:21:00.000Z',
      unreadableAt: '2026-10-21T11:22:00.000Z',
    });
  });

  it('call a one-post snapshot mostly unreadable "could not be read", its card on the older copy', () => {
    const item = (title: string, kind = 'other') => ({ title, why: 'Ranked', kind });
    const seen = collectSightings(
      [
        // Two of three in a kind the app does not know: the card keeps the older copy.
        post(
          '2026-10-21T20:00:00Z',
          relay('PRIORITIES_V1', {
            run_at: '2026-10-21T20:00:00Z',
            source: 'afternoon',
            items: [item('D'), item('E', 'legal'), item('F', 'legal')],
          }),
        ),
        // The copy kept, itself less one item.
        post(
          '2026-10-21T11:00:00Z',
          relay('PRIORITIES_V1', {
            run_at: '2026-10-21T11:00:00Z',
            source: 'morning',
            items: [item('A'), item('B'), item('C', 'legal')],
          }),
        ),
      ],
      DEAL_RULES,
    );
    expect(seen.priorities).toEqual({
      at: '2026-10-21T11:00:00.000Z',
      unreadableAt: '2026-10-21T20:00:00.000Z',
      skipped: 1,
    });
  });

  it("come from Jobs' and Students' own dropped counts too", () => {
    const role = {
      company: 'Example Robotics',
      title: 'Backend Engineer',
      function: 'engineering',
      status: 'active',
      first_seen: '2026-10-01',
      last_seen: '2026-10-15',
    };
    const seen = collectSightings(
      [
        post(
          '2026-10-19T13:20:00Z',
          relay('JOBS_V1', {
            run_at: '2026-10-19T13:00:00Z',
            roles: [role, { ...role, status: 'maybe' }],
          }),
        ),
      ],
      DEAL_RULES,
    );
    expect(seen['portfolio-jobs']).toEqual({
      at: '2026-10-19T13:20:00.000Z',
      unreadableAt: null,
      skipped: 1,
    });
  });

  it('reach the report row, and the Feeds tab says so in words', () => {
    const now = new Date('2026-10-21T15:00:00Z');
    const inputs = demoFeedInputs(now);
    const rows = buildFeedReport(
      {
        ...inputs,
        dealRelay: {
          state: 'ok',
          seen: { 'week-ahead': { at: '2026-10-21T11:21:40Z', unreadableAt: null, skipped: 2 } },
        },
      },
      now,
      TZ,
    ).rows;
    const row = rows.find((r) => r.id === 'week-ahead')!;
    expect(row).toMatchObject({ status: 'ok', skipped: 2, unreadableAt: null });
    expect(feedRowSummary(row, now, TZ)).toBe(
      'Last seen 4h ago (Oct 21, 6:21 AM). 2 items in the newest post were skipped because they could not be read; the rest of the post is showing.',
    );
    expect(feedRowSummary(row, now, TZ)).not.toMatch(/kept the older copy/);
  });
});

describe('the Feeds tab on skipped items', () => {
  const now = new Date('2026-10-21T15:00:00Z');
  const base = {
    def: feedDef('week-ahead'),
    status: 'ok' as const,
    lastSeen: '2026-10-21T11:24:00Z',
    unreadableAt: null,
    waitingSince: null,
    reason: null,
  };

  it('says one item, or several, were skipped from the newest post', () => {
    expect(feedRowSummary({ ...base, skipped: 1 }, now, TZ)).toBe(
      'Last seen 4h ago (Oct 21, 6:24 AM). 1 item in the newest post was skipped because it could not be read; the rest of the post is showing.',
    );
    expect(skippedWords({ skipped: 3, unreadableAt: null })).toMatch(/^3 items in the newest post/);
    expect(feedRowSummary({ ...base, skipped: 0 }, now, TZ)).toBe(
      'Last seen 4h ago (Oct 21, 6:24 AM).',
    );
  });

  it('speaks of the copy kept when a newer post could not be read at all', () => {
    expect(
      feedRowSummary({ ...base, skipped: 2, unreadableAt: '2026-10-21T14:00:00Z' }, now, TZ),
    ).toBe(
      'Last seen 4h ago (Oct 21, 6:24 AM). A newer post (Oct 21, 9:00 AM) could not be read, so its card kept the older copy. 2 items in the copy it kept were skipped.',
    );
  });
});
