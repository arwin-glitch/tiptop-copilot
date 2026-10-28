import { readFileSync } from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as askRoute } from '@/app/api/jobs-board/ask/route';
import { GET as answerRoute } from '@/app/api/jobs-board/ask/answer/route';
import {
  bookingChatRelayProblem,
  env,
  jobsChatRelayProblem,
  resetEnvCache,
} from '@/lib/config/env';
import { IDENTITY_ANSWER, NO_ANSWER } from '@/lib/jobs-board/assistant';
import {
  DEFAULT_JOBS_ASSISTANT,
  DEFAULT_JOBS_FAQ,
  type JobsAssistantConfig,
} from '@/lib/jobs-board/assistant-config';
import {
  buildJobsQuestionFacts,
  JOBS_EXPIRE_AFTER_MS,
  JOBS_QUESTION_RETENTION_DAYS,
  jobsChatConfigured,
  parseJobsAnswer,
  pruneJobsQuestions,
  resetJobsSettleThrottle,
  sanitiseJobsAnswer,
} from '@/lib/jobs-board/chat-bridge';
import { JOBS_CHAT_API_PATHS, routeBoardHost } from '@/lib/jobs-board/host';
import { jobsChatGate } from '@/lib/jobs-board/route-helpers';
import { visitorGate } from '@/lib/booking/route-helpers';
import { resetBoardRateLimit } from '@/lib/jobs-board/rate-limit';
import type { PublicBoard, PublicCompany, PublicJob } from '@/lib/jobs-board/public';
import { resetLimiters } from '@/lib/security/limits';
import {
  answerJobsQuestion,
  JOBS_CHAT_REQUEST,
  PENDING_TEXT,
  readJobsAssistant,
  readJobsAssistantPanel,
  readJobsChatAnswer,
  saveJobsAssistant,
  type JobsChatContext,
} from '@/lib/services/jobs-chat';
import type { JobsChatQuestion } from '@/lib/types/domain';
import { proxy } from '@/proxy';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * "Ask Arwin" on the public job board, end to end over the demo store: the
 * tiers in order, the optional routine on Arwin's Claude plan (fired with
 * public facts only, settled from its own Slack relay by question id, made
 * plain, expired, capped three ways, off unless set up and switched on), the
 * settings, the public routes' brakes and the board host. Every company,
 * role, person and address here is fictional; nothing reaches the network.
 */

const NOW = new Date('2026-10-28T15:00:00Z');
const FIRE_URL = 'https://api.anthropic.com/v1/claude_code/routines/trig_jobs_test/fire';
const POSTER = 'U0JOBSPOSTER';
const RELAY = 'C0JOBSRELAY';
const BOARD_URL = 'https://jobs.example/jobs';
const SAVED = { ...process.env };
const KEYS = [
  'JOBS_CHAT_FIRE_URL',
  'JOBS_CHAT_TOKEN',
  'ASK_RELAY_SLACK_TOKEN',
  'JOBS_CHAT_RELAY_CHANNEL_ID',
  'JOBS_CHAT_POSTER_IDS',
];

let harness: Harness;

function job(slug: string, title: string, extra: Partial<PublicJob> = {}): PublicJob {
  return {
    key: `acme-robotics/${slug}`,
    slug,
    companySlug: 'acme-robotics',
    companyName: 'Acme Robotics',
    title,
    team: null,
    fn: 'engineering',
    locations: ['Austin, TX'],
    remote: null,
    employmentType: 'full_time',
    seniority: null,
    comp: null,
    applyUrl: 'https://apply.example/acme',
    postedAt: NOW.toISOString(),
    validThrough: null,
    featured: false,
    description: 'Long description that must never reach the routine.',
    ...extra,
  };
}

const COMPANY: PublicCompany = {
  slug: 'acme-robotics',
  name: 'Acme Robotics',
  website: null,
  domain: null,
  careersUrl: null,
  linkedinJobsUrl: null,
  logoUrl: null,
  about: null,
  openRoles: 2,
};

const BOARD: PublicBoard = {
  title: 'Jobs at TipTop portfolio companies',
  intro: null,
  accent: '#0FC382',
  companies: [COMPANY],
  jobs: [
    job('backend-engineer-1a', 'Backend Engineer', { comp: '$150K - $180K' }),
    job('designer-2b', 'Product Designer', { fn: 'design', remote: 'hybrid' }),
  ],
};

const AI_ON: JobsAssistantConfig = { ...DEFAULT_JOBS_ASSISTANT, aiAnswers: true };

function context(extra: Partial<JobsChatContext> = {}): JobsChatContext {
  return {
    store: harness.store,
    organizationId: harness.auth.organizationId,
    board: BOARD,
    assistant: AI_ON,
    base: '/jobs',
    ipHash: 'hash-visitor-a',
    now: NOW,
    boardUrl: BOARD_URL,
    ...extra,
  };
}

const ask = (question: string, sessionId = 'session-aaaa-0001', extra = {}) =>
  answerJobsQuestion(JOBS_CHAT_REQUEST.parse({ question, sessionId }), context(extra));

function routineOn() {
  process.env.JOBS_CHAT_FIRE_URL = FIRE_URL;
  process.env.JOBS_CHAT_TOKEN = 'jobs-routine-token-for-tests';
  process.env.ASK_RELAY_SLACK_TOKEN = 'xoxb-test-read-only';
  process.env.JOBS_CHAT_RELAY_CHANNEL_ID = RELAY;
  process.env.JOBS_CHAT_POSTER_IDS = POSTER;
  resetEnvCache();
}

function fireRecorder(ok = true) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return { ok, status: ok ? 200 : 403, json: async () => ({}) } as Response;
  });
  return { calls, impl: impl as unknown as typeof fetch };
}

function slackFetch(messages: Record<string, unknown>[]) {
  const urls: string[] = [];
  const impl = vi.fn(async (url: string | URL | Request) => {
    urls.push(String(url));
    return { ok: true, json: async () => ({ ok: true, messages }) } as unknown as Response;
  });
  return { urls, impl: impl as unknown as typeof fetch };
}

const questionRows = () =>
  harness.store.list('jobs_chat_questions', harness.auth.organizationId, {}) as Promise<
    JobsChatQuestion[]
  >;

function firedPayload(calls: { init: RequestInit }[]) {
  const text = (JSON.parse(String(calls[0]!.init.body)) as { text: string }).text;
  const [marker, fenced] = text.split('\n');
  return { marker, payload: JSON.parse(fenced!.slice(1, -1)) as Record<string, unknown> };
}

beforeEach(async () => {
  harness = await createHarness({ now: NOW });
  resetLimiters();
  resetBoardRateLimit();
  resetJobsSettleThrottle();
  for (const key of KEYS) delete process.env[key];
  resetEnvCache();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await harness.dispose();
  for (const key of Object.keys(process.env)) {
    if (!(key in SAVED)) delete process.env[key];
  }
  Object.assign(process.env, SAVED);
  resetEnvCache();
});

describe('the tiers, cheapest first', () => {
  it('answers from the board, then the written answers, then says it has none', async () => {
    const fire = fireRecorder();
    routineOn();
    const board = await ask('engineering roles', undefined, { fetchImpl: fire.impl });
    expect(board).toMatchObject({ kind: 'answer', source: 'board' });
    const written = await ask('How often is the board updated?', undefined, {
      fetchImpl: fire.impl,
      assistant: DEFAULT_JOBS_ASSISTANT,
    });
    expect(written).toMatchObject({ kind: 'answer', source: 'written' });
    const none = await ask('Do they offer relocation help?', undefined, {
      assistant: DEFAULT_JOBS_ASSISTANT,
    });
    expect(none).toMatchObject({ kind: 'none', text: NO_ANSWER });
    expect(fire.calls).toHaveLength(0);
  });
});

describe('written answers the board would otherwise shadow', () => {
  it('gives every default written answer for its own question', async () => {
    for (const item of DEFAULT_JOBS_FAQ) {
      const reply = await ask(item.q, undefined, { assistant: DEFAULT_JOBS_ASSISTANT });
      expect(reply, item.q).toMatchObject({ kind: 'answer', source: 'written', text: item.a });
    }
  });

  it("gives the team's edited answer, and keeps specific and identity questions on the board", async () => {
    const assistant: JobsAssistantConfig = {
      ...DEFAULT_JOBS_ASSISTANT,
      faqItems: [{ q: 'What is this job board?', a: 'Roles at the companies we back.' }],
    };
    expect(await ask('What is this job board?', undefined, { assistant })).toMatchObject({
      source: 'written',
      text: 'Roles at the companies we back.',
    });
    expect(await ask('engineering roles', undefined, { assistant })).toMatchObject({
      source: 'board',
    });
    expect(await ask('Is Arwin a real person?', undefined, { assistant })).toMatchObject({
      source: 'board',
      text: IDENTITY_ANSWER,
    });
  });
});

describe('the per-address AI cap key', () => {
  it('is the same for every address in one IPv6 /64, in the jobs and booking routes', () => {
    const request = (ip: string) =>
      new Request('https://copilot.example/api/jobs-board/ask', {
        headers: { 'x-forwarded-for': ip },
      });
    const jobsHash = (ip: string) => {
      const gate = jobsChatGate(request(ip), { bucket: 'test-cap', max: 100, windowMs: 60_000 });
      return gate.ok ? gate.visitor.ipHash : 'refused';
    };
    const bookingHash = (ip: string) => {
      const gate = visitorGate(request(ip), {
        limits: [{ bucket: 'test-cap', max: 100, windowMs: 60_000 }],
      });
      return gate.ok ? gate.visitor.ipHash : 'refused';
    };
    for (const hash of [jobsHash, bookingHash]) {
      const a = hash('2001:db8:1:2::1');
      expect(a).toMatch(/^[0-9a-f]{32}$/);
      expect(hash('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe(a);
      expect(hash('2001:db8:1:3::1')).not.toBe(a);
      expect(hash('203.0.113.7')).not.toBe(hash('203.0.113.8'));
    }
  });
});

describe('the relay safety check', () => {
  it('refuses the notes relay channel and the accounts the notes reader trusts', () => {
    const safe = {
      ...env(),
      jobsChatRelayChannelId: RELAY,
      jobsChatPosterIds: [POSTER],
      bookingChatRelayChannelId: RELAY,
      bookingChatPosterIds: [POSTER],
      notesRelayChannelId: 'C0NOTESRELAY',
      notesRelayPosterIds: ['U0NOTESPOSTER'],
    };
    expect(jobsChatRelayProblem(safe)).toBeNull();
    expect(bookingChatRelayProblem(safe)).toBeNull();
    const onNotes = {
      ...safe,
      jobsChatRelayChannelId: 'C0NOTESRELAY',
      bookingChatRelayChannelId: 'C0NOTESRELAY',
    };
    expect(jobsChatRelayProblem(onNotes)).toMatch(/another relay reads/);
    expect(bookingChatRelayProblem(onNotes)).toMatch(/another relay reads/);
    const asNotes = {
      ...safe,
      jobsChatPosterIds: ['U0NOTESPOSTER'],
      bookingChatPosterIds: ['U0NOTESPOSTER'],
    };
    expect(jobsChatRelayProblem(asNotes)).toMatch(/another relay trusts/);
    expect(bookingChatRelayProblem(asNotes)).toMatch(/another relay trusts/);
  });
});

describe('AI answers through the jobs assistant routine', () => {
  it('stays off without its settings, or with an unsafe relay', async () => {
    const fire = fireRecorder();
    expect(jobsChatConfigured()).toBe(false);
    expect(await ask('Do they sponsor visas?', undefined, { fetchImpl: fire.impl })).toMatchObject({
      kind: 'none',
      text: NO_ANSWER,
    });
    routineOn();
    process.env.JOBS_CHAT_RELAY_CHANNEL_ID = env().askRelayChannelId;
    resetEnvCache();
    expect(jobsChatRelayProblem()).toMatch(/another relay reads/);
    expect(jobsChatConfigured()).toBe(false);
    process.env.JOBS_CHAT_RELAY_CHANNEL_ID = RELAY;
    process.env.JOBS_CHAT_POSTER_IDS = env().taskRelayPosterIds[0]!;
    resetEnvCache();
    expect(jobsChatRelayProblem()).toMatch(/another relay trusts/);
    delete process.env.JOBS_CHAT_POSTER_IDS;
    resetEnvCache();
    expect(jobsChatRelayProblem()).toMatch(/JOBS_CHAT_POSTER_IDS is not set/);
    // Set up, but switched off in Portfolio > Jobs.
    routineOn();
    expect(
      await ask('Do they sponsor visas?', undefined, {
        fetchImpl: fire.impl,
        assistant: DEFAULT_JOBS_ASSISTANT,
      }),
    ).toMatchObject({ kind: 'none' });
    expect(fire.calls).toHaveLength(0);
    expect(await questionRows()).toHaveLength(0);
  });

  it('fires the routine with the question and public facts only', async () => {
    routineOn();
    const fire = fireRecorder();
    const reply = await ask('Do they sponsor visas for engineers?', undefined, {
      fetchImpl: fire.impl,
    });
    expect(reply).toMatchObject({ kind: 'pending', text: PENDING_TEXT });
    expect(fire.calls).toHaveLength(1);
    expect(fire.calls[0]!.url).toBe(FIRE_URL);
    const { marker, payload } = firedPayload(fire.calls);
    expect(marker).toBe('JOBS_QUESTION_V1');
    expect(Object.keys(payload).sort()).toEqual(['facts', 'question', 'question_id']);
    expect(payload.question).toBe('Do they sponsor visas for engineers?');
    const facts = payload.facts as Record<string, unknown>;
    expect(Object.keys(facts).sort()).toEqual([
      'board_url',
      'companies_hiring',
      'faq',
      'matching_roles',
      'open_roles',
    ]);
    expect(facts.open_roles).toBe(2);
    expect(facts.companies_hiring).toEqual([{ name: 'Acme Robotics', open_roles: 2 }]);
    const roles = facts.matching_roles as Record<string, unknown>[];
    expect(roles.map((r) => r.title)).toEqual(['Backend Engineer']);
    expect(roles[0]).toMatchObject({
      pay: '$150K - $180K',
      url: `${BOARD_URL}/acme-robotics/backend-engineer-1a`,
    });
    const text = JSON.stringify(payload);
    expect(text).not.toContain('Long description');
    expect(text).not.toContain('apply.example');
    expect(text).not.toContain(harness.auth.organizationId);
    const rows = await questionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'pending', ip_hash: 'hash-visitor-a' });
    expect(rows[0]!.id).toBe(payload.question_id);
  });

  it('builds facts from named public fields, whatever else a role holds', () => {
    const facts = buildJobsQuestionFacts({
      boardUrl: BOARD_URL,
      jobs: BOARD.jobs,
      companies: BOARD.companies,
      related: [
        { ...BOARD.jobs[0]!, title: 'Engineer `rm -rf`', secret: 'pat@acme.example' } as PublicJob,
      ],
      faqItems: [],
      roleUrl: (j) => `${BOARD_URL}/${j.companySlug}/${j.slug}`,
    });
    const text = JSON.stringify(facts);
    expect(text).not.toContain('pat@acme.example');
    expect(text).not.toContain('`');
    expect(facts.matching_roles[0]!.title).toBe("Engineer 'rm -rf'");
  });

  it('caps questions per visit, per address and per day', async () => {
    routineOn();
    const fire = fireRecorder();
    for (let i = 0; i < 3; i++) {
      expect(
        (await ask(`Visa question ${i}?`, 'session-one-0001', { fetchImpl: fire.impl })).kind,
      ).toBe('pending');
    }
    expect(
      await ask('Visa question 4?', 'session-one-0001', { fetchImpl: fire.impl }),
    ).toMatchObject({
      kind: 'none',
      text: NO_ANSWER,
    });
    // A new visit from the same address: 5 a day in all.
    for (let i = 0; i < 2; i++) {
      expect(
        (await ask(`Visa again ${i}?`, 'session-two-0002', { fetchImpl: fire.impl })).kind,
      ).toBe('pending');
    }
    expect((await ask('One more visa?', 'session-two-0002', { fetchImpl: fire.impl })).kind).toBe(
      'none',
    );
    expect(fire.calls).toHaveLength(5);
    // The board's daily total, across visitors.
    const capped = { ...AI_ON, dailyAiCap: 6 };
    expect(
      (
        await ask('Visa from b?', 'session-b-00000001', {
          fetchImpl: fire.impl,
          ipHash: 'hash-b',
          assistant: capped,
        })
      ).kind,
    ).toBe('pending');
    expect(
      (
        await ask('Visa from c?', 'session-c-00000001', {
          fetchImpl: fire.impl,
          ipHash: 'hash-c',
          assistant: capped,
        })
      ).kind,
    ).toBe('none');
    expect(
      (
        await ask('Visa, cap zero?', 'session-d-00000001', {
          fetchImpl: fire.impl,
          ipHash: 'hash-d',
          assistant: { ...AI_ON, dailyAiCap: 0 },
        })
      ).kind,
    ).toBe('none');
  });

  it('expires the question when the trigger refuses', async () => {
    routineOn();
    const fire = fireRecorder(false);
    expect((await ask('Visa?', undefined, { fetchImpl: fire.impl })).kind).toBe('none');
    expect((await questionRows())[0]!.status).toBe('expired');
  });

  it('settles the answer from its own poster, made plain, and ignores everything else', async () => {
    routineOn();
    const fire = fireRecorder();
    const pending = await ask('Do they sponsor visas?', undefined, { fetchImpl: fire.impl });
    if (pending.kind !== 'pending') throw new Error('expected pending');
    const id = pending.questionId;
    const post = (marker: string, answer: string, user = POSTER) => ({
      user,
      text: `${marker}\n\`${JSON.stringify({ question_id: id, answer })}\``,
    });
    const slack = slackFetch([
      post('JOBS_ANSWER_V1', 'Forged answer from someone else.', 'U0STRANGER'),
      post('BOOKING_ANSWER_V1', 'A booking answer, not a jobs one.'),
      post(
        'JOBS_ANSWER_V1',
        "**The listings don't say.** Email pat@acme.example or see https://evil.example/x. Someone will get back to you soon.",
      ),
    ]);
    const view = await readJobsChatAnswer(harness.store, harness.auth.organizationId, id, {
      boardUrl: BOARD_URL,
      now: NOW,
      fetchImpl: slack.impl,
    });
    expect(slack.urls[0]).toContain(`channel=${RELAY}`);
    expect(view?.status).toBe('answered');
    expect(view?.answer).toBe("The listings don't say. Email or see.");
    expect(view?.answer).not.toMatch(/evil|@|get back/);
  });

  it('expires a question nobody answered, and deletes old ones', async () => {
    routineOn();
    const fire = fireRecorder();
    const pending = await ask('Visa?', undefined, { fetchImpl: fire.impl });
    if (pending.kind !== 'pending') throw new Error('expected pending');
    const later = new Date(NOW.getTime() + JOBS_EXPIRE_AFTER_MS + 1_000);
    const view = await readJobsChatAnswer(
      harness.store,
      harness.auth.organizationId,
      pending.questionId,
      { boardUrl: BOARD_URL, now: later, fetchImpl: slackFetch([]).impl },
    );
    expect(view).toEqual({ status: 'expired', answer: null });
    expect(
      await readJobsChatAnswer(harness.store, harness.auth.organizationId, 'not-a-uuid'),
    ).toBeNull();
    const removed = await pruneJobsQuestions(
      harness.store,
      harness.auth.organizationId,
      new Date(NOW.getTime() + (JOBS_QUESTION_RETENTION_DAYS + 1) * 86_400_000),
    );
    expect(removed).toBe(1);
  });

  it('reads only well-formed answers and keeps links to the board alone', () => {
    const id = '3f2b8c1e-5d4a-4b6c-9e8f-1a2b3c4d5e6f';
    expect(parseJobsAnswer(`JOBS_ANSWER_V1\n\`{"question_id":"${id}","answer":"Hi"}\``)).toEqual({
      question_id: id,
      answer: 'Hi',
    });
    expect(
      parseJobsAnswer(`BOOKING_ANSWER_V1\n\`{"question_id":"${id}","answer":"Hi"}\``),
    ).toBeNull();
    expect(parseJobsAnswer('JOBS_ANSWER_V1\n`{"question_id":"nope","answer":"Hi"}`')).toBeNull();
    expect(
      sanitiseJobsAnswer(`See ${BOARD_URL}/acme-robotics and https://evil.example.`, {
        boardUrl: BOARD_URL,
      }),
    ).toBe(`See ${BOARD_URL} and.`);
  });
});

describe('the settings in Portfolio > Jobs', () => {
  it('starts with the defaults, saves a patch and shows the status', async () => {
    const actor = { organizationId: harness.auth.organizationId, userId: harness.auth.userId };
    expect(await readJobsAssistant(harness.store, actor.organizationId)).toEqual(
      DEFAULT_JOBS_ASSISTANT,
    );
    const bad = await saveJobsAssistant(harness.store, actor, { dailyAiCap: 500 });
    expect(bad.ok).toBe(false);
    const saved = await saveJobsAssistant(harness.store, actor, {
      aiAnswers: true,
      faqItems: [{ q: 'Remote roles?', a: 'Some are. Use the Remote filter.' }],
    });
    expect(saved.ok && saved.value).toMatchObject({ aiAnswers: true, enabled: true });
    const panel = await readJobsAssistantPanel(harness.store, actor.organizationId);
    expect(panel.config.faqItems).toEqual([
      { q: 'Remote roles?', a: 'Some are. Use the Remote filter.' },
    ]);
    expect(panel.status).toMatchObject({ configured: false, tableReady: true, askedToday: 0 });
    expect(panel.editable).toBe(true);
  });
});

describe('the public routes', () => {
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    askRoute(
      new NextRequest('https://copilot.example/api/jobs-board/ask', {
        method: 'POST',
        headers: {
          host: 'copilot.example',
          origin: 'https://copilot.example',
          'content-type': 'application/json',
          'x-forwarded-for': '203.0.113.7',
          ...headers,
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    );

  it('refuses a question from another site, a bad body and an oversized one', async () => {
    const foreign = await post(
      { question: 'Remote roles', sessionId: 'session-aaaa-0001' },
      { origin: 'https://evil.example' },
    );
    expect(foreign.status).toBe(403);
    expect((await post({ question: '', sessionId: 'session-aaaa-0001' })).status).toBe(400);
    expect((await post({ question: 'Hi', sessionId: 'bad id!' })).status).toBe(400);
    expect((await post({ question: 'Hi', sessionId: 'session-aaaa-0001', extra: 1 })).status).toBe(
      400,
    );
    expect((await post('x'.repeat(5_000))).status).toBe(400);
    expect(foreign.headers.get('cache-control')).toBe('no-store');
    expect(foreign.headers.get('set-cookie')).toBeNull();
  });

  it('answers "not available" while the board is not on for visitors', async () => {
    const res = await post({ question: 'Remote roles', sessionId: 'session-aaaa-0001' });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('brakes each address', async () => {
    let last = 0;
    for (let i = 0; i < 31; i++) {
      last = (await post({ question: 'Remote roles', sessionId: 'session-aaaa-0001' })).status;
    }
    expect(last).toBe(429);
    const other = await post(
      { question: 'Remote roles', sessionId: 'session-aaaa-0001' },
      { 'x-forwarded-for': '198.51.100.9' },
    );
    expect(other.status).not.toBe(429);
  });

  it('refuses a poll for anything but a question id', async () => {
    const res = await answerRoute(
      new NextRequest('https://copilot.example/api/jobs-board/ask/answer?id=../../x', {
        headers: { host: 'copilot.example' },
      }),
    );
    expect(res.status).toBe(404);
  });

  it('is served on the board host and on Kraken with no sign-in; nothing else under /api is', async () => {
    const hosts = ['jobs.tiptop.vc'];
    for (const p of JOBS_CHAT_API_PATHS) {
      expect(routeBoardHost(p, ['jobs.tiptop.vc'], hosts)).toEqual({ kind: 'serve' });
    }
    expect(routeBoardHost('/api/jobs-board/other', ['jobs.tiptop.vc'], hosts)).toEqual({
      kind: 'not_found',
    });
    expect(routeBoardHost('/api/jobs-board/ask/answer/x', ['jobs.tiptop.vc'], hosts)).toEqual({
      kind: 'not_found',
    });
    const onBoard = await proxy(
      new NextRequest('https://jobs.tiptop.vc/api/jobs-board/ask', {
        method: 'POST',
        headers: { host: 'jobs.tiptop.vc' },
      }),
    );
    expect(onBoard.status).toBe(200);
    expect(onBoard.headers.get('x-middleware-rewrite')).toBeNull();
    const onKraken = await proxy(
      new NextRequest('https://copilot.tiptop.vc/api/jobs-board/ask/answer?id=x'),
    );
    expect(onKraken.status).toBe(200);
    expect(onKraken.headers.get('location')).toBeNull();
  });
});

describe('the migration', () => {
  const SQL = readFileSync(
    path.resolve(import.meta.dirname, '../../supabase/migrations/20261028110000_jobs_chat.sql'),
    'utf8',
  );

  it('is additive and re-runnable, with explicit constraint names and member-only reads', () => {
    expect(SQL).toMatch(/create table if not exists jobs_chat_questions/);
    expect(SQL).toMatch(/add column if not exists assistant jsonb/);
    expect(SQL).not.toMatch(/\bdrop table\b|\bdrop column\b/i);
    expect(SQL).not.toMatch(/constraint \w+_check\b/);
    for (const name of [
      'jobs_chat_questions_status_allowed',
      'jobs_chat_questions_question_length',
      'job_board_settings_assistant_shape',
    ]) {
      const drop = SQL.indexOf(`drop constraint if exists ${name}`);
      const add = SQL.indexOf(`add constraint ${name}`);
      expect(drop, name).toBeGreaterThan(-1);
      expect(add, name).toBeGreaterThan(drop);
    }
    expect(SQL).toMatch(/alter table jobs_chat_questions enable row level security/);
    expect(SQL).toMatch(
      /create policy jobs_chat_questions_select on jobs_chat_questions\s+for select using \(is_org_member\(organization_id\)\)/,
    );
    expect(SQL).not.toMatch(/create policy jobs_chat_questions_(insert|update|delete)/);
  });
});
