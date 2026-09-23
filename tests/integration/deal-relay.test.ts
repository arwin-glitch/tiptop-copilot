import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { resetEnvCache } from '@/lib/config/env';
import type { DataStore } from '@/lib/db/store';
import { parseSidecar } from '@/lib/deals/routine-state';
import { latestAnalysesByDeal } from '@/lib/services/deal-analysis';
import {
  mirrorDealId,
  PORTFOLIO_MIRROR_REASON,
  relayDealId,
  SIDECAR_FIELD,
  stableUuid,
} from '@/lib/services/deal-ingest';
import {
  pullDealsFromSlack,
  resetDealPullState,
  type DealRelayStatus,
} from '@/lib/services/deal-relay';
import {
  addNote,
  archiveDeal,
  recordDecision,
  restoreDeal,
  updateDealStage,
} from '@/lib/services/deals';
import type {
  AuditEvent,
  Deal,
  DealAnalysis,
  DealDecision,
  DealFact,
  DealPerson,
  DealSource,
  Organization,
  PortfolioCompany,
} from '@/lib/types/domain';

/**
 * The deal-sorter relay end to end, on the demo store: Slack pages in,
 * pipeline rows out. Every company, domain and thread id is invented.
 */

const TICK = String.fromCharCode(96);
const SAVED = { ...process.env };
let harness: Harness;
let clock = 1_790_000_000;

beforeEach(async () => {
  harness = await createHarness();
  process.env.ASK_RELAY_SLACK_TOKEN = 'xoxb-test';
  resetEnvCache();
  resetDealPullState();
});

afterEach(async () => {
  vi.useRealTimers();
  await harness.dispose();
  for (const key of Object.keys(process.env)) {
    if (!(key in SAVED)) delete process.env[key];
  }
  Object.assign(process.env, SAVED);
  resetEnvCache();
  resetDealPullState();
});

interface SlackMsg {
  ts: string;
  text: string;
  user: string;
  subtype?: string;
}

const nextTs = () => `${clock++}.000100`;

function upsert(deals: unknown[], part = 1, parts = 1, batch = '2026-09-20T09:50Z'): SlackMsg {
  const body = { v: 1, source: 'deal-sorter', batch, phase: 'a1', part, parts, deals };
  return {
    ts: nextTs(),
    user: 'U0ROUTINE1',
    text: `DEAL_UPSERT_V1\n${TICK}${JSON.stringify(body)}${TICK}`,
  };
}

function heartbeat(extra: Record<string, unknown> = {}): SlackMsg {
  const body = {
    v: 1,
    source: 'deal-sorter',
    run_at: '2026-09-20T09:58Z',
    phase: 'a1',
    as_of: '2026-09-20',
    backfill_done: ['a1'],
    attempts: { a1: 1 },
    posted: 18,
    parts: 3,
    stages: { new: 18 },
    near_misses: 0,
    ...extra,
  };
  return {
    ts: nextTs(),
    user: 'U0ROUTINE1',
    text: `DEAL_SORTER_RUN_V1\n${TICK}${JSON.stringify(body)}${TICK}`,
  };
}

/** A fake conversations.history: pages newest first, a cursor per page. */
function fakeSlack(pages: SlackMsg[][]) {
  const calls: URL[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url);
    const cursor = url.searchParams.get('cursor');
    const index = cursor ? Number(cursor.replace('page-', '')) : 0;
    const next = index + 1 < pages.length ? `page-${index + 1}` : '';
    return new Response(
      JSON.stringify({
        ok: true,
        messages: pages[index] ?? [],
        has_more: Boolean(next),
        response_metadata: { next_cursor: next },
      }),
    );
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** Newest-first single page from messages given oldest first. */
const channel = (...messages: SlackMsg[]) => fakeSlack([[...messages].reverse()]);

const pull = (impl: typeof fetch, now = new Date()) =>
  pullDealsFromSlack(harness.store, harness.auth.organizationId, impl, { force: true, now });

function hex(n: number): string {
  return (0xabc0000000 + n).toString(16);
}

function company(n: number, extra: Record<string, unknown> = {}) {
  const id = String(n).padStart(2, '0');
  return {
    key: `zz-relay-${id}`,
    name: `ZZ Relay ${id}`,
    fit: n % 3 === 0 ? 'unlikely' : 'possible',
    source: 'ZZ Angel Feed',
    summary: `Invented vertical software company number ${id}`,
    website: `zzrelay${id}.example`,
    founders: [{ name: `Founder ${id}`, title: 'CEO' }],
    first_seen: '2026-09-01',
    threads: [{ id: hex(n), subject: `Pitch ${id}`, date: '2026-09-01' }],
    ...extra,
  };
}

async function dealsNamed(prefix: string): Promise<Deal[]> {
  const all = (await harness.store.list('deals', harness.auth.organizationId, {})) as Deal[];
  return all.filter((d) => d.company_name.startsWith(prefix));
}

async function dealByName(name: string): Promise<Deal> {
  const [deal] = await dealsNamed(name);
  if (!deal) throw new Error(`no deal ${name}`);
  return deal;
}

async function sidecarOf(dealId: string) {
  const rows = (await harness.store.list('deal_facts', harness.auth.organizationId, {
    eq: { deal_id: dealId, field: SIDECAR_FIELD },
    isNull: ['superseded_by'],
  })) as DealFact[];
  return rows.length === 1 ? parseSidecar(rows[0]!.value) : null;
}

function spyWrites(store: DataStore): () => number {
  let writes = 0;
  const target = store as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  for (const method of ['insert', 'insertMany', 'update', 'upsert', 'remove', 'removeWhere']) {
    const original = target[method]!.bind(store);
    target[method] = async (...args: unknown[]) => {
      writes++;
      return original(...args);
    };
  }
  return () => writes;
}

describe('ingest from #deal-relay', () => {
  it('creates 18 deals from three parts, then writes nothing when the window is re-read', async () => {
    const deals = Array.from({ length: 18 }, (_, i) => company(i + 1));
    const parts = [0, 1, 2].map((p) => upsert(deals.slice(p * 6, p * 6 + 6), p + 1, 3));
    const beat = heartbeat();
    // Two pages, newest first, so the second is reached through the cursor.
    const now = new Date();
    const slack = fakeSlack([
      [beat, parts[2]!],
      [parts[1]!, parts[0]!],
    ]);

    const first = await pull(slack.impl, now);
    expect(first.state).toBe('ok');
    expect(first.counts?.created).toBe(18);
    expect(first.counts?.failed).toBe(0);
    expect(first.lastRun?.heartbeat.posted).toBe(18);

    const [firstCall, secondCall] = slack.calls;
    expect(firstCall?.searchParams.get('channel')).toBe('C0C40TVD4DP');
    expect(firstCall?.searchParams.get('limit')).toBe('200');
    const oldest = Number(firstCall?.searchParams.get('oldest'));
    expect(Math.abs(oldest - (now.getTime() / 1000 - 30 * 86_400))).toBeLessThan(5);
    expect(secondCall?.searchParams.get('cursor')).toBe('page-1');

    const created = await dealsNamed('ZZ Relay');
    expect(created).toHaveLength(18);
    const one = await dealByName('ZZ Relay 04');
    expect(one.stage).toBe('new');
    expect(one.domain).toBe('zzrelay04.example');
    expect(one.referral_source).toBe('ZZ Angel Feed');
    expect(one.received_at.slice(0, 10)).toBe('2026-09-01');
    const sources = (await harness.store.list('deal_sources', harness.auth.organizationId, {
      eq: { deal_id: one.id },
    })) as DealSource[];
    expect(sources).toEqual([
      expect.objectContaining({ kind: 'email_thread', ref_id: hex(4), url: null }),
    ]);
    const people = (await harness.store.list('deal_people', harness.auth.organizationId, {
      eq: { deal_id: one.id },
    })) as DealPerson[];
    expect(people).toEqual([
      expect.objectContaining({ name: 'Founder 04', role: 'CEO', email: null }),
    ]);
    const sidecar = await sidecarOf(one.id);
    expect(sidecar?.created_by_routine).toBe(true);
    expect(sidecar?.keys).toEqual(['zz-relay-04']);
    expect(sidecar?.stage_set).toBe('new');

    const writes = spyWrites(harness.store);
    const second = await pull(slack.impl);
    expect(second.counts?.unchanged).toBe(18);
    expect(writes()).toBe(0);
  });

  it('moves a stage it owns, and after a person moves it, only updates its view', async () => {
    const base = company(1);
    const t0 = new Date(Date.now() - 3 * 60_000);
    await pull(
      channel(upsert([{ ...base, stage: 'founder_meeting', evidence_date: '2026-09-01' }])).impl,
      t0,
    );
    const deal = await dealByName('ZZ Relay 01');
    expect(deal.stage).toBe('founder_meeting');

    const moving = channel(
      upsert([{ ...base, stage: 'founder_meeting', evidence_date: '2026-09-01' }]),
      upsert([{ ...base, stage: 'diligence', evidence_date: '2026-09-05' }]),
    );
    const moved = await pull(moving.impl, new Date(Date.now() - 2 * 60_000));
    expect(moved.counts?.moved).toBe(1);
    expect((await dealByName('ZZ Relay 01')).stage).toBe('diligence');
    const synced = (await harness.store.list('audit_events', harness.auth.organizationId, {
      eq: { entity_id: deal.id, action: 'deal.stage_synced' },
    })) as AuditEvent[];
    expect(synced).toEqual([
      expect.objectContaining({
        user_id: null,
        metadata: expect.objectContaining({ from: 'founder_meeting', to: 'diligence' }),
      }),
    ]);

    // A person picks a stage from the StageSelect.
    expect((await updateDealStage(harness.auth, deal.id, 'waiting_for_info')).ok).toBe(true);

    const later = channel(
      upsert([{ ...base, stage: 'diligence', evidence_date: '2026-09-05' }]),
      upsert([{ ...base, stage: 'ic_review', evidence_date: '2026-09-12' }]),
    );
    const after = await pull(later.impl);
    expect(after.counts?.moved).toBe(0);
    expect(after.counts?.suggested).toBe(1);
    expect((await dealByName('ZZ Relay 01')).stage).toBe('waiting_for_info');
    expect((await sidecarOf(deal.id))?.view?.stage).toBe('ic_review');
  });

  it('treats a person restoring the routine’s own stage as a person’s stage', async () => {
    const base = company(2);
    await pull(
      channel(upsert([{ ...base, stage: 'reviewing', evidence_date: '2026-09-01' }])).impl,
      new Date(Date.now() - 60_000),
    );
    const deal = await dealByName('ZZ Relay 02');
    await updateDealStage(harness.auth, deal.id, 'diligence');
    await updateDealStage(harness.auth, deal.id, 'reviewing');

    await pull(
      channel(
        upsert([{ ...base, stage: 'reviewing', evidence_date: '2026-09-01' }]),
        upsert([{ ...base, stage: 'founder_meeting', evidence_date: '2026-09-08' }]),
      ).impl,
    );
    expect((await dealByName('ZZ Relay 02')).stage).toBe('reviewing');
  });

  it('never moves a deal a person passed on', async () => {
    const base = company(3);
    await pull(
      channel(upsert([{ ...base, stage: 'reviewing', evidence_date: '2026-09-01' }])).impl,
      new Date(Date.now() - 60_000),
    );
    const deal = await dealByName('ZZ Relay 03');
    expect((await recordDecision(harness.auth, deal.id, 'pass', 'Outside the thesis')).ok).toBe(
      true,
    );

    await pull(
      channel(
        upsert([{ ...base, stage: 'reviewing', evidence_date: '2026-09-01' }]),
        upsert([{ ...base, stage: 'diligence', evidence_date: '2026-09-10' }]),
      ).impl,
    );
    expect((await dealByName('ZZ Relay 03')).stage).toBe('passed');
    const decisions = (await harness.store.list('deal_decisions', harness.auth.organizationId, {
      eq: { deal_id: deal.id },
    })) as DealDecision[];
    expect(decisions).toHaveLength(1);
  });

  it('leaves an archived deal alone when it is posted again', async () => {
    const base = company(5);
    await pull(channel(upsert([base])).impl);
    const deal = await dealByName('ZZ Relay 05');
    await archiveDeal(harness.auth, deal.id, 'Not a deal');

    const result = await pull(
      channel(upsert([base]), upsert([{ ...base, summary: 'changed' }])).impl,
    );
    expect(result.counts?.skipped_archived).toBe(1);
    expect(result.counts?.created).toBe(0);
    const after = await dealByName('ZZ Relay 05');
    expect(after.is_archived).toBe(true);
    expect(after.product_summary).not.toBe('changed');
  });

  it('archives a retracted deal nobody touched, and only flags one a person worked on', async () => {
    const gone = company(6);
    const kept = company(7);
    await pull(channel(upsert([gone, kept])).impl, new Date(Date.now() - 60_000));
    const keptDeal = await dealByName('ZZ Relay 07');
    await addNote(harness.auth, keptDeal.id, 'Spoke to them; worth a call.');

    const result = await pull(
      channel(
        upsert([gone, kept]),
        upsert([
          { key: gone.key, name: gone.name, retract: 'a services agency, not raising' },
          { key: kept.key, name: kept.name, retract: 'a services agency, not raising' },
        ]),
      ).impl,
    );
    expect(result.counts?.retracted).toBe(1);
    expect(result.counts?.retract_flagged).toBe(1);
    const goneDeal = await dealByName('ZZ Relay 06');
    expect(goneDeal.is_archived).toBe(true);
    const archivedEvents = (await harness.store.list('audit_events', harness.auth.organizationId, {
      eq: { entity_id: goneDeal.id, action: 'deal.archived' },
    })) as AuditEvent[];
    expect(archivedEvents).toEqual([expect.objectContaining({ user_id: null })]);
    expect((await dealByName('ZZ Relay 07')).is_archived).toBe(false);
    expect((await sidecarOf(keptDeal.id))?.retract).toBe('a services agency, not raising');

    // Restored by a person, it is not archived again.
    await restoreDeal(harness.auth, goneDeal.id);
    await pull(
      channel(
        upsert([gone]),
        upsert([{ key: gone.key, name: gone.name, retract: 'still not a startup' }]),
      ).impl,
    );
    expect((await dealByName('ZZ Relay 06')).is_archived).toBe(false);
  });

  it('never fills a column a person corrected', async () => {
    const base = company(8);
    await pull(channel(upsert([base])).impl);
    const deal = await dealByName('ZZ Relay 08');
    await harness.store.update('deals', harness.auth.organizationId, deal.id, {
      product_summary: 'Corrected by hand',
    });
    await pull(
      channel(
        upsert([base]),
        upsert([{ ...base, summary: 'A newer routine summary', sector: 'Legal' }]),
      ).impl,
    );
    const after = await dealByName('ZZ Relay 08');
    expect(after.product_summary).toBe('Corrected by hand');
    expect(after.vertical).toBe('Legal');
  });
});

describe('the Portfolio tab and Invested', () => {
  async function portfolioNamed(name: string): Promise<PortfolioCompany> {
    const all = (await harness.store.list(
      'portfolio_companies',
      harness.auth.organizationId,
      {},
    )) as PortfolioCompany[];
    const found = all.find((c) => c.name === name);
    if (!found) throw new Error(`no portfolio company ${name}`);
    return found;
  }

  async function addPortfolio(
    name: string,
    domain: string | null = null,
    at = new Date(),
  ): Promise<void> {
    const now = at.toISOString();
    await harness.store.insert('portfolio_companies', {
      ...(await portfolioNamed('Ledgerly')),
      id: crypto.randomUUID(),
      name,
      normalized_name: name.toLowerCase(),
      domain,
      website: domain ? `https://${domain}` : null,
      created_at: now,
      updated_at: now,
    });
  }

  it('lists every portfolio company under Invested, with no human decision written', async () => {
    const ledgerly = await portfolioNamed('Ledgerly');
    const result = await pull(
      channel(upsert([company(9, { name: 'Ledgerly', key: 'ledgerly', website: undefined })])).impl,
    );
    // The relay does not create a portfolio company's deal; the mirror does,
    // from the Portfolio row.
    expect(result.counts?.skipped_portfolio).toBe(1);
    expect(result.counts?.mirrored).toBe(2);

    const deal = await dealByName('Ledgerly');
    expect(deal.stage).toBe('invested');
    expect(deal.domain).toBe(ledgerly.domain);
    expect(await sidecarOf(deal.id)).toBeNull();
    expect(
      await harness.store.count('deal_decisions', harness.auth.organizationId, {
        eq: { deal_id: deal.id },
      }),
    ).toBe(0);
    const created = (await harness.store.list('audit_events', harness.auth.organizationId, {
      eq: { entity_id: deal.id, action: 'deal.created' },
    })) as AuditEvent[];
    expect(created).toEqual([
      expect.objectContaining({
        user_id: null,
        metadata: expect.objectContaining({ reason: PORTFOLIO_MIRROR_REASON }),
      }),
    ]);

    const writes = spyWrites(harness.store);
    const again = await pull(channel().impl);
    expect(again.counts?.mirrored).toBe(0);
    expect(writes()).toBe(0);
  });

  it('moves a matching deal into Invested once, and respects a person moving it back out', async () => {
    const base = company(10, {
      name: 'ZZ Mirror Co',
      key: 'zz-mirror-co',
      website: 'zzmirror.example',
    });
    await pull(
      channel(upsert([{ ...base, stage: 'diligence', evidence_date: '2026-09-01' }])).impl,
    );
    const deal = await dealByName('ZZ Mirror Co');
    expect(deal.stage).toBe('diligence');

    await addPortfolio('ZZ Mirror Co', 'zzmirror.example');
    const moved = await pull(channel().impl);
    expect(moved.counts?.mirror_moved).toBe(1);
    expect((await dealByName('ZZ Mirror Co')).stage).toBe('invested');
    const events = (await harness.store.list('audit_events', harness.auth.organizationId, {
      eq: { entity_id: deal.id, action: 'deal.stage_synced' },
    })) as AuditEvent[];
    expect(events.at(-1)).toMatchObject({
      user_id: null,
      metadata: { from: 'diligence', to: 'invested', reason: PORTFOLIO_MIRROR_REASON },
    });
    expect(
      await harness.store.count('deal_decisions', harness.auth.organizationId, {
        eq: { deal_id: deal.id },
      }),
    ).toBe(0);

    await updateDealStage(harness.auth, deal.id, 'monitoring');
    const next = await pull(channel().impl);
    expect(next.counts?.mirror_moved).toBe(0);
    expect((await dealByName('ZZ Mirror Co')).stage).toBe('monitoring');
  });

  it('leaves an archived match alone rather than creating a duplicate', async () => {
    await pull(
      channel(
        upsert([company(11, { name: 'ZZ Shelved Co', key: 'zz-shelved-co', website: undefined })]),
      ).impl,
    );
    const deal = await dealByName('ZZ Shelved Co');
    await archiveDeal(harness.auth, deal.id, 'Not a deal');
    await addPortfolio('ZZ Shelved Co');
    await pull(channel().impl);
    const all = await dealsNamed('ZZ Shelved Co');
    expect(all).toHaveLength(1);
    expect(all[0]!.is_archived).toBe(true);
    expect(all[0]!.stage).toBe('new');
  });

  it('never re-invests a deal it created once a person moves it out', async () => {
    const first = await pull(channel().impl);
    expect(first.counts?.mirrored).toBe(2);
    const deal = await dealByName('Ledgerly');
    expect(deal.id).toBe(
      mirrorDealId(harness.auth.organizationId, (await portfolioNamed('Ledgerly')).id),
    );

    expect((await updateDealStage(harness.auth, deal.id, 'monitoring')).ok).toBe(true);
    const next = await pull(channel().impl);
    expect(next.counts?.mirror_moved).toBe(0);
    expect((await dealByName('Ledgerly')).stage).toBe('monitoring');

    // A decision that moves the stage counts the same way.
    await updateDealStage(harness.auth, deal.id, 'invested');
    expect((await recordDecision(harness.auth, deal.id, 'pass', 'Wound down')).ok).toBe(true);
    await pull(channel().impl);
    expect((await dealByName('Ledgerly')).stage).toBe('passed');
  });

  it('leaves a person’s move out of Invested alone when they invested before the Portfolio row existed', async () => {
    const base = company(12, {
      name: 'ZZ Early Bet',
      key: 'zz-early-bet',
      website: 'zzearly.example',
    });
    await pull(
      channel(upsert([{ ...base, stage: 'diligence', evidence_date: '2026-09-01' }])).impl,
    );
    const deal = await dealByName('ZZ Early Bet');
    expect((await recordDecision(harness.auth, deal.id, 'invest', 'Wired')).ok).toBe(true);
    await addPortfolio('ZZ Early Bet', 'zzearly.example', new Date(Date.now() + 1_000));
    await pull(channel().impl);
    expect((await dealByName('ZZ Early Bet')).stage).toBe('invested');

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 5_000);
    await updateDealStage(harness.auth, deal.id, 'monitoring');
    const after = await pull(channel().impl);
    expect(after.counts?.mirror_moved).toBe(0);
    expect((await dealByName('ZZ Early Bet')).stage).toBe('monitoring');
  });

  it('still moves a deal a person staged before the company joined the Portfolio tab', async () => {
    const base = company(13, {
      name: 'ZZ Staged Co',
      key: 'zz-staged-co',
      website: 'zzstaged.example',
    });
    await pull(channel(upsert([base])).impl);
    const deal = await dealByName('ZZ Staged Co');
    await updateDealStage(harness.auth, deal.id, 'diligence');
    await addPortfolio('ZZ Staged Co', 'zzstaged.example', new Date(Date.now() + 60_000));
    const moved = await pull(channel().impl);
    expect(moved.counts?.mirror_moved).toBe(1);
    expect((await dealByName('ZZ Staged Co')).stage).toBe('invested');
  });

  it('only annotates the deal of a company already in the Portfolio tab', async () => {
    const base = company(14, {
      name: 'ZZ Annotated Co',
      key: 'zz-annotated-co',
      website: 'zzannotated.example',
      founders: [{ name: 'Founder Fourteen', title: 'CEO' }],
    });
    await pull(
      channel(upsert([{ ...base, stage: 'reviewing', evidence_date: '2026-09-01' }])).impl,
    );
    const deal = await dealByName('ZZ Annotated Co');
    await addPortfolio('ZZ Annotated Co', 'zzannotated.example');
    await pull(channel().impl);
    const before = await dealByName('ZZ Annotated Co');
    expect(before.stage).toBe('invested');

    const result = await pull(
      channel(
        upsert([
          {
            ...base,
            fit: 'likely',
            summary: 'A different routine summary',
            stage: 'diligence',
            evidence_date: '2026-09-10',
            founders: [{ name: 'Someone New', title: 'CTO' }],
          },
        ]),
      ).impl,
    );
    expect(result.counts?.updated).toBe(1);
    const after = await dealByName('ZZ Annotated Co');
    expect(after.stage).toBe('invested');
    expect(after.product_summary).toBe(before.product_summary);
    const people = (await harness.store.list('deal_people', harness.auth.organizationId, {
      eq: { deal_id: deal.id },
    })) as DealPerson[];
    expect(people.map((p) => p.name)).toEqual(['Founder Fourteen']);
    expect((await sidecarOf(deal.id))?.fit).toBe('likely');
  });
});

describe('Slack failures', () => {
  const refusal = (
    error: string,
    extra: Record<string, unknown> = {},
    status = 200,
    headers: Record<string, string> = {},
  ) =>
    (async () =>
      new Response(JSON.stringify({ ok: false, error, ...extra }), {
        status,
        headers,
      })) as unknown as typeof fetch;

  it.each([
    ['not_in_channel', 'bot_not_in_channel'],
    ['channel_not_found', 'bot_not_in_channel'],
    ['missing_scope', 'missing_scope'],
    ['invalid_auth', 'bad_token'],
    ['token_revoked', 'bad_token'],
    ['ratelimited', 'rate_limited'],
  ])(
    'maps %s to %s without throwing, and still mirrors the Portfolio tab',
    async (error, state) => {
      const status = await pull(refusal(error, { needed: 'groups:history' }));
      expect(status.state).toBe(state);
      if (state === 'missing_scope') expect(status.needed).toBe('groups:history');
      expect(status.counts?.mirrored).toBe(2);
    },
  );

  it('reports not_configured with no token, and mirrors anyway', async () => {
    delete process.env.ASK_RELAY_SLACK_TOKEN;
    resetEnvCache();
    const status = await pull(refusal('never called'));
    expect(status.state).toBe('not_configured');
    expect(status.missing).toEqual(['ASK_RELAY_SLACK_TOKEN']);
    expect(status.counts?.mirrored).toBe(2);
  });

  it('honours Retry-After on a 429', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let calls = 0;
    const limited = (async () => {
      calls++;
      return new Response('{}', { status: 429, headers: { 'retry-after': '120' } });
    }) as unknown as typeof fetch;
    const org = harness.auth.organizationId;
    expect((await pullDealsFromSlack(harness.store, org, limited)).state).toBe('rate_limited');
    vi.setSystemTime(Date.now() + 61_000);
    await pullDealsFromSlack(harness.store, org, limited);
    expect(calls).toBe(1);
    vi.setSystemTime(Date.now() + 60_000);
    await pullDealsFromSlack(harness.store, org, limited);
    expect(calls).toBe(2);
  });

  it('retries a 5xx or a network fault after ten seconds, not a minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let calls = 0;
    const flaky = (async () => {
      calls++;
      if (calls === 1) return new Response('oops', { status: 502 });
      throw new Error('socket hang up');
    }) as unknown as typeof fetch;
    const org = harness.auth.organizationId;
    let status: DealRelayStatus = await pullDealsFromSlack(harness.store, org, flaky);
    expect(status.state).toBe('error');
    await pullDealsFromSlack(harness.store, org, flaky);
    expect(calls).toBe(1);
    vi.setSystemTime(Date.now() + 11_000);
    status = await pullDealsFromSlack(harness.store, org, flaky);
    expect(calls).toBe(2);
    expect(status.state).toBe('error');
  });

  it('shares one pull between concurrent callers', async () => {
    let calls = 0;
    const slow = (async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return new Response(JSON.stringify({ ok: true, messages: [] }));
    }) as unknown as typeof fetch;
    const org = harness.auth.organizationId;
    const [a, b] = await Promise.all([
      pullDealsFromSlack(harness.store, org, slow),
      pullDealsFromSlack(harness.store, org, slow),
    ]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
  });
});

describe('repairs from review', () => {
  it('lands a new deal posted as invested at IC review, with no decision written', async () => {
    const base = company(20, {
      name: 'ZZ Wired Co',
      key: 'zz-wired-co',
      website: 'zzwired.example',
    });
    const result = await pull(
      channel(
        upsert([
          {
            ...base,
            stage: 'invested',
            evidence_kind: 'wire',
            evidence: 'Sep 3: partner approved the fund-admin wire',
            evidence_date: '2026-09-03',
          },
        ]),
      ).impl,
    );
    expect(result.counts?.created).toBe(1);
    expect(result.counts?.suggested).toBe(1);
    const deal = await dealByName('ZZ Wired Co');
    expect(deal.stage).toBe('ic_review');
    expect(deal.id).toBe(
      relayDealId(harness.auth.organizationId, 'zz-wired-co', 'zzwired.example'),
    );
    expect((await sidecarOf(deal.id))?.view).toMatchObject({
      stage: 'invested',
      evidence_kind: 'wire',
    });
    expect(
      await harness.store.count('deal_decisions', harness.auth.organizationId, {
        eq: { deal_id: deal.id },
      }),
    ).toBe(0);
  });

  it('derives stable, UUID-shaped ids', () => {
    const id = stableUuid('seed');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(stableUuid('seed')).toBe(id);
    expect(relayDealId('org', 'zz-a', 'https://www.zz-a.example/x')).toBe(
      relayDealId('org', 'zz-a', 'zz-a.example'),
    );
    expect(relayDealId('org', 'zz-a', 'zz-a.example')).not.toBe(relayDealId('org', 'zz-a', null));
  });

  it('adds founders to an existing deal without duplicating one', async () => {
    const base = company(21);
    await pull(channel(upsert([base])).impl);
    const deal = await dealByName('ZZ Relay 21');
    await pull(
      channel(
        upsert([base]),
        upsert([
          {
            ...base,
            founders: [{ name: 'founder 21', title: 'CEO' }, { name: 'Second Founder' }],
          },
        ]),
      ).impl,
    );
    const people = (await harness.store.list('deal_people', harness.auth.organizationId, {
      eq: { deal_id: deal.id },
    })) as DealPerson[];
    expect(people.map((p) => p.name).sort()).toEqual(['Founder 21', 'Second Founder']);
  });

  it('lets a pass through after an upcoming meeting was posted with its future date', async () => {
    const base = company(22);
    await pull(
      channel(upsert([{ ...base, stage: 'founder_meeting', evidence_date: '2026-12-01' }])).impl,
      new Date(Date.now() - 60_000),
    );
    const deal = await dealByName('ZZ Relay 22');
    expect(deal.stage).toBe('founder_meeting');
    const postDay = new Date(clock * 1000).toISOString().slice(0, 10);
    expect((await sidecarOf(deal.id))?.stage_evidence_date).toBe(postDay);

    await pull(
      channel(
        upsert([{ ...base, stage: 'founder_meeting', evidence_date: '2026-12-01' }]),
        upsert([
          { ...base, stage: 'passed', evidence_date: postDay, pass_reason: 'Outside the thesis' },
        ]),
      ).impl,
    );
    const after = await dealByName('ZZ Relay 22');
    expect(after.stage).toBe('passed');
    expect(after.outcome).toBe('Passed — Outside the thesis');
  });

  it('clears the pass outcome it wrote once it moves the deal on', async () => {
    const base = company(23);
    await pull(
      channel(
        upsert([
          { ...base, stage: 'passed', evidence_date: '2026-09-01', pass_reason: 'Too early' },
        ]),
      ).impl,
      new Date(Date.now() - 60_000),
    );
    expect((await dealByName('ZZ Relay 23')).outcome).toBe('Passed — Too early');
    await pull(
      channel(
        upsert([
          { ...base, stage: 'passed', evidence_date: '2026-09-01', pass_reason: 'Too early' },
        ]),
        upsert([{ ...base, stage: 'monitoring', evidence_date: '2026-09-15' }]),
      ).impl,
    );
    const after = await dealByName('ZZ Relay 23');
    expect(after.stage).toBe('monitoring');
    expect(after.outcome).toBeNull();
  });

  it('keeps two companies that share a key apart, in one pull and across pulls', async () => {
    const a = company(24, { key: 'zz-orbit', name: 'ZZ Orbit', website: 'orbit-a.example' });
    const b = company(25, {
      key: 'zz-orbit',
      name: 'ZZ Orbit',
      website: 'orbit-b.example',
      summary: 'The other Orbit',
    });
    await pull(channel(upsert([a])).impl);
    const result = await pull(channel(upsert([a]), upsert([b])).impl);
    expect(result.counts?.created).toBe(1);
    const both = await dealsNamed('ZZ Orbit');
    expect(both.map((d) => d.domain).sort()).toEqual(['orbit-a.example', 'orbit-b.example']);
    expect(both.find((d) => d.domain === 'orbit-a.example')?.product_summary).toBe(a.summary);

    const c = company(26, { key: 'zz-kite', name: 'ZZ Kite', website: 'kite-a.example' });
    const d = company(27, { key: 'zz-kite', name: 'ZZ Kite', website: 'kite-b.example' });
    const same = await pull(channel(upsert([c, d])).impl);
    expect(same.counts?.created).toBe(2);
  });

  it('keeps the routine the owner of a move whose sidecar write failed', async () => {
    const base = company(28);
    await pull(
      channel(upsert([{ ...base, stage: 'founder_meeting', evidence_date: '2026-09-01' }])).impl,
      new Date(Date.now() - 3 * 60_000),
    );
    const target = harness.store as unknown as Record<
      string,
      (...a: unknown[]) => Promise<unknown>
    >;
    const insert = target.insert!.bind(harness.store);
    let failOnce = true;
    target.insert = async (...args: unknown[]) => {
      if (args[0] === 'deal_facts' && failOnce) {
        failOnce = false;
        throw new Error('transient');
      }
      return insert(...args);
    };
    const failed = await pull(
      channel(
        upsert([{ ...base, stage: 'founder_meeting', evidence_date: '2026-09-01' }]),
        upsert([{ ...base, stage: 'diligence', evidence_date: '2026-09-05' }]),
      ).impl,
      new Date(Date.now() - 2 * 60_000),
    );
    expect(failed.counts?.failed).toBe(1);
    expect((await dealByName('ZZ Relay 28')).stage).toBe('diligence');

    const next = await pull(
      channel(
        upsert([{ ...base, stage: 'diligence', evidence_date: '2026-09-05' }]),
        upsert([{ ...base, stage: 'ic_review', evidence_date: '2026-09-12' }]),
      ).impl,
    );
    expect(next.counts?.moved).toBe(1);
    expect((await dealByName('ZZ Relay 28')).stage).toBe('ic_review');
  });

  it('counts a failed insert of new deals and still mirrors the Portfolio tab', async () => {
    const target = harness.store as unknown as Record<
      string,
      (...a: unknown[]) => Promise<unknown>
    >;
    const insertMany = target.insertMany!.bind(harness.store);
    let failOnce = true;
    target.insertMany = async (...args: unknown[]) => {
      if (args[0] === 'deals' && failOnce) {
        failOnce = false;
        throw new Error('transient');
      }
      return insertMany(...args);
    };
    const result = await pull(channel(upsert([company(29), company(30)])).impl);
    expect(result.state).toBe('ok');
    expect(result.counts).toMatchObject({ created: 0, failed: 2, mirrored: 2 });
    expect(await dealsNamed('ZZ Relay')).toHaveLength(0);

    const retry = await pull(channel(upsert([company(29), company(30)])).impl);
    expect(retry.counts?.created).toBe(2);
  });

  it('folds the relay into the only organization, and nowhere once there are two', async () => {
    const now = new Date().toISOString();
    await harness.store.insert('organizations', {
      id: crypto.randomUUID(),
      name: 'ZZ Second Workspace',
      slug: 'zz-second',
      created_at: now,
      updated_at: now,
    } as Organization);
    const status = await pull(channel(upsert([company(31)])).impl);
    expect(status.state).toBe('other_workspace');
    expect(await dealsNamed('ZZ Relay')).toHaveLength(0);
    // The Portfolio mirror is this organization's own data, so it still runs.
    expect(status.counts?.mirrored).toBe(2);
  });

  it('keeps reporting the newest change across quiet pulls', async () => {
    const slack = channel(upsert([company(32), company(33)]));
    const first = await pull(slack.impl);
    expect(first.lastChange?.counts.created).toBe(2);
    const quiet = await pull(slack.impl);
    expect(quiet.counts?.created).toBe(0);
    expect(quiet.lastChange?.counts.created).toBe(2);
    expect(quiet.lastChange?.at).toBe(first.lastChange?.at);
  });

  it('says it could not save, not that it could not read, when the ingest fails', async () => {
    const target = harness.store as unknown as Record<
      string,
      (...a: unknown[]) => Promise<unknown>
    >;
    const list = target.list!.bind(harness.store);
    target.list = async (...args: unknown[]) => {
      if (args[0] === 'deals') throw new Error('database unavailable');
      return list(...args);
    };
    const status = await pull(channel(upsert([company(34)])).impl);
    expect(status.state).toBe('save_failed');
  });

  it('reads the newest analysis of each deal', async () => {
    const [first, second] = (await harness.store.list(
      'deals',
      harness.auth.organizationId,
      {},
    )) as Deal[];
    if (!first || !second) throw new Error('the demo has deals');
    // Only the fields the lookup reads; the demo store does not check the rest.
    const analysis = (dealId: string, version: number) =>
      ({
        id: crypto.randomUUID(),
        organization_id: harness.auth.organizationId,
        deal_id: dealId,
        version,
        headline: `ZZ v${version}`,
      }) as unknown as DealAnalysis;
    for (const row of [
      analysis(first.id, 1),
      analysis(first.id, 3),
      analysis(first.id, 2),
      analysis(second.id, 1),
    ]) {
      await harness.store.insert('deal_analyses', row);
    }
    const latest = await latestAnalysesByDeal(harness.store, harness.auth.organizationId, [
      first.id,
      second.id,
    ]);
    expect(latest.get(first.id)?.headline).toBe('ZZ v3');
    expect(latest.get(second.id)?.headline).toBe('ZZ v1');
  });
});
