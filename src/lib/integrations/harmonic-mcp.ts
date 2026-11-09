import 'server-only';
import { createHash } from 'node:crypto';
import type { AuthContext } from '@/lib/auth/session';
import type { DataStore } from '@/lib/db/store';
import { isMissingTableError } from '@/lib/db/missing-table';
import {
  openToken,
  randomToken,
  sealToken,
  signedValue,
  verifySignedValue,
} from '@/lib/security/crypto';
import { log } from '@/lib/security/redact';
import type { HarmonicConnection } from '@/lib/types/domain';
import { err, ok, type Result } from '@/lib/util/result';

/**
 * Harmonic over MCP: one org-wide OAuth connection to Harmonic's hosted MCP
 * server, so Kraken can call Harmonic tools on the free OAuth quota (100
 * requests a day per Harmonic user). The paid REST API key path is separate
 * (lib/integrations/harmonic.ts) and unchanged.
 *
 * Flow: Connect registers a fresh OAuth client (RFC 7591 dynamic client
 * registration), keeps the pending client secret and PKCE verifier in an
 * in-process map keyed by `state` for ten minutes, and puts only the signed
 * `state` in a cookie — secrets never go in cookies. The callback checks the
 * cookie, exchanges the code, and stores one row per organization with the
 * client secret and both tokens sealed (AES-256-GCM, AAD `harmonic:<orgId>`).
 *
 * The pending map and the lookup cache are in-process. Kraken runs as a
 * single Render instance, so that is acceptable; with several instances a
 * callback landing on another instance would fail and the person would click
 * Connect again.
 */

export const HARMONIC_MCP_URL = 'https://mcp.api.harmonic.ai/';
export const HARMONIC_STATE_COOKIE = 'kraken_harmonic_oauth';

// Harmonic's new sign-in (login.harmonic.ai), named by the MCP server's
// protected-resource metadata; the old mcp.api.harmonic.ai/authorize flow
// refuses accounts on the new sign-in.
const AUTHORIZE_URL = 'https://login.harmonic.ai/oauth2/authorize';
const TOKEN_URL = 'https://login.harmonic.ai/oauth2/token';
const REGISTER_URL = 'https://login.harmonic.ai/oauth2/register';
const SCOPE = 'openid profile email offline_access';
const HTTP_TIMEOUT_MS = 8_000;
const PENDING_TTL_MS = 10 * 60_000;
const REFRESH_LEEWAY_MS = 60_000;
const LOOKUP_TTL_MS = 24 * 60 * 60_000;
const LOOKUP_MAX_ENTRIES = 200;
const PROTOCOL_VERSION = '2025-06-18';

interface PendingConnect {
  clientId: string;
  clientSecret: string;
  verifier: string;
  orgId: string;
  userId: string;
  redirectUri: string;
  expiresAt: number;
}

interface SealedBlob {
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

const pending = new Map<string, PendingConnect>();
const lookupCache = new Map<string, { at: number; hits: HarmonicLookupHit[] }>();

export function resetHarmonicMcpState(): void {
  pending.clear();
  lookupCache.clear();
  quotaUsed.clear();
  detailCache.clear();
  detailsInFlight.clear();
}

/* ------------------------------------------------------------------- quota */

/**
 * Harmonic's free OAuth quota is 100 tool calls a day per Harmonic user. Kraken
 * keeps its own count per organization (in-process, reset at midnight UTC) and
 * stops at 95, keeping five spare, so a busy day never runs Harmonic dry for
 * the person's own use. Only real tools/call requests count: cache hits are
 * free. When Harmonic itself says the quota is gone, the count jumps to the
 * limit for the rest of the day.
 */
export const HARMONIC_DAILY_LIMIT = 95;

const quotaUsed = new Map<string, { day: string; used: number }>();

function utcDay(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

function quotaEntry(organizationId: string): { day: string; used: number } {
  const day = utcDay();
  let entry = quotaUsed.get(organizationId);
  if (!entry || entry.day !== day) {
    entry = { day, used: 0 };
    quotaUsed.set(organizationId, entry);
    // Drop other organizations' stale days so the map cannot grow forever.
    for (const [org, e] of quotaUsed) if (e.day !== day) quotaUsed.delete(org);
  }
  return entry;
}

export function harmonicQuota(organizationId: string): {
  used: number;
  limit: number;
  remaining: number;
} {
  const { used } = quotaEntry(organizationId);
  const capped = Math.min(used, HARMONIC_DAILY_LIMIT);
  return {
    used: capped,
    limit: HARMONIC_DAILY_LIMIT,
    remaining: HARMONIC_DAILY_LIMIT - capped,
  };
}

function quotaSpent() {
  return err('rate_limited', 'Harmonic’s daily limit is used up. Try again tomorrow.', {
    details: { reason: 'daily_quota' },
  });
}

function aadFor(organizationId: string): string {
  return `harmonic:${organizationId}`;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function prunePending(now: number): void {
  for (const [state, entry] of pending) if (entry.expiresAt <= now) pending.delete(state);
}

function notConnected() {
  return err('not_configured', 'Harmonic is not connected. Connect it in Settings.', {
    details: { reason: 'not_connected' },
  });
}

async function http(
  url: string,
  init: RequestInit,
  timeoutMs = HTTP_TIMEOUT_MS,
): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

/** Harmonic's look-ups run a model on its side: a tool call can take a while. */
const TOOL_TIMEOUT_MS = 30_000;

/* ---------------------------------------------------------------- connect */

export async function harmonicConnectStart(
  store: DataStore,
  auth: AuthContext,
  redirectUri: string,
): Promise<Result<{ url: string; cookieValue: string }>> {
  void store;
  let clientId: string;
  let clientSecret: string;
  try {
    const response = await http(REGISTER_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_name: 'TipTop Kraken',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
        scope: SCOPE,
      }),
    });
    if (response.status === 429) return err('rate_limited', 'Harmonic is busy. Try again soon.');
    if (!response.ok) {
      log.warn('Harmonic client registration failed', { status: response.status });
      return err('provider_unavailable', 'Harmonic did not accept the connection request.');
    }
    const data = (await response.json()) as { client_id?: string; client_secret?: string };
    if (!data.client_id || !data.client_secret) {
      return err('provider_unavailable', 'Harmonic returned an incomplete client registration.');
    }
    clientId = data.client_id;
    clientSecret = data.client_secret;
  } catch {
    return err('provider_unavailable', 'Could not reach Harmonic.', { retryable: true });
  }

  const now = Date.now();
  prunePending(now);
  const state = randomToken(24);
  const verifier = randomToken(48);
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  pending.set(state, {
    clientId,
    clientSecret,
    verifier,
    orgId: auth.organizationId,
    userId: auth.userId,
    redirectUri,
    expiresAt: now + PENDING_TTL_MS,
  });

  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    scope: SCOPE,
    resource: HARMONIC_MCP_URL,
  }).toString();
  return ok({ url: url.toString(), cookieValue: signedValue(state) });
}

export async function harmonicConnectFinish(
  store: DataStore,
  auth: AuthContext,
  input: { code: string; state: string; cookieValue: string | undefined; redirectUri: string },
): Promise<Result<true>> {
  const fromCookie = input.cookieValue ? verifySignedValue(input.cookieValue) : null;
  if (!fromCookie || !input.state || fromCookie !== input.state) {
    return err('forbidden', 'The Harmonic sign-in could not be verified. Try connecting again.');
  }
  prunePending(Date.now());
  const entry = pending.get(input.state);
  if (!entry) {
    return err('invalid_input', 'The Harmonic sign-in expired. Try connecting again.');
  }
  if (entry.orgId !== auth.organizationId || entry.userId !== auth.userId) {
    return err('forbidden', 'The Harmonic sign-in was started by someone else.');
  }
  if (entry.redirectUri !== input.redirectUri) {
    return err('invalid_input', 'The Harmonic sign-in came back to the wrong address.');
  }
  pending.delete(input.state);
  if (!input.code) return err('invalid_input', 'Harmonic did not return an authorization code.');

  const tokens = await postToken({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: entry.clientId,
    client_secret: entry.clientSecret,
    code_verifier: entry.verifier,
    resource: HARMONIC_MCP_URL,
  });
  if (!tokens.ok) return tokens;
  if (!tokens.value.access_token) {
    return err('provider_unavailable', 'Harmonic did not return an access token.');
  }

  const sealed = sealBlob(auth.organizationId, {
    clientSecret: entry.clientSecret,
    accessToken: tokens.value.access_token,
    refreshToken: tokens.value.refresh_token ?? '',
  });
  if (!sealed.ok) return sealed;

  const now = new Date().toISOString();
  const row: HarmonicConnection = {
    id: crypto.randomUUID(),
    organization_id: auth.organizationId,
    connected_by: auth.userId,
    harmonic_email: null,
    client_id: entry.clientId,
    ...sealed.value,
    access_expires_at: expiresAt(tokens.value.expires_in),
    created_at: now,
    updated_at: now,
  };
  try {
    await store.upsert('harmonic_connections', row, ['organization_id']);
  } catch (e) {
    if (isMissingTableError(e)) {
      return err('not_configured', 'Harmonic needs a database update before it can connect.');
    }
    log.error('Harmonic connection could not be saved', { organizationId: auth.organizationId });
    return err('internal', 'The Harmonic connection could not be saved.');
  }
  clearLookupCache(auth.organizationId);
  log.info('Harmonic connected', { organizationId: auth.organizationId });
  return ok(true);
}

export async function harmonicConnection(
  store: DataStore,
  organizationId: string,
): Promise<{ connected: boolean; connectedBy: string | null; connectedAt: string | null }> {
  const row = await readRow(store, organizationId);
  if (!row) return { connected: false, connectedBy: null, connectedAt: null };
  return { connected: true, connectedBy: row.connected_by, connectedAt: row.created_at };
}

export async function harmonicDisconnect(store: DataStore, organizationId: string): Promise<void> {
  try {
    await store.removeWhere('harmonic_connections', organizationId, {
      eq: { organization_id: organizationId },
    });
  } catch (e) {
    if (!isMissingTableError(e)) throw e;
  }
  clearLookupCache(organizationId);
}

/* ------------------------------------------------------------------ tokens */

function expiresAt(expiresIn: number | undefined): string | null {
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn)) return null;
  return new Date(Date.now() + expiresIn * 1000).toISOString();
}

function sealBlob(
  organizationId: string,
  blob: SealedBlob,
): Result<
  Pick<HarmonicConnection, 'sealed_ciphertext' | 'sealed_iv' | 'sealed_auth_tag' | 'key_version'>
> {
  const sealed = sealToken(JSON.stringify(blob), aadFor(organizationId));
  if (!sealed.ok) return sealed;
  return ok({
    sealed_ciphertext: sealed.value.ciphertext,
    sealed_iv: sealed.value.iv,
    sealed_auth_tag: sealed.value.authTag,
    key_version: sealed.value.keyVersion,
  });
}

function openBlob(row: HarmonicConnection): Result<SealedBlob> {
  const opened = openToken(
    {
      ciphertext: row.sealed_ciphertext,
      iv: row.sealed_iv,
      authTag: row.sealed_auth_tag,
      keyVersion: row.key_version,
    },
    aadFor(row.organization_id),
  );
  if (!opened.ok) return opened;
  try {
    return ok(JSON.parse(opened.value) as SealedBlob);
  } catch {
    return err('internal', 'The stored Harmonic connection is unreadable. Reconnect Harmonic.');
  }
}

async function readRow(
  store: DataStore,
  organizationId: string,
): Promise<HarmonicConnection | null> {
  try {
    return await store.findOne('harmonic_connections', organizationId, {
      eq: { organization_id: organizationId },
    });
  } catch (e) {
    if (!isMissingTableError(e)) {
      log.warn('Harmonic connection read failed', { organizationId });
    }
    return null;
  }
}

async function postToken(params: Record<string, string>): Promise<Result<TokenResponse>> {
  try {
    const response = await http(TOKEN_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams(params),
    });
    if (response.status === 429) return err('rate_limited', 'Harmonic is busy. Try again soon.');
    if (response.status === 400 || response.status === 401) {
      log.warn('Harmonic token request refused', { status: response.status });
      return err('provider_unauthorized', 'Harmonic refused the sign-in. Reconnect Harmonic.');
    }
    if (!response.ok) {
      log.warn('Harmonic token request failed', { status: response.status });
      return err('provider_unavailable', 'Harmonic could not issue a token right now.', {
        retryable: true,
      });
    }
    return ok((await response.json()) as TokenResponse);
  } catch {
    return err('provider_unavailable', 'Could not reach Harmonic.', { retryable: true });
  }
}

async function refresh(
  store: DataStore,
  row: HarmonicConnection,
  blob: SealedBlob,
): Promise<Result<string>> {
  if (!blob.refreshToken) {
    return err('provider_unauthorized', 'The Harmonic sign-in expired. Reconnect Harmonic.');
  }
  const tokens = await postToken({
    grant_type: 'refresh_token',
    refresh_token: blob.refreshToken,
    client_id: row.client_id,
    client_secret: blob.clientSecret,
    resource: HARMONIC_MCP_URL,
  });
  if (!tokens.ok) return tokens;
  if (!tokens.value.access_token) {
    return err('provider_unavailable', 'Harmonic did not return an access token.');
  }
  const next: SealedBlob = {
    clientSecret: blob.clientSecret,
    accessToken: tokens.value.access_token,
    refreshToken: tokens.value.refresh_token ?? blob.refreshToken,
  };
  const sealed = sealBlob(row.organization_id, next);
  if (!sealed.ok) return sealed;
  try {
    await store.update('harmonic_connections', row.organization_id, row.id, {
      ...sealed.value,
      access_expires_at: expiresAt(tokens.value.expires_in),
    });
  } catch {
    // The new token still works for this call; the next call refreshes again.
    log.warn('Harmonic refreshed tokens could not be saved', {
      organizationId: row.organization_id,
    });
  }
  return ok(next.accessToken);
}

/* --------------------------------------------------------------------- MCP */

interface RpcMessage {
  id?: number | string;
  result?: { content?: { type?: string; text?: string }[]; isError?: boolean };
  error?: { code?: number; message?: string };
}

class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

/** A JSON body, or the JSON-RPC message(s) in an SSE stream's `data:` lines. */
async function readRpc(response: Response, id: number): Promise<RpcMessage | null> {
  const text = await response.text();
  const type = response.headers.get('content-type') ?? '';
  const candidates: unknown[] = [];
  if (type.includes('text/event-stream') || /^\s*(event|data):/m.test(text)) {
    let buffer: string[] = [];
    const flush = () => {
      if (buffer.length) {
        try {
          candidates.push(JSON.parse(buffer.join('\n')));
        } catch {
          // Not JSON: ignore this event.
        }
      }
      buffer = [];
    };
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('data:')) buffer.push(line.slice(5).trimStart());
      else if (line.trim() === '') flush();
    }
    flush();
  } else if (text.trim()) {
    try {
      candidates.push(JSON.parse(text));
    } catch {
      return null;
    }
  }
  const flat = candidates.flatMap((c) => (Array.isArray(c) ? c : [c])) as RpcMessage[];
  return flat.find((m) => m && m.id === id) ?? flat.find((m) => m && (m.result || m.error)) ?? null;
}

async function runTool(
  accessToken: string,
  name: string,
  args: Record<string, unknown>,
): Promise<Result<string>> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  const post = async (body: unknown, timeoutMs?: number) => {
    const response = await http(
      HARMONIC_MCP_URL,
      { method: 'POST', headers, body: JSON.stringify(body) },
      timeoutMs,
    );
    if (!response.ok && response.status !== 202) throw new HttpStatusError(response.status);
    return response;
  };

  const init = await post({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'tiptop-kraken', version: '1' },
    },
  });
  const session = init.headers.get('mcp-session-id');
  if (session) headers['mcp-session-id'] = session;
  const initMessage = await readRpc(init, 1);
  if (initMessage?.error) {
    return err('provider_unavailable', 'Harmonic did not start a session.', {
      details: { stage: 'initialize', rpcCode: initMessage.error.code ?? null },
    });
  }
  headers['mcp-protocol-version'] = PROTOCOL_VERSION;

  const notified = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await notified.text().catch(() => '');

  const call = await post(
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
    TOOL_TIMEOUT_MS,
  );
  const message = await readRpc(call, 2);
  if (!message) {
    return err('provider_unavailable', 'Harmonic returned an unreadable answer.', {
      details: { stage: 'tools/call', contentType: call.headers.get('content-type') },
    });
  }
  if (message.error) {
    log.warn('Harmonic tool call error', { tool: name, code: message.error.code ?? null });
    return err('provider_unavailable', 'Harmonic could not answer that right now.', {
      details: {
        stage: 'tools/call',
        rpcCode: message.error.code ?? null,
        rpcMessage: String(message.error.message ?? '').slice(0, 200),
      },
    });
  }
  const text = (message.result?.content ?? [])
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n');
  if (message.result?.isError) {
    if (/rate|limit|quota/i.test(text)) {
      return err('rate_limited', 'Harmonic’s daily limit is used up. Try again tomorrow.');
    }
    return err('provider_unavailable', 'Harmonic could not answer that right now.', {
      details: { stage: 'tool_error', text: text.slice(0, 200) },
    });
  }
  return ok(text);
}

export async function harmonicCallTool(
  store: DataStore,
  organizationId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<Result<string>> {
  const row = await readRow(store, organizationId);
  if (!row) return notConnected();
  const quota = quotaEntry(organizationId);
  if (quota.used >= HARMONIC_DAILY_LIMIT) return quotaSpent();
  const blob = openBlob(row);
  if (!blob.ok) return blob;
  quota.used += 1;
  const result = await callWithToken(store, row, blob.value, name, args);
  if (
    !result.ok &&
    result.error.code === 'rate_limited' &&
    result.error.message.includes('daily limit')
  ) {
    // Harmonic says the day's quota is gone: stop asking until tomorrow.
    quotaEntry(organizationId).used = HARMONIC_DAILY_LIMIT;
  }
  return result;
}

async function callWithToken(
  store: DataStore,
  row: HarmonicConnection,
  blob: SealedBlob,
  name: string,
  args: Record<string, unknown>,
): Promise<Result<string>> {
  let accessToken = blob.accessToken;
  let refreshed = false;
  const expiry = row.access_expires_at ? Date.parse(row.access_expires_at) : NaN;
  if (Number.isFinite(expiry) && expiry - Date.now() < REFRESH_LEEWAY_MS) {
    const next = await refresh(store, row, blob);
    if (!next.ok) return next;
    accessToken = next.value;
    refreshed = true;
  }

  for (;;) {
    try {
      return await runTool(accessToken, name, args);
    } catch (e) {
      if (e instanceof HttpStatusError) {
        if (e.status === 401 && !refreshed) {
          const next = await refresh(store, row, blob);
          if (!next.ok) return next;
          accessToken = next.value;
          refreshed = true;
          continue;
        }
        if (e.status === 401 || e.status === 403) {
          return err('provider_unauthorized', 'Harmonic refused the sign-in. Reconnect Harmonic.');
        }
        if (e.status === 429) {
          return err('rate_limited', 'Harmonic’s daily limit is used up. Try again tomorrow.');
        }
        log.warn('Harmonic MCP call failed', { tool: name, status: e.status });
        return err('provider_unavailable', 'Harmonic could not answer that right now.', {
          retryable: true,
          details: { stage: 'http', status: e.status },
        });
      }
      const timedOut = e instanceof Error && e.name === 'TimeoutError';
      return err(
        timedOut ? 'timeout' : 'provider_unavailable',
        timedOut ? 'Harmonic took too long to answer.' : 'Could not reach Harmonic.',
        { retryable: true },
      );
    }
  }
}

/* ------------------------------------------------------------------ lookup */

export interface HarmonicLookupHit {
  urn: string;
  kind: 'person' | 'company' | 'investor';
  id: string;
  name: string;
  headline: string | null;
  linkedin: string | null;
  website: string | null;
}

/** Undo the `answer: "..."` wrapper (JSON-escaped string) when present. */
function unwrapAnswer(text: string): string {
  const trimmed = text.trim();
  const match = /^answer:\s*("[\s\S]*")\s*$/.exec(trimmed);
  if (match) {
    try {
      const parsed = JSON.parse(match[1] as string) as unknown;
      if (typeof parsed === 'string') return parsed;
    } catch {
      // Fall through to a manual unescape.
    }
    return (match[1] as string).slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"');
  }
  return trimmed.includes('\\n') && !trimmed.includes('\n')
    ? trimmed.replace(/\\n/g, '\n').replace(/\\"/g, '"')
    : trimmed;
}

const ENTRY =
  /^\s*[-*]\s+\*\*(.+?)\*\*\s*\(urn:harmonic:(person|company|investor):([\w-]+)\)\s*(?:[—–-]+\s*(.*))?$/i;
const LINK = /^\s*(LinkedIn|Website):\s*(\S+)\s*$/i;

export function parseEntityLookup(text: string): HarmonicLookupHit[] {
  if (typeof text !== 'string' || !text) return [];
  const hits: HarmonicLookupHit[] = [];
  const seen = new Set<string>();
  let current: HarmonicLookupHit | null = null;
  for (const line of unwrapAnswer(text).split(/\r?\n/)) {
    const entry = ENTRY.exec(line);
    if (entry) {
      const kind = (entry[2] as string).toLowerCase() as HarmonicLookupHit['kind'];
      const id = entry[3] as string;
      const urn = `urn:harmonic:${kind}:${id}`;
      const headline = entry[4]?.trim() || null;
      current = seen.has(urn)
        ? null
        : {
            urn,
            kind,
            id,
            name: (entry[1] as string).trim(),
            headline,
            linkedin: null,
            website: null,
          };
      if (current) {
        seen.add(urn);
        hits.push(current);
      }
      continue;
    }
    const link = LINK.exec(line);
    if (link && current) {
      const url = link[2] as string;
      if (!/^https?:\/\//i.test(url)) continue;
      if ((link[1] as string).toLowerCase() === 'linkedin') current.linkedin ??= url;
      else current.website ??= url;
    }
  }
  return hits;
}

function clearLookupCache(organizationId: string): void {
  for (const key of lookupCache.keys()) {
    if (key.startsWith(`${organizationId}\u0000`)) lookupCache.delete(key);
  }
  for (const key of detailCache.keys()) {
    if (key.startsWith(`${organizationId}\u0000`)) detailCache.delete(key);
  }
}

/** Look-ups already on their way, so a warm-up and the page share one call. */
const lookupsInFlight = new Map<string, Promise<Result<HarmonicLookupHit[]>>>();

export async function harmonicLookup(
  store: DataStore,
  organizationId: string,
  query: string,
): Promise<Result<HarmonicLookupHit[]>> {
  const q = query.trim();
  if (!q) return ok([]);
  const key = `${organizationId}\u0000${q.toLowerCase()}`;
  const now = Date.now();
  const cached = lookupCache.get(key);
  if (cached && now - cached.at < LOOKUP_TTL_MS) return ok(cached.hits);
  if (cached) lookupCache.delete(key);
  const pending = lookupsInFlight.get(key);
  if (pending) return pending;
  const run = lookupNow(store, organizationId, q, key, now).finally(() =>
    lookupsInFlight.delete(key),
  );
  lookupsInFlight.set(key, run);
  return run;
}

async function lookupNow(
  store: DataStore,
  organizationId: string,
  q: string,
  key: string,
  now: number,
): Promise<Result<HarmonicLookupHit[]>> {
  const text = await harmonicCallTool(store, organizationId, 'entity_lookup', { query: q });
  if (!text.ok) return text;
  const hits = parseEntityLookup(text.value);
  lookupCache.set(key, { at: now, hits });
  while (lookupCache.size > LOOKUP_MAX_ENTRIES) {
    const oldest = lookupCache.keys().next().value;
    if (oldest === undefined) break;
    lookupCache.delete(oldest);
  }
  return ok(hits);
}

/* ------------------------------------------------------------------ detail */

/**
 * One Harmonic person or company, for the Ctrl+K hover preview. Read from
 * get_people / get_companies, whose text answer may be JSON (possibly inside
 * an `answer: "..."` wrapper or a code fence) or markdown; both are read
 * defensively and nothing here throws. Kept a day per organization.
 */
export interface HarmonicDetail {
  kind: 'person' | 'company';
  id: string;
  name: string | null;
  /** A person's current title (and company), or a company's one-liner. */
  headline: string | null;
  description: string | null;
  location: string | null;
  website: string | null;
  domain: string | null;
  linkedin: string | null;
  twitter: string | null;
  /** Person: current title. */
  title: string | null;
  /** Person: current company. */
  company: string | null;
  /** Company. */
  headcount: number | null;
  stage: string | null;
  fundingTotal: string | null;
  lastFundingAt: string | null;
  foundedYear: string | null;
}

const DETAIL_TTL_MS = 24 * 60 * 60_000;
const DETAIL_MAX_ENTRIES = 500;
const detailCache = new Map<string, { at: number; detail: HarmonicDetail }>();
const detailsInFlight = new Map<string, Promise<Result<HarmonicDetail>>>();

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function str(v: unknown): string | null {
  if (typeof v === 'string') {
    const t = v.trim();
    return t ? t : null;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/** The first readable string at any of these dotted paths. */
function pick(obj: Json, paths: readonly string[]): string | null {
  for (const path of paths) {
    let cur: unknown = obj;
    for (const part of path.split('.')) {
      if (Array.isArray(cur)) cur = cur[0];
      cur = isObj(cur) ? cur[part] : undefined;
    }
    const value = isObj(cur) ? (str(cur.url) ?? str(cur.name)) : str(cur);
    if (value) return value;
  }
  return null;
}

function httpUrl(raw: string | null): string | null {
  if (!raw) return null;
  const bare = /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(raw);
  const candidate = /^https?:\/\//i.test(raw) ? raw : bare ? `https://${raw}` : null;
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase() || null;
  } catch {
    return null;
  }
}

/** JSON somewhere in the text: whole, in a fence, or the outermost braces. */
function findJson(text: string, depth = 0): unknown {
  if (depth > 2) return undefined;
  const attempts: string[] = [text];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence?.[1]) attempts.push(fence[1]);
  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ] as const) {
    const a = text.indexOf(open);
    const b = text.lastIndexOf(close);
    if (a >= 0 && b > a) attempts.push(text.slice(a, b + 1));
  }
  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt) as unknown;
      if (typeof parsed === 'string') {
        const inner = findJson(parsed, depth + 1);
        if (inner !== undefined) return inner;
        continue;
      }
      if (isObj(parsed) || Array.isArray(parsed)) return parsed;
    } catch {
      // Try the next shape.
    }
  }
  return undefined;
}

/** The entity object: the first object (depth-first) with a name. */
function entityIn(value: unknown, depth = 0): Json | null {
  if (depth > 5) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = entityIn(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (!isObj(value)) return null;
  if (str(value.full_name) || str(value.name) || str(value.first_name)) return value;
  for (const v of Object.values(value)) {
    if (isObj(v) || Array.isArray(v)) {
      const found = entityIn(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function locationOf(obj: Json): string | null {
  const loc = obj.location;
  if (typeof loc === 'string') return str(loc);
  if (isObj(loc)) {
    const full = str(loc.location) ?? str(loc.display) ?? str(loc.address_formatted);
    if (full) return full;
    const parts = [loc.city, loc.state, loc.country].map(str).filter(Boolean);
    return parts.length ? parts.join(', ') : null;
  }
  return null;
}

function currentRole(obj: Json): { title: string | null; company: string | null } {
  const experience = Array.isArray(obj.experience) ? obj.experience.filter(isObj) : [];
  const current =
    experience.find((e) => e.is_current_position === true) ??
    experience.find((e) => e.end_date == null) ??
    experience[0];
  if (!current) return { title: null, company: null };
  return {
    title: str(current.title),
    company: pick(current, ['company_name', 'company.name', 'company']),
  };
}

function emptyDetail(kind: 'person' | 'company', id: string): HarmonicDetail {
  return {
    kind,
    id,
    name: null,
    headline: null,
    description: null,
    location: null,
    website: null,
    domain: null,
    linkedin: null,
    twitter: null,
    title: null,
    company: null,
    headcount: null,
    stage: null,
    fundingTotal: null,
    lastFundingAt: null,
    foundedYear: null,
  };
}

function clip(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  const flat = value.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1).replace(/\.0$/, '')}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${Math.round(n)}`;
}

function roleLine(title: string | null, company: string | null): string | null {
  return title && company ? `${title} at ${company}` : (title ?? company);
}

function detailFromJson(kind: 'person' | 'company', id: string, obj: Json): HarmonicDetail {
  const d = emptyDetail(kind, id);
  d.linkedin = httpUrl(
    pick(obj, [
      'socials.LINKEDIN.url',
      'socials.linkedin.url',
      'socials.linkedin',
      'linkedin_url',
      'linkedin',
    ]),
  );
  d.twitter = httpUrl(
    pick(obj, ['socials.TWITTER.url', 'socials.twitter.url', 'socials.twitter', 'twitter_url']),
  );
  d.location = clip(locationOf(obj), 120);
  if (kind === 'person') {
    const joined = [str(obj.first_name), str(obj.last_name)].filter(Boolean).join(' ');
    d.name = clip(str(obj.full_name) ?? str(obj.name) ?? joined, 120);
    const role = currentRole(obj);
    d.title = clip(role.title ?? str(obj.title), 120);
    d.company = clip(role.company ?? pick(obj, ['current_company.name', 'company_name']), 120);
    d.headline = clip(str(obj.headline), 200) ?? roleLine(d.title, d.company);
    d.description = clip(str(obj.about) ?? str(obj.summary) ?? str(obj.bio), 280);
  } else {
    d.name = clip(str(obj.name) ?? str(obj.legal_name), 120);
    d.website = httpUrl(pick(obj, ['website.url', 'website', 'website.domain', 'domain']));
    d.domain = hostOf(d.website) ?? str(obj.domain)?.toLowerCase() ?? null;
    d.headline = clip(str(obj.short_description) ?? str(obj.tagline), 200);
    d.description = clip(str(obj.description) ?? str(obj.short_description), 280);
    const rawHeadcount =
      obj.headcount ?? (isObj(obj.traction_metrics) ? obj.traction_metrics.headcount : null);
    const headcount = typeof rawHeadcount === 'number' ? rawHeadcount : Number(str(rawHeadcount));
    d.headcount = Number.isFinite(headcount) && headcount > 0 ? Math.round(headcount) : null;
    d.stage = clip(pick(obj, ['stage', 'funding.funding_stage', 'funding.last_funding_type']), 60);
    const total = pick(obj, ['funding.funding_total', 'funding_total', 'funding.total']);
    d.fundingTotal = total
      ? clip(/^\d+(\.\d+)?$/.test(total) ? formatUsd(Number(total)) : total, 40)
      : null;
    d.lastFundingAt = clip(pick(obj, ['funding.last_funding_at', 'last_funding_at']), 40);
    const founded = pick(obj, ['founding_date.date', 'founding_date', 'founded_year']);
    d.foundedYear = founded ? (/\d{4}/.exec(founded)?.[0] ?? null) : null;
  }
  return d;
}

const KV = /^\s*(?:[-*]\s+)?\**([A-Za-z][A-Za-z /]{0,30}?)\**\s*:\s*\**\s*(.+?)\s*$/;

function detailFromText(kind: 'person' | 'company', id: string, text: string): HarmonicDetail {
  const d = emptyDetail(kind, id);
  const fields = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const heading = /^\s*#{1,3}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      d.name ??= clip(
        (heading[1] as string)
          .replace(/\*+/g, '')
          .replace(/\(urn:[^)]*\)/, '')
          .trim(),
        120,
      );
      continue;
    }
    const entry = /^\s*[-*]?\s*\*\*(.+?)\*\*\s*\(urn:harmonic:/.exec(line);
    if (entry) {
      d.name ??= clip(entry[1], 120);
      continue;
    }
    const kv = KV.exec(line);
    if (kv) {
      const key = (kv[1] as string).trim().toLowerCase();
      if (!fields.has(key)) fields.set(key, (kv[2] as string).replace(/\*+/g, '').trim());
    }
  }
  const get = (...keys: string[]) => {
    for (const k of keys) {
      const v = fields.get(k);
      if (v) return v;
    }
    return null;
  };
  d.name ??= clip(get('name', 'full name', 'company name'), 120);
  d.location = clip(get('location', 'hq', 'headquarters'), 120);
  d.linkedin = httpUrl(get('linkedin', 'linkedin url'));
  d.twitter = httpUrl(get('twitter', 'x'));
  d.description = clip(get('description', 'about', 'summary', 'bio'), 280);
  if (kind === 'person') {
    d.title = clip(get('title', 'current title', 'role', 'position'), 120);
    d.company = clip(get('current company', 'company', 'employer'), 120);
    d.headline = clip(get('headline'), 200) ?? roleLine(d.title, d.company);
  } else {
    d.website = httpUrl(get('website', 'url', 'domain'));
    d.domain = hostOf(d.website);
    d.headline = clip(get('short description', 'tagline', 'one liner'), 200);
    const headcount = Number(
      (get('headcount', 'employees', 'team size') ?? '').replace(/[, ]/g, ''),
    );
    d.headcount = Number.isFinite(headcount) && headcount > 0 ? Math.round(headcount) : null;
    d.stage = clip(get('stage', 'funding stage', 'last round'), 60);
    d.fundingTotal = clip(
      get('total funding', 'funding total', 'funding raised', 'total raised'),
      40,
    );
    d.lastFundingAt = clip(get('last funding date', 'last funding', 'last funded'), 40);
    d.foundedYear =
      /\d{4}/.exec(get('founded', 'founding date', 'founded year') ?? '')?.[0] ?? null;
  }
  return d;
}

/** Harmonic's get_people / get_companies text as a detail. Never throws. */
export function parseHarmonicDetail(
  kind: 'person' | 'company',
  id: string,
  text: string,
): HarmonicDetail {
  try {
    if (typeof text !== 'string' || !text.trim()) return emptyDetail(kind, id);
    const unwrapped = unwrapAnswer(text);
    const json = findJson(unwrapped);
    const entity = json === undefined ? null : entityIn(json);
    if (entity) return detailFromJson(kind, id, entity);
    return detailFromText(kind, id, unwrapped);
  } catch {
    return emptyDetail(kind, id);
  }
}

/**
 * A Harmonic person's or company's details by numeric id, for the hover
 * preview. A day's cache per organization (500 entries at most) and one call
 * in flight per id; only a cache miss spends a look-up from the daily quota.
 */
export async function harmonicDetail(
  store: DataStore,
  organizationId: string,
  kind: 'person' | 'company',
  id: string,
): Promise<Result<HarmonicDetail>> {
  if (kind !== 'person' && kind !== 'company') {
    return err('invalid_input', 'Unknown Harmonic kind.');
  }
  if (!/^\d{1,20}$/.test(id)) return err('invalid_input', 'That is not a Harmonic id.');
  const key = `${organizationId}\u0000${kind}\u0000${id}`;
  const now = Date.now();
  const cached = detailCache.get(key);
  if (cached && now - cached.at < DETAIL_TTL_MS) return ok(cached.detail);
  if (cached) detailCache.delete(key);
  const inFlight = detailsInFlight.get(key);
  if (inFlight) return inFlight;
  const run = detailNow(store, organizationId, kind, id, key).finally(() =>
    detailsInFlight.delete(key),
  );
  detailsInFlight.set(key, run);
  return run;
}

async function detailNow(
  store: DataStore,
  organizationId: string,
  kind: 'person' | 'company',
  id: string,
  key: string,
): Promise<Result<HarmonicDetail>> {
  const text =
    kind === 'person'
      ? await harmonicCallTool(store, organizationId, 'get_people', {
          urns: [`urn:harmonic:person:${id}`],
          field_groups: ['basic', 'experience', 'location', 'socials'],
        })
      : await harmonicCallTool(store, organizationId, 'get_companies', {
          urns: [`urn:harmonic:company:${id}`],
          field_groups: [
            'name_id_description_headcount_website',
            'location',
            'funding',
            'external_profiles',
          ],
        });
  if (!text.ok) return text;
  const detail = parseHarmonicDetail(kind, id, text.value);
  detailCache.set(key, { at: Date.now(), detail });
  while (detailCache.size > DETAIL_MAX_ENTRIES) {
    const oldest = detailCache.keys().next().value;
    if (oldest === undefined) break;
    detailCache.delete(oldest);
  }
  return ok(detail);
}
