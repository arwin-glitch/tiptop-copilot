import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import {
  harmonicCallTool,
  harmonicConnectFinish,
  harmonicConnectStart,
  harmonicConnection,
  harmonicDisconnect,
  harmonicLookup,
  parseEntityLookup,
  resetHarmonicMcpState,
} from '@/lib/integrations/harmonic-mcp';

/**
 * Harmonic over MCP: OAuth connect, the MCP handshake and the entity_lookup
 * parser. Harmonic is a fake here; every name, id and token is fictional.
 */

const REDIRECT = 'https://kraken.example.test/api/integrations/harmonic/callback';
const BEST =
  'answer: "**Best match**\\n- **Rena Voss** (urn:harmonic:person:4100001) — Co-Founder and Managing Partner at Example Capital\\n  LinkedIn: https://www.linkedin.com/in/rena-voss-example"';
const WITH_ALTERNATIVES = [
  '**Best match**',
  '- **Brightlane** (urn:harmonic:company:7700001) — Payments for small clinics',
  '  Website: https://brightlane.example',
  '',
  '**Alternatives**',
  '- **Brightlane Labs** (urn:harmonic:company:7700002) — Robotics',
  '  LinkedIn: https://www.linkedin.com/company/brightlane-labs-example',
  '- **Bright Lane Fund** (urn:harmonic:investor:9900003)',
].join('\n');

interface Call {
  url: string;
  method: string;
  auth: string | null;
  session: string | null;
  body: string;
}

let calls: Call[];
let toolText: string;
let sse: boolean;
let mcp401Once: boolean;
let accessIssued: number;

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function fakeFetch() {
  return vi.fn(async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? init.body : String(init.body ?? '');
    calls.push({
      url,
      method: init.method ?? 'GET',
      auth: headers.get('authorization'),
      session: headers.get('mcp-session-id'),
      body,
    });
    if (url.endsWith('/register')) {
      return json({ client_id: 'client-fake-1', client_secret: 'secret-fake-1' }, 201);
    }
    if (url.endsWith('/token')) {
      accessIssued += 1;
      return json({
        access_token: `access-fake-${accessIssued}`,
        refresh_token: `refresh-fake-${accessIssued}`,
        expires_in: 3600,
      });
    }
    if (url === 'https://mcp.api.harmonic.ai/') {
      if (mcp401Once) {
        mcp401Once = false;
        return new Response('unauthorized', { status: 401 });
      }
      const rpc = JSON.parse(body) as { id?: number; method: string };
      if (rpc.method === 'initialize') {
        return json(
          { jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-06-18' } },
          200,
          { 'mcp-session-id': 'session-fake-1' },
        );
      }
      if (rpc.method === 'notifications/initialized') return new Response(null, { status: 202 });
      const result = {
        jsonrpc: '2.0',
        id: rpc.id,
        result: { content: [{ type: 'text', text: toolText }] },
      };
      if (sse) {
        return new Response(`event: message\ndata: ${JSON.stringify(result)}\n\n`, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return json(result);
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
  return { start: start.value, state, finish };
}

beforeEach(async () => {
  h = await createHarness();
  resetHarmonicMcpState();
  calls = [];
  toolText = BEST;
  sse = false;
  mcp401Once = false;
  accessIssued = 0;
  vi.stubGlobal('fetch', fakeFetch());
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await h.dispose();
});

describe('parseEntityLookup', () => {
  it('reads the best match out of the answer wrapper', () => {
    expect(parseEntityLookup(BEST)).toEqual([
      {
        urn: 'urn:harmonic:person:4100001',
        kind: 'person',
        id: '4100001',
        name: 'Rena Voss',
        headline: 'Co-Founder and Managing Partner at Example Capital',
        linkedin: 'https://www.linkedin.com/in/rena-voss-example',
        website: null,
      },
    ]);
  });

  it('keeps the best match first, then alternatives, with their links', () => {
    const hits = parseEntityLookup(WITH_ALTERNATIVES);
    expect(hits.map((x) => [x.kind, x.name])).toEqual([
      ['company', 'Brightlane'],
      ['company', 'Brightlane Labs'],
      ['investor', 'Bright Lane Fund'],
    ]);
    expect(hits[0]?.website).toBe('https://brightlane.example');
    expect(hits[1]?.linkedin).toBe('https://www.linkedin.com/company/brightlane-labs-example');
    expect(hits[2]?.headline).toBeNull();
  });

  it('returns nothing for text without entries', () => {
    expect(parseEntityLookup('answer: "No match found."')).toEqual([]);
    expect(parseEntityLookup('')).toEqual([]);
  });
});

describe('connect', () => {
  it('registers, exchanges the code and stores sealed tokens only', async () => {
    const { start, finish } = await connect();
    expect(finish.ok).toBe(true);
    const url = new URL(start.url);
    expect(url.origin + url.pathname).toBe('https://login.harmonic.ai/oauth2/authorize');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('resource')).toBe('https://mcp.api.harmonic.ai/');
    expect(start.cookieValue).not.toContain('secret-fake-1');

    const token = calls.find((c) => c.url.endsWith('/token'));
    expect(token?.body).toContain('code_verifier=');
    expect(token?.body).toContain('client_secret=secret-fake-1');

    const rows = await h.store.list('harmonic_connections', h.auth.organizationId);
    expect(rows).toHaveLength(1);
    const raw = JSON.stringify(rows[0]);
    expect(raw).not.toContain('access-fake-1');
    expect(raw).not.toContain('refresh-fake-1');
    expect(raw).not.toContain('secret-fake-1');
    expect(rows[0]?.client_id).toBe('client-fake-1');

    const status = await harmonicConnection(h.store, h.auth.organizationId);
    expect(status.connected).toBe(true);
    expect(status.connectedBy).toBe(h.auth.userId);

    await harmonicDisconnect(h.store, h.auth.organizationId);
    expect((await harmonicConnection(h.store, h.auth.organizationId)).connected).toBe(false);
  });

  it('refuses a state that does not match the cookie', async () => {
    const start = await harmonicConnectStart(h.store, h.auth, REDIRECT);
    if (!start.ok) throw new Error('start failed');
    const result = await harmonicConnectFinish(h.store, h.auth, {
      code: 'code-fake',
      state: 'some-other-state',
      cookieValue: start.value.cookieValue,
      redirectUri: REDIRECT,
    });
    expect(result.ok).toBe(false);
    expect(calls.some((c) => c.url.endsWith('/token'))).toBe(false);
    expect((await harmonicConnection(h.store, h.auth.organizationId)).connected).toBe(false);
  });

  it('says not connected before anyone connects', async () => {
    const result = await harmonicCallTool(h.store, h.auth.organizationId, 'entity_lookup', {
      query: 'x',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.reason).toBe('not_connected');
  });
});

describe('tool calls', () => {
  it('runs the handshake and reads an SSE answer', async () => {
    await connect();
    calls = [];
    sse = true;
    const result = await harmonicCallTool(h.store, h.auth.organizationId, 'entity_lookup', {
      query: 'Rena Voss',
    });
    expect(result).toEqual({ ok: true, value: BEST });
    const methods = calls.map((c) => (JSON.parse(c.body) as { method: string }).method);
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/call']);
    expect(calls[0]?.auth).toBe('Bearer access-fake-1');
    expect(calls[2]?.session).toBe('session-fake-1');
  });

  it('refreshes once on a 401 and retries', async () => {
    await connect();
    calls = [];
    mcp401Once = true;
    const result = await harmonicCallTool(h.store, h.auth.organizationId, 'entity_lookup', {
      query: 'Rena Voss',
    });
    expect(result.ok).toBe(true);
    const refresh = calls.find((c) => c.url.endsWith('/token'));
    expect(refresh?.body).toContain('grant_type=refresh_token');
    expect(refresh?.body).toContain('refresh_token=refresh-fake-1');
    expect(calls.at(-1)?.auth).toBe('Bearer access-fake-2');
    const rows = await h.store.list('harmonic_connections', h.auth.organizationId);
    expect(JSON.stringify(rows[0])).not.toContain('access-fake-2');
  });

  it('caches lookups per organization and query', async () => {
    await connect();
    calls = [];
    const first = await harmonicLookup(h.store, h.auth.organizationId, 'Rena Voss');
    expect(first.ok && first.value[0]?.name).toBe('Rena Voss');
    const count = calls.length;
    const second = await harmonicLookup(h.store, h.auth.organizationId, '  rena voss ');
    expect(second).toEqual(first);
    expect(calls.length).toBe(count);
  });
});
