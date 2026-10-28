import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { env, type AppEnv } from '@/lib/config/env';
import type { DataStore } from '@/lib/db/store';
import { DEMO_IDS } from '@/lib/demo/ids';
import { isCareersPageRole } from '@/lib/jobs-board/careers-page';
import {
  hidePosting,
  readPublicBoard,
  saveCompanyJobs,
  setBoardEnabled,
  type JobsActor,
} from '@/lib/services/jobs-board';
import {
  detectCareersSource,
  resetJobsBoardSyncState,
  syncJobBoards,
} from '@/lib/services/jobs-board-sync';

/**
 * Careers pages on no supported job board (their JobPosting structured data)
 * and LinkedIn jobs links, end to end over the demo store. Every answer is
 * faked from fictional pages; nothing reaches the network.
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
const publicDns = async () => ['93.184.215.14'];
const ORG = () => harness.auth.organizationId;
const CAREERS = 'https://careers.stonebridge-fixture.example.com/jobs';

function role(id: string, title: string, extra: Record<string, unknown> = {}) {
  return {
    '@type': 'JobPosting',
    title,
    identifier: id,
    datePosted: '2026-10-01',
    hiringOrganization: { name: 'Stonebridge Ops' },
    jobLocation: { address: { addressLocality: 'Austin', addressRegion: 'TX' } },
    url: `${CAREERS}/${id}`,
    ...extra,
  };
}

function html(...roles: unknown[]): string {
  return `<html><head><script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': roles,
  })}</script></head><body>Careers</body></html>`;
}

/** A fake network: robots.txt allows everything; the careers page answers `page()`. */
function network(page: () => Response) {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/robots.txt'))
      return new Response('User-agent: *\nAllow: /\n', { status: 200 });
    if (url.startsWith(CAREERS)) return page();
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const htmlResponse = (body: string) =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });

async function sync(fetchImpl: typeof fetch, resolveHost = publicDns) {
  return syncJobBoards(harness.store, ORG(), {
    fetchImpl,
    e: live(),
    sleep: noSleep,
    resolveHost,
    trigger: 'daily',
    companyIds: [DEMO_IDS.pcStonebridge],
  });
}

async function pageRoles(store: DataStore = harness.store) {
  const rows = await store.list('job_postings', ORG(), {
    eq: { portfolio_company_id: DEMO_IDS.pcStonebridge },
  });
  return rows.filter(isCareersPageRole);
}

async function publicTitles(): Promise<string[]> {
  const read = await readPublicBoard({ store: harness.store, organizationId: ORG() });
  return read.state === 'on' ? read.board.jobs.map((j) => j.title).sort() : [];
}

/** Stonebridge's careers page, found to carry structured-data roles. */
async function stonebridgeOnCareersPage(net: ReturnType<typeof network>, autoPublish = false) {
  const saved = await saveCompanyJobs(
    harness.store,
    actor,
    DEMO_IDS.pcStonebridge,
    { careersUrl: CAREERS, autoPublish },
    {
      detectSource: (url, companyName) =>
        detectCareersSource(url, {
          fetchImpl: net.fetchImpl,
          e: live(),
          sleep: noSleep,
          resolveHost: publicDns,
          companyName,
        }),
    },
  );
  expect(saved.ok).toBe(true);
  return saved;
}

describe('careers pages read for their JobPosting data', () => {
  it('turns the daily read on when the page lists roles, and keeps them off the board until allowed', async () => {
    const net = network(() =>
      htmlResponse(html(role('ops-1', 'Yard Planner'), role('eng-2', 'Fixture Systems Engineer'))),
    );
    const saved = await stonebridgeOnCareersPage(net);
    expect(saved.ok && saved.value.company).toMatchObject({
      ats: null,
      sync_enabled: true,
      careers_url: CAREERS,
    });
    expect(saved.ok && saved.value.note).toMatch(/found 2 roles on that careers page/);

    const first = await sync(net.fetchImpl);
    expect(first.results[0]).toMatchObject({ status: 'ok', added: 2, total: 2 });
    expect(first.results[0]!.message).toMatch(/2 open roles on the careers page/);
    const rows = await pageRoles();
    expect(rows.map((r) => r.title).sort()).toEqual(['Fixture Systems Engineer', 'Yard Planner']);
    expect(rows.every((r) => r.source === 'ats' && !r.published)).toBe(true);
    expect(rows[0]!.source_key).toMatch(/^page:careers\.stonebridge-fixture\.example\.com:/);

    await setBoardEnabled(harness.store, actor, true);
    expect(await publicTitles()).not.toContain('Yard Planner');
    // Auto-publish follows the same rule as a job board's roles.
    await saveCompanyJobs(harness.store, actor, DEMO_IDS.pcStonebridge, { autoPublish: true });
    expect(await publicTitles()).toEqual(
      expect.arrayContaining(['Yard Planner', 'Fixture Systems Engineer']),
    );
  });

  it('closes a role the page stops listing, skips expired ones, and never closes on an empty page', async () => {
    let body = html(role('ops-1', 'Yard Planner'), role('eng-2', 'Fixture Systems Engineer'));
    const net = network(() => htmlResponse(body));
    await stonebridgeOnCareersPage(net, true);
    await sync(net.fetchImpl);

    body = html(
      role('ops-1', 'Yard Planner'),
      role('old-3', 'Expired Role', { validThrough: '2020-01-01' }),
    );
    resetJobsBoardSyncState();
    const second = await sync(net.fetchImpl);
    expect(second.results[0]).toMatchObject({ status: 'ok', closed: 1, total: 1 });
    expect(second.results[0]!.message).toMatch(/1 expired left out/);
    const rows = await pageRoles();
    expect(rows.find((r) => r.title === 'Fixture Systems Engineer')!.status).toBe('closed');
    expect(rows.some((r) => r.title === 'Expired Role')).toBe(false);

    // A redesign with no structured data: nothing is closed.
    body = '<html><body>We are hiring! Email us.</body></html>';
    resetJobsBoardSyncState();
    const third = await sync(net.fetchImpl);
    expect(third.results[0]).toMatchObject({ status: 'skipped', closed: 0 });
    expect((await pageRoles()).find((r) => r.title === 'Yard Planner')!.status).toBe('active');
  });

  it('keeps a hidden role hidden, and its address, when its link or key changes', async () => {
    // No identifier: the role's key comes from its link, which picks up a
    // fresh tracking parameter on every load.
    let n = 0;
    const net = network(() =>
      htmlResponse(
        html(
          role('ops-1', 'Yard Planner', {
            identifier: undefined,
            url: `${CAREERS}/yard-planner?utm_source=feed&session=s${++n}#apply`,
          }),
          role('eng-2', 'Fixture Systems Engineer'),
        ),
      ),
    );
    const ours = async () =>
      (await publicTitles()).filter((t) =>
        ['Yard Planner', 'Fixture Systems Engineer'].includes(t),
      );
    await stonebridgeOnCareersPage(net, true);
    await sync(net.fetchImpl);
    await setBoardEnabled(harness.store, actor, true);
    const planner = (await pageRoles()).find((r) => r.title === 'Yard Planner')!;
    const hidden = await hidePosting(harness.store, actor, planner.id);
    expect(hidden.ok).toBe(true);
    expect(await ours()).toEqual(['Fixture Systems Engineer']);

    resetJobsBoardSyncState();
    const second = await sync(net.fetchImpl);
    expect(second.results[0]).toMatchObject({ status: 'ok', added: 0, closed: 0 });
    let rows = await pageRoles();
    expect(rows.filter((r) => r.title === 'Yard Planner')).toHaveLength(1);
    expect(await ours()).toEqual(['Fixture Systems Engineer']);

    // The page renumbers its roles: the same title under a new id keeps its
    // row (hidden, same address) rather than coming back as a fresh one.
    const engineer = rows.find((r) => r.title === 'Fixture Systems Engineer')!;
    await hidePosting(harness.store, actor, engineer.id);
    const renumbered = network(() =>
      htmlResponse(
        html(
          role('ops-1', 'Yard Planner', { identifier: undefined, url: `${CAREERS}/yard-planner` }),
          role('eng-99', 'Fixture Systems Engineer'),
        ),
      ),
    );
    resetJobsBoardSyncState();
    const third = await sync(renumbered.fetchImpl);
    expect(third.results[0]).toMatchObject({ status: 'ok', added: 0, closed: 0 });
    rows = await pageRoles();
    expect(rows).toHaveLength(2);
    const moved = rows.find((r) => r.id === engineer.id)!;
    expect(moved.source_key).toMatch(/:eng-99$/);
    expect(moved).toMatchObject({ slug: engineer.slug, status: 'active', published: false });
    expect(moved.hidden_at).not.toBeNull();
    expect(await ours()).toEqual([]);
  });

  it('never fetches a careers page whose host resolves to a private address', async () => {
    const net = network(() => htmlResponse(html(role('ops-1', 'Yard Planner'))));
    await stonebridgeOnCareersPage(net);
    const before = net.calls.length;
    const result = await sync(net.fetchImpl, async () => ['10.0.0.7']);
    expect(result.results[0]).toMatchObject({ status: 'failed', added: 0 });
    expect(net.calls.length).toBe(before);
    expect(await pageRoles()).toEqual([]);
  });

  it('obeys robots.txt for the careers page', async () => {
    const net = network(() => htmlResponse(html(role('ops-1', 'Yard Planner'))));
    await stonebridgeOnCareersPage(net);
    resetJobsBoardSyncState();
    const blocked = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/robots.txt'))
        return new Response('User-agent: *\nDisallow: /jobs\n', { status: 200 });
      return net.fetchImpl(input);
    }) as typeof fetch;
    const result = await sync(blocked);
    expect(result.results[0]!.status).toBe('failed');
    expect(result.results[0]!.message).toMatch(/robots\.txt/);
    expect(await pageRoles()).toEqual([]);
  });

  it('leaves the daily read off when the page lists no roles', async () => {
    const net = network(() => htmlResponse('<html><body>Careers</body></html>'));
    const saved = await stonebridgeOnCareersPage(net);
    expect(saved.ok && saved.value.company.sync_enabled).toBe(false);
    expect(saved.ok && saved.value.note).toMatch(/could not find a job board/);
  });
});

describe('LinkedIn jobs links', () => {
  it('stores the jobs tab from a company address and shows it on the public board', async () => {
    const saved = await saveCompanyJobs(harness.store, actor, DEMO_IDS.pcStonebridge, {
      linkedinUrl: 'linkedin.com/company/stonebridge-fixture',
      listed: true,
    });
    expect(saved.ok && saved.value.company.linkedin_url).toBe(
      'https://www.linkedin.com/company/stonebridge-fixture/jobs/',
    );
    await setBoardEnabled(harness.store, actor, true);
    const read = await readPublicBoard({ store: harness.store, organizationId: ORG() });
    const company =
      read.state === 'on' ? read.board.companies.find((c) => c.name === 'Stonebridge Ops') : null;
    expect(company?.linkedinJobsUrl).toBe(
      'https://www.linkedin.com/company/stonebridge-fixture/jobs/',
    );

    const cleared = await saveCompanyJobs(harness.store, actor, DEMO_IDS.pcStonebridge, {
      linkedinUrl: '',
    });
    expect(cleared.ok && cleared.value.company.linkedin_url).toBeNull();
  });

  it('refuses an address that is not a LinkedIn company page', async () => {
    const saved = await saveCompanyJobs(harness.store, actor, DEMO_IDS.pcStonebridge, {
      linkedinUrl: 'https://www.linkedin.com/in/pat-example',
    });
    expect(saved.ok).toBe(false);
    expect(!saved.ok && saved.error.code).toBe('invalid_input');
  });

  it('saves everything else, and says the migration is needed, before the column exists', async () => {
    const store = harness.store;
    const withoutColumn = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'update') {
          return async (table: string, org: string, id: string, patch: Record<string, unknown>) => {
            if (table === 'job_companies' && 'linkedin_url' in patch) {
              throw Object.assign(new Error("Could not find the 'linkedin_url' column"), {
                code: 'PGRST204',
              });
            }
            return (target.update as (...a: unknown[]) => Promise<unknown>)(table, org, id, patch);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as DataStore;
    const saved = await saveCompanyJobs(withoutColumn, actor, DEMO_IDS.pcStonebridge, {
      linkedinUrl: 'https://www.linkedin.com/company/stonebridge-fixture',
      about: 'Stonebridge makes fixtures.',
    });
    expect(saved.ok).toBe(true);
    expect(saved.ok && saved.value.note).toMatch(/20261028100000_jobs_linkedin\.sql/);
    expect(saved.ok && saved.value.company.about).toBe('Stonebridge makes fixtures.');
  });
});
