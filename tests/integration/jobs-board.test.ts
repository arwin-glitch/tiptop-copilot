import { readFileSync } from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { env, type AppEnv } from '@/lib/config/env';
import type { DataStore } from '@/lib/db/store';
import { DEMO_IDS } from '@/lib/demo/ids';
import { demoJobs } from '@/lib/demo/jobs-fixtures';
import { DEMO_JOBS_IDS } from '@/lib/demo/jobs-board-fixtures';
import {
  featurePosting,
  hidePosting,
  publishPosting,
  readJobsBoard,
  readPublicBoard,
  saveCompanyJobs,
  savePosting,
  setBoardEnabled,
  setPostingOpen,
  type JobsActor,
} from '@/lib/services/jobs-board';
import {
  detectCareersBoard,
  formatJobsCronStatus,
  importEmailedRoles,
  resetJobsBoardSyncState,
  syncJobBoards,
} from '@/lib/services/jobs-board-sync';
import { proxy } from '@/proxy';

/**
 * The public job board end to end over the demo store: board syncs (every
 * board answer faked from fictional fixtures; nothing reaches the network),
 * the emailed-role import, the gate, the switch, and the board host.
 */

let harness: Harness;
let actor: JobsActor;

beforeEach(async () => {
  resetJobsBoardSyncState();
  harness = await createHarness();
  actor = { organizationId: harness.auth.organizationId, userId: harness.auth.userId };
});

afterEach(async () => {
  await harness.dispose();
});

const live = (): AppEnv => ({ ...env(), demoMode: false });
const noSleep = async () => undefined;
const ORG = () => harness.auth.organizationId;

const GREENHOUSE = JSON.parse(
  readFileSync(path.join('tests', 'fixtures', 'ats', 'greenhouse.json'), 'utf8'),
) as { jobs: Record<string, unknown>[] };

type Answer = (url: string) => Response;

/** A fake network: robots.txt allows everything unless an answer says otherwise. */
function network(answers: Record<string, Answer>) {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    for (const [prefix, answer] of Object.entries(answers)) {
      if (url.startsWith(prefix)) return answer(url);
    }
    if (url.endsWith('/robots.txt'))
      return new Response('User-agent: *\nAllow: /\n', { status: 200 });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const EXAMPLE_API = 'https://boards-api.greenhouse.io/v1/boards/examplerobotics/jobs';
const LEDGERLY_API = 'https://boards-api.greenhouse.io/v1/boards/ledgerly-demo/jobs';

async function sync(fetchImpl: typeof fetch, companyIds?: string[]) {
  return syncJobBoards(harness.store, ORG(), {
    fetchImpl,
    e: live(),
    sleep: noSleep,
    trigger: 'daily',
    companyIds,
  });
}

async function postings(store: DataStore = harness.store) {
  return store.list('job_postings', ORG());
}

async function publicTitles(): Promise<string[]> {
  const read = await readPublicBoard({ store: harness.store, organizationId: ORG() });
  return read.state === 'on' ? read.board.jobs.map((j) => j.title).sort() : [];
}

/** Stonebridge Ops on the fictional Greenhouse board "examplerobotics". */
async function stonebridgeOnGreenhouse(autoPublish = false) {
  const saved = await saveCompanyJobs(harness.store, actor, DEMO_IDS.pcStonebridge, {
    careersUrl: 'https://job-boards.greenhouse.io/examplerobotics',
    autoPublish,
  });
  expect(saved.ok).toBe(true);
  return saved;
}

describe('syncing companies’ own job boards', () => {
  it('adds new roles, keeps them off the board until a person allows it, and closes vanished ones', async () => {
    const saved = await stonebridgeOnGreenhouse(false);
    expect(saved.ok && saved.value.detected).toEqual({
      ats: 'greenhouse',
      token: 'examplerobotics',
    });
    expect(saved.ok && saved.value.company.sync_enabled).toBe(true);

    let answer = GREENHOUSE;
    const net = network({
      [EXAMPLE_API]: () => json(answer),
      [LEDGERLY_API]: () => json({ jobs: [] }),
    });

    const first = await sync(net.fetchImpl, [DEMO_IDS.pcStonebridge]);
    expect(first.results[0]).toMatchObject({ status: 'ok', added: 2, closed: 0, total: 2 });
    expect(first.results[0]!.message).toContain('2 unreadable left out');
    const rows = (await postings()).filter(
      (p) => p.portfolio_company_id === DEMO_IDS.pcStonebridge && p.source === 'ats',
    );
    expect(rows.map((r) => r.title).sort()).toEqual([
      'Account Executive, Mid-Market',
      'Senior Platform Engineer',
    ]);
    expect(rows.every((r) => !r.published)).toBe(true);
    // Read, but not public: auto-publish is off and nobody published them.
    expect(await publicTitles()).not.toContain('Senior Platform Engineer');

    // One disappears from the board: closed, and gone from the public board.
    answer = { jobs: [GREENHOUSE.jobs[0]!] };
    const second = await sync(net.fetchImpl, [DEMO_IDS.pcStonebridge]);
    expect(second.results[0]).toMatchObject({ status: 'ok', added: 0, updated: 1, closed: 1 });
    const ae = (await postings()).find((p) => p.title === 'Account Executive, Mid-Market')!;
    expect(ae.status).toBe('closed');
    expect(ae.closed_at).not.toBeNull();

    // It comes back: reopened.
    answer = GREENHOUSE;
    await sync(net.fetchImpl, [DEMO_IDS.pcStonebridge]);
    expect((await postings()).find((p) => p.id === ae.id)!.status).toBe('active');

    // The company's result is saved for the Companies view.
    const company = await harness.store.findOne('job_companies', ORG(), {
      eq: { portfolio_company_id: DEMO_IDS.pcStonebridge },
    });
    expect(company).toMatchObject({ last_sync_status: 'ok', last_sync_count: 2 });
  });

  it('auto-publish puts board roles on the board, a hidden role stays hidden, and off takes them down', async () => {
    await stonebridgeOnGreenhouse(true);
    const net = network({ [EXAMPLE_API]: () => json(GREENHOUSE) });
    await sync(net.fetchImpl, [DEMO_IDS.pcStonebridge]);
    expect(await publicTitles()).toEqual(
      expect.arrayContaining(['Account Executive, Mid-Market', 'Senior Platform Engineer']),
    );

    const platform = (await postings()).find((p) => p.title === 'Senior Platform Engineer')!;
    expect((await hidePosting(harness.store, actor, platform.id)).ok).toBe(true);
    await sync(net.fetchImpl, [DEMO_IDS.pcStonebridge]);
    const after = (await postings()).find((p) => p.id === platform.id)!;
    expect(after.published).toBe(false);
    expect(after.hidden_at).not.toBeNull();
    expect(await publicTitles()).not.toContain('Senior Platform Engineer');

    // A role a person published by hand outlives auto-publish going off.
    const ae = (await postings()).find((p) => p.title === 'Account Executive, Mid-Market')!;
    await publishPosting(harness.store, actor, ae.id);
    const off = await saveCompanyJobs(harness.store, actor, DEMO_IDS.pcStonebridge, {
      autoPublish: false,
    });
    expect(off.ok).toBe(true);
    expect(await publicTitles()).toContain('Account Executive, Mid-Market');
    // The demo's own Ledgerly roles (auto-published on its board) are untouched.
    expect(await publicTitles()).toContain('VP Sales');
  });

  it('isolates one company’s failure from the others, and never closes roles on a bad answer', async () => {
    await stonebridgeOnGreenhouse(true);
    const net = network({
      [EXAMPLE_API]: () => json(GREENHOUSE),
      [LEDGERLY_API]: () => new Response('boom', { status: 500 }),
    });
    const summary = await sync(net.fetchImpl);
    const byName = Object.fromEntries(summary.results.map((r) => [r.name, r]));
    expect(byName['Ledgerly']).toMatchObject({ status: 'failed' });
    expect(byName['Stonebridge Ops']).toMatchObject({ status: 'ok', added: 2 });
    // Ledgerly's roles are all still open and public.
    expect(await publicTitles()).toEqual(expect.arrayContaining(['VP Sales', 'Product Designer']));

    // A board that is gone (404) or answers in an unknown shape closes nothing either.
    resetJobsBoardSyncState();
    for (const bad of [
      () => new Response('gone', { status: 404 }),
      () => json({ error: 'changed' }),
    ]) {
      const n2 = network({ [LEDGERLY_API]: bad });
      const r = await sync(n2.fetchImpl, [DEMO_IDS.pcLedgerly]);
      expect(r.results[0]!.status).toBe('failed');
    }
    const ledgerly = (await postings()).filter(
      (p) => p.portfolio_company_id === DEMO_IDS.pcLedgerly,
    );
    expect(ledgerly.every((p) => p.status === 'active')).toBe(true);
    expect(formatJobsCronStatus(summary, null)).toMatch(
      /^ok: 1 of 2 boards, 2 new, 0 closed, 1 failed$/,
    );
  });

  it('obeys robots.txt and pauses a host that says "too many requests"', async () => {
    const blocked = network({
      'https://boards-api.greenhouse.io/robots.txt': () =>
        new Response('User-agent: *\nDisallow: /v1/\n'),
    });
    const r1 = await sync(blocked.fetchImpl, [DEMO_IDS.pcLedgerly]);
    expect(r1.results[0]).toMatchObject({ status: 'failed' });
    expect(r1.results[0]!.message).toMatch(/robots\.txt/);
    expect(blocked.calls.some((u) => u.startsWith(LEDGERLY_API))).toBe(false);

    resetJobsBoardSyncState();
    const limited = network({
      [LEDGERLY_API]: () =>
        new Response('slow down', { status: 429, headers: { 'retry-after': '120' } }),
    });
    const r2 = await sync(limited.fetchImpl, [DEMO_IDS.pcLedgerly]);
    expect(r2.results[0]!.status).toBe('skipped');
    const before = limited.calls.length;
    const r3 = await sync(limited.fetchImpl, [DEMO_IDS.pcLedgerly]);
    expect(r3.results[0]!.status).toBe('skipped');
    expect(limited.calls.length).toBe(before);
  });

  it('reads a company careers page for its board, and refuses internal addresses', async () => {
    const net = network({
      'https://careers.fixture-co.example.com/jobs': () =>
        new Response(
          '<script src="https://boards.greenhouse.io/embed/job_board/js?for=examplerobotics"></script>',
          { status: 200 },
        ),
      // A careers link that redirects to the company's Lever board.
      'https://fixture-co.example.com/careers': () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://jobs.lever.co/northwindfixture' },
        }),
      // One that redirects somewhere internal.
      'https://sneaky.fixture-co.example.com/careers': () =>
        new Response(null, { status: 301, headers: { location: 'http://169.254.169.254/latest' } }),
    });
    const publicDns = async () => ['93.184.215.14'];
    const opts = { fetchImpl: net.fetchImpl, e: live(), sleep: noSleep, resolveHost: publicDns };
    expect(await detectCareersBoard('https://careers.fixture-co.example.com/jobs', opts)).toEqual({
      ats: 'greenhouse',
      token: 'examplerobotics',
    });
    expect(await detectCareersBoard('https://fixture-co.example.com/careers', opts)).toEqual({
      ats: 'lever',
      token: 'northwindfixture',
    });
    expect(
      await detectCareersBoard('https://sneaky.fixture-co.example.com/careers', opts),
    ).toBeNull();
    expect(await detectCareersBoard('http://localhost:3000/careers', opts)).toBeNull();
    expect(await detectCareersBoard('http://169.254.169.254/latest', opts)).toBeNull();
    // A public-looking name that resolves to a private address is never fetched.
    const privateDns = { ...opts, resolveHost: async () => ['10.0.0.7'] };
    expect(
      await detectCareersBoard('https://intranet-ish.fixture-co.example.com/x', privateDns),
    ).toBeNull();
    expect(
      net.calls.some(
        (u) => u.includes('localhost') || u.includes('169.254') || u.includes('intranet-ish'),
      ),
    ).toBe(false);
  });

  it('never calls out in demo mode', async () => {
    const net = network({});
    const summary = await syncJobBoards(harness.store, ORG(), {
      fetchImpl: net.fetchImpl,
      e: { ...env(), demoMode: true },
      sleep: noSleep,
    });
    expect(net.calls).toEqual([]);
    expect(summary.results[0]).toMatchObject({ name: 'Ledgerly', status: 'ok', added: 1 });
  });
});

describe('emailed roles', () => {
  const roles = () => demoJobs(new Date()).roles;

  it('arrive as drafts that are never public until a person approves each one', async () => {
    const imported = await importEmailedRoles(harness.store, ORG(), roles());
    // Stonebridge's Founding Engineer; Ledgerly's VP Sales is already on its own board.
    expect(imported).toMatchObject({ added: 1, covered: 1 });
    const draft = (await postings()).find((p) => p.source === 'email')!;
    expect(draft).toMatchObject({
      title: 'Founding Engineer',
      published: false,
      approved_at: null,
      comp: null,
      description: null,
      apply_url: 'https://stonebridgeops.demo/jobs/founding-engineer',
    });
    // Nothing private came across: no contact, no founder note, no source email.
    const text = JSON.stringify(draft);
    for (const secret of [
      'dev@stonebridgeops.demo',
      'Dev Sharma',
      'offers declined',
      '0f0000000000b201',
      '$150K',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(await publicTitles()).not.toContain('Founding Engineer');

    // Featuring does not publish it either.
    await featurePosting(harness.store, actor, draft.id, true);
    expect(await publicTitles()).not.toContain('Founding Engineer');

    const approved = await publishPosting(harness.store, actor, draft.id);
    expect(approved.ok && approved.value).toMatchObject({
      published: true,
      approved_by: harness.auth.userId,
    });
    expect(await publicTitles()).toContain('Founding Engineer');

    // Importing again changes nothing; the founder calling it filled closes it.
    expect(await importEmailedRoles(harness.store, ORG(), roles())).toMatchObject({ added: 0 });
    const filled = roles().map((r) =>
      r.title === 'Founding Engineer' ? { ...r, status: 'filled' as const } : r,
    );
    expect(await importEmailedRoles(harness.store, ORG(), filled)).toMatchObject({ closed: 1 });
    expect(await publicTitles()).not.toContain('Founding Engineer');
  });

  it('hand the approval to the company board copy of the same role', async () => {
    await importEmailedRoles(harness.store, ORG(), roles());
    const draft = (await postings()).find((p) => p.source === 'email')!;
    await publishPosting(harness.store, actor, draft.id);

    await stonebridgeOnGreenhouse(false);
    const sameRole = { ...GREENHOUSE.jobs[0]!, id: 7000099, title: 'Founding Engineer' };
    const net = network({ [EXAMPLE_API]: () => json({ jobs: [sameRole] }) });
    await sync(net.fetchImpl, [DEMO_IDS.pcStonebridge]);

    const all = await postings();
    const fromEmail = all.find((p) => p.id === draft.id)!;
    const fromBoard = all.find((p) => p.source === 'ats' && p.title === 'Founding Engineer')!;
    expect(fromEmail).toMatchObject({ status: 'closed', published: false });
    expect(fromBoard).toMatchObject({
      published: true,
      approved_at: draft.approved_at ?? expect.any(String),
    });
    const read = await readPublicBoard({ store: harness.store, organizationId: ORG() });
    const founding =
      read.state === 'on' ? read.board.jobs.filter((j) => j.title === 'Founding Engineer') : [];
    expect(founding).toHaveLength(1);
    expect(founding[0]!.applyUrl).toContain('greenhouse.io');
  });

  it('close an unapproved draft when the company board lists the role', async () => {
    await importEmailedRoles(harness.store, ORG(), roles());
    await stonebridgeOnGreenhouse(false);
    const sameRole = { ...GREENHOUSE.jobs[0]!, id: 7000099, title: 'Founding Engineer (Remote)' };
    await sync(network({ [EXAMPLE_API]: () => json({ jobs: [sameRole] }) }).fetchImpl, [
      DEMO_IDS.pcStonebridge,
    ]);
    const draft = (await postings()).find((p) => p.source === 'email')!;
    expect(draft.status).toBe('closed');
    const board = await readJobsBoard(harness.store, ORG());
    expect(
      board.postings.filter((p) => p.source === 'email' && p.status === 'active'),
    ).toHaveLength(0);
  });
});

describe('the board switch and the gate', () => {
  it('hides everything while off; the signed-in preview still reads it', async () => {
    expect((await readPublicBoard({ store: harness.store, organizationId: ORG() })).state).toBe(
      'on',
    );
    await setBoardEnabled(harness.store, actor, false);
    expect(await readPublicBoard({ store: harness.store, organizationId: ORG() })).toEqual({
      state: 'off',
    });
    const preview = await readPublicBoard({
      store: harness.store,
      organizationId: ORG(),
      preview: true,
    });
    expect(preview.state === 'on' && preview.preview).toBe(true);
    await setBoardEnabled(harness.store, actor, true);
    expect((await readPublicBoard({ store: harness.store, organizationId: ORG() })).state).toBe(
      'on',
    );
  });

  it('treats missing tables as "off", and says writes need the migration', async () => {
    const missing = Object.assign(new Error('relation "job_postings" does not exist'), {
      code: '42P01',
    });
    const store = new Proxy(harness.store, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (typeof args[0] === 'string' && args[0].startsWith('job_'))
            return Promise.reject(missing);
          return value.apply(target, args);
        };
      },
    }) as DataStore;
    expect(await readPublicBoard({ store, organizationId: ORG() })).toEqual({ state: 'off' });
    expect((await readJobsBoard(store, ORG())).available).toBe(false);
    const saved = await setBoardEnabled(store, actor, true);
    expect(saved.ok).toBe(false);
    expect(!saved.ok && saved.error.code).toBe('not_configured');
    expect(!saved.ok && saved.error.message).toContain('20261022100000_public_jobs.sql');
  });

  it('adds, edits and closes hand-added roles; a board role cannot be edited here', async () => {
    const added = await savePosting(harness.store, actor, {
      portfolioCompanyId: DEMO_IDS.pcStonebridge,
      title: 'Field Technician',
      locations: 'Austin, TX; Round Rock, TX; austin, tx',
      remote: 'onsite',
      applyUrl: 'stonebridgeops.demo/careers/field-tech',
      description: '## About\n\n<script>x</script>\n• Fix things',
      publish: true,
    });
    expect(added.ok).toBe(true);
    const role = added.ok ? added.value : null;
    expect(role).toMatchObject({
      source: 'manual',
      published: true,
      job_function: 'other',
      apply_url: 'https://stonebridgeops.demo/careers/field-tech',
      locations: ['Austin, TX', 'Round Rock, TX'],
    });
    expect(role!.description).toBe('## About\n\n<script>x</script>\n\n- Fix things');
    expect(await publicTitles()).toContain('Field Technician');

    const edited = await savePosting(
      harness.store,
      actor,
      { title: 'Senior Field Technician' },
      role!.id,
    );
    expect(edited.ok && edited.value.slug).toBe(role!.slug);
    await setPostingOpen(harness.store, actor, role!.id, false);
    expect(await publicTitles()).not.toContain('Senior Field Technician');

    const boardRole = await savePosting(
      harness.store,
      actor,
      { title: 'x' },
      DEMO_JOBS_IDS.hiddenRole,
    );
    expect(!boardRole.ok && boardRole.error.code).toBe('conflict');
    // With no apply link and no careers page to fall back on, it cannot go public.
    await saveCompanyJobs(harness.store, actor, DEMO_IDS.pcStonebridge, { careersUrl: '' });
    const noLink = await savePosting(harness.store, actor, {
      portfolioCompanyId: DEMO_IDS.pcStonebridge,
      title: 'No link role',
      publish: true,
    });
    expect(noLink.ok).toBe(false);
    expect(!noLink.ok && noLink.error.message).toMatch(/apply link/);
  });

  it('refuses a careers page that is not an address, and a logo that is not https', async () => {
    const badUrl = await saveCompanyJobs(harness.store, actor, DEMO_IDS.pcStonebridge, {
      careersUrl: 'not an address',
    });
    expect(!badUrl.ok && badUrl.error.code).toBe('invalid_input');
    const badLogo = await saveCompanyJobs(harness.store, actor, DEMO_IDS.pcStonebridge, {
      logoUrl: 'http://insecure.example/logo.png',
    });
    expect(!badLogo.ok && badLogo.error.code).toBe('invalid_input');
    const unknown = await saveCompanyJobs(harness.store, actor, DEMO_IDS.pcStonebridge, {
      careersUrl: 'https://stonebridgeops.demo/careers',
    });
    expect(unknown.ok && unknown.value.note).toMatch(/could not find a job board/);
  });
});

describe('the board host in the proxy', () => {
  const request = (url: string, headers: Record<string, string> = {}) =>
    new NextRequest(url, { headers });

  it('rewrites the board host to the board pages, with no sign-in', async () => {
    const res = await proxy(request('https://jobs.tiptop.vc/ledgerly', { host: 'jobs.tiptop.vc' }));
    expect(res.headers.get('x-middleware-rewrite')).toContain('/jobs-host/ledgerly');
    const home = await proxy(request('https://jobs.tiptop.vc/', { host: 'jobs.tiptop.vc' }));
    expect(home.headers.get('x-middleware-rewrite')).toMatch(/\/jobs-host$/);
    const app = await proxy(request('https://jobs.tiptop.vc/today', { host: 'jobs.tiptop.vc' }));
    expect(app.headers.get('x-middleware-rewrite')).toContain('/jobs-host/today');
    // A forwarded header cannot reach Kraken on the board's host.
    const spoofed = await proxy(
      request('https://jobs.tiptop.vc/today', {
        host: 'jobs.tiptop.vc',
        'x-forwarded-host': 'copilot.tiptop.vc',
      }),
    );
    expect(spoofed.headers.get('x-middleware-rewrite')).toContain('/jobs-host/today');
    const old = await proxy(
      request('https://jobs.tiptop.vc/jobs/ledgerly?x=1', { host: 'jobs.tiptop.vc' }),
    );
    expect(old.status).toBe(308);
    // Absolute: Next refuses a relative Location from the proxy (a 500 in a real server).
    expect(old.headers.get('location')).toBe('https://jobs.tiptop.vc/ledgerly?x=1');
  });

  it('serves /jobs on Kraken with no sign-in, keeps the preview and the app signed in, hides /jobs-host', async () => {
    const board = await proxy(request('https://copilot.tiptop.vc/jobs/ledgerly'));
    expect(board.status).toBe(200);
    expect(board.headers.get('location')).toBeNull();
    const previewPage = await proxy(request('https://copilot.tiptop.vc/jobs-preview'));
    expect(previewPage.status).toBe(307);
    expect(previewPage.headers.get('location')).toContain('/login');
    const internal = await proxy(request('https://copilot.tiptop.vc/jobs-host/ledgerly'));
    expect(internal.status).toBe(404);
  });
});

describe('emailed roles: hides, private links and staleness', () => {
  const roles = () => demoJobs(new Date()).roles;

  it("keeps a person's hide when the company board lists the same role", async () => {
    await importEmailedRoles(harness.store, ORG(), roles());
    const draft = (await postings()).find((p) => p.source === 'email')!;
    await publishPosting(harness.store, actor, draft.id);
    // Hidden on purpose (say, a confidential replacement).
    await hidePosting(harness.store, actor, draft.id);

    await stonebridgeOnGreenhouse(true);
    const sameRole = { ...GREENHOUSE.jobs[0]!, id: 7000099, title: 'Founding Engineer' };
    await sync(network({ [EXAMPLE_API]: () => json({ jobs: [sameRole] }) }).fetchImpl, [
      DEMO_IDS.pcStonebridge,
    ]);
    const fromBoard = (await postings()).find(
      (p) => p.source === 'ats' && p.title === 'Founding Engineer',
    )!;
    expect(fromBoard.published).toBe(false);
    expect(fromBoard.hidden_at).not.toBeNull();
    expect(await publicTitles()).not.toContain('Founding Engineer');
    // And the next read keeps it hidden too.
    await sync(network({ [EXAMPLE_API]: () => json({ jobs: [sameRole] }) }).fetchImpl, [
      DEMO_IDS.pcStonebridge,
    ]);
    expect(await publicTitles()).not.toContain('Founding Engineer');
  });

  it('asks the approver to confirm a link to a shared document before it goes public', async () => {
    const withDoc = roles().map((r) =>
      r.title === 'Founding Engineer'
        ? { ...r, link: 'https://docs.google.com/document/d/fixture-doc/edit' }
        : r,
    );
    await importEmailedRoles(harness.store, ORG(), withDoc);
    const draft = (await postings()).find((p) => p.source === 'email')!;
    const refused = await publishPosting(harness.store, actor, draft.id);
    expect(!refused.ok && refused.error.code).toBe('conflict');
    expect(!refused.ok && refused.error.message).toMatch(/may be private/);
    expect(await publicTitles()).not.toContain('Founding Engineer');

    const confirmed = await publishPosting(harness.store, actor, draft.id, { confirmLink: true });
    expect(confirmed.ok).toBe(true);
    expect(await publicTitles()).toContain('Founding Engineer');
  });

  it("records the founder's last mention, and a later mention re-confirms the role", async () => {
    const DAY = 86_400_000;
    const day = (daysAgo: number) =>
      new Date(Date.now() - daysAgo * DAY).toISOString().slice(0, 10);
    const old = roles().map((r) =>
      r.title === 'Founding Engineer' ? { ...r, first_seen: day(120), last_seen: day(90) } : r,
    );
    await importEmailedRoles(harness.store, ORG(), old);
    const draft = (await postings()).find((p) => p.source === 'email')!;
    expect(draft.last_seen_at.slice(0, 10)).toBe(day(90));

    // Approved long ago and never mentioned since: stale, off the board.
    await publishPosting(harness.store, actor, draft.id);
    await harness.store.update('job_postings', ORG(), draft.id, {
      approved_at: new Date(Date.now() - 70 * DAY).toISOString(),
    });
    expect(await publicTitles()).not.toContain('Founding Engineer');

    // The founder mentions it again in this week's scan: confirmed open.
    const again = old.map((r) =>
      r.title === 'Founding Engineer' ? { ...r, last_seen: day(2) } : r,
    );
    await importEmailedRoles(harness.store, ORG(), again);
    const after = (await postings()).find((p) => p.id === draft.id)!;
    expect(after.last_seen_at.slice(0, 10)).toBe(day(2));
    expect(await publicTitles()).toContain('Founding Engineer');
  });
});

describe('polite reads', () => {
  it('never follows a job board API redirect, and keeps where it pointed out of the message', async () => {
    await stonebridgeOnGreenhouse(true);
    const seen: RequestInit[] = [];
    const net = network({
      [EXAMPLE_API]: () =>
        new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }),
    });
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith(EXAMPLE_API)) seen.push(init ?? {});
      return net.fetchImpl(input, init);
    }) as typeof fetch;
    const result = await sync(fetchImpl, [DEMO_IDS.pcStonebridge]);
    expect(result.results[0]).toMatchObject({ status: 'failed' });
    expect(result.results[0]!.message).toMatch(/moved/);
    expect(result.results[0]!.message).not.toMatch(/169\.254|302/);
    expect(seen[0]?.redirect).toBe('manual');
    expect(net.calls.some((c) => c.includes('169.254'))).toBe(false);
  });

  it('stops reading an answer the moment it passes the size cap', async () => {
    const { readCapped } = await import('@/lib/services/jobs-board-sync');
    let pulled = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new TextEncoder().encode('x'.repeat(64_000)));
      },
      cancel() {
        cancelled = true;
      },
    });
    // No Content-Length: only reading as it arrives can stop it.
    expect(await readCapped(new Response(endless), 200_000)).toBeNull();
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10);
    expect(await readCapped(new Response('small'), 200_000)).toBe('small');
  });
});

describe('the board host brakes and shapes', () => {
  const request = (url: string, headers: Record<string, string> = {}) =>
    new NextRequest(url, { headers });

  it('answers scanner paths with a 404 before any page, on both hosts', async () => {
    for (const path of ['/.env', '/wp-login.php', '/a/b/c']) {
      const res = await proxy(request(`https://jobs.tiptop.vc${path}`, { host: 'jobs.tiptop.vc' }));
      expect(res.status).toBe(404);
      expect(res.headers.get('x-middleware-rewrite')).toBeNull();
    }
    const deep = await proxy(request('https://copilot.tiptop.vc/jobs/a/b/c'));
    expect(deep.status).toBe(404);
  });

  it("serves the pages' preview images on the board host with no sign-in", async () => {
    for (const path of [
      '/jobs-host/opengraph-image',
      '/jobs-host/ledgerly/vp-sales-1a2b3c/opengraph-image',
    ]) {
      const res = await proxy(request(`https://jobs.tiptop.vc${path}`, { host: 'jobs.tiptop.vc' }));
      expect(res.status, path).toBe(200);
      expect(res.headers.get('location'), path).toBeNull();
      expect(res.headers.get('x-middleware-rewrite'), path).toBeNull();
    }
  });

  it('does not let X-Forwarded-Host turn Kraken into the board', async () => {
    const res = await proxy(
      request('https://copilot.tiptop.vc/today', {
        host: 'copilot.tiptop.vc',
        'x-forwarded-host': 'jobs.tiptop.vc',
      }),
    );
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
  });

  it('brakes one address that floods the board, and leaves the rest alone', async () => {
    const { resetBoardRateLimit, BOARD_PAGE_LIMIT } = await import('@/lib/jobs-board/rate-limit');
    resetBoardRateLimit();
    const from = (ip: string) => ({ host: 'jobs.tiptop.vc', 'cf-connecting-ip': ip });
    for (let i = 0; i < BOARD_PAGE_LIMIT; i++) {
      const ok = await proxy(request('https://jobs.tiptop.vc/ledgerly', from('203.0.113.50')));
      expect(ok.status).toBe(200);
    }
    const braked = await proxy(request('https://jobs.tiptop.vc/ledgerly', from('203.0.113.50')));
    expect(braked.status).toBe(429);
    expect(braked.headers.get('retry-after')).toBe('60');
    const other = await proxy(request('https://jobs.tiptop.vc/ledgerly', from('203.0.113.51')));
    expect(other.status).toBe(200);
    resetBoardRateLimit();
  });
});
