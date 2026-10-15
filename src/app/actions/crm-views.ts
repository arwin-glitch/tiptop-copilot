'use server';

import { requireAuth, requireRole, type AuthContext } from '@/lib/auth/session';
import type { CrmSavedView } from '@/lib/crm/saved-views';
import { getStore } from '@/lib/runtime';
import { rateLimit } from '@/lib/security/limits';
import { crmActor } from '@/lib/services/crm';
import { deleteView, saveView } from '@/lib/services/crm-views';
import type { AppError } from '@/lib/util/result';
import type { ActionResult } from './index';

/**
 * Server actions for a list's saved views. A file of their own beside
 * `actions/crm.ts`, on its rules: authenticate first, views are shared by
 * everyone on the list so saving one needs the member role, and everything
 * is delegated to `lib/services/crm-views`, whose Result comes back as an
 * ActionResult — never a throw.
 */

function fail(error: AppError): ActionResult<never> {
  return {
    ok: false,
    error: { message: error.message, code: error.code, stillUsable: error.stillUsable },
  };
}

async function writer(): Promise<
  { auth: AuthContext; denied?: undefined } | { auth?: undefined; denied: ActionResult<never> }
> {
  const auth = await requireAuth();
  const role = requireRole(auth, 'member');
  if (!role.ok) return { denied: fail(role.error) };
  const limited = rateLimit(`crm-views:${auth.userId}`, 60, 60_000);
  if (!limited.ok) return { denied: fail(limited.error) };
  return { auth };
}

/**
 * Save a view: a new one (no `id`, a `name` required), or an existing one
 * re-saved with the page's current state and/or renamed. The state is
 * checked against the list on the server, whatever the page sent.
 */
export async function saveCrmViewAction(
  listId: string,
  input: { id?: string | null; name?: string | null; state?: unknown },
): Promise<ActionResult<{ view: CrmSavedView }>> {
  const { auth, denied } = await writer();
  if (denied) return denied;
  const result = await saveView(
    getStore(),
    auth.organizationId,
    String(listId ?? ''),
    {
      id: typeof input?.id === 'string' ? input.id : null,
      name: typeof input?.name === 'string' ? input.name : undefined,
      state: input?.state,
    },
    crmActor(auth),
  );
  if (!result.ok) return fail(result.error);
  return { ok: true, data: { view: result.value.view } };
}

export async function deleteCrmViewAction(
  listId: string,
  viewId: string,
): Promise<ActionResult<{ deleted: string }>> {
  const { auth, denied } = await writer();
  if (denied) return denied;
  const result = await deleteView(
    getStore(),
    auth.organizationId,
    String(listId ?? ''),
    String(viewId ?? ''),
    crmActor(auth),
  );
  if (!result.ok) return fail(result.error);
  return { ok: true, data: { deleted: String(viewId) } };
}
