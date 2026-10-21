import 'server-only';
import {
  NO_COUNTS,
  type AffinityCounts,
  type AffinityListImportResult,
  type AffinityListRequest,
  type AffinityNotesImportResult,
  type AffinityNotesRequest,
} from '@/lib/crm/affinity-csv';
import { crmNameKey, isCopilotField } from '@/lib/crm/fields';
import { isMissingTableError } from '@/lib/db/missing-table';
import { chunk, listAllPages } from '@/lib/db/paging';
import type { DataStore } from '@/lib/db/store';
import { recordAudit } from '@/lib/security/audit';
import { log } from '@/lib/security/redact';
import {
  CRM_MIGRATION_FILE,
  isCrmNotSetUp,
  matchRecordsByName,
  upsertEntries,
  upsertList,
  upsertNotes,
  upsertRecords,
  type CrmActor,
  type CrmEntryRow,
  type CrmNoteRow,
  type CrmUpsertSummary,
} from '@/lib/services/crm';
import type { CrmField, CrmList } from '@/lib/types/domain';
import { err, ok, type Result } from '@/lib/util/result';

/**
 * The Affinity import: one request of /api/crm/import at a time.
 *
 * The page parses the CSV exports in the browser (lib/crm/affinity-csv.ts)
 * and sends them here in chunks; this turns a chunk into the CRM service's
 * upserts, in the order they depend on each other — the list, then the
 * records its rows are about, then the rows — and reports how every row
 * fared. Every step is an idempotent upsert on natural keys, so a chunk
 * retried after a timeout, or a whole file imported twice, writes nothing
 * new the second time.
 *
 * Notes are linked by name: the names a note is attached to are matched
 * against the companies and people already imported (and against deal rows,
 * for notes on opportunities), which is why the page imports lists first.
 * A name that matches nothing, or more than one record, is kept on the note
 * as text rather than guessed at.
 */

const NOT_SET_UP = `Nothing was saved: the CRM tables do not exist yet. Run ${CRM_MIGRATION_FILE} in the Supabase SQL editor, then try again.`;

function notSetUp(): Result<never> {
  return err('not_configured', NOT_SET_UP, {
    stillUsable: 'Everything outside the CRM works as before.',
  });
}

function countsOf(summary: CrmUpsertSummary): AffinityCounts {
  const { inserted, updated, unchanged, skipped, errors } = summary;
  return { inserted, updated, unchanged, skipped, errors };
}

/** Problems once each, in row order. */
function tidy(problems: { row: number; message: string }[]) {
  const seen = new Set<string>();
  return problems
    .filter((p) => {
      const key = `${p.row}\u0000${p.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.row - b.row)
    .slice(0, 100);
}

/**
 * The list's key for each field the request sent. A re-imported column keeps
 * the key it was first stored under (mergeCrmFields matches by key, then by
 * label), so the request's keys are looked up the same way in the list the
 * upsert returned — passing over a column added in Copilot on an Affinity
 * list, as mergeCrmFields does, so the file's values never land in it.
 */
function fieldKeys(sent: readonly CrmField[], list: CrmList): Map<string, string> {
  const out = new Map<string, string>();
  const stored = list.fields.filter((f) => list.source === 'copilot' || !isCopilotField(f));
  for (const field of sent) {
    const label = field.name.trim().toLowerCase();
    const match =
      stored.find((f) => f.key === field.key) ??
      stored.find((f) => f.name.trim().toLowerCase() === label);
    if (match) out.set(field.key, match.key);
  }
  return out;
}

/** Import one chunk of a list export: the list, the records, then the rows. */
export async function importAffinityList(
  store: DataStore,
  organizationId: string,
  request: AffinityListRequest,
  actor?: CrmActor,
): Promise<Result<AffinityListImportResult>> {
  const upserted = await upsertList(store, organizationId, {
    id: request.list.id ?? null,
    externalId: request.list.externalId ?? null,
    name: request.list.name,
    entityType: request.list.entityType,
    fields: request.list.fields,
  });
  if (!upserted.ok) return upserted;
  const { list, created, updated } = upserted.value;
  const problems: { row: number; message: string }[] = [];

  let recordIds: (string | null)[] = [];
  let records: AffinityCounts = NO_COUNTS;
  if (request.records.length) {
    // A deal list's records are the companies its deals are with.
    const kind = list.entity_type === 'person' ? 'person' : 'company';
    const result = await upsertRecords(store, organizationId, kind, request.records);
    if (!result.ok) return result;
    recordIds = result.value.ids;
    records = countsOf(result.value);
    // A record's problem is reported against the first row that points at it.
    for (const p of result.value.problems) {
      const row = request.entries.findIndex((e) => e.record === p.row);
      if (row >= 0) problems.push({ row, message: p.message });
    }
  }

  const keys = fieldKeys(request.list.fields, list);
  const rows: CrmEntryRow[] = request.entries.map((entry) => {
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(entry.values ?? {})) {
      // An unknown key passes through, for upsertEntries to drop and report.
      values[keys.get(key) ?? key] = value;
    }
    return {
      externalId: entry.externalId ?? null,
      title: entry.title ?? null,
      recordId: typeof entry.record === 'number' ? (recordIds[entry.record] ?? null) : null,
      values,
    };
  });
  const entries = await upsertEntries(store, organizationId, list.id, rows);
  if (!entries.ok) return entries;
  problems.push(...entries.value.problems);

  const result: AffinityListImportResult = {
    list: { id: list.id, name: list.name, created, updated },
    records,
    entries: countsOf(entries.value),
    keptEdits: entries.value.keptEdits,
    problems: tidy(problems),
  };
  await recordAudit(store, {
    organizationId,
    userId: actor?.userId ?? null,
    action: 'crm.imported',
    entityType: 'crm_list',
    entityId: list.id,
    metadata: {
      kind: 'list',
      source: 'affinity',
      list_created: created,
      rows: request.entries.length,
      kept_edits: result.keptEdits,
      ...prefixed('entries', result.entries),
      ...prefixed('records', records),
    },
  });
  return ok(result);
}

function prefixed(prefix: string, counts: AffinityCounts): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).map(([k, v]) => [`${prefix}_${k}`, v]));
}

/* ------------------------------------------------------------------ notes */

/**
 * Deal rows by title, case-insensitively, across every deal list: a note on
 * an Affinity opportunity names the opportunity, which is a row here, not a
 * company or person.
 */
async function dealEntriesByTitle(
  store: DataStore,
  organizationId: string,
  names: readonly string[],
): Promise<Result<Map<string, string[]>>> {
  try {
    const out = new Map<string, string[]>();
    const titles = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
    if (!titles.length) return ok(out);
    const lists = await listAllPages(store, 'crm_lists', organizationId, {
      eq: { entity_type: 'deal' },
    });
    if (!lists.length) return ok(out);
    const listIds = lists.map((l) => l.id);
    // Fifty names a request keeps the `in (...)` list well inside URL limits.
    for (const group of chunk(titles, 50)) {
      for (const entry of await listAllPages(store, 'crm_list_entries', organizationId, {
        in: { list_id: listIds, title: group },
      })) {
        const key = crmNameKey(entry.title);
        const ids = out.get(key) ?? [];
        if (!ids.includes(entry.id)) ids.push(entry.id);
        out.set(key, ids);
      }
    }
    return ok(out);
  } catch (error) {
    if (isMissingTableError(error)) return notSetUp();
    log.error('CRM import could not match deal rows', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return err('internal', 'The notes could not be linked just now. Try again.', {
      retryable: true,
    });
  }
}

/**
 * Import one chunk of a notes export, linking each note to the records and
 * deal rows its names match. A cell like "Acme Robotics, Brightlane" may be
 * two names joined with a comma; it is split only when every part matches,
 * since a comma also sits inside names ("Acme, Inc.").
 */
export async function importAffinityNotes(
  store: DataStore,
  organizationId: string,
  request: AffinityNotesRequest,
  actor?: CrmActor,
): Promise<Result<AffinityNotesImportResult>> {
  const commaParts = (name: string) =>
    name.includes(',')
      ? name
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean)
      : [];
  const candidates = new Set<string>();
  for (const note of request.notes) {
    for (const name of note.entityNames ?? []) {
      candidates.add(name);
      for (const part of commaParts(name)) candidates.add(part);
    }
  }

  const records = await matchRecordsByName(store, organizationId, [...candidates]);
  if (!records.ok) return isCrmNotSetUp(records) ? notSetUp() : records;
  const deals = await dealEntriesByTitle(store, organizationId, [...candidates]);
  if (!deals.ok) return deals;

  const lookup = (name: string) => {
    const key = crmNameKey(name);
    const recordIds = records.value[key] ?? [];
    const entryIds = deals.value.get(key) ?? [];
    return {
      record: recordIds.length === 1 ? recordIds[0] : undefined,
      entry: entryIds.length === 1 ? entryIds[0] : undefined,
      ambiguous: recordIds.length > 1 || entryIds.length > 1,
    };
  };

  const unmatched = new Set<string>();
  const ambiguous = new Set<string>();
  const rows: (CrmNoteRow & { recordIds: string[]; entryIds: string[] })[] = request.notes.map(
    (note) => {
      const recordIds = new Set<string>();
      const entryIds = new Set<string>();
      const names: string[] = [];
      const link = (hit: ReturnType<typeof lookup>) => {
        if (hit.record) recordIds.add(hit.record);
        if (hit.entry) entryIds.add(hit.entry);
        return Boolean(hit.record || hit.entry);
      };
      for (const name of note.entityNames ?? []) {
        const whole = lookup(name);
        if (link(whole)) {
          names.push(name);
          continue;
        }
        const parts = commaParts(name);
        const hits = parts.map(lookup);
        if (parts.length > 1 && hits.every((h) => h.record || h.entry)) {
          hits.forEach(link);
          names.push(...parts);
          continue;
        }
        names.push(name);
        (whole.ambiguous ? ambiguous : unmatched).add(crmNameKey(name));
      }
      return {
        externalId: note.externalId,
        content: note.content,
        author: note.author ?? null,
        occurredAt: note.occurredAt ?? null,
        entityNames: names,
        recordIds: [...recordIds],
        entryIds: [...entryIds],
      };
    },
  );

  const upserted = await upsertNotes(store, organizationId, rows);
  if (!upserted.ok) return upserted;
  const summary = upserted.value;
  const result: AffinityNotesImportResult = {
    notes: countsOf(summary),
    linked: rows.filter((r, i) => summary.ids[i] && (r.recordIds.length || r.entryIds.length))
      .length,
    unmatchedNames: unmatched.size,
    ambiguousNames: ambiguous.size,
    problems: tidy(summary.problems),
  };
  await recordAudit(store, {
    organizationId,
    userId: actor?.userId ?? null,
    action: 'crm.imported',
    entityType: 'crm_note',
    entityId: null,
    metadata: {
      kind: 'notes',
      source: 'affinity',
      rows: request.notes.length,
      linked: result.linked,
      ...prefixed('notes', result.notes),
    },
  });
  return ok(result);
}
