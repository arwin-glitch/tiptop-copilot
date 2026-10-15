import { describe, expect, it, vi } from 'vitest';
import {
  dispatchBody,
  dispatchMessage,
  LATEST_PROTOCOL_VERSION,
  negotiateProtocolVersion,
  RPC_ERROR,
  type McpDispatchDeps,
  type McpToolOutput,
} from '@/lib/mcp/protocol';

/**
 * The JSON-RPC 2.0 surface of the MCP server, on its own: what each method
 * answers, which messages get no answer, and how a tool's success, failure
 * and crash come back — with the store, auth and audit stubbed out.
 */

function deps(overrides: Partial<McpDispatchDeps> = {}): McpDispatchDeps {
  return {
    server: { name: 'test-server', title: 'Test', version: '9.9.9', instructions: 'Be careful.' },
    tools: [
      {
        name: 'echo',
        title: 'Echo',
        description: 'Echoes.',
        inputSchema: { type: 'object', properties: { say: { type: 'string' } } },
        annotations: { readOnlyHint: true },
      },
    ],
    callTool: async (_name, args): Promise<McpToolOutput> => ({
      text: `said ${String(args.say ?? '')}`,
      structured: { said: args.say ?? null },
    }),
    ...overrides,
  };
}

const call = (id: number | string, method: string, params?: unknown) => ({
  jsonrpc: '2.0',
  id,
  method,
  ...(params === undefined ? {} : { params }),
});

describe('initialize', () => {
  it('answers with the requested protocol version when supported, and the server info', async () => {
    const response = await dispatchMessage(
      call(1, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'claude-ai', version: '1' },
      }),
      deps(),
    );
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'test-server', title: 'Test', version: '9.9.9' },
        instructions: 'Be careful.',
      },
    });
  });

  it('answers an unknown or missing version with the newest it supports', async () => {
    expect(negotiateProtocolVersion('1999-01-01')).toBe(LATEST_PROTOCOL_VERSION);
    expect(negotiateProtocolVersion(undefined)).toBe(LATEST_PROTOCOL_VERSION);
    const response = await dispatchMessage(call('a', 'initialize'), deps());
    expect(response).toMatchObject({
      id: 'a',
      result: { protocolVersion: LATEST_PROTOCOL_VERSION },
    });
  });
});

describe('ping and tools/list', () => {
  it('answers ping with an empty result', async () => {
    expect(await dispatchMessage(call(2, 'ping'), deps())).toEqual({
      jsonrpc: '2.0',
      id: 2,
      result: {},
    });
  });

  it('lists the tools', async () => {
    const response = await dispatchMessage(call(3, 'tools/list'), deps());
    expect(response).toMatchObject({ result: { tools: [{ name: 'echo', title: 'Echo' }] } });
  });
});

describe('tools/call', () => {
  it('returns the text as content and the JSON as structuredContent', async () => {
    const response = await dispatchMessage(
      call(4, 'tools/call', { name: 'echo', arguments: { say: 'hi' } }),
      deps(),
    );
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 4,
      result: {
        content: [{ type: 'text', text: 'said hi' }],
        structuredContent: { said: 'hi' },
        isError: false,
      },
    });
  });

  it('treats missing arguments as {}', async () => {
    const response = await dispatchMessage(call(5, 'tools/call', { name: 'echo' }), deps());
    expect(response).toMatchObject({ result: { structuredContent: { said: null } } });
  });

  it('refuses an unknown tool as invalid params, without calling anything', async () => {
    const callTool = vi.fn();
    const response = await dispatchMessage(
      call(6, 'tools/call', { name: 'delete_everything' }),
      deps({ callTool }),
    );
    expect(response).toMatchObject({ id: 6, error: { code: RPC_ERROR.invalidParams } });
    expect(callTool).not.toHaveBeenCalled();
  });

  it('refuses arguments that are not an object, and a call with no name', async () => {
    expect(
      await dispatchMessage(call(7, 'tools/call', { name: 'echo', arguments: [1, 2] }), deps()),
    ).toMatchObject({ error: { code: RPC_ERROR.invalidParams } });
    expect(await dispatchMessage(call(8, 'tools/call', {}), deps())).toMatchObject({
      error: { code: RPC_ERROR.invalidParams },
    });
  });

  it('turns a tool that throws into a tool error, and reports the call either way', async () => {
    const onToolCall = vi.fn();
    let t = 1_000;
    const response = await dispatchMessage(
      call(9, 'tools/call', { name: 'echo', arguments: {} }),
      deps({
        callTool: async () => {
          t += 25;
          throw new Error('database exploded with a secret in the message');
        },
        onToolCall,
        clock: () => t,
      }),
    );
    expect(response).toMatchObject({ id: 9, result: { isError: true } });
    expect(JSON.stringify(response)).not.toContain('secret');
    expect(onToolCall).toHaveBeenCalledWith({
      tool: 'echo',
      ok: false,
      errorCode: 'internal',
      durationMs: 25,
    });
  });

  it('passes a tool-level failure through as isError with its code for the audit', async () => {
    const onToolCall = vi.fn();
    const response = await dispatchMessage(
      call(10, 'tools/call', { name: 'echo', arguments: {} }),
      deps({
        callTool: async () => ({
          text: 'No such record.',
          structured: { error: { code: 'not_found' } },
          isError: true,
          errorCode: 'not_found',
        }),
        onToolCall,
      }),
    );
    expect(response).toMatchObject({
      result: { isError: true, content: [{ type: 'text', text: 'No such record.' }] },
    });
    expect(onToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, errorCode: 'not_found' }),
    );
  });
});

describe('malformed messages and notifications', () => {
  it('does not answer a notification, whatever its method', async () => {
    expect(
      await dispatchMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, deps()),
    ).toBeNull();
    expect(await dispatchMessage({ jsonrpc: '2.0', method: 'tools/list' }, deps())).toBeNull();
  });

  it('accepts a response the client sends without answering it', async () => {
    expect(await dispatchMessage({ jsonrpc: '2.0', id: 1, result: {} }, deps())).toBeNull();
  });

  it('refuses a non-object, a wrong version, a missing method and a null id', async () => {
    expect(await dispatchMessage('hello', deps())).toMatchObject({
      id: null,
      error: { code: RPC_ERROR.invalidRequest },
    });
    expect(await dispatchMessage({ jsonrpc: '1.0', id: 1, method: 'ping' }, deps())).toMatchObject({
      id: 1,
      error: { code: RPC_ERROR.invalidRequest },
    });
    expect(await dispatchMessage({ jsonrpc: '2.0', id: 2 }, deps())).toMatchObject({
      id: 2,
      error: { code: RPC_ERROR.invalidRequest },
    });
    expect(
      await dispatchMessage({ jsonrpc: '2.0', id: null, method: 'ping' }, deps()),
    ).toMatchObject({ id: null, error: { code: RPC_ERROR.invalidRequest } });
  });

  it('answers an unknown method with method-not-found', async () => {
    expect(await dispatchMessage(call(11, 'resources/list'), deps())).toMatchObject({
      id: 11,
      error: { code: RPC_ERROR.methodNotFound },
    });
  });
});

describe('batches', () => {
  it('answers each request in order and skips notifications', async () => {
    const responses = await dispatchBody(
      [
        call(1, 'ping'),
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        call(2, 'tools/list'),
      ],
      deps(),
    );
    expect(Array.isArray(responses)).toBe(true);
    expect((responses as { id: number }[]).map((r) => r.id)).toEqual([1, 2]);
  });

  it('has nothing to say to a batch of notifications, and refuses an empty batch', async () => {
    expect(
      await dispatchBody([{ jsonrpc: '2.0', method: 'notifications/initialized' }], deps()),
    ).toBeNull();
    expect(await dispatchBody([], deps())).toMatchObject({
      error: { code: RPC_ERROR.invalidRequest },
    });
  });
});
