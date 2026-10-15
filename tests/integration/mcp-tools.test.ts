import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import type { DataStore } from '@/lib/db/store';
import { DEMO_IDS, demoCrmId } from '@/lib/demo/ids';
import { MCP_TOOLS, runMcpTool, type McpToolContext } from '@/lib/mcp/tools';
import type { McpToolOutput } from '@/lib/mcp/protocol';

/**
 * Each MCP tool against the demo store: the CRM fixtures (a deal pipeline, an
 * LP pipeline with commitments, a portfolio list, notes — one of them carrying
 * an injection attempt), Copilot's own deals, portfolio and tasks, and the
 * demo LP-pipeline and portfolio-health snapshots.
 *
 * Two properties are checked across tools rather than once: LP amounts never
 * appear anywhere in an answer, and note text only ever arrives fenced as
 * untrusted data.
 */

let harness: Harness;
let ctx: McpToolContext;

beforeEach(async () => {
  harness = await createHarness();
  ctx = {
    store: harness.store,
    organizationId: harness.auth.organizationId,
    now: new Date(),
    appUrl: 'https://copilot.example',
  };
});

afterEach(async () => {
  await harness.dispose();
});

const BRINDLE = demoCrmId('record', 0);
const MARREN_SOLBERG = demoCrmId('record', 20);
const MARROWGATE = demoCrmId('record', 9);
const LEDGERLY = demoCrmId('record', 28);
const BRINDLE_DEAL_ENTRY = demoCrmId('entry', 0);

async function run(name: string, args: Record<string, unknown> = {}): Promise<McpToolOutput> {
  return runMcpTool(ctx, name, args);
}

/** Text and JSON together, for "never appears anywhere" checks. */
function everything(out: McpToolOutput): string {
  return `${out.text}\n${JSON.stringify(out.structured)}`;
}

/** The demo LP commitments, in every way they could be written. */
const LP_AMOUNTS = ['2,000,000', '2000000', '1,000,000', '1000000', '250,000', '250000', '$2M'];
function expectNoLpAmounts(out: McpToolOutput) {
  const all = everything(out);
  for (const amount of LP_AMOUNTS) expect(all).not.toContain(amount);
  expect(all).not.toMatch(/commitment/i);
}

describe('tools/list', () => {
  it('describes nine read-only tools with plain object schemas', () => {
    expect(MCP_TOOLS.map((t) => t.name)).toEqual([
      'search',
      'get_record',
      'list_lists',
      'list_entries',
      'get_notes',
      'deals_pipeline',
      'lp_pipeline',
      'portfolio',
      'tasks',
    ]);
    for (const tool of MCP_TOOLS) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema).not.toHaveProperty('$schema');
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(tool.description.length).toBeGreaterThan(40);
    }
    const search = MCP_TOOLS.find((t) => t.name === 'search');
    expect(search?.inputSchema).toMatchObject({
      required: ['query'],
      properties: { query: { type: 'string' } },
    });
  });

  it('refuses bad arguments as a tool error naming the argument', async () => {
    const out = await run('search', { query: 'a' });
    expect(out.isError).toBe(true);
    expect(out.errorCode).toBe('invalid_input');
    expect(out.text).toMatch(/query/);
    expect((await run('list_entries', { list_id: 'not-an-id' })).isError).toBe(true);
  });
});

describe('search', () => {
  it('finds a company with its list stage, its deal entry and notes that mention it', async () => {
    const out = await run('search', { query: 'Brindle' });
    expect(out.isError).toBeFalsy();
    const results = out.structured.results as {
      kind: string;
      id: string | null;
      summary: string;
      source: string;
    }[];
    const company = results.find((r) => r.kind === 'company');
    expect(company).toMatchObject({ id: BRINDLE, source: 'crm' });
    expect(company?.summary).toContain('Deal Pipeline: 3. First Meeting');
    expect(results.some((r) => r.kind === 'deal' && r.id === BRINDLE_DEAL_ENTRY)).toBe(true);
    expect(results.some((r) => r.kind === 'note')).toBe(true);
    expect(out.text).toContain(`(id ${BRINDLE})`);
    expect(out.text).toContain('<untrusted-content');
  });

  it('finds LPs on the CRM LP list and in the Fund II pipeline, stages only', async () => {
    const crm = await run('search', { query: 'Maren', kinds: ['lp', 'person', 'note'] });
    const results = crm.structured.results as { kind: string; summary: string }[];
    expect(results.find((r) => r.kind === 'lp')?.summary).toBe('LP Pipeline · Soft Circle');
    expect(results.some((r) => r.kind === 'person')).toBe(true);
    // The LP call note is found, with its amount masked.
    expect(results.some((r) => r.kind === 'note')).toBe(true);
    expect(crm.text).toContain('[amount]');
    expectNoLpAmounts(crm);

    const fund = await run('search', { query: 'Grace', kinds: ['lp'] });
    expect(fund.structured.results).toEqual([
      expect.objectContaining({
        kind: 'lp',
        id: null,
        name: 'Grace Okafor',
        source: 'fund_ii_pipeline',
        summary: 'Lakeside Family Office · Fund II pipeline · Materials sent',
      }),
    ]);
  });

  it('does not reveal which LP notes hold an amount: a hit only on a masked amount is dropped', async () => {
    const LP_NOTE = demoCrmId('note', 5);
    for (const query of ['$2M', '2M', 'circle at $2']) {
      const out = await run('search', { query, kinds: ['note'] });
      const ids = (out.structured.results as { id: string }[]).map((r) => r.id);
      expect(ids).not.toContain(LP_NOTE);
    }
    // Words that are shown still find it.
    const shown = await run('search', { query: 'emerging-manager', kinds: ['note'] });
    expect((shown.structured.results as { id: string }[]).map((r) => r.id)).toContain(LP_NOTE);
  });

  it('masks amounts in the title of a note about an LP, everywhere the title appears', async () => {
    const LP_NOTE = demoCrmId('note', 5);
    await harness.store.update('crm_notes', harness.auth.organizationId, LP_NOTE, {
      title: 'Commitment call: $2M soft circle',
    });
    const found = await run('search', { query: 'soft circle', kinds: ['note'] });
    const hit = (found.structured.results as { id: string; name: string }[]).find(
      (r) => r.id === LP_NOTE,
    );
    expect(hit?.name).toBe('Commitment call: [amount] soft circle');
    expect(everything(found)).not.toContain('$2M');

    const notes = await run('get_notes', { entry_id: demoCrmId('entry', 11) });
    const json = (notes.structured.notes as { id: string; title: string | null }[]).find(
      (n) => n.id === LP_NOTE,
    );
    expect(json?.title).toBe('Commitment call: [amount] soft circle');
    expect(everything(notes)).not.toContain('$2M');

    const record = await run('get_record', { id: MARREN_SOLBERG });
    expect(everything(record)).not.toContain('$2M');
  });

  it('finds Copilot deals and portfolio companies, with links back to the app', async () => {
    const out = await run('search', { query: 'Ledgerly', kinds: ['portfolio', 'company'] });
    const results = out.structured.results as { kind: string; url?: string }[];
    expect(results.find((r) => r.kind === 'portfolio')?.url).toBe(
      `https://copilot.example/portfolio/${DEMO_IDS.pcLedgerly}`,
    );
    expect(results.some((r) => r.kind === 'company')).toBe(true);
  });

  it('says so when nothing matches', async () => {
    const out = await run('search', { query: 'zzzz-nothing' });
    expect(out.text).toMatch(/Nothing matched/);
    expect(out.structured.results).toEqual([]);
  });
});

describe('get_record', () => {
  it('returns a company with its lists and values, related people and fenced note excerpts', async () => {
    const out = await run('get_record', { id: BRINDLE });
    expect(out.isError).toBeFalsy();
    expect(out.structured.type).toBe('company');
    const lists = out.structured.lists as { list: string; values: Record<string, string> }[];
    const deal = lists.find((l) => l.list === 'Deal Pipeline');
    // A deal list is not an LP list: its amounts are shown.
    expect(deal?.values).toMatchObject({ Status: '3. First Meeting', Amount: '$750,000' });
    expect(out.structured.related).toEqual([expect.objectContaining({ name: 'Ada Brennan' })]);
    expect(out.text).toContain('<untrusted-content source-id="crm_note:');
    const notes = out.structured.notes as { latest: { content_untrusted: string }[] };
    expect(notes.latest[0]?.content_untrusted).toBeTruthy();
  });

  it('returns an LP with the stage and without the commitment, in values, fields or notes', async () => {
    const out = await run('get_record', { id: MARREN_SOLBERG });
    const lists = out.structured.lists as { list: string; values: Record<string, string> }[];
    expect(lists.find((l) => l.list === 'LP Pipeline')?.values).toEqual({
      Status: 'Soft Circle',
      Fund: 'Fund II',
      Organization: 'Oakhaven Capital',
      'Last Contact': expect.any(String),
    });
    expect(out.text).toContain('stages only');
    expectNoLpAmounts(out);
  });

  it('shows where a company also lives in Copilot', async () => {
    const out = await run('get_record', { id: LEDGERLY });
    expect(out.structured.copilot).toEqual([
      expect.objectContaining({ kind: 'portfolio', id: DEMO_IDS.pcLedgerly, name: 'Ledgerly' }),
    ]);
  });

  it('returns a list entry, a Copilot deal and a portfolio company by their ids', async () => {
    const entry = await run('get_record', { id: BRINDLE_DEAL_ENTRY });
    expect(entry.structured.type).toBe('list_entry');
    expect(entry.text).toContain('Deal Pipeline');

    const deal = await run('get_record', { id: DEMO_IDS.dealVetrix });
    expect(deal.structured.type).toBe('deal');
    expect(deal.text).toContain(`https://copilot.example/deals/${DEMO_IDS.dealVetrix}`);

    const company = await run('get_record', { id: DEMO_IDS.pcLedgerly });
    expect(company.structured.type).toBe('portfolio');
  });

  it('says not found for an unknown id', async () => {
    const out = await run('get_record', { id: '00000000-0000-4000-8000-00000000ffff' });
    expect(out).toMatchObject({ isError: true, errorCode: 'not_found' });
  });
});

describe('list_lists and list_entries', () => {
  it('lists every list with its stages, hiding amount columns on the LP list only', async () => {
    const out = await run('list_lists');
    const lists = out.structured.lists as {
      id: string;
      name: string;
      entry_count: number;
      lp_list: boolean;
      fields: { key: string }[];
      status_field: { stages: string[] } | null;
    }[];
    expect(lists.map((l) => l.name).slice(0, 3)).toEqual([
      'Deal Pipeline',
      'LP Pipeline',
      'Portfolio',
    ]);
    expect(lists).toHaveLength(15);
    expect(lists.find((l) => l.name === 'Family Office LP Pipeline')?.lp_list).toBe(true);
    const deals = lists[0];
    expect(deals?.entry_count).toBe(11);
    expect(deals?.fields.map((f) => f.key)).toContain('amount');
    expect(deals?.status_field?.stages).toEqual([
      '1. Sourced',
      '3. First Meeting',
      '5. Diligence',
      '10. Invested',
      'Passed',
    ]);
    const lps = lists[1];
    expect(lps?.lp_list).toBe(true);
    expect(lps?.fields.map((f) => f.key)).not.toContain('commitment');
    expectNoLpAmounts(out);
  });

  it('filters a list by stage and pages through it', async () => {
    const out = await run('list_entries', {
      list_id: DEMO_IDS.crmListDeals,
      status: ['5. Diligence'],
    });
    expect(out.structured.total).toBe(2);
    const titles = (out.structured.entries as { title: string }[]).map((e) => e.title).sort();
    expect(titles).toEqual(['Cobaltline', 'Marrowgate Software']);

    const page = await run('list_entries', { list_id: DEMO_IDS.crmListDeals, limit: 5 });
    expect(page.structured).toMatchObject({ total: 11, offset: 0, limit: 5, next_offset: 5 });
    expect(page.text).toContain('call again with offset 5');
  });

  it('never shows or sorts by an LP amount', async () => {
    const out = await run('list_entries', {
      list_id: DEMO_IDS.crmListLps,
      sort: 'commitment',
      direction: 'desc',
    });
    expect(out.structured.sort).toEqual({ key: 'position', dir: 'asc' });
    expect(out.text).toContain('hidden on an LP list');
    expectNoLpAmounts(out);
  });

  it('refuses to filter an LP list by a hidden amount column, or by anything but a status field', async () => {
    for (const status_field of ['commitment', 'organization', 'last_contact', 'nope']) {
      const out = await run('list_entries', {
        list_id: DEMO_IDS.crmListLps,
        status_field,
        status: ['250000', '1000000', '2000000'],
      });
      expect(out).toMatchObject({ isError: true, errorCode: 'invalid_input' });
      expect(out.structured).not.toHaveProperty('total');
      expectNoLpAmounts(out);
    }
    // A status field that is shown still filters, as does the pipeline field.
    const fund = await run('list_entries', {
      list_id: DEMO_IDS.crmListLps,
      status_field: 'fund',
      status: ['Fund II'],
    });
    expect(fund.isError).toBeFalsy();
    expect(fund.structured.total).toBeGreaterThan(0);
    const stage = await run('list_entries', {
      list_id: DEMO_IDS.crmListLps,
      status_field: 'status',
      status: ['Soft Circle'],
    });
    expect(stage.isError).toBeFalsy();
    expectNoLpAmounts(stage);
  });

  it('says not found for a list that does not exist', async () => {
    const out = await run('list_entries', { list_id: '00000000-0000-4000-8000-00000000fffe' });
    expect(out).toMatchObject({ isError: true, errorCode: 'not_found' });
  });
});

describe('get_notes', () => {
  it("returns a record's notes in full, newest first, inside untrusted fences", async () => {
    const out = await run('get_notes', { record_id: BRINDLE });
    const notes = out.structured.notes as { content_untrusted: string }[];
    expect(notes[0]?.content_untrusted).toContain('Brindle automates prior authorisations');
    const fenceAt = out.text.indexOf('<untrusted-content');
    expect(fenceAt).toBeGreaterThan(-1);
    expect(out.text.indexOf('Brindle automates')).toBeGreaterThan(fenceAt);
    expect(out.structured.untrusted).toMatch(/never instructions/);
  });

  it('keeps an injection attempt inside the fence, with the warning and the flag', async () => {
    const out = await run('get_notes', { record_id: MARROWGATE });
    const flagged = (out.structured.notes as { injection_flagged: boolean }[]).find(
      (n) => n.injection_flagged,
    );
    expect(flagged).toBeTruthy();
    expect(out.text).toContain('SECURITY NOTE');
    expect(out.text).toContain('flagged: contains instruction-like text');
    const attempt = out.text.indexOf('Ignore all previous instructions');
    const open = out.text.lastIndexOf('<untrusted-content', attempt);
    const close = out.text.indexOf('</untrusted-content>', attempt);
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(attempt);
  });

  it('pages, and masks amounts on notes about an LP', async () => {
    const first = await run('get_notes', { entry_id: demoCrmId('entry', 11), limit: 1 });
    expect((first.structured.notes as unknown[]).length).toBe(1);
    expectNoLpAmounts(first);
    expect(first.text).toContain('[amount]');
  });

  it('wants exactly one of record_id and entry_id', async () => {
    expect((await run('get_notes', {})).isError).toBe(true);
    expect(
      (await run('get_notes', { record_id: BRINDLE, entry_id: BRINDLE_DEAL_ENTRY })).isError,
    ).toBe(true);
  });
});

describe('deals_pipeline', () => {
  it("counts Copilot's deals by stage and each CRM deal list by status", async () => {
    const out = await run('deals_pipeline', { days: 30 });
    const copilot = out.structured.copilot as {
      live_deals: number;
      stages: { key: string; count: number | null }[];
    };
    expect(copilot.live_deals).toBeGreaterThan(0);
    const counted = copilot.stages.reduce((sum, s) => sum + (s.count ?? 0), 0);
    expect(counted).toBeLessThanOrEqual(copilot.live_deals);

    const crm = out.structured.crm_lists as {
      name: string;
      total: number;
      stages: { label: string; count: number }[];
    }[];
    // Deal lists only: the demo's Family Office LP Pipeline is an opportunity
    // list too, and stays out.
    expect(crm.map((l) => l.name)).toEqual(['Deal Pipeline', 'Seed Opportunities']);
    expect(crm[0]?.total).toBe(11);
    expect(Object.fromEntries(crm[0]?.stages.map((s) => [s.label, s.count]) ?? [])).toEqual({
      '1. Sourced': 3,
      '3. First Meeting': 3,
      '5. Diligence': 2,
      '10. Invested': 1,
      Passed: 2,
    });
    expect(out.text).toContain('CRM list Deal Pipeline');
  });
});

describe('lp_pipeline', () => {
  it('gives the Fund II stages and the CRM LP list by status, never an amount', async () => {
    const out = await run('lp_pipeline');
    const fund = out.structured.fund_ii as {
      state: string;
      stages: { stage: string; count: number }[];
      lps: { who: string; stage: string; gmail_thread_id: string | null }[];
    };
    expect(fund.state).toBe('ok');
    expect(fund.stages.find((s) => s.stage === 'soft_commit')?.count).toBe(1);
    expect(fund.lps.find((l) => l.who === 'Ivy Chen')).toMatchObject({
      stage: 'soft_commit',
      gmail_thread_id: '0f0000000000f002',
    });
    const crm = out.structured.crm_lists as {
      name: string;
      people: { name: string; stage: string | null; values: Record<string, string> }[];
    }[];
    expect(crm[0]?.name).toBe('LP Pipeline');
    expect(crm[0]?.people.find((p) => p.name === 'Desmond Achterberg')).toMatchObject({
      stage: 'Committed',
    });
    expect(out.structured.rule).toMatch(/Stages only/);
    expectNoLpAmounts(out);
  });

  it('can give counts alone', async () => {
    const out = await run('lp_pipeline', { include_people: false });
    expect((out.structured.fund_ii as { lps?: unknown }).lps).toBeUndefined();
    expect(out.text).not.toContain('Grace Okafor');
  });
});

describe('portfolio and tasks', () => {
  it('lists portfolio companies, and routine health for names it could not match', async () => {
    const out = await run('portfolio');
    const companies = out.structured.companies as { name: string; url: string }[];
    expect(companies.map((c) => c.name)).toEqual(['Ledgerly', 'Stonebridge Ops']);
    expect(companies[0]?.url).toContain('/portfolio/');
    const health = out.structured.health as { state: string; not_in_portfolio: unknown[] };
    expect(health.state).toBe('ok');
    expect(health.not_in_portfolio.length).toBe(4);
  });

  it('lists open tasks soonest first, marking the overdue ones', async () => {
    const out = await run('tasks');
    const tasks = out.structured.tasks as {
      due_at: string | null;
      overdue: boolean;
      status: string;
    }[];
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks.every((t) => t.status === 'open' || t.status === 'snoozed')).toBe(true);
    const dated = tasks.filter((t) => t.due_at).map((t) => t.due_at as string);
    expect([...dated].sort()).toEqual(dated);

    const overdue = await run('tasks', { due: 'overdue' });
    const onlyOverdue = overdue.structured.tasks as { overdue: boolean }[];
    expect(onlyOverdue.every((t) => t.overdue)).toBe(true);
    expect(overdue.structured.total).toBe(out.structured.overdue);
  });
});

describe('before the CRM migration has run', () => {
  it('reports the CRM as not set up, and still answers from the rest of Copilot', async () => {
    const missing = Object.assign(new Error('relation "crm_lists" does not exist'), {
      code: '42P01',
    });
    const store = new Proxy(harness.store, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (typeof args[0] === 'string' && args[0].startsWith('crm_')) {
            return Promise.reject(missing);
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as DataStore;
    ctx = { ...ctx, store };

    const lists = await run('list_lists');
    expect(lists).toMatchObject({ isError: true, errorCode: 'not_configured' });
    expect(lists.text).toContain('20261015000000_crm.sql');

    const search = await run('search', { query: 'Ledgerly' });
    expect(search.isError).toBeFalsy();
    expect(search.structured.crm_set_up).toBe(false);
    expect((search.structured.results as { kind: string }[]).map((r) => r.kind)).toContain(
      'portfolio',
    );

    const notes = await run('get_notes', { record_id: BRINDLE });
    expect(notes).toMatchObject({ isError: true, errorCode: 'not_configured' });

    const deals = await run('deals_pipeline');
    expect(deals.isError).toBeFalsy();
    expect(deals.structured.crm_set_up).toBe(false);
  });
});
