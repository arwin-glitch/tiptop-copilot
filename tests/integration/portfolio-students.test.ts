import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { env, type AppEnv } from '@/lib/config/env';
import {
  peekPortfolioStudents,
  readPortfolioStudents,
  resetPortfolioStudentsCache,
} from '@/lib/services/portfolio-students';
import { peekPortfolioJobs, resetPortfolioJobsCache } from '@/lib/services/portfolio-jobs';

/**
 * Reading the students routine's snapshot from #deal-relay against the demo
 * store's single organization, with Slack faked. All values are fictional.
 */

let harness: Harness;

beforeEach(async () => {
  resetPortfolioStudentsCache();
  resetPortfolioJobsCache();
  harness = await createHarness();
});

afterEach(async () => {
  await harness.dispose();
});

const RUN = '2026-10-19T13:00:00.000Z';
const NOW = new Date('2026-10-21T12:00:00Z');
const live = (): AppEnv => ({
  ...env(),
  demoMode: false,
  askRelaySlackToken: 'xoxb-test',
  authAllowedDomains: ['tiptop.example'],
  dealRelayPosterIds: [],
});

const POST = `STUDENTS_V1\n\`${JSON.stringify({
  run_at: RUN,
  part: 1,
  parts: 1,
  scanned_since: '2026-10-16T13:00:00Z',
  emails_scanned: 12,
  items: [
    {
      kind: 'intern_request',
      person: 'Ada Example',
      school_or_org: 'Example State University',
      program: null,
      ask: 'Asks about a summer internship',
      status: 'new',
      nick_replied: false,
      next_step: 'Nick to reply',
      next_owner: 'nick',
      first_seen: '2026-10-18',
      last_seen: '2026-10-18',
      sources: [
        { thread_id: '1a0000000000aaaa', date: '2026-10-18', subject: 'Internship question' },
      ],
    },
  ],
})}\``;

function slack(answers: (() => Response)[]) {
  const calls: string[] = [];
  let i = 0;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return answers[Math.min(i++, answers.length - 1)]!();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const ok =
  (text = POST) =>
  () =>
    new Response(JSON.stringify({ ok: true, messages: [{ text, ts: '1792400000.000100' }] }), {
      status: 200,
    });
const limited = () => new Response('{}', { status: 429, headers: { 'retry-after': '30' } });

describe('readPortfolioStudents', () => {
  it('serves the demo snapshot in demo mode, with no Slack call', async () => {
    const s = slack([ok()]);
    const result = await readPortfolioStudents(harness.store, harness.auth.organizationId, {
      now: NOW,
      fetchImpl: s.fetchImpl,
      e: { ...env(), demoMode: true },
    });
    expect(result.state).toBe('ok');
    expect(result.snapshot?.items.length).toBeGreaterThanOrEqual(4);
    expect(s.calls).toHaveLength(0);
  });

  it('stays closed without a token or a sign-in allowlist', async () => {
    const org = harness.auth.organizationId;
    const s = slack([ok()]);
    const opts = { now: NOW, fetchImpl: s.fetchImpl };
    const noToken = { ...live(), askRelaySlackToken: undefined };
    const open = { ...live(), authAllowedDomains: [] };
    expect((await readPortfolioStudents(harness.store, org, { ...opts, e: noToken })).state).toBe(
      'not_configured',
    );
    expect((await readPortfolioStudents(harness.store, org, { ...opts, e: open })).state).toBe(
      'restricted',
    );
    expect(s.calls).toHaveLength(0);
    expect(peekPortfolioStudents(org, { now: NOW, e: open })).toBeNull();
  });

  it('reads the snapshot from #deal-relay, caches it, and keeps it apart from Jobs', async () => {
    const org = harness.auth.organizationId;
    const s = slack([ok()]);
    const result = await readPortfolioStudents(harness.store, org, {
      now: NOW,
      fetchImpl: s.fetchImpl,
      e: live(),
    });
    expect(result.state).toBe('ok');
    expect(result.snapshot).toMatchObject({ runAt: RUN, emailsScanned: 12, partial: false });
    expect(result.snapshot?.items.map((i) => i.person)).toEqual(['Ada Example']);
    expect(s.calls[0]).toContain('conversations.history');
    expect(peekPortfolioStudents(org, { now: NOW, e: live() })?.runAt).toBe(RUN);
    // The Jobs reader has its own cache: a students read is not a jobs scan.
    expect(peekPortfolioJobs(org, { now: NOW, e: live() })).toBeNull();

    await readPortfolioStudents(harness.store, org, {
      now: NOW,
      fetchImpl: s.fetchImpl,
      e: live(),
    });
    expect(s.calls).toHaveLength(1);
  });

  it('finds no scan in a channel holding only a jobs post', async () => {
    const jobsPost = `JOBS_V1\n\`${JSON.stringify({ run_at: RUN, roles: [] })}\``;
    const result = await readPortfolioStudents(harness.store, harness.auth.organizationId, {
      now: NOW,
      fetchImpl: slack([ok(jobsPost)]).fetchImpl,
      e: live(),
    });
    expect(result).toMatchObject({ state: 'ok', snapshot: null });
  });

  it('keeps the last good snapshot while Slack rate-limits', async () => {
    const org = harness.auth.organizationId;
    const s = slack([ok(), limited]);
    await readPortfolioStudents(harness.store, org, {
      now: NOW,
      fetchImpl: s.fetchImpl,
      e: live(),
    });
    const during = await readPortfolioStudents(harness.store, org, {
      now: new Date(NOW.getTime() + 10 * 60_000),
      fetchImpl: s.fetchImpl,
      e: live(),
    });
    expect(during.state).toBe('ok');
    expect(during.snapshot?.runAt).toBe(RUN);
  });
});
