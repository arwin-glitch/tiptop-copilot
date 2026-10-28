'use client';

import * as React from 'react';
import Link from 'next/link';
import { CheckCircle2, FileSpreadsheet, Handshake, StickyNote, Upload, X } from 'lucide-react';
import {
  addCounts,
  buildListImport,
  buildNotesImport,
  defaultListName,
  detectAffinityMapping,
  detectListMapping,
  listFieldColumns,
  mappingProblems,
  mappingWarnings,
  NO_COUNTS,
  parseAffinityCsv,
  suggestTargetList,
  type AffinityColumnType,
  type AffinityCounts,
  type AffinityCsv,
  type AffinityExistingList,
  type AffinityFileKind,
  type AffinityImportRequest,
  type AffinityListImportResult,
  type AffinityListMapping,
  type AffinityMapping,
  type AffinityNotesImportResult,
  type AffinityNotesMapping,
  type AffinityRowProblem,
  type AffinityTableKind,
} from '@/lib/crm/affinity-csv';
import {
  buildIntroductionsImport,
  readAffinityIntroductions,
  SECTION_LABELS,
  type AffinityIntroductionsImportResult,
  type AffinityIntroductionsMapping,
} from '@/lib/crm/affinity-introductions';
import { crmNameKey } from '@/lib/crm/fields';
import type { CrmEntityType } from '@/lib/types/domain';
import { cn } from '@/lib/util/cn';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  FieldLabel,
} from '@/components/ui/card';
import { ErrorState, Notice } from '@/components/ui/feedback';
import { Field, Input, Select } from '@/components/ui/form';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from '@/components/ui/table';

/**
 * The Affinity importer: drop CSV exports, check how each was read, import.
 *
 * Everything up to the Import button happens in the browser — parsing, the
 * guesses about which column is which, the preview — so a person can drop a
 * 4,700-row export and correct a column type without a round trip. The
 * import itself sends chunks of 200 rows to /api/crm/import, one at a time,
 * lists before notes (notes link to the companies, people and deals the lists
 * brought in). Every chunk is an idempotent upsert, so a retry, a stopped
 * import run again, or the same file dropped twice does not add its rows a
 * second time; a value someone has changed in Kraken since is kept, and the
 * summary says so.
 *
 * Which list a file updates is the person's choice, offered from the lists
 * already here and pre-chosen when the file looks like one of them (a second
 * saved view of a list is named "<list> - <view>.csv").
 */

const ENTITY_LABEL: Record<CrmEntityType, string> = {
  company: 'Companies',
  person: 'People',
  deal: 'Deals',
};

/** What a list's records are: a deal list's rows link to companies. */
const RECORD_LABEL: Record<CrmEntityType, string> = {
  company: 'Companies',
  person: 'People',
  deal: 'Companies the deals are with',
};

const ID_LABEL: Record<CrmEntityType, string> = {
  company: 'Organization ID column',
  person: 'Person ID column',
  deal: 'Opportunity ID column',
};

const TYPE_OPTIONS: { value: AffinityColumnType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'status', label: 'One choice (status)' },
  { value: 'multi', label: 'Several choices (tags)' },
  { value: 'date', label: 'Date' },
  { value: 'number', label: 'Number' },
  { value: 'money', label: 'Money' },
  { value: 'person', label: 'People' },
  { value: 'company', label: 'Companies' },
  { value: 'url', label: 'Link' },
  { value: 'email', label: 'Email' },
  { value: 'skip', label: 'Leave out' },
];

const KIND_LABEL: Record<AffinityFileKind, string> = {
  list: 'List',
  notes: 'Notes',
  introductions: 'Introductions',
};

/** Lists first, notes next (they link to the lists' rows), introductions last. */
const KIND_ORDER: Record<AffinityFileKind, number> = { list: 0, notes: 1, introductions: 2 };

const MAX_FILE_BYTES = 60 * 1024 * 1024;
const PREVIEW_ROWS = 5;

type FileStatus = 'reading' | 'ready' | 'unreadable' | 'importing' | 'done' | 'failed';

interface FileOutcome {
  kind: AffinityFileKind;
  list: AffinityListImportResult['list'] | null;
  /** The list's rows, or the notes. */
  rows: AffinityCounts;
  records: AffinityCounts;
  /** Notes (or introductions) linked to at least one company, person or deal. */
  linked: number;
  ambiguousNames: number;
  /** Values changed in Kraken since the last import, kept rather than overwritten. */
  keptEdits: number;
  problems: AffinityRowProblem[];
  /** Why the file stopped part-way, if it did. */
  stopped: string | null;
}

interface ImportFile {
  id: number;
  name: string;
  status: FileStatus;
  csv: AffinityCsv | null;
  mapping: AffinityMapping | null;
  error: string | null;
  progress: { done: number; total: number } | null;
  outcome: FileOutcome | null;
}

/* --------------------------------------------------------------- sending */

type ChunkResult<T> = { ok: true; value: T } | { ok: false; message: string; fatal: boolean };

interface ErrorBody {
  ok: false;
  error?: {
    code?: string;
    message?: string;
    retryable?: boolean;
    details?: { retry_after_seconds?: number };
  };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One chunk, retried twice on a dropped connection or a server hiccup — safe
 * because the import is idempotent. "Fatal" stops the whole import: signed
 * out, not allowed, or the CRM not set up, none of which a retry fixes.
 */
async function sendChunk<T>(body: AffinityImportRequest): Promise<ChunkResult<T>> {
  let message = 'Kraken could not be reached.';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await wait(attempt * 1500);
    let res: Response;
    try {
      res = await fetch('/api/crm/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      message = 'The connection dropped.';
      continue;
    }
    const json = (await res.json().catch(() => null)) as ({ ok: true } & T) | ErrorBody | null;
    if (res.ok && json?.ok) return { ok: true, value: json as T };
    const error = json && !json.ok ? json.error : undefined;
    message = error?.message ?? `Kraken answered with an error (${res.status}).`;
    if (res.status === 401 || res.status === 403 || error?.code === 'not_configured') {
      return { ok: false, message, fatal: true };
    }
    if (res.status === 429) {
      await wait(Math.min(error?.details?.retry_after_seconds ?? 5, 30) * 1000);
      continue;
    }
    if (res.status < 500 && !error?.retryable) return { ok: false, message, fatal: false };
  }
  return { ok: false, message, fatal: false };
}

/* ------------------------------------------------------------- component */

/** A list mapping pointed at the existing list the file most likely updates, if any. */
function withTarget(
  mapping: AffinityMapping,
  fileName: string,
  lists: readonly AffinityExistingList[],
): AffinityMapping {
  if (mapping.kind !== 'list') return mapping;
  const target = suggestTargetList(fileName, mapping.listName, mapping.entityType, lists);
  return target
    ? { ...mapping, targetListId: target.id, listName: target.name }
    : { ...mapping, targetListId: null };
}

export function AffinityImport({
  ready,
  canImport,
  lists,
}: {
  ready: boolean;
  canImport: boolean;
  /** The lists already in Kraken, to import into. */
  lists: AffinityExistingList[];
}) {
  const [files, setFiles] = React.useState<ImportFile[]>([]);
  const [running, setRunning] = React.useState(false);
  const [finished, setFinished] = React.useState(false);
  const [fatal, setFatal] = React.useState<string | null>(null);
  const nextId = React.useRef(1);

  const update = React.useCallback((id: number, patch: Partial<ImportFile>) => {
    setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }, []);

  const addFiles = async (picked: File[]) => {
    const added = picked.map((file) => ({
      file,
      id: nextId.current++,
    }));
    setFiles((prev) => [
      ...prev,
      ...added.map(({ file, id }): ImportFile => ({
        id,
        name: file.name,
        status: 'reading',
        csv: null,
        mapping: null,
        error: null,
        progress: null,
        outcome: null,
      })),
    ]);
    setFinished(false);
    await Promise.all(
      added.map(async ({ file, id }) => {
        if (!/\.csv$/i.test(file.name) && file.type !== 'text/csv') {
          update(id, {
            status: 'unreadable',
            error: 'Only .csv files can be imported. In Affinity, use Export → Export view as CSV.',
          });
          return;
        }
        if (file.size > MAX_FILE_BYTES) {
          update(id, {
            status: 'unreadable',
            error:
              'This file is larger than 60 MB. Export the list in smaller views and import each.',
          });
          return;
        }
        try {
          const text = await file.text();
          // Introductions come in sections, not as one table: read apart.
          const introductions = readAffinityIntroductions(text);
          if (introductions) {
            update(id, { status: 'ready', ...introductions });
            return;
          }
          const csv = parseAffinityCsv(text);
          if (!csv.headers.length) {
            update(id, {
              status: 'unreadable',
              error: 'This file has no header row, so its columns cannot be read.',
            });
            return;
          }
          update(id, {
            status: 'ready',
            csv,
            mapping: withTarget(detectAffinityMapping(file.name, csv), file.name, lists),
          });
        } catch {
          update(id, { status: 'unreadable', error: 'This file could not be read as a CSV file.' });
        }
      }),
    );
  };

  const importable = (f: ImportFile) =>
    f.status !== 'reading' &&
    f.status !== 'unreadable' &&
    f.csv !== null &&
    f.mapping !== null &&
    mappingProblems(f.mapping, f.csv).length === 0;

  /** Import one file chunk by chunk; returns the message that should stop everything, if any. */
  const importFile = async (file: ImportFile): Promise<string | null> => {
    const { csv, mapping } = file;
    if (!csv || !mapping) return null;
    const plan =
      mapping.kind === 'list'
        ? buildListImport(mapping, csv)
        : mapping.kind === 'notes'
          ? buildNotesImport(mapping, csv)
          : buildIntroductionsImport(mapping);
    let outcome: FileOutcome = {
      kind: mapping.kind,
      list: null,
      rows: NO_COUNTS,
      records: NO_COUNTS,
      linked: 0,
      ambiguousNames: 0,
      keptEdits: 0,
      problems: [...plan.skipped, ...plan.notices],
      stopped: null,
    };
    let done = 0;
    update(file.id, { status: 'importing', progress: { done, total: plan.rowCount }, outcome });

    for (let i = 0; i < plan.requests.length; i++) {
      const request = plan.requests[i] as AffinityImportRequest;
      const lines = plan.lines[i] ?? [];
      const result = await sendChunk<
        AffinityListImportResult | AffinityNotesImportResult | AffinityIntroductionsImportResult
      >(request);
      if (!result.ok) {
        outcome = { ...outcome, stopped: result.message };
        update(file.id, { status: 'failed', outcome });
        return result.fatal ? result.message : null;
      }
      const problems = result.value.problems.map((p) => ({
        line: lines[p.row] ?? 0,
        message: p.message,
      }));
      if ('entries' in result.value) {
        const r = result.value;
        outcome = {
          ...outcome,
          // The first chunk creates the list; later ones only add rows to it.
          list: outcome.list
            ? { ...outcome.list, updated: outcome.list.updated || r.list.updated }
            : r.list,
          rows: addCounts(outcome.rows, r.entries),
          records: addCounts(outcome.records, r.records),
          keptEdits: outcome.keptEdits + (r.keptEdits ?? 0),
          problems: [...outcome.problems, ...problems],
        };
      } else if ('notes' in result.value) {
        const r = result.value;
        outcome = {
          ...outcome,
          rows: addCounts(outcome.rows, r.notes),
          linked: outcome.linked + r.linked,
          ambiguousNames: outcome.ambiguousNames + r.ambiguousNames,
          problems: [...outcome.problems, ...problems],
        };
      } else {
        const r = result.value;
        outcome = {
          ...outcome,
          rows: addCounts(outcome.rows, r.introductions),
          linked: outcome.linked + r.linked,
          problems: [...outcome.problems, ...problems],
        };
      }
      done += lines.length;
      update(file.id, { progress: { done, total: plan.rowCount }, outcome });
    }
    update(file.id, { status: 'done', outcome });
    return null;
  };

  const runImport = async () => {
    setRunning(true);
    setFinished(false);
    setFatal(null);
    // Files not imported yet; once every file has been, all of them again.
    const fresh = files.filter((f) => importable(f) && !f.outcome);
    // Lists first: notes are linked to the records and deals the lists bring in.
    const queue = (fresh.length ? fresh : files.filter(importable)).sort(
      (a, b) => KIND_ORDER[a.mapping?.kind ?? 'list'] - KIND_ORDER[b.mapping?.kind ?? 'list'],
    );
    for (const file of queue) {
      const stop = await importFile(file);
      if (stop) {
        setFatal(stop);
        break;
      }
    }
    setRunning(false);
    setFinished(true);
  };

  const readyCount = files.filter(importable).length;
  const freshCount = files.filter((f) => importable(f) && !f.outcome).length;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div>
            <CardTitle as="h2">How it works</CardTitle>
            <CardDescription>
              Bring each Affinity list across with its companies, people, fields and notes.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <ol className="list-decimal space-y-1.5 pl-5 text-sm">
            <li>
              In Affinity, open a list and choose <strong>Export → Export view as CSV</strong>.
            </li>
            <li>
              For its notes, choose <strong>Export → Export all notes in view</strong>. For who
              introduced whom, <strong>Export → Export all introductions in view</strong>.
            </li>
            <li>
              Drop the files below, check how each one was read, then import. Lists go in first and
              notes after, so each note is attached to the company, person or deal it is about.
            </li>
          </ol>
          <p className="mt-3 text-sm text-[var(--fg-muted)]">
            Importing an export again updates the rows it brought in rather than adding them twice,
            and keeps any value someone has changed in Kraken since. Each file goes into the list
            you choose for it, and a list made by mistake can be archived from its page.
          </p>
        </CardContent>
      </Card>

      {!canImport ? (
        <Notice tone="warn">
          Your role can see lists but not import into them. Ask an owner of this workspace to run
          the import, or to change your role.
        </Notice>
      ) : null}

      <DropZone disabled={running} onFiles={(picked) => void addFiles(picked)} />

      {files.map((file) => (
        <FileCard
          key={file.id}
          file={file}
          lists={lists}
          busy={running}
          onMapping={(mapping) =>
            update(file.id, {
              mapping,
              ...(file.status === 'done' || file.status === 'failed'
                ? { status: 'ready' as const, outcome: null, progress: null }
                : {}),
            })
          }
          onRemove={() => setFiles((prev) => prev.filter((f) => f.id !== file.id))}
        />
      ))}

      {files.length ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            loading={running}
            disabled={!ready || !canImport || running || readyCount === 0}
            onClick={() => void runImport()}
          >
            {running
              ? 'Importing…'
              : freshCount
                ? `Import ${freshCount} ${freshCount === 1 ? 'file' : 'files'}`
                : 'Import again'}
          </Button>
          <p className="min-w-0 flex-1 text-sm text-[var(--fg-muted)]">
            {!ready
              ? 'Importing needs the CRM tables set up first (see above).'
              : readyCount < files.length && !running
                ? 'Files that still need a choice are left out until it is made.'
                : 'Nothing is changed in Affinity. Rows already in Kraken are updated, and values changed in Kraken are kept.'}
          </p>
        </div>
      ) : null}

      {fatal ? (
        <ErrorState
          title="The import stopped"
          message={fatal}
          stillUsable="Everything imported before this point is saved. Run the import again once this is fixed; the rows already saved are matched, not added again."
        />
      ) : null}

      {finished ? <FinalSummary files={files} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------- drop zone */

function DropZone({ disabled, onFiles }: { disabled: boolean; onFiles: (files: File[]) => void }) {
  const [over, setOver] = React.useState(false);
  const inputId = React.useId();
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const dropped = Array.from(e.dataTransfer.files);
        if (!disabled && dropped.length) onFiles(dropped);
      }}
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-[var(--radius-card)] border-2 border-dashed px-6 py-10 text-center transition-colors duration-[var(--motion-fast)]',
        over
          ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
          : 'border-[var(--border-strong)] bg-[var(--bg-sunken)]',
        disabled && 'opacity-60',
      )}
    >
      <Upload className="size-6 text-[var(--fg-subtle)]" aria-hidden="true" />
      <div>
        <p className="font-medium">Drop Affinity CSV files here</p>
        <p className="mt-1 text-sm text-[var(--fg-muted)]">
          List, notes and introductions exports together, as many as you like.
        </p>
      </div>
      <label
        htmlFor={inputId}
        className={cn(
          buttonVariants({ variant: 'secondary', size: 'sm' }),
          'cursor-pointer has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--focus)]',
          disabled && 'pointer-events-none',
        )}
      >
        Choose files
        <input
          id={inputId}
          type="file"
          accept=".csv,text/csv"
          multiple
          disabled={disabled}
          aria-label="Choose CSV files"
          className="sr-only"
          onChange={(e) => {
            const picked = Array.from(e.target.files ?? []);
            // Cleared so choosing the same file again (after fixing it) fires again.
            e.target.value = '';
            if (picked.length) onFiles(picked);
          }}
        />
      </label>
    </div>
  );
}

/* --------------------------------------------------------------- one file */

const STATUS_BADGE: Record<FileStatus, { label: string; tone: NonNullable<BadgeProps['tone']> }> = {
  reading: { label: 'Reading…', tone: 'neutral' },
  ready: { label: 'Ready', tone: 'info' },
  unreadable: { label: "Can't be read", tone: 'danger' },
  importing: { label: 'Importing', tone: 'info' },
  done: { label: 'Imported', tone: 'ok' },
  failed: { label: 'Stopped', tone: 'danger' },
};

function FileCard({
  file,
  lists,
  busy,
  onMapping,
  onRemove,
}: {
  file: ImportFile;
  lists: readonly AffinityExistingList[];
  busy: boolean;
  onMapping: (mapping: AffinityMapping) => void;
  onRemove: () => void;
}) {
  const { csv, mapping } = file;
  const problems = csv && mapping ? mappingProblems(mapping, csv) : [];
  const warnings = React.useMemo(
    () => (csv && mapping ? mappingWarnings(mapping, csv) : []),
    [csv, mapping],
  );
  const uid = React.useId();
  const status =
    file.status === 'ready' && problems.length
      ? { label: 'Needs a choice', tone: 'warn' as const }
      : STATUS_BADGE[file.status];
  const locked = busy || file.status === 'importing';
  const Icon =
    mapping?.kind === 'notes'
      ? StickyNote
      : mapping?.kind === 'introductions'
        ? Handshake
        : FileSpreadsheet;

  return (
    <Card>
      <CardHeader>
        <div className="flex min-w-0 items-start gap-3">
          <Icon className="mt-0.5 size-5 shrink-0 text-[var(--fg-subtle)]" aria-hidden="true" />
          <div className="min-w-0">
            <CardTitle as="h2" className="break-all">
              {file.name}
            </CardTitle>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <Badge tone={status.tone}>{status.label}</Badge>
              {mapping ? <Badge tone="outline">{KIND_LABEL[mapping.kind]}</Badge> : null}
              {mapping?.kind === 'list' ? (
                <Badge tone="outline">{ENTITY_LABEL[mapping.entityType]}</Badge>
              ) : null}
              {csv ? (
                <span className="tabular text-xs text-[var(--fg-muted)]">
                  {csv.rows.length.toLocaleString()} {csv.rows.length === 1 ? 'row' : 'rows'}
                </span>
              ) : null}
            </div>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Remove ${file.name}`}
          disabled={locked}
          onClick={onRemove}
        >
          <X aria-hidden="true" />
        </Button>
      </CardHeader>
      <CardContent className="space-y-5">
        {file.error ? (
          <ErrorState title="This file can't be imported" message={file.error} />
        ) : null}

        {csv && mapping ? (
          <>
            {csv.warnings.length ? (
              <Notice tone="warn">
                <ul className="space-y-0.5">
                  {csv.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </Notice>
            ) : null}

            {mapping.kind === 'introductions' ? (
              <IntroductionSections mapping={mapping} />
            ) : (
              <>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <Field label="This file is" htmlFor={`${uid}-kind`}>
                    <Select
                      id={`${uid}-kind`}
                      value={mapping.kind}
                      disabled={locked}
                      onChange={(e) =>
                        onMapping(
                          withTarget(
                            detectAffinityMapping(
                              file.name,
                              csv,
                              e.target.value as AffinityTableKind,
                            ),
                            file.name,
                            lists,
                          ),
                        )
                      }
                    >
                      <option value="list">A list (Export view as CSV)</option>
                      <option value="notes">Notes (Export all notes in view)</option>
                    </Select>
                  </Field>
                  {mapping.kind === 'list' ? (
                    <ListBasics
                      fileName={file.name}
                      csv={csv}
                      mapping={mapping}
                      lists={lists}
                      disabled={locked}
                      onChange={onMapping}
                    />
                  ) : (
                    <NotesColumns
                      csv={csv}
                      mapping={mapping}
                      disabled={locked}
                      onChange={onMapping}
                    />
                  )}
                </div>

                {mapping.kind === 'list' ? (
                  <ListColumns
                    fileName={file.name}
                    csv={csv}
                    mapping={mapping}
                    disabled={locked}
                    onChange={onMapping}
                  />
                ) : (
                  <LinkedNameColumns
                    csv={csv}
                    mapping={mapping}
                    disabled={locked}
                    onChange={onMapping}
                  />
                )}
              </>
            )}

            {problems.length ? (
              <Notice tone="warn">
                <ul className="space-y-0.5">
                  {problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </Notice>
            ) : null}

            {warnings.length ? (
              <Notice tone="warn">
                <ul className="space-y-0.5">
                  {warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </Notice>
            ) : null}

            <Preview fileName={file.name} csv={csv} />
          </>
        ) : null}

        {file.progress && file.status === 'importing' ? (
          <Progress label={`Importing ${file.name}`} {...file.progress} />
        ) : null}
        {file.outcome && (file.status === 'done' || file.status === 'failed') ? (
          <Outcome outcome={file.outcome} mapping={mapping} />
        ) : null}
      </CardContent>
    </Card>
  );
}

function ColumnSelect({
  label,
  hint,
  value,
  headers,
  none,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string | null;
  headers: readonly string[];
  /** The label of the "no column" choice. */
  none: string;
  disabled: boolean;
  onChange: (header: string | null) => void;
}) {
  const id = React.useId();
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <Select
        id={id}
        value={value ?? ''}
        disabled={disabled}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">{none}</option>
        {headers.map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </Select>
    </Field>
  );
}

function ListBasics({
  fileName,
  csv,
  mapping,
  lists,
  disabled,
  onChange,
}: {
  fileName: string;
  csv: AffinityCsv;
  mapping: AffinityListMapping;
  lists: readonly AffinityExistingList[];
  disabled: boolean;
  onChange: (mapping: AffinityMapping) => void;
}) {
  const uid = React.useId();
  const set = (patch: Partial<AffinityListMapping>) => onChange({ ...mapping, ...patch });
  const { headers } = csv;
  const target = lists.find((l) => l.id === mapping.targetListId) ?? null;
  // The server finds a list by name when none is chosen, so a "new" list
  // named like an existing one of the same kind is that list; say so.
  const sameName = target
    ? null
    : lists.find(
        (l) =>
          l.entityType === mapping.entityType &&
          crmNameKey(l.name) === crmNameKey(mapping.listName),
      );
  const choose = (id: string) => {
    const list = lists.find((l) => l.id === id);
    if (!list) {
      set({ targetListId: null, listName: defaultListName(fileName) });
      return;
    }
    // A list holds one kind of thing, so choosing it re-reads the columns as that kind.
    const base =
      list.entityType === mapping.entityType
        ? mapping
        : detectListMapping(fileName, csv, list.entityType);
    onChange({ ...base, targetListId: list.id, listName: list.name });
  };
  return (
    <>
      {lists.length ? (
        <Field
          label="Import into"
          htmlFor={`${uid}-target`}
          hint={
            target
              ? `Rows already on ${target.name} are updated and new ones added to it.`
              : sameName
                ? `${sameName.name} already has this name, so its rows are updated rather than a new list made.`
                : 'A new list, made from this file.'
          }
        >
          <Select
            id={`${uid}-target`}
            value={target?.id ?? ''}
            disabled={disabled}
            aria-describedby={`${uid}-target-hint`}
            onChange={(e) => choose(e.target.value)}
          >
            <option value="">A new list</option>
            {(['deal', 'company', 'person'] as const).map((type) => {
              const group = lists.filter((l) => l.entityType === type);
              if (!group.length) return null;
              return (
                <optgroup key={type} label={ENTITY_LABEL[type]}>
                  {group.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                      {l.archived ? ' (archived)' : ''} · {l.entryCount.toLocaleString()}{' '}
                      {l.entryCount === 1 ? 'row' : 'rows'}
                    </option>
                  ))}
                </optgroup>
              );
            })}
          </Select>
        </Field>
      ) : null}
      {target ? null : (
        <Field label="List name" htmlFor={`${uid}-name`}>
          <Input
            id={`${uid}-name`}
            value={mapping.listName}
            maxLength={300}
            disabled={disabled}
            onChange={(e) => set({ listName: e.target.value })}
          />
        </Field>
      )}
      <Field label="This list holds" htmlFor={`${uid}-entity`}>
        <Select
          id={`${uid}-entity`}
          value={mapping.entityType}
          disabled={disabled || target !== null}
          onChange={(e) =>
            onChange({
              ...detectListMapping(fileName, csv, e.target.value as CrmEntityType),
              listName: mapping.listName,
            })
          }
        >
          <option value="deal">Deals (an opportunity list)</option>
          <option value="company">Companies (an organization list)</option>
          <option value="person">People (a person list)</option>
        </Select>
      </Field>
      <ColumnSelect
        label="Name column"
        value={mapping.nameColumn}
        headers={headers}
        none={
          mapping.firstNameColumn || mapping.lastNameColumn
            ? 'First name + last name'
            : 'Choose a column'
        }
        disabled={disabled}
        onChange={(nameColumn) => set({ nameColumn })}
      />
      <ColumnSelect
        label="Status column"
        hint="The pipeline stage, like “3. First Meeting”."
        value={mapping.statusColumn}
        headers={headers}
        none="No status column"
        disabled={disabled}
        onChange={(statusColumn) => set({ statusColumn })}
      />
      <ColumnSelect
        label="Affinity row ID column"
        hint="Lets a later import update the same rows."
        value={mapping.rowIdColumn}
        headers={headers}
        none="None"
        disabled={disabled}
        onChange={(rowIdColumn) => set({ rowIdColumn })}
      />
      <ColumnSelect
        label={ID_LABEL[mapping.entityType]}
        value={mapping.entityIdColumn}
        headers={headers}
        none="None"
        disabled={disabled}
        onChange={(entityIdColumn) => set({ entityIdColumn })}
      />
      {mapping.entityType === 'company' ? (
        <ColumnSelect
          label="Website column"
          hint="Used to recognise the same company in other lists."
          value={mapping.domainColumn}
          headers={headers}
          none="None"
          disabled={disabled}
          onChange={(domainColumn) => set({ domainColumn })}
        />
      ) : null}
      {mapping.entityType === 'person' ? (
        <>
          <ColumnSelect
            label="Email addresses column"
            value={mapping.emailsColumn}
            headers={headers}
            none="None"
            disabled={disabled}
            onChange={(emailsColumn) => set({ emailsColumn })}
          />
          <ColumnSelect
            label="Primary email column"
            value={mapping.primaryEmailColumn}
            headers={headers}
            none="None"
            disabled={disabled}
            onChange={(primaryEmailColumn) => set({ primaryEmailColumn })}
          />
        </>
      ) : null}
      {mapping.entityType === 'deal' ? (
        <ColumnSelect
          label="Company column"
          hint="Each deal is linked to this company."
          value={mapping.organizationColumn}
          headers={headers}
          none="None"
          disabled={disabled}
          onChange={(organizationColumn) =>
            set({
              organizationColumn,
              types: organizationColumn
                ? { ...mapping.types, [organizationColumn]: 'company' }
                : mapping.types,
            })
          }
        />
      ) : null}
    </>
  );
}

/** A few distinct values of a column, for recognising it. */
function examples(csv: AffinityCsv, header: string): string {
  const seen = new Set<string>();
  for (const row of csv.rows) {
    const v = (row.cells[header] ?? '').trim().replace(/\s+/g, ' ');
    const shown = v.length > 40 ? `${v.slice(0, 40)}…` : v;
    if (shown) seen.add(shown);
    if (seen.size >= 3) break;
  }
  return [...seen].join(' · ');
}

function ListColumns({
  fileName,
  csv,
  mapping,
  disabled,
  onChange,
}: {
  fileName: string;
  csv: AffinityCsv;
  mapping: AffinityListMapping;
  disabled: boolean;
  onChange: (mapping: AffinityMapping) => void;
}) {
  const columns = listFieldColumns(mapping, csv.headers);
  const identifying = csv.headers.filter((h) => !columns.includes(h));
  return (
    <section>
      <FieldLabel as="h3">Columns</FieldLabel>
      <p className="mt-1 mb-2 text-sm text-[var(--fg-muted)]">
        Each column becomes a field of the list. Change a type that was guessed wrong, or leave a
        column out.
        {identifying.length ? ` Used to recognise each row: ${identifying.join(', ')}.` : null}
      </p>
      {columns.length ? (
        <Table caption={`Columns of ${fileName}`}>
          <TableHead>
            <TableRow>
              <TableHeaderCell>Column</TableHeaderCell>
              <TableHeaderCell>Imported as</TableHeaderCell>
              <TableHeaderCell>Examples</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {columns.map((header) => (
              <TableRow key={header}>
                <TableCell className="py-2 font-medium">{header}</TableCell>
                <TableCell className="py-2">
                  {header === mapping.statusColumn ? (
                    <span className="text-sm">Status (the pipeline)</span>
                  ) : (
                    <Select
                      aria-label={`Type of ${header}`}
                      className="h-8 w-48"
                      value={mapping.types[header] ?? 'text'}
                      disabled={disabled}
                      onChange={(e) =>
                        onChange({
                          ...mapping,
                          types: {
                            ...mapping.types,
                            [header]: e.target.value as AffinityColumnType,
                          },
                        })
                      }
                    >
                      {TYPE_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  )}
                </TableCell>
                {/* A floor on the width: on a phone the table scrolls rather than
                    squeezing the examples into a one-word column. */}
                <TableCell className="min-w-56 py-2 text-[var(--fg-muted)]">
                  <span className="line-clamp-2">
                    {examples(csv, header) || <span className="italic">Empty</span>}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <p className="text-sm text-[var(--fg-subtle)] italic">No other columns.</p>
      )}
    </section>
  );
}

function NotesColumns({
  csv,
  mapping,
  disabled,
  onChange,
}: {
  csv: AffinityCsv;
  mapping: AffinityNotesMapping;
  disabled: boolean;
  onChange: (mapping: AffinityMapping) => void;
}) {
  const set = (patch: Partial<AffinityNotesMapping>) => onChange({ ...mapping, ...patch });
  const { headers } = csv;
  return (
    <>
      <ColumnSelect
        label="Note text column"
        value={mapping.contentColumn}
        headers={headers}
        none="Choose a column"
        disabled={disabled}
        onChange={(contentColumn) => set({ contentColumn })}
      />
      <ColumnSelect
        label="Attached to column"
        hint="The company, person or deal the note is on."
        value={mapping.entityColumn}
        headers={headers}
        none="None"
        disabled={disabled}
        onChange={(entityColumn) =>
          set({
            entityColumn,
            associatedColumns: mapping.associatedColumns.filter((c) => c !== entityColumn),
          })
        }
      />
      <ColumnSelect
        label="Author column"
        value={mapping.authorColumn}
        headers={headers}
        none="None"
        disabled={disabled}
        onChange={(authorColumn) => set({ authorColumn })}
      />
      <ColumnSelect
        label="Date column"
        value={mapping.dateColumn}
        headers={headers}
        none="None"
        disabled={disabled}
        onChange={(dateColumn) => set({ dateColumn })}
      />
      <ColumnSelect
        label="Note ID column"
        hint="Only if the export has one."
        value={mapping.idColumn}
        headers={headers}
        none="None"
        disabled={disabled}
        onChange={(idColumn) => set({ idColumn })}
      />
    </>
  );
}

function LinkedNameColumns({
  csv,
  mapping,
  disabled,
  onChange,
}: {
  csv: AffinityCsv;
  mapping: AffinityNotesMapping;
  disabled: boolean;
  onChange: (mapping: AffinityMapping) => void;
}) {
  const used = new Set(
    [mapping.contentColumn, mapping.authorColumn, mapping.dateColumn, mapping.idColumn].filter(
      Boolean,
    ),
  );
  const options = csv.headers.filter((h) => !used.has(h) && h !== mapping.entityColumn);
  if (!options.length) return null;
  return (
    <fieldset>
      <legend className="text-sm font-medium">Other names the note is attached to</legend>
      <p className="mt-1 mb-2 text-sm text-[var(--fg-muted)]">
        Ticked columns hold more company, person or deal names. Each name is matched to what the
        lists brought in; a name with no match is kept on the note as text.
      </p>
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        {options.map((h) => (
          <label key={h} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-[var(--accent)]"
              checked={mapping.associatedColumns.includes(h)}
              disabled={disabled}
              onChange={(e) =>
                onChange({
                  ...mapping,
                  associatedColumns: e.target.checked
                    ? [...mapping.associatedColumns, h]
                    : mapping.associatedColumns.filter((c) => c !== h),
                })
              }
            />
            {h}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Preview({ fileName, csv }: { fileName: string; csv: AffinityCsv }) {
  const rows = csv.rows.slice(0, PREVIEW_ROWS);
  if (!rows.length) return null;
  return (
    <section>
      <FieldLabel as="h3">
        First {rows.length} {rows.length === 1 ? 'row' : 'rows'}
      </FieldLabel>
      <Table caption={`First rows of ${fileName}`} className="mt-2 text-[13px]">
        <TableHead>
          <TableRow>
            <TableHeaderCell numeric>Row</TableHeaderCell>
            {csv.headers.map((h) => (
              <TableHeaderCell key={h}>{h}</TableHeaderCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.line}>
              <TableCell numeric className="py-2 text-[var(--fg-subtle)]">
                {row.line}
              </TableCell>
              {csv.headers.map((h) => (
                <TableCell key={h} className="py-2">
                  {/* Text content only: export cells are untrusted. */}
                  <span className="line-clamp-2 block max-w-64 min-w-24 break-words">
                    {row.cells[h]}
                  </span>
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

function Progress({ label, done, total }: { label: string; done: number; total: number }) {
  const pct = total ? Math.round((done / total) * 100) : 100;
  return (
    <div>
      <div className="mb-1.5 flex justify-between gap-3 text-sm">
        <span className="min-w-0 truncate">{label}</span>
        <span className="tabular shrink-0 text-[var(--fg-muted)]">
          {done.toLocaleString()} of {total.toLocaleString()} rows
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        className="h-2 overflow-hidden rounded-full bg-[var(--bg-sunken)]"
      >
        <div
          className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-[var(--motion-base)]"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/** What an introductions export was read as: each section, and any left out. */
function IntroductionSections({ mapping }: { mapping: AffinityIntroductionsMapping }) {
  return (
    <section>
      <FieldLabel as="h3">Sections</FieldLabel>
      <ul className="mt-2 space-y-1 text-sm">
        {mapping.sections.map((s) => (
          <li key={s.line} className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium">{s.title}</span>
            <span className="tabular text-[var(--fg-muted)]">
              {s.rows.toLocaleString()} {s.rows === 1 ? 'row' : 'rows'}
            </span>
            {s.section && !s.unrecognised ? (
              <Badge tone="ok">{SECTION_LABELS[s.section]}</Badge>
            ) : (
              <Badge tone="warn">Not recognised</Badge>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-sm text-[var(--fg-muted)]">
        Each introduction shows on the profiles of the companies and people it names, as “Introduced
        by” and “Introduced”.
      </p>
    </section>
  );
}

/* --------------------------------------------------------------- results */

const ROWS_LABEL: Record<AffinityFileKind, string> = {
  list: 'Rows',
  notes: 'Notes',
  introductions: 'Introductions',
};

function countLine(counts: AffinityCounts): string {
  const parts = [`${counts.inserted.toLocaleString()} added`];
  if (counts.updated) parts.push(`${counts.updated.toLocaleString()} updated`);
  if (counts.unchanged) parts.push(`${counts.unchanged.toLocaleString()} already up to date`);
  if (counts.skipped) parts.push(`${counts.skipped.toLocaleString()} skipped`);
  if (counts.errors) parts.push(`${counts.errors.toLocaleString()} could not be saved`);
  return parts.join(' · ');
}

function Outcome({ outcome, mapping }: { outcome: FileOutcome; mapping: AffinityMapping | null }) {
  const rows = outcome.rows;
  const stored = rows.inserted + rows.updated + rows.unchanged;
  const nothingChanged =
    !outcome.stopped && rows.inserted === 0 && rows.updated === 0 && rows.unchanged > 0;
  const entityType = mapping?.kind === 'list' ? mapping.entityType : null;
  const records = outcome.records;
  return (
    <div className="space-y-2 rounded-md border border-[var(--border)] bg-[var(--bg-sunken)] p-3 text-sm">
      {outcome.stopped ? (
        <p className="text-[var(--danger)]">
          <span className="font-medium">Stopped part-way:</span> {outcome.stopped} Rows sent before
          this point are saved; importing the file again finishes the job, matching those rows
          rather than adding them twice.
        </p>
      ) : (
        <p className="flex items-center gap-2 font-medium">
          <CheckCircle2 className="size-4 text-[var(--ok)]" aria-hidden="true" />
          {KIND_LABEL[outcome.kind]} imported
        </p>
      )}
      {outcome.list ? (
        <p>
          <Link
            href={`/lists/${outcome.list.id}`}
            className="font-medium text-[var(--accent)] underline-offset-2 hover:underline"
          >
            {outcome.list.name}
          </Link>{' '}
          <span className="text-[var(--fg-muted)]">
            {outcome.list.created
              ? '— a new list'
              : outcome.list.updated
                ? '— an existing list, with its columns updated'
                : '— an existing list'}
          </span>
        </p>
      ) : null}
      <p>
        <span className="font-medium">{ROWS_LABEL[outcome.kind]}:</span> {countLine(rows)}
      </p>
      {entityType && records.inserted + records.updated + records.unchanged > 0 ? (
        <p>
          <span className="font-medium">{RECORD_LABEL[entityType]}:</span> {countLine(records)}
        </p>
      ) : null}
      {outcome.kind === 'notes' && stored > 0 ? (
        <p className="text-[var(--fg-muted)]">
          {outcome.linked.toLocaleString()} of {stored.toLocaleString()} notes are attached to a
          company, person or deal in Kraken. The others keep the names they were attached to as text
          {outcome.ambiguousNames
            ? ', including names that matched more than one record and were not guessed at'
            : ''}
          .
        </p>
      ) : null}
      {outcome.kind === 'introductions' && stored > 0 ? (
        <p className="text-[var(--fg-muted)]">
          {outcome.linked.toLocaleString()} of {stored.toLocaleString()} introductions name a
          company or person already in Kraken and show on their profiles. The rest appear on a
          profile as soon as that company or person is imported.
        </p>
      ) : null}
      {nothingChanged ? (
        <p className="text-[var(--fg-muted)]">
          Everything in this file was already in Kraken, so nothing changed.
        </p>
      ) : rows.unchanged > 0 ? (
        <p className="text-[var(--fg-muted)]">
          {rows.unchanged.toLocaleString()} {ROWS_LABEL[outcome.kind].toLowerCase()} were already in
          Kraken and were left as they were.
        </p>
      ) : null}
      {outcome.keptEdits > 0 ? (
        <p className="text-[var(--fg-muted)]">
          {outcome.keptEdits.toLocaleString()}{' '}
          {outcome.keptEdits === 1 ? 'value was' : 'values were'} changed in Kraken since the last
          import and {outcome.keptEdits === 1 ? 'was' : 'were'} kept rather than overwritten by this
          file; the rows below say which.
        </p>
      ) : null}
      {outcome.problems.length ? (
        <details>
          <summary className="cursor-pointer font-medium">
            {outcome.problems.length.toLocaleString()}{' '}
            {outcome.problems.length === 1 ? 'row needs' : 'rows need'} a look
          </summary>
          <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto">
            {[...outcome.problems]
              .sort((a, b) => a.line - b.line)
              .map((p, i) => (
                <li key={`${p.line}-${i}`}>
                  <span className="tabular font-medium">Row {p.line}:</span> {p.message}
                </li>
              ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function FinalSummary({ files }: { files: ImportFile[] }) {
  const outcomes = files.map((f) => f.outcome).filter((o): o is FileOutcome => o !== null);
  if (!outcomes.length) return null;
  const lists = outcomes.filter((o) => o.kind === 'list');
  const notes = outcomes.filter((o) => o.kind === 'notes');
  const intros = outcomes.filter((o) => o.kind === 'introductions');
  const listRows = lists.reduce((sum, o) => addCounts(sum, o.rows), NO_COUNTS);
  const noteRows = notes.reduce((sum, o) => addCounts(sum, o.rows), NO_COUNTS);
  const introRows = intros.reduce((sum, o) => addCounts(sum, o.rows), NO_COUNTS);
  const problems = outcomes.reduce((n, o) => n + o.problems.length, 0);
  const stopped = outcomes.filter((o) => o.stopped).length;
  return (
    <Card role="status" aria-live="polite">
      <CardHeader>
        <div>
          <CardTitle as="h2">
            {stopped ? 'Import finished, with stops' : 'Import finished'}
          </CardTitle>
          <CardDescription>
            Importing the same files again matches the rows already here rather than adding them
            twice, and keeps values changed in Kraken since.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <ul className="space-y-1 text-sm">
          {lists.length ? (
            <li>
              <span className="font-medium">
                {lists.length} {lists.length === 1 ? 'list' : 'lists'}:
              </span>{' '}
              {countLine(listRows)}
            </li>
          ) : null}
          {notes.length ? (
            <li>
              <span className="font-medium">Notes:</span> {countLine(noteRows)}
            </li>
          ) : null}
          {intros.length ? (
            <li>
              <span className="font-medium">Introductions:</span> {countLine(introRows)}
            </li>
          ) : null}
          {problems ? (
            <li className="text-[var(--fg-muted)]">
              {problems.toLocaleString()} {problems === 1 ? 'row needs' : 'rows need'} a look; each
              file above lists them by row number.
            </li>
          ) : null}
        </ul>
        <Button asChild variant="secondary" size="sm">
          <Link href="/knowledge?tab=lists">Open Affinity lists</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
