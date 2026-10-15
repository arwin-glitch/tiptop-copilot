'use server';

import { requireAuth, requireRole, type AuthContext } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import {
  addEntry,
  addNote,
  crmActor,
  getEntry,
  searchRecords,
  updateEntryValues,
  updateList,
  updateStatusOptions,
  type CrmEntryDetail,
  type CrmRecordSummary,
} from '@/lib/services/crm';
import { rateLimit } from '@/lib/security/limits';
import type { CrmListEntry, CrmNote, CrmRecordKind } from '@/lib/types/domain';
import type { AppError } from '@/lib/util/result';
import type { ActionResult } from './index';

/**
 * Server actions for the Lists pages.
 *
 * A file of their own rather than more of `actions/index.ts`, which is the
 * deal and inbox boundary; the rules are the same. Every action authenticates
 * first, writes need the member role (the same floor the CRM tables' row-level
 * security sets), and everything is delegated to `lib/services/crm`, whose
 * Result comes back as a discriminated ActionResult — never a throw, so a
 * missing table reads as "nothing was saved" rather than an error boundary.
 */

function fail(error: AppError): ActionResult<never> {
  return {
    ok: false,
    error: { message: error.message, code: error.code, stillUsable: error.stillUsable },
  };
}

function succeed<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

/** Signed in, a member or above, and not hammering the store. */
async function writer(): Promise<
  { auth: AuthContext; denied?: undefined } | { auth?: undefined; denied: ActionResult<never> }
> {
  const auth = await requireAuth();
  const role = requireRole(auth, 'member');
  if (!role.ok) return { denied: fail(role.error) };
  // Generous: a status sweep down a board is a click a second.
  const limited = rateLimit(`crm-write:${auth.userId}`, 120, 60_000);
  if (!limited.ok) return { denied: fail(limited.error) };
  return { auth };
}

/** Set some of an entry's values — a status change is `{ status: '5. Diligence' }`. */
export async function setCrmEntryValuesAction(
  entryId: string,
  patch: Record<string, unknown>,
): Promise<ActionResult<{ entry: CrmListEntry }>> {
  const { auth, denied } = await writer();
  if (denied) return denied;
  const result = await updateEntryValues(
    getStore(),
    auth.organizationId,
    entryId,
    patch,
    crmActor(auth),
  );
  if (!result.ok) return fail(result.error);
  return succeed({ entry: result.value });
}

/** One entry with its record and notes, for the side panel. */
export async function getCrmEntryAction(entryId: string): Promise<ActionResult<CrmEntryDetail>> {
  const auth = await requireAuth();
  const result = await getEntry(getStore(), auth.organizationId, entryId);
  if (!result.ok) return fail(result.error);
  return succeed(result.value);
}

export async function addCrmNoteAction(input: {
  content: string;
  entryIds?: string[];
  recordIds?: string[];
}): Promise<ActionResult<{ note: CrmNote }>> {
  const { auth, denied } = await writer();
  if (denied) return denied;
  const result = await addNote(
    getStore(),
    auth.organizationId,
    {
      content: String(input.content ?? ''),
      entryIds: Array.isArray(input.entryIds) ? input.entryIds : [],
      recordIds: Array.isArray(input.recordIds) ? input.recordIds : [],
    },
    crmActor(auth),
  );
  if (!result.ok) return fail(result.error);
  return succeed({ note: result.value });
}

export async function addCrmEntryAction(
  listId: string,
  input: { recordId?: string | null; title?: string | null; values?: Record<string, unknown> },
): Promise<ActionResult<{ entry: CrmListEntry }>> {
  const { auth, denied } = await writer();
  if (denied) return denied;
  const result = await addEntry(
    getStore(),
    auth.organizationId,
    listId,
    {
      recordId: input.recordId || null,
      title: input.title ?? null,
      values: input.values ?? {},
    },
    crmActor(auth),
  );
  if (!result.ok) return fail(result.error);
  return succeed({ entry: result.value });
}

/** Companies or people by name, domain or email, for the "Add entry" picker. */
export async function searchCrmRecordsAction(
  q: string,
  kind?: CrmRecordKind,
): Promise<ActionResult<CrmRecordSummary[]>> {
  const auth = await requireAuth();
  const limited = rateLimit(`crm-search:${auth.userId}`, 120, 60_000);
  if (!limited.ok) return fail(limited.error);
  const result = await searchRecords(
    getStore(),
    auth.organizationId,
    String(q ?? ''),
    8,
    kind === 'company' || kind === 'person' ? kind : undefined,
  );
  if (!result.ok) return fail(result.error);
  return succeed(
    result.value.map(({ id, kind: k, name, domain, primary_email }) => ({
      id,
      kind: k,
      name,
      domain,
      primary_email,
    })),
  );
}

/**
 * Archive a list, or bring it back. Archiving hides it from Lists and keeps
 * every row, so a list imported by mistake can be put away and restored.
 */
export async function setCrmListArchivedAction(
  listId: string,
  archived: boolean,
): Promise<ActionResult<{ archived: boolean }>> {
  const { auth, denied } = await writer();
  if (denied) return denied;
  const result = await updateList(
    getStore(),
    auth.organizationId,
    listId,
    { archived: Boolean(archived) },
    crmActor(auth),
  );
  if (!result.ok) return fail(result.error);
  return succeed({ archived: result.value.archived });
}

/** A status field's stages, in order: added, reordered, or unused ones removed. */
export async function setCrmStatusOptionsAction(
  listId: string,
  fieldKey: string,
  options: string[],
): Promise<ActionResult<{ options: string[] }>> {
  const { auth, denied } = await writer();
  if (denied) return denied;
  const result = await updateStatusOptions(
    getStore(),
    auth.organizationId,
    listId,
    String(fieldKey ?? ''),
    Array.isArray(options) ? options.filter((o): o is string => typeof o === 'string') : [],
    crmActor(auth),
  );
  if (!result.ok) return fail(result.error);
  const field = result.value.fields.find((f) => f.key === fieldKey);
  return succeed({ options: field?.options ?? [] });
}
