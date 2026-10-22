import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addSecondOrganization, createHarness, type Harness } from '../helpers/harness';
import { DELETE, GET, POST } from '@/app/api/mcp/route';
import { POST as postWithPathToken } from '@/app/api/mcp/[token]/route';
import type { DataStore } from '@/lib/db/store';
import {
  MCP_AUTH_FAILURES_PER_MINUTE,
  MCP_RATE_PER_MINUTE,
  resetMcpLimiters,
} from '@/lib/mcp/http';
import { setStoreForTesting } from '@/lib/runtime';
import {
  authenticateMcpToken,
  createMcpToken,
  hashMcpToken,
  listMcpTokens,
  MCP_TOKEN_LIMIT,
  mintMcpToken,
  parseMcpToken,
  revokeMcpToken,
} from '@/lib/services/mcp-tokens';
import type { AuditEvent, McpToken } from '@/lib/types/domain';

/**
 * The MCP endpoint end to end through its route handlers, on the demo store:
 * token auth (header and path, missing, invalid, revoked, a table that does not
 * exist yet), the abuse brakes, the HTTP framing of JSON-RPC, the audit trail,
 * and tenancy. The tools' answers are covered in mcp-tools.test.ts.
 */

let harness: Harness;
let token: string;
let tokenId: string;
let address = 0;
let ip: string;

beforeEach(async () => {
  harness = await createHarness();
  resetMcpLimiters();
  ip = `203.0.113.${++address}`;
  const created = await createMcpToken(
    harness.store,
    harness.auth.organizationId,
    { userId: harness.auth.userId },
    'Test client',
  );
  if (!created.ok) throw new Error(created.error.message);
  token = created.value.token;
  tokenId = created.value.summary.id;
});

afterEach(async () => {
  await harness.dispose();
  vi.unstubAllEnvs();
});

function request(
  body: unknown,
  options: { bearer?: string | null; headers?: Record<string, string>; raw?: string } = {},
): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'x-forwarded-for': ip,
    ...options.headers,
  };
  if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
  return new Request('https://copilot.example/api/mcp', {
    method: 'POST',
    headers,
    body: options.raw ?? JSON.stringify(body),
  });
}

const ping = (id: number | string = 1) => ({ jsonrpc: '2.0', id, method: 'ping' });

async function audits(): Promise<AuditEvent[]> {
  return (await harness.store.list('audit_events', harness.auth.organizationId, {
    eq: { action: 'mcp.tool_called' },
  })) as AuditEvent[];
}

describe('token shape and storage', () => {
  it('mints a token naming the organization, and stores only its hash', async () => {
    expect(parseMcpToken(token)).toEqual({ organizationId: harness.auth.organizationId });
    const rows = (await harness.store.list(
      'mcp_tokens',
      harness.auth.organizationId,
      {},
    )) as McpToken[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).toBe(hashMcpToken(token));
    expect(JSON.stringify(rows)).not.toContain(token.slice(6));
    expect(rows[0]?.hint).toBe(token.slice(-4));
  });

  it('never lists the hash, and never audits the token', async () => {
    const listed = await listMcpTokens(harness.store, harness.auth.organizationId);
    expect(listed.ok && listed.value[0]).toMatchObject({ name: 'Test client', revoked_at: null });
    expect(JSON.stringify(listed)).not.toContain(hashMcpToken(token));
    const events = await harness.store.list('audit_events', harness.auth.organizationId, {
      eq: { action: 'mcp.token_created' },
    });
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(token.slice(6));
  });

  it('refuses a blank or long name, and a token past the limit', async () => {
    const org = harness.auth.organizationId;
    const blank = await createMcpToken(harness.store, org, { userId: null }, '   ');
    expect(blank.ok ? null : blank.error.code).toBe('invalid_input');
    const long = await createMcpToken(harness.store, org, { userId: null }, 'x'.repeat(81));
    expect(long.ok ? null : long.error.code).toBe('invalid_input');
    for (let i = 1; i < MCP_TOKEN_LIMIT; i++) {
      const more = await createMcpToken(harness.store, org, { userId: null }, `Client ${i}`);
      expect(more.ok).toBe(true);
    }
    const over = await createMcpToken(harness.store, org, { userId: null }, 'One too many');
    expect(over.ok ? null : over.error.code).toBe('conflict');
  });

  it('rejects malformed tokens before touching the store', async () => {
    for (const bad of ['', 'tcmcp_', 'Bearer x', `${token}x`, token.replace('tcmcp_', 'tcmcq_')]) {
      const result = await authenticateMcpToken(harness.store, bad);
      expect(result.ok ? null : result.error.code).toBe('unauthenticated');
    }
  });
});

describe('authentication', () => {
  it('accepts the token as a Bearer header', async () => {
    const response = await POST(request(ping(), { bearer: token }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ jsonrpc: '2.0', id: 1, result: {} });
  });

  it('accepts the token as the URL path segment (claude.ai custom connectors)', async () => {
    const response = await postWithPathToken(request(ping()), {
      params: Promise.resolve({ token }),
    });
    expect(response.status).toBe(200);
  });

  it('refuses a request with no token, saying how to send one', async () => {
    const response = await POST(request(ping()));
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toMatch(/^Bearer/);
    const body = (await response.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toMatch(/Authorization: Bearer/);
  });

  it('refuses a well-formed token that was never issued', async () => {
    const forged = mintMcpToken(harness.auth.organizationId);
    const response = await POST(request(ping(), { bearer: forged }));
    expect(response.status).toBe(401);
  });

  it('refuses a token whose last character differs (no prefix match)', async () => {
    const near = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    expect((await POST(request(ping(), { bearer: near }))).status).toBe(401);
  });

  it('refuses a revoked token, and says it was revoked', async () => {
    const revoked = await revokeMcpToken(
      harness.store,
      harness.auth.organizationId,
      { userId: harness.auth.userId },
      tokenId,
    );
    expect(revoked.ok && revoked.value.revoked_at).toBeTruthy();
    const response = await POST(request(ping(), { bearer: token }));
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/revoked/i);
    // Revoking again is a no-op, not an error.
    const again = await revokeMcpToken(
      harness.store,
      harness.auth.organizationId,
      { userId: null },
      tokenId,
    );
    expect(again.ok).toBe(true);
  });

  it('uses the path token even when the client adds an Authorization header of its own', async () => {
    const good = await postWithPathToken(request(ping(), { bearer: 'some-oauth-token' }), {
      params: Promise.resolve({ token }),
    });
    expect(good.status).toBe(200);
    const bad = await postWithPathToken(request(ping(), { bearer: token }), {
      params: Promise.resolve({ token: mintMcpToken(harness.auth.organizationId) }),
    });
    expect(bad.status).toBe(401);
  });

  it('keys the failed-token brake on the hop the host adds, not the one the client writes', async () => {
    // A client spoofing the first X-Forwarded-For hop is still the same caller.
    for (let i = 0; i < MCP_AUTH_FAILURES_PER_MINUTE; i++) {
      const spoofed = request(ping(), {
        bearer: mintMcpToken(harness.auth.organizationId),
        headers: { 'x-forwarded-for': `10.0.0.${i}, ${ip}` },
      });
      expect((await POST(spoofed)).status).toBe(401);
    }
    const again = request(ping(), {
      bearer: mintMcpToken(harness.auth.organizationId),
      headers: { 'x-forwarded-for': `10.9.9.9, ${ip}` },
    });
    expect((await POST(again)).status).toBe(429);
  });

  it("prefers Cloudflare's CF-Connecting-IP to X-Forwarded-For for the brake", async () => {
    // Behind Cloudflare only (Render sets RENDER=true); elsewhere the header is a client's.
    vi.stubEnv('RENDER', 'true');
    // Behind a proxy that appends itself, every caller shares the last hop;
    // the edge's header still tells callers apart.
    const via = (edge: string, bearer: string) =>
      request(ping(), {
        bearer,
        headers: { 'cf-connecting-ip': edge, 'x-forwarded-for': `${edge}, 10.1.1.1` },
      });
    for (let i = 0; i < MCP_AUTH_FAILURES_PER_MINUTE; i++) {
      expect(
        (await POST(via('192.0.2.10', mintMcpToken(harness.auth.organizationId)))).status,
      ).toBe(401);
    }
    expect((await POST(via('192.0.2.10', mintMcpToken(harness.auth.organizationId)))).status).toBe(
      429,
    );
    // Same proxy hop, different caller at the edge: not braked.
    expect((await POST(via('192.0.2.11', mintMcpToken(harness.auth.organizationId)))).status).toBe(
      401,
    );
  });

  it('records when a token was last used', async () => {
    await POST(request(ping(), { bearer: token }));
    const row = (await harness.store.get(
      'mcp_tokens',
      harness.auth.organizationId,
      tokenId,
    )) as McpToken;
    expect(row.last_used_at).toBeTruthy();
  });

  it('cannot reach another organization: a token reads only its own', async () => {
    const other = await addSecondOrganization(harness);
    const created = await createMcpToken(
      harness.store,
      other.organizationId,
      { userId: null },
      'X',
    );
    if (!created.ok) throw new Error(created.error.message);
    const response = await POST(
      request(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'search', arguments: { query: 'Brindle' } },
        },
        { bearer: created.value.token },
      ),
    );
    const body = (await response.json()) as { result: { structuredContent: { results: [] } } };
    expect(body.result.structuredContent.results).toEqual([]);
  });

  it('does not accept a row filed under one organization for a token naming another', async () => {
    const other = await addSecondOrganization(harness);
    const foreign = mintMcpToken(other.organizationId);
    await harness.store.insert('mcp_tokens', {
      id: '33333333-3333-4333-8333-333333333333',
      organization_id: harness.auth.organizationId,
      name: 'Misfiled',
      token_hash: hashMcpToken(foreign),
      hint: foreign.slice(-4),
      created_by: null,
      created_at: new Date().toISOString(),
      last_used_at: null,
      revoked_at: null,
    });
    expect((await POST(request(ping(), { bearer: foreign }))).status).toBe(401);
  });
});

describe('before the migration has run', () => {
  it('answers 503 with the migration to run, and Settings gets the same message', async () => {
    const missing = Object.assign(new Error('relation "mcp_tokens" does not exist'), {
      code: '42P01',
    });
    const store = new Proxy(harness.store, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (args[0] === 'mcp_tokens') throw missing;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as DataStore;
    setStoreForTesting(store);

    const response = await POST(request(ping(), { bearer: token }));
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain('20261016020000_mcp_tokens.sql');

    const listed = await listMcpTokens(store, harness.auth.organizationId);
    expect(listed.ok ? null : listed.error.code).toBe('not_configured');
    const created = await createMcpToken(store, harness.auth.organizationId, { userId: null }, 'A');
    expect(created.ok ? null : created.error.code).toBe('not_configured');
  });
});

describe('abuse brakes', () => {
  it(`allows ${MCP_RATE_PER_MINUTE} messages a minute per token, then 429 with Retry-After`, async () => {
    for (let i = 0; i < MCP_RATE_PER_MINUTE; i++) {
      const ok = await POST(request(ping(i), { bearer: token }));
      expect(ok.status).toBe(200);
    }
    const limited = await POST(request(ping('over'), { bearer: token }));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    const body = (await limited.json()) as { id: string; error: { code: number } };
    expect(body).toMatchObject({ id: 'over', error: { code: -32029 } });
  });

  it('counts each message of a batch against the limit', async () => {
    const batch = Array.from({ length: MCP_RATE_PER_MINUTE + 1 }, (_, i) => ping(i));
    expect((await POST(request(batch, { bearer: token }))).status).toBe(429);
  });

  it(`brakes an address's bad tokens after ${MCP_AUTH_FAILURES_PER_MINUTE}, and never a good one`, async () => {
    for (let i = 0; i < MCP_AUTH_FAILURES_PER_MINUTE; i++) {
      expect(
        (await POST(request(ping(), { bearer: mintMcpToken(harness.auth.organizationId) }))).status,
      ).toBe(401);
    }
    // Further bad tokens from that address, well-formed or malformed: 429.
    const braked = await POST(
      request(ping(), { bearer: mintMcpToken(harness.auth.organizationId) }),
    );
    expect(braked.status).toBe(429);
    expect(Number(braked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await POST(request(ping(), { bearer: 'tcmcp_nonsense' }))).status).toBe(429);
    // No token at all is not a guess: still the plain 401 that says how to send one.
    expect((await POST(request(ping()))).status).toBe(401);
    // A valid token from the same address is served: the address is shared
    // (claude.ai's egress, a proxy), so a braked address must not shut out
    // every client behind it.
    expect((await POST(request(ping(), { bearer: token }))).status).toBe(200);
    expect(
      (
        await postWithPathToken(request(ping()), {
          params: Promise.resolve({ token }),
        })
      ).status,
    ).toBe(200);
    // Another address is unaffected.
    ip = '198.51.100.7';
    expect(
      (await POST(request(ping(), { bearer: mintMcpToken(harness.auth.organizationId) }))).status,
    ).toBe(401);
  });

  it('does not count a revoked token toward the brake (a stale connector is not a guesser)', async () => {
    const stale = await createMcpToken(
      harness.store,
      harness.auth.organizationId,
      { userId: null },
      'Old connector',
    );
    if (!stale.ok) throw new Error(stale.error.message);
    await revokeMcpToken(
      harness.store,
      harness.auth.organizationId,
      { userId: null },
      stale.value.summary.id,
    );
    for (let i = 0; i < MCP_AUTH_FAILURES_PER_MINUTE * 2; i++) {
      const response = await POST(request(ping(), { bearer: stale.value.token }));
      expect(response.status).toBe(401);
    }
    // Still not braked: a bad token is a plain 401, and the live token works.
    expect(
      (await POST(request(ping(), { bearer: mintMcpToken(harness.auth.organizationId) }))).status,
    ).toBe(401);
    expect((await POST(request(ping(), { bearer: token }))).status).toBe(200);
  });
});

describe('HTTP framing', () => {
  it('answers 202 with no body to a notification', async () => {
    const response = await POST(
      request({ jsonrpc: '2.0', method: 'notifications/initialized' }, { bearer: token }),
    );
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('');
  });

  it('answers 400 with a parse error to a body that is not JSON', async () => {
    const response = await POST(request(null, { bearer: token, raw: '{"jsonrpc":' }));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });

  it('refuses an oversized body unread', async () => {
    const response = await POST(
      request(null, { bearer: token, raw: JSON.stringify({ pad: 'x'.repeat(300_000) }) }),
    );
    expect(response.status).toBe(413);
  });

  it('refuses an unsupported MCP-Protocol-Version header, accepts a supported one', async () => {
    const bad = await POST(
      request(ping(), { bearer: token, headers: { 'mcp-protocol-version': '1999-01-01' } }),
    );
    expect(bad.status).toBe(400);
    const good = await POST(
      request(ping(), { bearer: token, headers: { 'mcp-protocol-version': '2025-06-18' } }),
    );
    expect(good.status).toBe(200);
  });

  it('answers GET and DELETE with 405 and Allow: POST (no SSE stream, no sessions)', async () => {
    for (const response of [GET(), DELETE()]) {
      const r = await response;
      expect(r.status).toBe(405);
      expect(r.headers.get('allow')).toBe('POST');
    }
  });

  it('runs the whole handshake a client does', async () => {
    const init = await POST(
      request(
        {
          jsonrpc: '2.0',
          id: 0,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'test', version: '1' },
          },
        },
        { bearer: token },
      ),
    );
    const initBody = (await init.json()) as {
      result: { protocolVersion: string; serverInfo: { name: string }; instructions: string };
    };
    expect(initBody.result.protocolVersion).toBe('2025-06-18');
    expect(initBody.result.serverInfo.name).toBe('tiptop-copilot');
    expect(initBody.result.instructions).toMatch(/untrusted/i);

    const list = await POST(
      request({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { bearer: token }),
    );
    const listBody = (await list.json()) as { result: { tools: { name: string }[] } };
    expect(listBody.result.tools.map((t) => t.name)).toEqual([
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
  });
});

describe('audit', () => {
  it('records each tool call with the tool and client name, never the arguments', async () => {
    await POST(
      request(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'search', arguments: { query: 'Brindle Health' } },
        },
        { bearer: token },
      ),
    );
    await POST(
      request(
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'get_record', arguments: { id: 'nope' } },
        },
        { bearer: token },
      ),
    );
    const events = await audits();
    expect(events).toHaveLength(2);
    const byTool = Object.fromEntries(events.map((e) => [e.metadata.tool, e]));
    expect(byTool.search).toMatchObject({
      entity_type: 'mcp_token',
      entity_id: tokenId,
      user_id: null,
      metadata: { tool: 'search', client: 'Test client', ok: true, error_code: null },
    });
    expect(byTool.get_record?.metadata).toMatchObject({ ok: false, error_code: 'invalid_input' });
    expect(JSON.stringify(events)).not.toContain('Brindle');
    expect(JSON.stringify(events)).not.toContain(ip);
  });

  it('does not audit pings, lists or the handshake', async () => {
    await POST(request(ping(), { bearer: token }));
    await POST(request({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { bearer: token }));
    expect(await audits()).toHaveLength(0);
  });
});
