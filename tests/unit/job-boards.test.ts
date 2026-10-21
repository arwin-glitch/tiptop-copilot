import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { env, type AppEnv } from '@/lib/config/env';
import { jobBoardCheck, readBoardAnswer } from '@/lib/portfolio/job-boards';
import { jobId } from '@/lib/portfolio/job-id';
import type { JobRole } from '@/lib/portfolio/jobs';
import {
  cachedJobLinkVerdicts,
  jobLinkVerdicts,
  resetJobLivenessCache,
} from '@/lib/services/job-liveness';

/** Board slugs, posting ids and companies below are fictional. */
const UUID = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';

describe('jobBoardCheck', () => {
  it('recognises postings on the three boards and builds their API address', () => {
    expect(jobBoardCheck('https://boards.greenhouse.io/examplerobotics/jobs/4012345')).toEqual({
      board: 'Greenhouse',
      apiUrl: 'https://boards-api.greenhouse.io/v1/boards/examplerobotics/jobs/4012345',
      postingId: '4012345',
      kind: 'posting',
    });
    expect(
      jobBoardCheck('https://job-boards.greenhouse.io/examplerobotics/jobs/4012345?gh_src=x')
        ?.apiUrl,
    ).toBe('https://boards-api.greenhouse.io/v1/boards/examplerobotics/jobs/4012345');
    expect(jobBoardCheck(`https://jobs.lever.co/samplefreight/${UUID}/apply`)).toEqual({
      board: 'Lever',
      apiUrl: `https://api.lever.co/v0/postings/samplefreight/${UUID}`,
      postingId: UUID,
      kind: 'posting',
    });
    expect(jobBoardCheck(`https://jobs.ashbyhq.com/samplefreight/${UUID.toUpperCase()}`)).toEqual({
      board: 'Ashby',
      apiUrl: 'https://api.ashbyhq.com/posting-api/job-board/samplefreight',
      postingId: UUID,
      kind: 'board',
    });
  });

  it('checks nothing else: careers pages, look-alike hosts, odd paths', () => {
    for (const link of [
      null,
      'not a url',
      'https://examplerobotics.example/careers/backend',
      'https://boards.greenhouse.io.evil.example/x/jobs/1',
      'https://evil.example/boards.greenhouse.io/x/jobs/1',
      'https://boards.greenhouse.io/examplerobotics',
      'https://boards.greenhouse.io/examplerobotics/jobs/not-a-number',
      'https://boards.greenhouse.io/../jobs/1',
      `https://jobs.lever.co/samplefreight/not-a-uuid`,
      `https://jobs.lever.co/samplefreight/${UUID}/elsewhere`,
      `https://user:pw@jobs.lever.co/samplefreight/${UUID}`,
      `https://jobs.lever.co:8443/samplefreight/${UUID}`,
      `ftp://jobs.lever.co/samplefreight/${UUID}`,
    ]) {
      expect(jobBoardCheck(link), String(link)).toBeNull();
    }
  });
});

describe('readBoardAnswer', () => {
  const posting = jobBoardCheck('https://boards.greenhouse.io/examplerobotics/jobs/1')!;
  const board = jobBoardCheck(`https://jobs.ashbyhq.com/samplefreight/${UUID}`)!;

  it('takes only a definite answer', () => {
    expect(readBoardAnswer(posting, 200, {})).toBe('live');
    expect(readBoardAnswer(posting, 404, null)).toBe('gone');
    expect(readBoardAnswer(posting, 410, null)).toBe('gone');
    expect(readBoardAnswer(posting, 500, null)).toBe('unknown');
    expect(readBoardAnswer(posting, 429, null)).toBe('unknown');
    expect(readBoardAnswer(posting, 0, null)).toBe('unknown');
  });

  it('looks the posting up in a whole board', () => {
    expect(readBoardAnswer(board, 200, { jobs: [{ id: UUID.toUpperCase() }] })).toBe('live');
    expect(readBoardAnswer(board, 200, { jobs: [{ id: 'other' }] })).toBe('gone');
    expect(readBoardAnswer(board, 200, { nope: true })).toBe('unknown');
    expect(readBoardAnswer(board, 404, null)).toBe('gone');
  });
});

function role(title: string, link: string | null, status: JobRole['status'] = 'active'): JobRole {
  return {
    id: jobId('Example Robotics', title),
    company: 'Example Robotics',
    company_domain: 'examplerobotics.example',
    is_portfolio: true,
    title,
    function: 'engineering',
    seniority: null,
    location: null,
    remote: null,
    comp: null,
    link,
    contact_name: null,
    contact_email: null,
    status,
    status_note: null,
    first_seen: '2026-09-01T12:00:00.000Z',
    last_seen: '2026-10-01T12:00:00.000Z',
    times_mentioned: 1,
    sources: [],
  };
}

describe('jobLinkVerdicts', () => {
  const e: AppEnv = { ...env(), demoMode: false };
  const NOW = new Date('2026-10-21T12:00:00Z');
  const gone = role('Backend Engineer', 'https://boards.greenhouse.io/examplerobotics/jobs/11');
  const live = role('Designer', `https://jobs.lever.co/examplerobotics/${UUID}`);
  const careers = role('Analyst', 'https://examplerobotics.example/careers/analyst');
  const filled = role(
    'Controller',
    'https://boards.greenhouse.io/examplerobotics/jobs/12',
    'filled',
  );

  beforeEach(() => resetJobLivenessCache());

  function fakeBoards() {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/jobs/11')) return new Response('{}', { status: 404 });
      return new Response('{"id":"x"}', { status: 200 });
    }) as typeof fetch;
    return { calls, fetchImpl };
  }

  it('asks the board for open roles only, and caches the answer for a day', async () => {
    const boards = fakeBoards();
    const verdicts = await jobLinkVerdicts([gone, live, careers, filled], {
      now: NOW,
      fetchImpl: boards.fetchImpl,
      e,
    });
    expect(boards.calls.sort()).toEqual([
      `https://api.lever.co/v0/postings/examplerobotics/${UUID}`,
      'https://boards-api.greenhouse.io/v1/boards/examplerobotics/jobs/11',
    ]);
    expect(verdicts.get(gone.id)).toEqual({
      gone: true,
      board: 'Greenhouse',
      checkedAt: NOW.toISOString(),
    });
    expect(verdicts.get(live.id)?.gone).toBe(false);
    expect(verdicts.has(careers.id)).toBe(false);

    const later = new Date(NOW.getTime() + 6 * 3_600_000);
    await jobLinkVerdicts([gone, live], { now: later, fetchImpl: boards.fetchImpl, e });
    expect(boards.calls).toHaveLength(2);
    expect(cachedJobLinkVerdicts([gone], { now: later, e }).get(gone.id)?.gone).toBe(true);

    const nextDay = new Date(NOW.getTime() + 25 * 3_600_000);
    expect(cachedJobLinkVerdicts([gone], { now: nextDay, e }).size).toBe(0);
    await jobLinkVerdicts([gone], { now: nextDay, fetchImpl: boards.fetchImpl, e });
    expect(boards.calls).toHaveLength(3);
  });

  it('treats a fault as no answer, and never calls out in demo mode', async () => {
    const failing = (async () => {
      throw new Error('offline');
    }) as typeof fetch;
    const verdicts = await jobLinkVerdicts([gone], { now: NOW, fetchImpl: failing, e });
    expect(verdicts.size).toBe(0);

    const boards = fakeBoards();
    const demo = await jobLinkVerdicts([live], {
      now: NOW,
      fetchImpl: boards.fetchImpl,
      e: { ...e, demoMode: true },
    });
    expect(demo.size).toBe(0);
    expect(boards.calls).toHaveLength(0);
  });

  it('never holds the caller past its wait, and fills the cache after', async () => {
    let release: () => void = () => {};
    const slow = (async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const first = await jobLinkVerdicts([gone], { now: NOW, fetchImpl: slow, e, waitMs: 10 });
    expect(first.size).toBe(0);
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(cachedJobLinkVerdicts([gone], { now: NOW, e }).get(gone.id)?.gone).toBe(true);
  });
});
