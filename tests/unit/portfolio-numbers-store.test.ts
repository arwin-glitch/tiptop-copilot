import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanyLike } from '@/lib/company-updates/classify';
import {
  buildCompanyNumbers,
  extractMetrics,
  type CompanyNumbers,
} from '@/lib/company-updates/metrics';
import {
  loadPortfolioNumbers,
  mergeSnapshot,
  NUMBERS_RULES_VERSION,
  NUMBERS_SNAPSHOT_ACTION,
  readNumbersSnapshot,
  refreshPortfolioNumbers,
  refreshSettled,
  resetPortfolioNumbersRefresh,
  snapshotIsStale,
  type NumbersComputation,
  type NumbersReader,
  type NumbersSnapshot,
} from '@/lib/services/portfolio-numbers';
import type { AuditEvent } from '@/lib/types/domain';
import { createHarness, type Harness } from '../helpers/harness';

// Fictional companies and figures only: this repository is public.
const ACME: CompanyLike = { id: 'c-acme', name: 'Acme Widgets', domain: 'acmewidgets.example' };
const BRAMBLE: CompanyLike = { id: 'c-bramble', name: 'Bramble Labs', domain: null };
const CORVID: CompanyLike = { id: 'c-corvid', name: 'Corvid Systems', domain: null };

const NOW = new Date('2026-10-15T15:00:00Z');
const MINUTE = 60_000;

function numbersFor(company: CompanyLike, body: string, date = '2026-10-01T12:00:00Z') {
  const id = `ab${company.id.replace(/[^a-z]/g, '')}${date.slice(5, 7)}`.padEnd(16, '0');
  const numbers = buildCompanyNumbers(company, [
    {
      messageId: id,
      threadId: id,
      subject: `${company.name} update`,
      date,
      metrics: extractMetrics(`${company.name} update\n\n${body}`, { company: company.name }),
    },
  ]);
  if (!numbers) throw new Error(`no numbers in the ${company.name} fixture`);
  return numbers;
}

const ACME_SEPT = numbersFor(ACME, 'ARR reached $1.2M. Cash is $3.4M.', '2026-09-02T12:00:00Z');
const ACME_OCT = numbersFor(ACME, 'ARR reached $1.5M. Cash is $3.1M.', '2026-10-02T12:00:00Z');
const BRAMBLE_OCT = numbersFor(BRAMBLE, 'We ended the quarter at $640K ARR.');

const read = (companyId: string, numbers: CompanyNumbers | null, complete = true) => ({
  companyId,
  numbers,
  complete,
});

const snapshotOf = (
  companies: readonly CompanyLike[],
  numbers: CompanyNumbers[],
  at: Date,
  partial = false,
): NumbersSnapshot => ({
  ...mergeSnapshot(
    null,
    { state: 'ok', reads: numbers.map((n) => read(n.companyId, n)) },
    companies,
    at,
  ),
  partial,
});

describe('the next snapshot', () => {
  it('takes new numbers for a company read in full, and drops one whose numbers are gone', () => {
    const previous = snapshotOf([ACME, BRAMBLE], [ACME_SEPT, BRAMBLE_OCT], NOW);
    const next = mergeSnapshot(
      previous,
      { state: 'ok', reads: [read(ACME.id, ACME_OCT), read(BRAMBLE.id, null)] },
      [ACME, BRAMBLE],
      NOW,
    );
    expect(next.companies.map((c) => [c.name, c.revenue?.value.display])).toEqual([
      ['Acme Widgets', '$1.5M'],
    ]);
    expect(next.partial).toBe(false);
    expect(next.rules).toBe(NUMBERS_RULES_VERSION);
  });

  it('keeps the stored numbers for a company the read ran out of time on', () => {
    const previous = snapshotOf([ACME], [ACME_OCT], NOW);
    const next = mergeSnapshot(
      previous,
      // Part of the mail only: an older figure must not replace a complete read.
      { state: 'ok', reads: [read(ACME.id, ACME_SEPT, false)] },
      [ACME],
      NOW,
    );
    expect(next.companies[0]?.revenue?.value.display).toBe('$1.5M');
    expect(next.partial).toBe(true);
  });

  it('takes a partial read when nothing was stored for that company, and marks it partial', () => {
    const next = mergeSnapshot(
      null,
      { state: 'ok', reads: [read(ACME.id, ACME_SEPT, false), read(BRAMBLE.id, null)] },
      [ACME, BRAMBLE],
      NOW,
    );
    expect(next.companies.map((c) => c.name)).toEqual(['Acme Widgets']);
    expect(next.partial).toBe(true);
  });

  it('leaves out companies no longer in the portfolio and uses current names', () => {
    const previous = snapshotOf([ACME, BRAMBLE], [ACME_OCT, BRAMBLE_OCT], NOW);
    const renamed = { ...ACME, name: 'Acme Widget Co' };
    const next = mergeSnapshot(
      previous,
      { state: 'ok', reads: [read(ACME.id, null, false)] },
      [renamed],
      NOW,
    );
    expect(next.companies.map((c) => c.name)).toEqual(['Acme Widget Co']);
    expect(next.checked).toBe(1);
  });
});

describe('staleness', () => {
  const snap = snapshotOf([ACME, BRAMBLE], [ACME_OCT], NOW);

  it('is fresh for 30 minutes, then stale', () => {
    expect(snapshotIsStale(snap, [ACME, BRAMBLE], new Date(NOW.getTime() + 29 * MINUTE))).toBe(
      false,
    );
    expect(snapshotIsStale(snap, [ACME, BRAMBLE], new Date(NOW.getTime() + 30 * MINUTE))).toBe(
      true,
    );
  });

  it('goes stale sooner when the read was partial', () => {
    const partial = { ...snap, partial: true };
    expect(snapshotIsStale(partial, [ACME, BRAMBLE], new Date(NOW.getTime() + 3 * MINUTE))).toBe(
      true,
    );
  });

  it('is stale at once when a company is added, removed or renamed', () => {
    expect(snapshotIsStale(snap, [ACME, BRAMBLE, CORVID], NOW)).toBe(true);
    expect(snapshotIsStale(snap, [ACME], NOW)).toBe(true);
    expect(snapshotIsStale(snap, [ACME, { ...BRAMBLE, name: 'Bramble' }], NOW)).toBe(true);
    // Order does not matter.
    expect(snapshotIsStale(snap, [BRAMBLE, ACME], NOW)).toBe(false);
  });
});

describe('the stored numbers', () => {
  let harness: Harness;
  let org: string;

  beforeEach(async () => {
    resetPortfolioNumbersRefresh();
    harness = await createHarness({ now: NOW });
    org = harness.auth.organizationId;
  });
  afterEach(async () => {
    resetPortfolioNumbersRefresh();
    await harness.dispose();
  });

  const reader = (reads: NumbersComputation['reads'], state: NumbersComputation['state'] = 'ok') =>
    vi.fn<NumbersReader>(async () => ({ state, reads }));

  const snapshotRows = async () =>
    (await harness.store.list('audit_events', org, {
      eq: { action: NUMBERS_SNAPSHOT_ACTION },
    })) as AuditEvent[];

  it('a refresh stores the numbers, and a later refresh replaces them rather than piling up', async () => {
    await refreshPortfolioNumbers(harness.store, org, [ACME], {
      read: reader([read(ACME.id, ACME_SEPT)]),
      now: () => NOW,
    });
    await refreshPortfolioNumbers(harness.store, org, [ACME], {
      read: reader([read(ACME.id, ACME_OCT)]),
      now: () => new Date(NOW.getTime() + 40 * MINUTE),
    });
    const stored = await readNumbersSnapshot(harness.store, org);
    expect(stored?.companies[0]?.revenue?.value.display).toBe('$1.5M');
    // The source email and its date survive the round trip exactly.
    expect(stored?.companies[0]?.revenue).toEqual(ACME_OCT.revenue);
    expect(stored?.companies[0]?.history).toEqual(ACME_OCT.history);
    expect(stored?.checkedAt).toBe(new Date(NOW.getTime() + 40 * MINUTE).toISOString());
    expect(await snapshotRows()).toHaveLength(1);
  });

  it('shows stored numbers at once, without reading Gmail, while they are fresh', async () => {
    await refreshPortfolioNumbers(harness.store, org, [ACME], {
      read: reader([read(ACME.id, ACME_OCT)]),
      now: () => NOW,
    });
    const gmail = reader([]);
    const loaded = await loadPortfolioNumbers(harness.store, org, [ACME], {
      now: new Date(NOW.getTime() + 10 * MINUTE),
      read: gmail,
    });
    expect(gmail).not.toHaveBeenCalled();
    expect(loaded.pending).toBeNull();
    expect(loaded.refreshing).toBe(false);
    expect(loaded.result.state).toBe('ok');
    if (loaded.result.state !== 'ok') return;
    expect(loaded.result.companies[0]?.revenue?.value.display).toBe('$1.5M');
    expect(loaded.result.checkedAt).toBe(NOW.toISOString());
  });

  it('shows stale numbers at once and refreshes them in the background', async () => {
    await refreshPortfolioNumbers(harness.store, org, [ACME], {
      read: reader([read(ACME.id, ACME_SEPT)]),
      now: () => NOW,
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const gmail = vi.fn<NumbersReader>(async () => {
      await gate;
      return { state: 'ok', reads: [read(ACME.id, ACME_OCT)] };
    });
    const later = new Date(NOW.getTime() + 45 * MINUTE);
    const loaded = await loadPortfolioNumbers(harness.store, org, [ACME], {
      now: later,
      read: gmail,
    });
    // Returned before the read finished, with what was stored.
    expect(loaded.result.state).toBe('ok');
    if (loaded.result.state !== 'ok') return;
    expect(loaded.result.companies[0]?.revenue?.value.display).toBe('$1.2M');
    expect(loaded.refreshing).toBe(true);
    await vi.waitFor(() => expect(gmail).toHaveBeenCalledTimes(1));

    // A second view while it runs joins the same refresh.
    const again = await loadPortfolioNumbers(harness.store, org, [ACME], {
      now: later,
      read: gmail,
    });
    expect(again.pending).toBe(loaded.pending);
    expect(gmail).toHaveBeenCalledTimes(1);

    release();
    await loaded.pending;
    const next = await loadPortfolioNumbers(harness.store, org, [ACME], {
      now: later,
      read: gmail,
    });
    expect(next.pending).toBeNull();
    expect(next.result.state === 'ok' && next.result.companies[0]?.revenue?.value.display).toBe(
      '$1.5M',
    );
  });

  it('keeps the stored numbers when Gmail fails, and waits before trying again', async () => {
    await refreshPortfolioNumbers(harness.store, org, [ACME], {
      read: reader([read(ACME.id, ACME_OCT)]),
      now: () => NOW,
    });
    const failing = reader([], 'error');
    const later = new Date(NOW.getTime() + 45 * MINUTE);
    const first = await loadPortfolioNumbers(harness.store, org, [ACME], {
      now: later,
      read: failing,
    });
    expect((await first.pending)?.state).toBe('error');
    const stored = await readNumbersSnapshot(harness.store, org);
    expect(stored?.checkedAt).toBe(NOW.toISOString());
    expect(stored?.companies[0]?.revenue?.value.display).toBe('$1.5M');

    const second = await loadPortfolioNumbers(harness.store, org, [ACME], {
      now: new Date(later.getTime() + MINUTE),
      read: failing,
    });
    expect(second.pending).toBeNull();
    expect(second.result.state).toBe('ok');
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it('a reader that throws leaves the stored numbers alone', async () => {
    await refreshPortfolioNumbers(harness.store, org, [ACME], {
      read: reader([read(ACME.id, ACME_OCT)]),
      now: () => NOW,
    });
    const outcome = await refreshPortfolioNumbers(harness.store, org, [ACME], {
      read: async () => {
        throw new Error('quota');
      },
      now: () => new Date(NOW.getTime() + 45 * MINUTE),
    });
    expect(outcome.state).toBe('error');
    expect((await readNumbersSnapshot(harness.store, org))?.checkedAt).toBe(NOW.toISOString());
  });

  it('with nothing stored, waits for the first read', async () => {
    const loaded = await loadPortfolioNumbers(harness.store, org, [ACME, BRAMBLE], {
      now: NOW,
      read: reader([read(ACME.id, ACME_OCT), read(BRAMBLE.id, BRAMBLE_OCT)]),
    });
    expect(loaded.pending).toBeNull();
    expect(loaded.result.state).toBe('ok');
    if (loaded.result.state !== 'ok') return;
    expect(loaded.result.companies.map((c) => c.name)).toEqual(['Acme Widgets', 'Bramble Labs']);
    expect(await snapshotRows()).toHaveLength(1);
  });

  it('with nothing stored and a slow first read, says so and lets the read finish', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const loaded = await loadPortfolioNumbers(harness.store, org, [ACME], {
      now: NOW,
      budgetMs: 20,
      read: async () => {
        await gate;
        return { state: 'ok', reads: [read(ACME.id, ACME_OCT)] };
      },
    });
    expect(loaded.result.state).toBe('pending');
    expect(loaded.pending).not.toBeNull();
    release();
    await loaded.pending;
    expect((await readNumbersSnapshot(harness.store, org))?.companies).toHaveLength(1);
  });

  it('with nothing stored and Gmail not connected, says so', async () => {
    const loaded = await loadPortfolioNumbers(harness.store, org, [ACME], {
      now: NOW,
      read: reader([], 'not_connected'),
    });
    expect(loaded.result.state).toBe('not_connected');
    expect(await snapshotRows()).toHaveLength(0);
  });

  it('never shows a snapshot stored under older rules or in a shape it does not know', async () => {
    const base: AuditEvent = {
      id: '00000000-0000-4000-8000-0000000000a1',
      organization_id: org,
      user_id: null,
      action: NUMBERS_SNAPSHOT_ACTION,
      entity_type: 'portfolio',
      entity_id: 'numbers',
      metadata: { ...snapshotOf([ACME], [ACME_OCT], NOW), rules: NUMBERS_RULES_VERSION - 1 },
      ip_hash: null,
      created_at: NOW.toISOString(),
    };
    await harness.store.insert('audit_events', base);
    expect(await readNumbersSnapshot(harness.store, org)).toBeNull();

    await harness.store.removeWhere('audit_events', org, {
      eq: { action: NUMBERS_SNAPSHOT_ACTION },
    });
    await harness.store.insert('audit_events', {
      ...base,
      metadata: { rules: NUMBERS_RULES_VERSION, companies: [{ companyId: 'x' }] },
    });
    expect(await readNumbersSnapshot(harness.store, org)).toBeNull();
  });

  it('only shows companies still in the portfolio', async () => {
    await refreshPortfolioNumbers(harness.store, org, [ACME, BRAMBLE], {
      read: reader([read(ACME.id, ACME_OCT), read(BRAMBLE.id, BRAMBLE_OCT)]),
      now: () => NOW,
    });
    const loaded = await loadPortfolioNumbers(harness.store, org, [BRAMBLE], {
      now: NOW,
      read: reader([read(BRAMBLE.id, BRAMBLE_OCT)]),
    });
    expect(loaded.result.state === 'ok' && loaded.result.companies.map((c) => c.name)).toEqual([
      'Bramble Labs',
    ]);
    await loaded.pending;
  });

  it('reads the fictional demo portfolio through the real extractor and stores it', async () => {
    const companies = (await harness.store.list('portfolio_companies', org, {
      eq: { is_archived: false },
    })) as CompanyLike[];
    const loaded = await loadPortfolioNumbers(harness.store, org, companies, { now: NOW });
    expect(loaded.result.state).toBe('ok');
    if (loaded.result.state !== 'ok') return;
    const ledgerly = loaded.result.companies.find((c) => c.name === 'Ledgerly');
    expect(ledgerly?.revenue?.value.display).toBe('$780K');
    expect((await readNumbersSnapshot(harness.store, org))?.checked).toBe(companies.length);
  });
});

describe('a refresh that runs out of time', () => {
  let harness: Harness;
  let org: string;

  beforeEach(async () => {
    resetPortfolioNumbersRefresh();
    harness = await createHarness({ now: NOW });
    org = harness.auth.organizationId;
  });
  afterEach(async () => {
    vi.useRealTimers();
    resetPortfolioNumbersRefresh();
    await harness.dispose();
  });

  /** A reader that answers each pass in turn, repeating the last answer. */
  const passes = (...answers: NumbersComputation['reads'][]) => {
    let call = 0;
    return vi.fn<NumbersReader>(async () => ({
      state: 'ok',
      reads: answers[Math.min(call++, answers.length - 1)]!,
    }));
  };

  const fast = { now: () => NOW, pauseMs: 0 };
  const acmeOnly = [read(ACME.id, ACME_OCT), read(BRAMBLE.id, null, false)];
  const both = [read(ACME.id, ACME_OCT), read(BRAMBLE.id, BRAMBLE_OCT)];

  it('carries on by itself until every company is read', async () => {
    const gmail = passes(acmeOnly, both);
    const first = await refreshPortfolioNumbers(harness.store, org, [ACME, BRAMBLE], {
      ...fast,
      read: gmail,
    });
    expect(first.snapshot?.partial).toBe(true);
    expect(first.next).not.toBeNull();

    const last = await refreshSettled(Promise.resolve(first));
    expect(gmail).toHaveBeenCalledTimes(2);
    expect(last.next).toBeNull();
    const stored = await readNumbersSnapshot(harness.store, org);
    expect(stored?.partial).toBe(false);
    expect(stored?.companies.map((c) => c.name)).toEqual(['Acme Widgets', 'Bramble Labs']);
    expect(
      await harness.store.list('audit_events', org, { eq: { action: NUMBERS_SNAPSHOT_ACTION } }),
    ).toHaveLength(1);
  });

  it('stores each pass as it ends', async () => {
    let between: NumbersSnapshot | null = null;
    let call = 0;
    const gmail = vi.fn<NumbersReader>(async (store, organizationId) => {
      call += 1;
      if (call === 1) return { state: 'ok', reads: acmeOnly };
      between = await readNumbersSnapshot(store, organizationId);
      return { state: 'ok', reads: both };
    });
    await refreshSettled(
      refreshPortfolioNumbers(harness.store, org, [ACME, BRAMBLE], { ...fast, read: gmail }),
    );
    const seen = between as NumbersSnapshot | null;
    expect(seen?.partial).toBe(true);
    expect(seen?.companies.map((c) => c.name)).toEqual(['Acme Widgets']);
  });

  it('stops when a pass reads no company in full that an earlier pass had not', async () => {
    const gmail = passes(acmeOnly);
    const last = await refreshSettled(
      refreshPortfolioNumbers(harness.store, org, [ACME, BRAMBLE], { ...fast, read: gmail }),
    );
    // The second pass finished nothing new, so there is no third.
    expect(gmail).toHaveBeenCalledTimes(2);
    expect(last.snapshot?.partial).toBe(true);
    expect(last.next).toBeNull();
  });

  it('stops after six passes even while each one reads more', async () => {
    const companies: CompanyLike[] = Array.from({ length: 9 }, (_, i) => ({
      id: `c-fictional-${i}`,
      name: `Fictional Co ${i}`,
      domain: null,
    }));
    let call = 0;
    const gmail = vi.fn<NumbersReader>(async () => {
      call += 1;
      return { state: 'ok', reads: companies.map((c, i) => read(c.id, null, i < call)) };
    });
    const last = await refreshSettled(
      refreshPortfolioNumbers(harness.store, org, companies, { ...fast, read: gmail }),
    );
    expect(gmail).toHaveBeenCalledTimes(6);
    expect(last.snapshot?.partial).toBe(true);
    expect(last.next).toBeNull();
  });

  it('never lets a later partial pass replace a figure read in full', async () => {
    const gmail = passes(
      acmeOnly,
      // Out of time on Acme this pass: only an older update was read.
      [read(ACME.id, ACME_SEPT, false), read(BRAMBLE.id, BRAMBLE_OCT)],
      both,
    );
    await refreshSettled(
      refreshPortfolioNumbers(harness.store, org, [ACME, BRAMBLE], { ...fast, read: gmail }),
    );
    const stored = await readNumbersSnapshot(harness.store, org);
    expect(stored?.companies.find((c) => c.companyId === ACME.id)?.revenue?.value.display).toBe(
      '$1.5M',
    );
    expect(stored?.partial).toBe(false);
  });

  it('is still one refresh: views and the job join the pass that is running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let call = 0;
    const gmail = vi.fn<NumbersReader>(async () => {
      call += 1;
      if (call === 1) return { state: 'ok', reads: acmeOnly };
      await gate;
      return { state: 'ok', reads: both };
    });
    const first = await refreshPortfolioNumbers(harness.store, org, [ACME, BRAMBLE], {
      ...fast,
      read: gmail,
    });
    await vi.waitFor(() => expect(gmail).toHaveBeenCalledTimes(2));

    const joined = refreshPortfolioNumbers(harness.store, org, [ACME, BRAMBLE], {
      ...fast,
      read: gmail,
    });
    expect(joined).toBe(first.next);
    const view = await loadPortfolioNumbers(harness.store, org, [ACME, BRAMBLE], {
      now: NOW,
      read: gmail,
    });
    expect(view.refreshing).toBe(true);
    expect(view.pending).toBe(first.next);
    expect(view.result.state === 'ok' && view.result.partial).toBe(true);

    release();
    await refreshSettled(joined);
    expect(gmail).toHaveBeenCalledTimes(2);
    const done = await loadPortfolioNumbers(harness.store, org, [ACME, BRAMBLE], {
      now: NOW,
      read: gmail,
    });
    expect(done.pending).toBeNull();
    expect(done.result.state === 'ok' && done.result.partial).toBe(false);
  });

  it('stops when Gmail fails part-way, keeping the last pass stored', async () => {
    let call = 0;
    const gmail = vi.fn<NumbersReader>(async () => {
      call += 1;
      return call === 1 ? { state: 'ok', reads: acmeOnly } : { state: 'error', reads: [] };
    });
    const last = await refreshSettled(
      refreshPortfolioNumbers(harness.store, org, [ACME, BRAMBLE], { ...fast, read: gmail }),
    );
    expect(last.state).toBe('error');
    expect(last.next).toBeNull();
    const stored = await readNumbersSnapshot(harness.store, org);
    expect(stored?.companies.map((c) => c.name)).toEqual(['Acme Widgets']);
    expect(stored?.partial).toBe(true);

    // The usual cooldown applies before a view tries again.
    const view = await loadPortfolioNumbers(harness.store, org, [ACME, BRAMBLE], {
      now: new Date(NOW.getTime() + 3 * MINUTE),
      read: gmail,
    });
    expect(view.pending).toBeNull();
    expect(gmail).toHaveBeenCalledTimes(2);
  });

  it('pauses between passes to let the Gmail quota refill', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const gmail = passes(acmeOnly, both);
    const first = await refreshPortfolioNumbers(harness.store, org, [ACME, BRAMBLE], {
      now: () => NOW,
      read: gmail,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(gmail).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    await refreshSettled(Promise.resolve(first));
    expect(gmail).toHaveBeenCalledTimes(2);
  });
});
