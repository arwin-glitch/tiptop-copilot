'use server';

import { z } from 'zod';
import { requireAuth, requireRole, type AuthContext } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import {
  addEntry,
  addListField,
  addNote,
  addRecordsToList,
  affinitySyncIsOn,
  createList,
  createRecord,
  crmActor,
  CRM_BULK_ADD_MAX,
  deleteNote,
  getEntry,
  listCrmLists,
  removeEntry,
  restoreEntry,
  saveViewAsList,
  searchRecords,
  updateEntryValues,
  updateList,
  updateNote,
  updateStatusOptions,
  type CrmBulkAdd,
  type CrmEntryDetail,
  type CrmRecordSummary,
} from '@/lib/services/crm';
import { findCrmRecords } from '@/lib/services/crm-finder';
import { getPrimaryIntegration } from '@/lib/services/inbox';
import { relationshipScope } from '@/lib/services/relationships';
import { rateLimit } from '@/lib/security/limits';
import { setListDestination } from '@/lib/services/crm-destinations';
import { isCrmDestination, type CrmListDestination } from '@/lib/crm/destinations';
import { CRM_COPILOT_FIELD_TYPES } from '@/lib/crm/fields';
import { normalizeFinderCriteria } from '@/lib/crm/finder';
import type { CrmViewCondition } from '@/lib/crm/saved-views';
import type {
  CrmEntityType,
  CrmField,
  CrmListEntry,
  CrmNote,
  CrmRecordKind,
} from '@/lib/types/domain';
import type { AppError } from '@/lib/util/result';
import type { ActionResult } from './index';

/**
 * Server actions for the CRM: the Affinity lists, list pages and profiles.
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
 * Archive a list, or bring it back. Archiving hides it from the Affinity
 * lists and every page it fed, and keeps every row, so a list imported by
 * mistake can be put away and restored.
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

/**
 * Send a list's rows to another page (Knowledge → Affinity lists), or with
 * `null` put it back where its name says. Kept per list as an audit row; see
 * lib/services/crm-destinations.ts.
 */
export async function setCrmListDestinationAction(
  listId: string,
  destination: string | null,
): Promise<ActionResult<{ destination: CrmListDestination }>> {
  const { auth, denied } = await writer();
  if (denied) return denied;
  const chosen = destination === null || destination === '' ? null : destination;
  if (chosen !== null && !isCrmDestination(chosen)) {
    return fail({ code: 'invalid_input', message: 'That is not one of the places a list can go.' });
  }
  const result = await setListDestination(
    getStore(),
    auth.organizationId,
    String(listId ?? ''),
    chosen,
    crmActor(auth),
  );
  if (!result.ok) return fail(result.error);
  return succeed({ destination: result.value });
}

/* ------------------------------------------------------- CRM write parity */
//
// What keeps the CRM growing once Affinity is gone: new lists (empty, from a
// list's view, or from Find & save), new companies and people, columns,
// notes that can be edited and deleted, and taking a row off a list with
// Undo. The same floor as every write above; inputs are checked with zod
// before anything reaches the service.

const invalid = (message: string): ActionResult<never> => fail({ code: 'invalid_input', message });

const ENTITY = z.enum(['company', 'person', 'deal']);
const LIST_NAME = z.string().trim().min(1).max(300);

/** A new, empty list. */
export async function createCrmListAction(input: {
  name: string;
  entityType: CrmEntityType;
}): Promise<ActionResult<{ id: string; name: string }>> {
  const { auth, denied } = await writer();
  if (denied) return denied;
  const parsed = z.object({ name: LIST_NAME, entityType: ENTITY }).safeParse(input);
  if (!parsed.success) {
    return invalid('Name the list, and say whether it holds companies, people or deals.');
  }
  const result = await createList(getStore(), auth.organizationId, parsed.data, crmActor(auth));
  if (!result.ok) return fail(result.error);
  return succeed({ id: result.value.id, name: result.value.name });
}

const CONDITION = z.object({
  key: z.string().max(80),
  op: z.string().max(20),
  value: z.union([z.string().max(500), z.number()]).optional(),
  values: z.array(z.string().max(500)).max(200).optional(),
});

/** "Save as list": the rows a list's view shows, as a new list of the same kind. */
export async function saveCrmViewAsListAction(
  sourceListId: string,
  input: {
    name: string;
    q?: string;
    statuses?: string[];
    conditions?: unknown[];
    sort?: string;
    dir?: 'asc' | 'desc';
  },
): Promise<ActionResult<{ id: string; name: string; added: number; truncated: boolean }>> {
  const { auth, denied } = await writer();
  if (denied) return denied;
  const parsed = z
    .object({
      sourceListId: z.uuid(),
      name: LIST_NAME,
      q: z.string().max(200).optional(),
      statuses: z.array(z.string().max(500)).max(50).optional(),
      conditions: z.array(CONDITION).max(40).optional(),
      sort: z.string().max(60).optional(),
      dir: z.enum(['asc', 'desc']).optional(),
    })
    .safeParse({ ...input, sourceListId });
  if (!parsed.success) return invalid('Name the new list.');
  const { name, q, statuses, conditions, sort, dir } = parsed.data;
  const result = await saveViewAsList(
    getStore(),
    auth.organizationId,
    parsed.data.sourceListId,
    {
      name,
      query: {
        query: q || null,
        statusIn: statuses ?? null,
        // Checked against the list's own fields by the service (normalizeConditions).
        conditions: (conditions ?? []) as CrmViewCondition[],
        sortKey: sort || null,
        sortDir: dir ?? null,
      },
    },
    crmActor(auth),
  );
  if (!result.ok) return fail(result.error);
  const { list, added, truncated } = result.value;
  return succeed({ id: list.id, name: list.name, added, truncated });
}

/** A column added in Kraken (a custom field), at the end of the list's columns. */
export async function addCrmListFieldAction(
  listId: string,
  input: { name: string; type: string; options?: string[] },
): Promise<ActionResult<{ field: CrmField }>> {
  const { auth, denied } = await writer();
  if (denied) return denied;
  const parsed = z
    .object({
      listId: z.uuid(),
      name: z.string().trim().min(1).max(200),
      type: z.enum(CRM_COPILOT_FIELD_TYPES),
      options: z.array(z.string().max(200)).max(200).optional(),
    })
    .safeParse({ ...input, listId });
  if (!parsed.success) return invalid('Name the column and pick what kind it is.');
  const result = await addListField(
    getStore(),
    auth.organizationId,
    parsed.data.listId,
    { name: parsed.data.name, type: parsed.data.type, options: parsed.data.options ?? [] },
    crmActor(auth),
  );
  if (!result.ok) return fail(result.error);
  return succeed({ field: result.value.field });
}

/** Take a row off its list; the tombstone id is what Undo hands back. */
export async function removeCrmEntryAction(
  entryId: string,
): Promise<ActionResult<{ tombstoneId: string; title: string }>> {
  const { auth, denied } = await writer();
  if (denied) return denied;
  const result = await removeEntry(
    getStore(),
    auth.organizationId,
    String(entryId ?? ''),
    crmActor(auth),
  );
  if (!result.ok) return fail(result.error);
  return succeed({ tombstoneId: result.value.tombstoneId, title: result.value.title });
}

/** Undo a removal: the row goes back as it was. */
export async function restoreCrmEntryAction(
  tombstoneId: string,
): Promise<ActionResult<{ entry: CrmListEntry }>> {
  const { auth, denied } = await writer();
  if (denied) return denied;
  const result = await restoreEntry(
    getStore(),
    auth.organizationId,
    String(tombstoneId ?? ''),
    crmActor(auth),
  );
  if (!result.ok) return fail(result.error);
  return succeed({ entry: result.value });
}

/** Change a note's text. Affinity's notes are refused while the sync runs, and say why. */
export async function updateCrmNoteAction(
  noteId: string,
  input: { content: string },
): Promise<ActionResult<{ note: CrmNote }>> {
  const { auth, denied } = await writer();
  if (denied) return denied;
  const result = await updateNote(
    getStore(),
    auth.organizationId,
    String(noteId ?? ''),
    { content: String(input?.content ?? '') },
    crmActor(auth),
    { affinitySyncOn: affinitySyncIsOn() },
  );
  if (!result.ok) return fail(result.error);
  return succeed({ note: result.value });
}

/** Delete a note, under the same rule as editing one. */
export async function deleteCrmNoteAction(noteId: string): Promise<ActionResult<{ id: string }>> {
  const { auth, denied } = await writer();
  if (denied) return denied;
  const result = await deleteNote(
    getStore(),
    auth.organizationId,
    String(noteId ?? ''),
    crmActor(auth),
    { affinitySyncOn: affinitySyncIsOn() },
  );
  if (!result.ok) return fail(result.error);
  return succeed({ id: result.value.id });
}

const NEW_RECORD = z.object({
  kind: z.enum(['company', 'person']),
  name: z.string().max(500).optional(),
  domain: z.string().max(300).optional(),
  email: z.string().max(320).optional(),
  location: z.string().max(300).optional(),
  listId: z.uuid().nullish(),
});

/**
 * A new company or person. One already in the CRM (the same domain, the same
 * email, or with neither the same name) comes back as `existed`, for the page
 * to open instead. With `listId` the record is also put on that list.
 */
export async function createCrmRecordAction(input: {
  kind: CrmRecordKind;
  name?: string;
  domain?: string;
  email?: string;
  location?: string;
  listId?: string | null;
}): Promise<
  ActionResult<{
    record: CrmRecordSummary;
    existed: boolean;
    matchedBy: 'domain' | 'email' | 'name' | null;
    entry: CrmListEntry | null;
  }>
> {
  const { auth, denied } = await writer();
  if (denied) return denied;
  const parsed = NEW_RECORD.safeParse(input);
  if (!parsed.success) return invalid('Give a name, a website or an email address.');
  const store = getStore();
  const { listId, ...fields } = parsed.data;
  const created = await createRecord(store, auth.organizationId, fields, crmActor(auth));
  if (!created.ok) return fail(created.error);
  const { record, existed, matchedBy } = created.value;
  let entry: CrmListEntry | null = null;
  if (listId) {
    const added = await addEntry(
      store,
      auth.organizationId,
      listId,
      { recordId: record.id },
      crmActor(auth),
    );
    // Already on the list is no failure: the page says so and opens nothing new.
    if (!added.ok && added.error.code !== 'conflict') return fail(added.error);
    entry = added.ok ? added.value : null;
  }
  const { id, kind, name, domain, primary_email } = record;
  return succeed({ record: { id, kind, name, domain, primary_email }, existed, matchedBy, entry });
}

/** Put companies or people on a list (the profile's "Add to list"). */
export async function addCrmRecordsToListAction(
  listId: string,
  recordIds: string[],
): Promise<ActionResult<CrmBulkAdd>> {
  const { auth, denied } = await writer();
  if (denied) return denied;
  const parsed = z
    .object({ listId: z.uuid(), recordIds: z.array(z.uuid()).min(1).max(CRM_BULK_ADD_MAX) })
    .safeParse({ listId, recordIds });
  if (!parsed.success) return invalid('Pick a list and who to add to it.');
  const result = await addRecordsToList(
    getStore(),
    auth.organizationId,
    parsed.data.listId,
    parsed.data.recordIds,
    crmActor(auth),
  );
  if (!result.ok) return fail(result.error);
  return succeed(result.value);
}

/** The lists a company or a person can be put on, for the "Add to list" pickers. */
export async function crmListsForAction(
  kind: CrmRecordKind,
): Promise<ActionResult<CrmListChoice[]>> {
  const auth = await requireAuth();
  const result = await listCrmLists(getStore(), auth.organizationId);
  if (!result.ok) return fail(result.error);
  const entity: CrmEntityType = kind === 'person' ? 'person' : 'company';
  return succeed(
    result.value
      .filter((l) => l.entity_type === entity)
      .map((l) => ({ id: l.id, name: l.name, entryCount: l.entry_count, source: l.source })),
  );
}

const FINDER = z.object({
  kind: z.enum(['company', 'person']),
  q: z.string().max(200).optional(),
  place: z.string().max(200).optional(),
  years: z.number().int().min(1).max(20).nullish(),
  listId: z.uuid().nullish(),
});

/** A list someone can put a company or person on. */
export interface CrmListChoice {
  id: string;
  name: string;
  entryCount: number;
  source: 'affinity' | 'copilot';
}

/** Find & save's criteria as the page sends them (lib/crm/finder.ts). */
export interface CrmFinderInput {
  kind: CrmRecordKind;
  q?: string;
  place?: string;
  years?: number | null;
  listId?: string | null;
}

/** Every id Find & save matches for these criteria, worked out again on the server. */
async function finderIds(
  auth: AuthContext,
  input: CrmFinderInput,
): Promise<
  { ids: string[]; denied?: undefined } | { ids?: undefined; denied: ActionResult<never> }
> {
  const parsed = FINDER.safeParse(input);
  if (!parsed.success) return { denied: invalid('That search could not be read. Search again.') };
  const criteria = normalizeFinderCriteria(parsed.data);
  const store = getStore();
  const integration = await getPrimaryIntegration(store, auth.organizationId).catch(() => null);
  const found = await findCrmRecords(store, auth.organizationId, criteria, {
    scope: relationshipScope(auth.profile.email, integration),
    limit: CRM_BULK_ADD_MAX,
  });
  if (!found.ok) return { denied: fail(found.error) };
  if (found.value.needsNarrowing) {
    return { denied: invalid('Search by a name, a place or a list first.') };
  }
  return { ids: found.value.ids.slice(0, CRM_BULK_ADD_MAX) };
}

/** Find & save → "Save as list": every match, as a new list. */
export async function saveFinderAsListAction(
  input: CrmFinderInput,
  name: string,
): Promise<ActionResult<{ id: string; name: string; added: number }>> {
  const { auth, denied } = await writer();
  if (denied) return denied;
  const listName = LIST_NAME.safeParse(name);
  if (!listName.success) return invalid('Name the new list.');
  const found = await finderIds(auth, input);
  if (found.denied) return found.denied;
  if (!found.ids.length)
    return invalid('Nothing matches this search, so there is nothing to save.');
  const store = getStore();
  const created = await createList(
    store,
    auth.organizationId,
    { name: listName.data, entityType: input.kind === 'company' ? 'company' : 'person' },
    crmActor(auth),
  );
  if (!created.ok) return fail(created.error);
  const added = await addRecordsToList(
    store,
    auth.organizationId,
    created.value.id,
    found.ids,
    crmActor(auth),
  );
  if (!added.ok) return fail(added.error);
  return succeed({ id: created.value.id, name: created.value.name, added: added.value.added });
}

/** Find & save → "Add to list": every match, onto a list that already exists. */
export async function addFinderToListAction(
  input: CrmFinderInput,
  listId: string,
): Promise<ActionResult<CrmBulkAdd>> {
  const { auth, denied } = await writer();
  if (denied) return denied;
  if (!z.uuid().safeParse(listId).success) return invalid('Pick a list to add them to.');
  const found = await finderIds(auth, input);
  if (found.denied) return found.denied;
  const result = await addRecordsToList(
    getStore(),
    auth.organizationId,
    listId,
    found.ids,
    crmActor(auth),
  );
  if (!result.ok) return fail(result.error);
  return succeed(result.value);
}
