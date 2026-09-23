import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createHarness, type Harness } from '../helpers/harness';
import { resetEnvCache } from '@/lib/config/env';
import { resetDealPullState } from '@/lib/services/deal-relay';
import { POST as cron } from '@/app/api/cron/daily/route';

/**
 * The daily job's deals step. Its JSON response is printed into the public
 * repository's Actions log, so the one property that matters most is that it
 * carries counts and never a company name. Every name here is invented.
 */

const TICK = String.fromCharCode(96);
const SECRET = 'cron-secret-for-tests-000000000000';
const SAVED = { ...process.env };
let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
  process.env.CRON_SECRET = SECRET;
  process.env.ASK_RELAY_SLACK_TOKEN = 'xoxb-test';
  resetEnvCache();
  resetDealPullState();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await harness.dispose();
  for (const key of Object.keys(process.env)) {
    if (!(key in SAVED)) delete process.env[key];
  }
  Object.assign(process.env, SAVED);
  resetEnvCache();
  resetDealPullState();
});

const NAMES = ['ZZ Cron Alpha', 'ZZ Cron Beta', 'ZZ Cron Gamma'];

function relayPage(): Response {
  const deals = NAMES.map((name, i) => ({
    key: name.toLowerCase().replace(/ /g, '-'),
    name,
    fit: 'possible',
    source: 'ZZ Angel Feed',
    ...(i === 0
      ? { stage: 'diligence', evidence_date: '2026-09-10', evidence: `${name} data room` }
      : {}),
  }));
  const body = { v: 1, source: 'deal-sorter', batch: 'b', phase: 'inc', part: 1, parts: 1, deals };
  const messages = [
    {
      ts: '1790000100.000100',
      user: 'U0ROUTINE1',
      text: `DEAL_UPSERT_V1\n${TICK}${JSON.stringify(body)}${TICK}`,
    },
  ];
  return new Response(JSON.stringify({ ok: true, messages }));
}

function call() {
  return cron(
    new NextRequest('https://tiptop-copilot.onrender.com/api/cron/daily?tasks=sync', {
      method: 'POST',
      headers: { authorization: `Bearer ${SECRET}` },
    }),
  );
}

describe('the daily job and the deal relay', () => {
  it('reports the deals pull as counts only, never a company name', async () => {
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('conversations.history') && url.includes('C0C40TVD4DP')) return relayPage();
      return new Response(JSON.stringify({ ok: true, messages: [] }));
    }) as typeof fetch);

    const response = await call();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { results: { deals: string }[] };
    const deals = body.results[0]?.deals ?? '';
    expect(deals).toMatch(/^ok: 3 created, 0 moved, 0 suggested, 0 rejected/);
    const text = JSON.stringify(body);
    for (const name of [...NAMES, 'data room', 'Ledgerly', 'Stonebridge']) {
      expect(text).not.toContain(name);
    }
  });

  it('says why it skipped when Slack refuses, still without names', async () => {
    vi.stubGlobal(
      'fetch',
      (async () =>
        new Response(JSON.stringify({ ok: false, error: 'not_in_channel' }))) as typeof fetch,
    );
    const body = (await (await call()).json()) as { results: { deals: string }[] };
    expect(body.results[0]?.deals).toMatch(/^skipped: bot_not_in_channel/);
  });
});
