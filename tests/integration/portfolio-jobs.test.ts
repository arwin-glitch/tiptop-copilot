import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { env, type AppEnv } from '@/lib/config/env';
import {
  peekPortfolioJobs,
  readPortfolioJobs,
  readPortfolioJobsWithin,
  resetPortfolioJobsCache,
} from '@/lib/services/portfolio-jobs';

/**
 * Reading the jobs routine's snapshot from #deal-relay against the demo
 * store's single organization, with Slack faked. All values are fictional.
 */

let harness: Harness;

beforeEach(async () => {
  resetPortfolioJobsCache();
  harness = await createHarness();
});

afterEach(async () => {
  await harness.dispose();
});

const RUN = '2026-10-19T13:00:00Z';
const NOW = new Date('2026-10-21T12:00:00Z');
const live = (): AppEnv => ({
  ...env(),
  demoMode: false,
  askRelaySlackToken: 'xoxb-test',
  authAllowedDomains: ['tiptop.example'],
  dealRelayPosterIds: [],
});

const POST = `JOBS_V1\n\`${JSON.stringify({
  run_at: RUN,
  roles: [
    {
      company: 'Example Robotics',
      title: 'Backend Engineer',
      function: 'engineering',
      status: 'active',
      first_seen: '2026-09-01',
      last_seen: '2026-10-01',
      times_mentioned: 2,
      sources: [{ message_id: '1a0000000000aaaa', date: '2026-10-01', subject: 'October update' }],
    },
  ],
})}\``;

function slack(answers: (() => Response)[]) {
  const calls: string[] = [];
  let i = 0;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    const answer = answers[Math.min(i++, answers.length - 1)]!;
    return answer();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const ok = () =>
  new Response(JSON.stringify({ ok: true, messages: [{ text: POST, ts: '1792400000.000100' }] }), {
    status: 200,
  });
const empty = () => new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 });
const limited = () => new Response('{}', { status: 429, headers: { 'retry-after': '30' } });
const removed = () =>
  new Response(JSON.stringify({ ok: false, error: 'not_in_channel' }), { status: 200 });

describe('readPortfolioJobs', () => {
  it('serves the demo snapshot in demo mode, with no Slack call', async () => {
    const s = slack([ok]);
    const result = await readPortfolioJobs(harness.store, harness.auth.organizationId, {
      now: NOW,
      fetchImpl: s.fetchImpl,
      e: { ...env(), demoMode: true },
    });
    expect(result.state).toBe('ok');
    expect(result.snapshot?.roles.length).toBeGreaterThan(3);
    expect(s.calls).toHaveLength(0);
  });

  it('stays closed without a token or a sign-in allowlist', async () => {
    const org = harness.auth.organizationId;
    const s = slack([ok]);
    const opts = { now: NOW, fetchImpl: s.fetchImpl };
    expect(
      (
        await readPortfolioJobs(harness.store, org, {
          ...opts,
          e: { ...live(), askRelaySlackToken: undefined },
        })
      ).state,
    ).toBe('not_configured');
    expect(
      (
        await readPortfolioJobs(harness.store, org, {
          ...opts,
          e: { ...live(), authAllowedDomains: [] },
        })
      ).state,
    ).toBe('restricted');
    expect(s.calls).toHaveLength(0);
    expect(
      peekPortfolioJobs(org, { now: NOW, e: { ...live(), authAllowedDomains: [] } }),
    ).toBeNull();
  });

  it('reads the snapshot from #deal-relay and caches it', async () => {
    const org = harness.auth.organizationId;
    const s = slack([ok]);
    expect(peekPortfolioJobs(org, { now: NOW, e: live() })).toBeNull();
    const result = await readPortfolioJobs(harness.store, org, {
      now: NOW,
      fetchImpl: s.fetchImpl,
      e: live(),
    });
    expect(result.state).toBe('ok');
    expect(result.snapshot?.roles.map((r) => r.title)).toEqual(['Backend Engineer']);
    expect(s.calls[0]).toContain('conversations.history');
    expect(peekPortfolioJobs(org, { now: NOW, e: live() })?.runAt).toBe(RUN);

    await readPortfolioJobs(harness.store, org, { now: NOW, fetchImpl: s.fetchImpl, e: live() });
    expect(s.calls).toHaveLength(1);
  });

  it('says there is no scan yet when the routine has not posted', async () => {
    const result = await readPortfolioJobs(harness.store, harness.auth.organizationId, {
      now: NOW,
      fetchImpl: slack([empty]).fetchImpl,
      e: live(),
    });
    expect(result).toMatchObject({ state: 'ok', snapshot: null });
  });

  it('keeps the last good snapshot while Slack rate-limits, and drops it once access goes', async () => {
    const org = harness.auth.organizationId;
    const s = slack([ok, limited, removed]);
    await readPortfolioJobs(harness.store, org, { now: NOW, fetchImpl: s.fetchImpl, e: live() });

    const later = new Date(NOW.getTime() + 10 * 60_000);
    const during = await readPortfolioJobs(harness.store, org, {
      now: later,
      fetchImpl: s.fetchImpl,
      e: live(),
    });
    expect(during.state).toBe('ok');
    expect(during.snapshot?.runAt).toBe(RUN);

    const after = await readPortfolioJobs(harness.store, org, {
      now: new Date(later.getTime() + 2 * 60_000),
      fetchImpl: s.fetchImpl,
      e: live(),
    });
    expect(after).toMatchObject({ state: 'bot_not_in_channel', snapshot: null });
    expect(peekPortfolioJobs(org, { now: later, e: live() })).toBeNull();
  });

  it('answers null past its wait, for a page that only counts', async () => {
    const never = (() => new Promise<Response>(() => {})) as typeof fetch;
    const result = await readPortfolioJobsWithin(harness.store, harness.auth.organizationId, 20, {
      now: NOW,
      fetchImpl: never,
      e: live(),
    });
    expect(result).toBeNull();
  });
});
