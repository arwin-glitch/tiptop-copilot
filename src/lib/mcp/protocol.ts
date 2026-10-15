/**
 * The Model Context Protocol, the small part of it this server speaks.
 *
 * MCP is JSON-RPC 2.0. Over the Streamable HTTP transport a client POSTs one
 * message (or, before the 2025-06-18 revision, a batch) and the server answers
 * each request with a JSON response; notifications get no answer. This server
 * is stateless and read-only, so it needs four methods — `initialize`, `ping`,
 * `tools/list` and `tools/call` — and acknowledges the client's notifications.
 * Implemented by hand: the SDK would bring a dependency, a session model and
 * an SSE stream for what is a dozen lines of dispatch.
 *
 * Pure: no store, no network. The tools and what happens around a call (rate
 * limits, audit) are injected, so this file is tested on its own.
 */

export const JSONRPC_VERSION = '2.0';

/** JSON-RPC 2.0's reserved error codes. */
export const RPC_ERROR = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /** Implementation-defined (-32000 to -32099): the caller is over its rate limit. */
  rateLimited: -32029,
  /** Implementation-defined: the token was missing, invalid or revoked. */
  unauthenticated: -32001,
  /** Implementation-defined: the server is not set up to answer. */
  notConfigured: -32002,
} as const;

/**
 * Protocol revisions this server answers to, newest first. Tools, as used
 * here, read the same in all of them; a client asking for one we do not know
 * gets the newest, as the spec's version negotiation prescribes.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export type JsonRpcId = string | number;

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: JsonRpcId | null; result: unknown }
  | { jsonrpc: '2.0'; id: JsonRpcId | null; error: JsonRpcError };

export function rpcResult(id: JsonRpcId | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

export function rpcError(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

/* ------------------------------------------------------------------ tools */

/** What `tools/list` shows for one tool. */
export interface McpToolDescriptor {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

/** What a tool hands back: a concise text answer and the same answer as JSON. */
export interface McpToolOutput {
  text: string;
  structured: Record<string, unknown>;
  /** A tool-level failure the model can read and act on (bad arguments, not found). */
  isError?: boolean;
  /** An AppError code for the audit trail; never shown to the client. */
  errorCode?: string;
}

export interface McpServerInfo {
  name: string;
  title: string;
  version: string;
  instructions: string;
}

/** Everything the dispatcher needs from outside. */
export interface McpDispatchDeps {
  server: McpServerInfo;
  tools: readonly McpToolDescriptor[];
  /** Run a tool known to exist. May throw; a throw becomes a tool error. */
  callTool: (name: string, args: Record<string, unknown>) => Promise<McpToolOutput>;
  /** Told about every finished tools/call, for the audit trail. */
  onToolCall?: (call: {
    tool: string;
    ok: boolean;
    errorCode: string | null;
    durationMs: number;
  }) => void | Promise<void>;
  /** Timer, for tests. */
  clock?: () => number;
}

/* --------------------------------------------------------------- dispatch */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is JsonRpcId {
  return (typeof value === 'string' && value.length <= 200) || Number.isFinite(value as number);
}

/**
 * Answer one JSON-RPC message. Null means "no response": a notification, or a
 * response the client sent to us (this server never sends requests, so there
 * is nothing to match it to).
 */
export async function dispatchMessage(
  message: unknown,
  deps: McpDispatchDeps,
): Promise<JsonRpcResponse | null> {
  if (!isObject(message)) {
    return rpcError(null, RPC_ERROR.invalidRequest, 'Each message must be a JSON-RPC object.');
  }
  const hasId = 'id' in message && message.id !== undefined;
  const id = hasId && isId(message.id) ? message.id : null;

  if (message.jsonrpc !== JSONRPC_VERSION) {
    return rpcError(id, RPC_ERROR.invalidRequest, 'Only JSON-RPC 2.0 is supported.');
  }
  if (typeof message.method !== 'string') {
    // A response from the client ({ id, result } or { id, error }): accepted, not answered.
    if ('result' in message || 'error' in message) return null;
    return rpcError(id, RPC_ERROR.invalidRequest, 'A request needs a "method".');
  }
  if (hasId && id === null) {
    return rpcError(null, RPC_ERROR.invalidRequest, 'A request id must be a string or a number.');
  }

  const method = message.method;
  const params = message.params;

  // Notifications (no id) are acknowledged by the transport and never answered,
  // whatever their method: notifications/initialized, notifications/cancelled, …
  if (!hasId) return null;

  try {
    switch (method) {
      case 'initialize':
        return rpcResult(id, initializeResult(params, deps.server));
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, { tools: deps.tools });
      case 'tools/call':
        return await callTool(id as JsonRpcId, params, deps);
      default:
        return rpcError(id, RPC_ERROR.methodNotFound, `Method not found: ${method.slice(0, 100)}`);
    }
  } catch {
    return rpcError(id, RPC_ERROR.internalError, 'The server could not answer that request.');
  }
}

/** The protocol version to answer an `initialize` with. */
export function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === 'string' &&
    (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : LATEST_PROTOCOL_VERSION;
}

function initializeResult(params: unknown, server: McpServerInfo) {
  const requested = isObject(params) ? params.protocolVersion : undefined;
  return {
    protocolVersion: negotiateProtocolVersion(requested),
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: server.name, title: server.title, version: server.version },
    instructions: server.instructions,
  };
}

async function callTool(
  id: JsonRpcId,
  params: unknown,
  deps: McpDispatchDeps,
): Promise<JsonRpcResponse> {
  if (!isObject(params) || typeof params.name !== 'string') {
    return rpcError(id, RPC_ERROR.invalidParams, 'tools/call needs a tool "name".');
  }
  const name = params.name;
  if (!deps.tools.some((t) => t.name === name)) {
    return rpcError(id, RPC_ERROR.invalidParams, `Unknown tool: ${name.slice(0, 100)}`);
  }
  const args = params.arguments === undefined || params.arguments === null ? {} : params.arguments;
  if (!isObject(args)) {
    return rpcError(id, RPC_ERROR.invalidParams, 'Tool "arguments" must be an object.');
  }

  const clock = deps.clock ?? Date.now;
  const started = clock();
  let output: McpToolOutput;
  try {
    output = await deps.callTool(name, args);
  } catch {
    output = {
      text: `${name} failed unexpectedly. Try again in a moment.`,
      structured: { error: { code: 'internal', message: 'The tool failed unexpectedly.' } },
      isError: true,
      errorCode: 'internal',
    };
  }
  await deps.onToolCall?.({
    tool: name,
    ok: !output.isError,
    errorCode: output.isError ? (output.errorCode ?? 'tool_error') : null,
    durationMs: Math.max(0, clock() - started),
  });

  return rpcResult(id, {
    content: [{ type: 'text', text: output.text }],
    structuredContent: output.structured,
    isError: Boolean(output.isError),
  });
}

/**
 * Answer a POST body: one message or a batch. Null means nothing to send back
 * (only notifications or responses), which the transport turns into 202.
 */
export async function dispatchBody(
  body: unknown,
  deps: McpDispatchDeps,
): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  if (Array.isArray(body)) {
    if (body.length === 0) {
      return rpcError(null, RPC_ERROR.invalidRequest, 'An empty batch is not a request.');
    }
    const responses: JsonRpcResponse[] = [];
    // In order, one at a time: a batch is small, and the audit and rate limit
    // see calls in the order they were sent.
    for (const message of body) {
      const response = await dispatchMessage(message, deps);
      if (response) responses.push(response);
    }
    return responses.length ? responses : null;
  }
  return dispatchMessage(body, deps);
}

/** How many messages a POST body carries, for the rate limit. */
export function messageCount(body: unknown): number {
  return Array.isArray(body) ? body.length : 1;
}

/** The single request id of a body, when it has exactly one, for a transport-level error. */
export function soleRequestId(body: unknown): JsonRpcId | null {
  if (Array.isArray(body) || !isObject(body)) return null;
  return isId(body.id) ? body.id : null;
}
