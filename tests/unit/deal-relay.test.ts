import { describe, expect, it } from 'vitest';
import {
  clampDates,
  collectRelayMessages,
  MAX_MESSAGE_CHARS,
  parseDealRelayMessage,
  RELAY_DEAL_SCHEMA,
  type RelayDeal,
} from '@/lib/services/deal-relay';

/**
 * The #deal-relay message format. Every company, domain and thread id here is
 * invented.
 */

const TICK = String.fromCharCode(96);
const upsert = (deals: unknown[], extra: Record<string, unknown> = {}) =>
  [
    'DEAL_UPSERT_V1',
    TICK +
      JSON.stringify({
        v: 1,
        source: 'deal-sorter',
        batch: '2026-09-23T09:50Z',
        phase: 'a1',
        part: 1,
        parts: 1,
        deals,
        ...extra,
      }) +
      TICK,
  ].join('\n');

const deal = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  name: `ZZ ${key}`,
  fit: 'possible',
  source: 'ZZ Angel Feed',
  ...extra,
});

describe('parseDealRelayMessage', () => {
  it('reads the marker line plus backticked JSON', () => {
    const parsed = parseDealRelayMessage(upsert([deal('zz-quill')]));
    expect(parsed?.kind).toBe('upsert');
    if (parsed?.kind !== 'upsert') return;
    expect(parsed.batch).toBe('2026-09-23T09:50Z');
    expect(parsed.phase).toBe('a1');
    expect(parsed.deals).toHaveLength(1);
    expect(parsed.deals[0]?.key).toBe('zz-quill');
    expect(parsed.rejects).toEqual([]);
  });

  it('ignores chatter and every other relay marker', () => {
    expect(parseDealRelayMessage('morning all')).toBeNull();
    expect(parseDealRelayMessage(42)).toBeNull();
    expect(
      parseDealRelayMessage('PORTFOLIO_ADD_V1\n`{"source":"x","companies":[{"name":"ZZ"}]}`'),
    ).toBeNull();
    expect(parseDealRelayMessage('BRIEFING_PAYLOAD_V1\n`{"kind":"morning"}`')).toBeNull();
  });

  it('counts a marked message it cannot read, rather than dropping it silently', () => {
    expect(parseDealRelayMessage('DEAL_UPSERT_V1 no body')).toEqual({
      kind: 'invalid',
      reason: 'no backticked body',
    });
    expect(parseDealRelayMessage('DEAL_UPSERT_V1\n`{not json}`')?.kind).toBe('invalid');
    expect(parseDealRelayMessage(upsert([], { v: 2 }))?.kind).toBe('invalid');
    expect(parseDealRelayMessage(upsert([], { phase: 'z9' }))?.kind).toBe('invalid');
    expect(
      parseDealRelayMessage(upsert(Array.from({ length: 13 }, (_, i) => deal(`zz-${i}`))))?.kind,
    ).toBe('invalid');
  });

  it('reads auto-linked names and websites back as the text the routine wrote', () => {
    const parsed = parseDealRelayMessage(
      upsert([
        deal('zz-zeta', {
          name: '<http://Zeta.example|Zeta.example>',
          summary: 'An invented tool, see <http://zeta.example|zeta.example>',
        }),
      ]),
    );
    if (parsed?.kind !== 'upsert') throw new Error('expected an upsert');
    expect(parsed.deals[0]?.name).toBe('Zeta.example');
    expect(parsed.deals[0]?.summary).toBe('An invented tool, see zeta.example');
  });

  it('keeps a deal and drops only the field that is wrong', () => {
    const parsed = parseDealRelayMessage(
      upsert([
        deal('zz-kept', {
          stage: 'diligence',
          evidence_date: '2026-09-05',
          threads: [{ id: 'thread-f:17' }, { id: '19a8f3c2b7e4d1a0', subject: 'Intro' }],
          founders: [{ name: 'Ana Zed', title: 'x'.repeat(101) }, { name: 'Bo Yin' }],
        }),
        deal('zz-no-date', { stage: 'diligence', evidence_date: '2026-02-30' }),
        { ...deal('zz-bad'), name: 'x'.repeat(201) },
      ]),
    );
    if (parsed?.kind !== 'upsert') throw new Error('expected an upsert');
    expect(parsed.deals.map((d) => d.key)).toEqual(['zz-kept', 'zz-no-date']);
    const kept = parsed.deals[0]!;
    expect(kept.stage).toBe('diligence');
    expect(kept.threads).toEqual([{ id: '19a8f3c2b7e4d1a0', subject: 'Intro' }]);
    expect(kept.founders).toEqual([{ name: 'Bo Yin' }]);
    // A stage never stands without a valid evidence date: both go.
    expect(parsed.deals[1]).not.toHaveProperty('stage');
    expect(parsed.deals[1]).not.toHaveProperty('evidence_date');
    expect(parsed.rejects).toEqual([{ path: 'name', message: expect.any(String) }]);
    expect(parsed.dropped.map((d) => d.path)).toEqual(
      expect.arrayContaining(['threads.0.id', 'founders.0.title', 'evidence_date']),
    );
  });

  it('refuses an oversize message, and never recurses into deep nesting', () => {
    const long = upsert([deal('zz-long', { summary: 'x'.repeat(200) })]).padEnd(
      MAX_MESSAGE_CHARS + 10,
      ' ',
    );
    expect(parseDealRelayMessage(`${long}x`)).toEqual({
      kind: 'invalid',
      reason: 'message too long',
    });
    const deep = '['.repeat(3000) + ']'.repeat(3000);
    const text = upsert([deal('zz-deep')]).replace(
      '"source":"ZZ Angel Feed"',
      `"founders":${deep}`,
    );
    const parsed = parseDealRelayMessage(text);
    if (parsed?.kind !== 'upsert') throw new Error('expected an upsert');
    expect(parsed.deals.map((d) => d.key)).toEqual(['zz-deep']);
    expect(parsed.deals[0]?.founders ?? []).toEqual([]);
  });

  it('accepts a website Slack has wrapped in link markup', () => {
    const parsed = parseDealRelayMessage(
      upsert([deal('zz-quill', { website: '<http://zzquill.example|zzquill.example>' })]),
    );
    if (parsed?.kind !== 'upsert') throw new Error('expected an upsert');
    expect(parsed.deals[0]?.website).toBe('zzquill.example');
  });

  it('keeps the five good deals when the sixth is invalid, and records only path and message', () => {
    const deals = [
      deal('zz-a'),
      deal('zz-b'),
      { ...deal('zz-c'), key: 'ZZ Bad Key' },
      deal('zz-d'),
      deal('zz-e'),
      deal('zz-f'),
    ];
    const parsed = parseDealRelayMessage(upsert(deals));
    if (parsed?.kind !== 'upsert') throw new Error('expected an upsert');
    expect(parsed.deals.map((d) => d.key)).toEqual(['zz-a', 'zz-b', 'zz-d', 'zz-e', 'zz-f']);
    expect(parsed.rejects).toEqual([{ path: 'key', message: 'must be a lowercase slug' }]);
    expect(JSON.stringify(parsed.rejects)).not.toContain('ZZ Bad Key');
  });

  it('strips fields the schema has no slot for', () => {
    const parsed = parseDealRelayMessage(
      upsert([
        deal('zz-quill', {
          founder_email: 'jane@zzquill.example',
          valuation: '$20M post',
          check_size: '$100K',
        }),
      ]),
    );
    if (parsed?.kind !== 'upsert') throw new Error('expected an upsert');
    expect(Object.keys(parsed.deals[0] ?? {})).not.toEqual(
      expect.arrayContaining(['founder_email', 'valuation', 'check_size']),
    );
  });

  it('treats null and empty strings as absent', () => {
    const parsed = parseDealRelayMessage(
      upsert([deal('zz-quill', { summary: '', round: null, website: null, aka: null })]),
    );
    if (parsed?.kind !== 'upsert') throw new Error('expected an upsert');
    expect(parsed.rejects).toEqual([]);
    expect(parsed.deals[0]).not.toHaveProperty('summary');
    expect(parsed.deals[0]).not.toHaveProperty('website');
  });

  it('parses the heartbeat leniently', () => {
    const text = [
      'DEAL_SORTER_RUN_V1',
      TICK +
        JSON.stringify({
          v: 1,
          source: 'deal-sorter',
          run_at: '2026-09-23T09:58Z',
          phase: 'a1',
          as_of: '2026-09-23',
          backfill_done: ['a1'],
          attempts: { a1: 1 },
          posted: 'lots',
          stages: { new: 3 },
        }) +
        TICK,
    ].join('\n');
    const parsed = parseDealRelayMessage(text);
    expect(parsed?.kind).toBe('heartbeat');
    if (parsed?.kind !== 'heartbeat') return;
    expect(parsed.heartbeat.backfill_done).toEqual(['a1']);
    expect(parsed.heartbeat.posted).toBe(0);
    expect(parsed.heartbeat.near_misses).toBe(0);
    expect(parsed.heartbeat.stages).toEqual({ new: 3 });
  });
});

describe('the per-deal schema', () => {
  const ok = (value: Record<string, unknown>) =>
    RELAY_DEAL_SCHEMA.safeParse({ key: 'zz-quill', name: 'ZZ Quill', ...value }).success;

  it('accepts only lowercase slug keys up to 80 characters', () => {
    for (const key of ['zz-quill', '3d-print', 'a']) expect(ok({ key })).toBe(true);
    for (const key of ['ZZ-Quill', 'zz--quill', '-zz', 'zz-', 'zz quill', 'a'.repeat(81)]) {
      expect(ok({ key })).toBe(false);
    }
  });

  it('rejects oversize fields', () => {
    expect(ok({ name: 'x'.repeat(200) })).toBe(true);
    expect(ok({ name: 'x'.repeat(201) })).toBe(false);
    expect(ok({ summary: 'x'.repeat(301) })).toBe(false);
    expect(ok({ aka: ['a', 'b', 'c', 'd', 'e', 'f'] })).toBe(false);
    expect(ok({ founders: Array.from({ length: 7 }, (_, i) => ({ name: `F${i}` })) })).toBe(false);
    expect(ok({ threads: Array.from({ length: 6 }, (_, i) => ({ id: `abcdef012${i}` })) })).toBe(
      false,
    );
  });

  it('requires an evidence date with a stage, and a real date', () => {
    expect(ok({ stage: 'diligence' })).toBe(false);
    expect(ok({ stage: 'diligence', evidence_date: '2026-09-01' })).toBe(true);
    expect(ok({ stage: 'diligence', evidence_date: '2026-02-30' })).toBe(false);
    expect(ok({ stage: 'somewhere', evidence_date: '2026-09-01' })).toBe(false);
  });

  it('checks thread ids and websites', () => {
    expect(ok({ threads: [{ id: '19a8f3c2b7e4d1a0' }] })).toBe(true);
    expect(ok({ threads: [{ id: 'not-a-thread' }] })).toBe(false);
    expect(ok({ website: 'zzquill.example' })).toBe(true);
    expect(ok({ website: 'not a website' })).toBe(false);
    // An address, or a real host hidden after an @, is not a website.
    expect(ok({ website: 'jane@zz-a.example' })).toBe(false);
    expect(ok({ website: 'good.example@evil.example' })).toBe(false);
  });

  it('replaces email addresses in free text, and amounts where TipTop acts', () => {
    const parsed = RELAY_DEAL_SCHEMA.parse({
      key: 'zz-quill',
      name: 'ZZ Quill',
      stage: 'ic_review',
      evidence_date: '2026-09-03',
      evidence: 'Sep 3: partner approved the $150K wire; cc ops@zz-fund.example',
      next_step: 'Confirm USD 25,000 allocation',
      pass_reason: 'valuation of 40M USD too high',
      summary: 'Invented CPQ tool; reach jane@zzquill.example',
      raise: '$2M seed',
    });
    expect(parsed.evidence).toBe('Sep 3: partner approved the [amount] wire; cc [email removed]');
    expect(parsed.next_step).toBe('Confirm [amount] allocation');
    expect(parsed.pass_reason).toBe('valuation of [amount] too high');
    expect(parsed.summary).toBe('Invented CPQ tool; reach [email removed]');
    // The round size the founder states is the one amount a deal carries.
    expect(parsed.raise).toBe('$2M seed');
  });
});

describe('dates', () => {
  it('clamps every posted date to the day of the post', () => {
    const clamped = clampDates(
      {
        key: 'zz-quill',
        name: 'ZZ Quill',
        stage: 'founder_meeting',
        evidence_date: '2026-10-02',
        first_seen: '2026-09-01',
        last_activity: '2026-10-02',
        threads: [{ id: '19a8f3c2b7e4d1a0', date: '2026-10-01' }, { id: '19a8f3c2b7e4d1a1' }],
      } as RelayDeal,
      '2026-09-23',
    );
    expect(clamped.evidence_date).toBe('2026-09-23');
    expect(clamped.first_seen).toBe('2026-09-01');
    expect(clamped.last_activity).toBe('2026-09-23');
    expect(clamped.threads).toEqual([
      { id: '19a8f3c2b7e4d1a0', date: '2026-09-23' },
      { id: '19a8f3c2b7e4d1a1' },
    ]);
  });
});

describe('collectRelayMessages', () => {
  const msg = (ts: string, text: string, extra: Record<string, unknown> = {}) => ({
    ts,
    text,
    user: 'U0ROUTINE1',
    ...extra,
  });

  it('skips messages with a subtype and, when configured, other posters', () => {
    const messages = [
      msg('1790000003.000100', upsert([deal('zz-c')])),
      msg('1790000002.000100', upsert([deal('zz-b')]), { user: 'U0SOMEONE9' }),
      msg('1790000001.000100', upsert([deal('zz-a')]), { subtype: 'channel_join' }),
    ];
    expect(collectRelayMessages(messages).observations.map((o) => o.deal.key)).toEqual([
      'zz-b',
      'zz-c',
    ]);
    expect(
      collectRelayMessages(messages, ['U0ROUTINE1']).observations.map((o) => o.deal.key),
    ).toEqual(['zz-c']);
  });

  it('orders observations oldest first and keeps the newest heartbeat', () => {
    const beat = (phase: string) =>
      ['DEAL_SORTER_RUN_V1', TICK + JSON.stringify({ phase, backfill_done: [] }) + TICK].join('\n');
    const collected = collectRelayMessages([
      msg('1790000040.000000', beat('a2')),
      msg('1790000030.000000', upsert([deal('zz-late')])),
      msg('1790000020.000000', beat('a1')),
      msg('1790000010.000000', upsert([deal('zz-early')])),
      msg('1790000005.000000', 'DEAL_UPSERT_V1 broken'),
    ]);
    expect(collected.observations.map((o) => o.deal.key)).toEqual(['zz-early', 'zz-late']);
    expect(collected.observations[0]!.seq).toBeLessThan(collected.observations[1]!.seq);
    expect(collected.lastRun?.heartbeat.phase).toBe('a2');
    expect(collected.lastRun?.ts).toBe(new Date(1790000040 * 1000).toISOString());
    expect(collected.rejected.total).toBe(1);
    expect(collected.rejected.byIssue).toEqual({ 'message: no backticked body': 1 });
  });

  it('clamps future dates to the post day, and counts dropped fields apart from rejects', () => {
    const ts = String(Date.parse('2026-09-23T09:55:00Z') / 1000);
    const collected = collectRelayMessages([
      msg(
        ts,
        upsert([
          deal('zz-soon', {
            stage: 'founder_meeting',
            evidence_date: '2026-10-02',
            threads: [{ id: 'nope' }],
          }),
        ]),
      ),
    ]);
    expect(collected.observations[0]?.deal.evidence_date).toBe('2026-09-23');
    expect(collected.rejected.total).toBe(0);
    expect(collected.rejected.dropped).toBe(1);
    expect(Object.keys(collected.rejected.byIssue)).toEqual([
      'dropped threads.0.id: must be a Gmail thread id',
    ]);
  });
});
