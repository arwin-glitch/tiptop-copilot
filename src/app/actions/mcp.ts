'use server';

import { requireAuth, requireRole, type AuthContext } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { rateLimit } from '@/lib/security/limits';
import {
  createMcpToken,
  listMcpTokens,
  revokeMcpToken,
  type McpTokenSummary,
} from '@/lib/services/mcp-tokens';
import type { AppError } from '@/lib/util/result';
import type { ActionResult } from './index';

/**
 * Settings → Connect Claude (MCP): create, list and revoke connector tokens.
 *
 * Owners only. A token reads the whole CRM, LP stages and notes included, so
 * handing one out is an owner's decision, like connecting the mailbox.
 */

function fail(error: Pick<AppError, 'code' | 'message' | 'stillUsable'>): ActionResult<never> {
  return {
    ok: false,
    error: { message: error.message, code: error.code, stillUsable: error.stillUsable },
  };
}

async function owner(): Promise<
  { auth: AuthContext; denied?: undefined } | { auth?: undefined; denied: ActionResult<never> }
> {
  const auth = await requireAuth();
  const role = requireRole(auth, 'owner');
  if (!role.ok) return { denied: fail(role.error) };
  const limited = rateLimit(`mcp-tokens:${auth.userId}`, 30, 60_000);
  if (!limited.ok) return { denied: fail(limited.error) };
  return { auth };
}

export async function listMcpTokensAction(): Promise<ActionResult<McpTokenSummary[]>> {
  const { auth, denied } = await owner();
  if (denied) return denied;
  const result = await listMcpTokens(getStore(), auth.organizationId);
  if (!result.ok) return fail(result.error);
  return { ok: true, data: result.value };
}

/** The token comes back once, here, and is never stored or shown again. */
export async function createMcpTokenAction(
  name: string,
): Promise<ActionResult<{ token: string; summary: McpTokenSummary }>> {
  const { auth, denied } = await owner();
  if (denied) return denied;
  const result = await createMcpToken(
    getStore(),
    auth.organizationId,
    { userId: auth.userId },
    typeof name === 'string' ? name : '',
  );
  if (!result.ok) return fail(result.error);
  return { ok: true, data: result.value };
}

export async function revokeMcpTokenAction(
  tokenId: string,
): Promise<ActionResult<McpTokenSummary>> {
  const { auth, denied } = await owner();
  if (denied) return denied;
  const result = await revokeMcpToken(
    getStore(),
    auth.organizationId,
    { userId: auth.userId },
    typeof tokenId === 'string' ? tokenId : '',
  );
  if (!result.ok) return fail(result.error);
  return { ok: true, data: result.value };
}
