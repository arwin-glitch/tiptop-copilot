import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import {
  HARMONIC_DAILY_LIMIT,
  harmonicCallTool,
  harmonicConnectFinish,
  harmonicConnectStart,
  harmonicDetail,
  harmonicLookup,
  harmonicQuota,
  parseHarmonicDetail,
  resetHarmonicMcpState,
} from '@/lib/integrations/harmonic-mcp';
import { cardFromHarmonic } from '@/lib/services/search-preview';

/**
 * Harmonic details for the Ctrl+K hover preview, and Kraken's own daily cap
 * on Harmonic calls. Harmonic is a fake; every name, id and URL is fictional.
 */

const REDIRECT = 'https://kraken.example.test/api/integrations/harmonic/callback';

const COMPANY_JSON = JSON.stringify({
  companies: [
    {
      entity_urn: 'urn:harmonic:company:7700001',
      name: 'Brightlane',
      description: 'Payments and scheduling for small clinics.',
      short_description: 'Clinic payments',
      headcount: 42,
      website: { url: 'https://www.brightlane.example', domain: 'brightlane.example' },
      location: { city: 'Austin', state: 'Texas', country: 'United States' },
      funding: { funding_total: 12500000, funding_stage: 'SERIES_A' },
      socials: { LINKEDIN: { url: 'https://www.linkedin.com/company/brightlane-example' } },
    },
  ],
});

const PERSON_JSON = `answer: ${JSON.stringify(
  JSON.stringify([
    {
      full_name: 'Rena Voss',
      location: { location: 'Denver, Colorado' },
      experience: [
        { title: 'Analyst', company_name: 'Old Co Example', is_current_position: false },
        { title: 'Managing Partner', company_name: 'Example Capital', is_current_position: true },
      ],
      socials: { LINKEDIN: { url: 'https://www.linkedin.com/in/rena-voss-example' } },
    },
  ]),
)}`;

const PERSON_MARKDOWN = [
  '## Rena Voss (urn:harmonic:person:4100001)',
  '- **Title:** Managing Partner',
  '- **Company:** Example Capital',
  '- **Location:** Denver, Colorado',
  '- **LinkedIn:** https://www.linkedin.com/in/rena-voss-example',
  '- **Website:** javascript:alert(1)',
].join('\n');

let toolText: string;
let toolError: string | null;
let toolCalls: number;

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function fakeFetch() {
  return vi.fn(async (url: string, init: RequestInit) => {
    const body = typeof init.body === 'string' ? init.body : String(init.body ?? '');
    if (url.endsWith('/register')) {
      return json({ client_id: 'client-fake-1', client_secret: 'secret-fake-1' }, 201);
    }
    if (url.endsWith('/token')) {
      return json({ access_token: 'access-fake', refresh_token: 'refresh-fake', expires_in: 3600 });
    }
    if (url === 'https://mcp.api.harmonic.ai/') {
      const rpc = JSON.parse(body) as { id?: number; method: string };
      if (rpc.method === 'initialize') {
        return json({ jsonrpc: '2.0', id: rpc.id, result: {} }, 200, {
          'mcp-session-id': 'session-fake-1',
        });
      }
      if (rpc.method === 'notifications/initialized') return new Response(null, { status: 202 });
      toolCalls += 1;
      return json({
        jsonrpc: '2.0',
        id: rpc.id,
        result: toolError
          ? { content: [{ type: 'text', text: toolError }], isError: true }
          : { content: [{ type: 'text', text: toolText }] },
      });
    }
    return new Response('not found', { status: 404 });
  });
}

let h: Harness;

async function connect() {
  const start = await harmonicConnectStart(h.store, h.auth, REDIRECT);
  if (!start.ok) throw new Error(start.error.message);
  const state = new URL(start.value.url).searchParams.get('state') as string;
  const finish = await harmonicConnectFinish(h.store, h.auth, {
    code: 'code-fake',
    state,
    cookieValue: start.value.cookieValue,
    redirectUri: REDIRECT,
  });
  if (!finish.ok) throw new Error(finish.error.message);
}

beforeEach(async () => {
  h = await createHarness();
  resetHarmonicMcpState();
  toolText = COMPANY_JSON;
  toolError = null;
  toolCalls = 0;
  vi.stubGlobal('fetch', fakeFetch());
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await h.dispose();
});

describe('parseHarmonicDetail', () => {
  it('reads a company out of JSON', () => {
    const d = parseHarmonicDetail('company', '7700001', COMPANY_JSON);
    expect(d.name).toBe('Brightlane');
    expect(d.domain).toBe('brightlane.example');
    expect(d.website).toBe('https://www.brightlane.example/');
    expect(d.headcount).toBe(42);
    expect(d.location).toBe('Austin, Texas, United States');
    expect(d.fundingTotal).toBe('$12.5M');
    expect(d.stage).toBe('SERIES_A');
    expect(d.linkedin).toBe('https://www.linkedin.com/company/brightlane-example');
  });

  it('reads a person out of an answer-wrapped JSON string, current role first', () => {
    const d = parseHarmonicDetail('person', '4100001', PERSON_JSON);
    expect(d.name).toBe('Rena Voss');
    expect(d.title).toBe('Managing Partner');
    expect(d.company).toBe('Example Capital');
    expect(d.headline).toBe('Managing Partner at Example Capital');
    expect(d.location).toBe('Denver, Colorado');
  });

  it('falls back to markdown fields and drops non-http links', () => {
    const d = parseHarmonicDetail('person', '4100001', PERSON_MARKDOWN);
    expect(d.name).toBe('Rena Voss');
    expect(d.title).toBe('Managing Partner');
    expect(d.company).toBe('Example Capital');
    expect(d.linkedin).toBe('https://www.linkedin.com/in/rena-voss-example');
    expect(d.website).toBeNull();
  });

  it('never throws on junk', () => {
    for (const junk of ['', '{not json', '[[[', 'answer: "', '\u0000']) {
      expect(parseHarmonicDetail('company', '1', junk).name).toBeNull();
    }
  });

  it('becomes a preview card with safe links only', () => {
    const card = cardFromHarmonic(
      parseHarmonicDetail('company', '7700001', COMPANY_JSON),
      'harmonic_company',
    );
    expect(card.source).toBe('harmonic');
    expect(card.logoDomain).toBe('brightlane.example');
    expect(card.openHref).toBe('/network/harmonic?kind=company&id=7700001');
    expect(card.facts.find((f) => f.label === 'Headcount')?.value).toBe('42');
    for (const l of card.links) expect(l.href).toMatch(/^(https?:\/\/|\/[^/])/);
  });
});

describe('harmonicDetail', () => {
  it('calls get_companies once and serves the cache after, without spending quota', async () => {
    await connect();
    const first = await harmonicDetail(h.store, h.auth.organizationId, 'company', '7700001');
    expect(first.ok && first.value.name).toBe('Brightlane');
    expect(toolCalls).toBe(1);
    expect(harmonicQuota(h.auth.organizationId).used).toBe(1);
    const [second, third] = await Promise.all([
      harmonicDetail(h.store, h.auth.organizationId, 'company', '7700001'),
      harmonicDetail(h.store, h.auth.organizationId, 'company', '7700001'),
    ]);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(toolCalls).toBe(1);
    expect(harmonicQuota(h.auth.organizationId).used).toBe(1);
  });

  it('refuses an id that is not digits without calling Harmonic', async () => {
    await connect();
    const res = await harmonicDetail(h.store, h.auth.organizationId, 'person', '12a');
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.code).toBe('invalid_input');
    expect(toolCalls).toBe(0);
  });
});

describe('daily quota', () => {
  it('stops calling Harmonic at the limit and resets the next UTC day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-10T12:00:00Z'));
    await connect();
    const org = h.auth.organizationId;
    expect(harmonicQuota(org)).toEqual({ used: 0, limit: 95, remaining: 95 });
    for (let i = 0; i < HARMONIC_DAILY_LIMIT; i += 1) {
      const res = await harmonicCallTool(h.store, org, 'entity_lookup', { query: `q${i}` });
      expect(res.ok).toBe(true);
    }
    expect(toolCalls).toBe(HARMONIC_DAILY_LIMIT);
    expect(harmonicQuota(org).remaining).toBe(0);

    const blocked = await harmonicLookup(h.store, org, 'one more');
    expect(!blocked.ok && blocked.error.code).toBe('rate_limited');
    expect(toolCalls).toBe(HARMONIC_DAILY_LIMIT);

    vi.setSystemTime(new Date('2026-03-11T00:00:05Z'));
    expect(harmonicQuota(org).remaining).toBe(95);
    const fresh = await harmonicCallTool(h.store, org, 'entity_lookup', { query: 'next day' });
    expect(fresh.ok).toBe(true);
    expect(toolCalls).toBe(HARMONIC_DAILY_LIMIT + 1);
  });

  it('spends the rest of the day when Harmonic says its own quota is gone', async () => {
    await connect();
    const org = h.auth.organizationId;
    toolError = 'Daily rate limit exceeded for this user.';
    const res = await harmonicCallTool(h.store, org, 'entity_lookup', { query: 'x' });
    expect(!res.ok && res.error.code).toBe('rate_limited');
    expect(harmonicQuota(org).remaining).toBe(0);
    toolError = null;
    const after = await harmonicCallTool(h.store, org, 'entity_lookup', { query: 'y' });
    expect(!after.ok && after.error.code).toBe('rate_limited');
    expect(toolCalls).toBe(1);
  });

  it('does not count when Harmonic is not connected', async () => {
    const res = await harmonicCallTool(h.store, h.auth.organizationId, 'entity_lookup', {
      query: 'x',
    });
    expect(!res.ok && res.error.code).toBe('not_configured');
    expect(harmonicQuota(h.auth.organizationId).used).toBe(0);
  });
});
