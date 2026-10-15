import 'server-only';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { isMissingColumnError, isMissingTableError } from '@/lib/db/missing-table';
import type { DataStore } from '@/lib/db/store';
import { recordAudit } from '@/lib/security/audit';
import { log } from '@/lib/security/redact';
import type { McpToken } from '@/lib/types/domain';
import { newId, sha256 } from '@/lib/util/hash';
import { err, ok, type Result } from '@/lib/util/result';

/**
 * Tokens for the MCP endpoint, one per Claude client.
 *
 * A token is `tcmcp_<organization id as 32 hex>_<43 random base64url chars>`:
 * 256 bits of randomness, plus the organization it belongs to, which is not a
 * secret and is what lets a request with no session find its token row in an
 * organization-scoped table. Only the SHA-256 of the whole string is stored;
 * the token is returned once, from `createMcpToken`, and never again.
 *
 * Tokens live in `mcp_tokens` (20261016020000_mcp_tokens.sql), a hand-applied
 * migration. Until it runs, every function here returns `not_configured` with
 * the fix, never a throw: Settings shows a set-up note and /api/mcp refuses
 * with that message.
 */

export const MCP_TOKEN_PREFIX = 'tcmcp_';
export const MCP_TOKENS_MIGRATION_FILE = 'supabase/migrations/20261016020000_mcp_tokens.sql';
/** Live (unrevoked) tokens an organization may hold at once. */
export const MCP_TOKEN_LIMIT = 20;
export const MCP_TOKEN_NAME_MAX = 80;
/** last_used_at is written at most this often per token. */
const TOUCH_EVERY_MS = 60_000;

const TOKEN_RE = /^tcmcp_([0-9a-f]{32})_([A-Za-z0-9_-]{43})$/;

const NOT_SET_UP = `Claude connections are not set up yet: the mcp_tokens table does not exist. Run ${MCP_TOKENS_MIGRATION_FILE} in the Supabase SQL editor, then reload.`;

/** What Settings lists: never the hash. */
export interface McpTokenSummary {
  id: string;
  name: string;
  hint: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

/** Who an authenticated MCP request is. */
export interface McpCaller {
  tokenId: string;
  organizationId: string;
  /** The client's name, as the owner gave it; what the audit trail records. */
  clientName: string;
}

function summarize(row: McpToken): McpTokenSummary {
  const { id, name, hint, created_at, last_used_at, revoked_at } = row;
  return { id, name, hint, created_at, last_used_at, revoked_at };
}

async function guard<T>(operation: string, run: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await run();
  } catch (error) {
    if (isMissingTableError(error) || isMissingColumnError(error)) {
      return err('not_configured', NOT_SET_UP, {
        stillUsable: 'Everything else in Copilot works as before.',
        details: { operation },
      });
    }
    log.error('MCP token operation failed', {
      operation,
      reason: error instanceof Error ? error.message : String(error),
    });
    return err('internal', 'Claude connections could not be read just now.', {
      retryable: true,
      details: { operation },
    });
  }
}

/* ------------------------------------------------------------ token shape */

/** A fresh token for an organization. Exported for tests; use createMcpToken. */
export function mintMcpToken(organizationId: string): string {
  const orgHex = organizationId.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(orgHex)) throw new Error('Organization id is not a uuid.');
  return `${MCP_TOKEN_PREFIX}${orgHex}_${randomBytes(32).toString('base64url')}`;
}

/** The organization a well-formed token names, or null for anything else. */
export function parseMcpToken(token: string): { organizationId: string } | null {
  const match = TOKEN_RE.exec(token);
  if (!match) return null;
  const hex = match[1] as string;
  const organizationId = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
  return { organizationId };
}

export function hashMcpToken(token: string): string {
  return sha256(token);
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/* ------------------------------------------------------------- settings */

/** Every token of the organization, newest first, revoked ones included. */
export async function listMcpTokens(
  store: DataStore,
  organizationId: string,
): Promise<Result<McpTokenSummary[]>> {
  return guard('list MCP tokens', async () => {
    const rows = await store.list(
      'mcp_tokens',
      organizationId,
      {},
      { orderBy: [{ field: 'created_at', direction: 'desc' }], limit: 200 },
    );
    return ok(rows.map(summarize));
  });
}

/**
 * Create a named token. The returned `token` is the only time it exists in
 * the clear: it is not stored, not logged and not audited.
 */
export async function createMcpToken(
  store: DataStore,
  organizationId: string,
  actor: { userId: string | null },
  rawName: string,
  now: Date = new Date(),
): Promise<Result<{ token: string; summary: McpTokenSummary }>> {
  return guard('create an MCP token', async () => {
    const name = (rawName ?? '').replace(/\s+/g, ' ').trim();
    if (!name) return err('invalid_input', 'Give the connection a name, like “claude.ai”.');
    if (name.length > MCP_TOKEN_NAME_MAX) {
      return err('invalid_input', `Keep the name under ${MCP_TOKEN_NAME_MAX} characters.`);
    }
    const live = await store.count('mcp_tokens', organizationId, { isNull: ['revoked_at'] });
    if (live >= MCP_TOKEN_LIMIT) {
      return err(
        'conflict',
        `There are already ${MCP_TOKEN_LIMIT} live connections. Revoke one you no longer use first.`,
      );
    }
    const token = mintMcpToken(organizationId);
    const row: McpToken = {
      id: newId(),
      organization_id: organizationId,
      name,
      token_hash: hashMcpToken(token),
      hint: token.slice(-4),
      created_by: actor.userId,
      created_at: now.toISOString(),
      last_used_at: null,
      revoked_at: null,
    };
    await store.insert('mcp_tokens', row);
    await recordAudit(store, {
      organizationId,
      userId: actor.userId,
      action: 'mcp.token_created',
      entityType: 'mcp_token',
      entityId: row.id,
      metadata: { name, hint: row.hint },
    });
    return ok({ token, summary: summarize(row) });
  });
}

/** Revoke a token for good. Revoking one already revoked is a no-op. */
export async function revokeMcpToken(
  store: DataStore,
  organizationId: string,
  actor: { userId: string | null },
  tokenId: string,
  now: Date = new Date(),
): Promise<Result<McpTokenSummary>> {
  return guard('revoke an MCP token', async () => {
    if (!/^[0-9a-f-]{36}$/i.test(tokenId ?? '')) {
      return err('not_found', 'That connection does not exist.');
    }
    const row = await store.get('mcp_tokens', organizationId, tokenId);
    if (!row) return err('not_found', 'That connection does not exist.');
    if (row.revoked_at) return ok(summarize(row));
    const updated = await store.update('mcp_tokens', organizationId, row.id, {
      revoked_at: now.toISOString(),
    });
    await recordAudit(store, {
      organizationId,
      userId: actor.userId,
      action: 'mcp.token_revoked',
      entityType: 'mcp_token',
      entityId: row.id,
      metadata: { name: row.name, hint: row.hint },
    });
    return ok(summarize(updated));
  });
}

/* ------------------------------------------------------------ the endpoint */

/**
 * Who presented this token, or why not.
 *
 * The row is found by the token's hash within the organization the token
 * names, and the stored hash is then compared in constant time as well. Every
 * refusal is `unauthenticated`; only a revoked token says so, because whoever
 * holds it held a real one. last_used_at is refreshed at most once a minute,
 * best-effort: a failed write never fails the request.
 */
export async function authenticateMcpToken(
  store: DataStore,
  token: string,
  now: Date = new Date(),
): Promise<Result<McpCaller>> {
  const invalid = () => err('unauthenticated', 'That token is not valid for this Copilot.');
  const parsed = parseMcpToken(token ?? '');
  if (!parsed) return invalid();
  return guard('authenticate an MCP token', async () => {
    const hash = hashMcpToken(token);
    const row = await store.findOne('mcp_tokens', parsed.organizationId, {
      eq: { token_hash: hash },
    });
    if (!row || !sameHash(row.token_hash, hash)) return invalid();
    if (row.revoked_at) {
      // Told apart (details.reason) so the endpoint's failed-token brake does
      // not count it: a stale connector is not someone guessing.
      return err('unauthenticated', 'That token has been revoked. Create a new one in Settings.', {
        details: { reason: 'revoked' },
      });
    }
    const last = row.last_used_at ? Date.parse(row.last_used_at) : 0;
    if (!last || now.getTime() - last >= TOUCH_EVERY_MS) {
      try {
        await store.update('mcp_tokens', row.organization_id, row.id, {
          last_used_at: now.toISOString(),
        });
      } catch (error) {
        log.warn('Could not record MCP token use', {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return ok({ tokenId: row.id, organizationId: row.organization_id, clientName: row.name });
  });
}
