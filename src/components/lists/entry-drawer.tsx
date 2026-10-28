'use client';

import * as React from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { ArrowUpRight, ListX } from 'lucide-react';
import { getCrmEntryAction, setCrmEntryValuesAction } from '@/app/actions/crm';
import { CrmNotesPanel } from '@/components/lists/crm-notes-panel';
import { CrmValueView } from '@/components/lists/crm-value';
import { EditableCrmValue } from '@/components/lists/editable-value';
import { ExportNotesLink } from '@/components/lists/export-notes-link';
import { TimeInStatus } from '@/components/lists/list-table';
import { StatusSelect } from '@/components/lists/status-select';
import type { ListViewList } from '@/components/lists/list-view';
import { DataRow, SectionHeading } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Dialog, Drawer } from '@/components/ui/dialog';
import { ErrorState, SkeletonText } from '@/components/ui/feedback';
import { isCopilotField } from '@/lib/crm/fields';
import { CRM_TIME_IN_STATUS_LABEL, type CrmTimeInStatus } from '@/lib/crm/saved-views';
import type { CrmEntryDetail, CrmRecordSummary } from '@/lib/services/crm';
import type { CrmField, CrmListEntry, CrmValue } from '@/lib/types/domain';
import { formatDate } from '@/lib/util/time';

const NO_NOTES: CrmEntryDetail['notes'] = [];

interface Loaded {
  entryId: string;
  detail: CrmEntryDetail | null;
  error: string | null;
}

/**
 * The side panel for one entry: every field (hidden columns included), the
 * company or person it points at, the notes on it and on that record, and a
 * box to add one.
 *
 * The entry's values come from the page — so a status changed here, on the
 * row or on a card is the same change — and its notes are fetched when the
 * panel opens, since a list page carries none of them. A note is attached to
 * the entry, and on a company or person list to the record too, so it shows
 * on the profile and on every list that record is on.
 *
 * A column added in Kraken (and every column of a list made in Kraken) is
 * edited here in place; Affinity's columns stay as the sync writes them.
 * Notes written in Kraken can be edited and deleted. "Remove from list"
 * takes the row off, with Undo on the message that follows.
 */
export function EntryDrawer({
  list,
  entry,
  record,
  statusField,
  statusOptions,
  valuesOf,
  timer,
  now,
  timezone,
  canWrite,
  saving,
  affinitySyncOn,
  onClose,
  onStatusChange,
  onValuesSaved,
  onRemove,
}: {
  list: ListViewList;
  entry: CrmListEntry | null;
  record: CrmRecordSummary | null;
  statusField: CrmField | null;
  statusOptions: string[];
  valuesOf: (entry: CrmListEntry) => Record<string, CrmValue>;
  /** How long the entry has been in its current status, when known. */
  timer?: CrmTimeInStatus;
  now: number;
  timezone: string;
  canWrite: boolean;
  saving: boolean;
  /** Affinity's notes are read-only while the daily sync runs. */
  affinitySyncOn: boolean;
  onClose: () => void;
  onStatusChange: (entry: CrmListEntry, next: string | null) => void;
  /** A value edited here was saved: the entry as it is stored now. */
  onValuesSaved: (entry: CrmListEntry) => void;
  /** "Remove from list". */
  onRemove: (entry: CrmListEntry) => void;
}) {
  const entryId = entry?.id ?? null;
  const [loaded, setLoaded] = React.useState<Loaded | null>(null);
  const [noteCount, setNoteCount] = React.useState<{ entryId: string; count: number } | null>(null);

  React.useEffect(() => {
    if (!entryId) return;
    let cancelled = false;
    getCrmEntryAction(entryId).then(
      (result) => {
        if (cancelled) return;
        setLoaded({
          entryId,
          detail: result.ok ? (result.data ?? null) : null,
          error: result.ok ? null : (result.error?.message ?? 'The notes could not be loaded.'),
        });
      },
      () => {
        if (!cancelled) {
          setLoaded({ entryId, detail: null, error: 'The notes could not be loaded.' });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [entryId]);

  const current = loaded && loaded.entryId === entryId ? loaded : null;
  // The panel may open from a just-added entry the page has not re-rendered
  // with yet; the fetched detail knows its record.
  const linked = record ?? current?.detail?.record ?? null;
  const values = entry ? valuesOf(entry) : {};

  const notesShown =
    noteCount && noteCount.entryId === entryId ? noteCount.count : current?.detail?.notes.length;
  // Columns the team owns: added in Kraken, or on a list made in Kraken.
  const editable = (field: CrmField) =>
    canWrite && (list.source === 'copilot' || isCopilotField(field));

  const saveValue = async (
    target: CrmListEntry,
    field: CrmField,
    next: string | string[] | null,
  ): Promise<CrmValue | undefined> => {
    const result = await setCrmEntryValuesAction(target.id, { [field.key]: next }).catch(
      () => null,
    );
    if (!result) {
      toast.error(`${field.name} could not be saved: no connection.`);
      return undefined;
    }
    if (!result.ok || !result.data) {
      toast.error(result.error?.message ?? `${field.name} could not be saved.`, {
        description: result.error?.stillUsable,
      });
      return undefined;
    }
    onValuesSaved(result.data.entry);
    return result.data.entry.values[field.key] ?? null;
  };

  return (
    <Dialog
      open={entry !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {entry ? (
        <Drawer title={entry.title} description={list.name}>
          <div className="space-y-6">
            <section aria-label="Linked record">
              {linked ? (
                <Link
                  href={`/lists/records/${linked.id}`}
                  className="group flex items-start justify-between gap-3 rounded-md border border-[var(--border)] p-3 transition-colors hover:bg-[var(--bg-hover)]"
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{linked.name}</span>
                    <span className="text-mini block truncate text-[var(--fg-muted)]">
                      {[
                        linked.kind === 'company' ? 'Company' : 'Person',
                        linked.domain ?? linked.primary_email,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  <span className="text-mini flex shrink-0 items-center gap-1 text-[var(--accent)]">
                    Open profile
                    <ArrowUpRight className="size-3.5" aria-hidden="true" />
                  </span>
                </Link>
              ) : (
                <p className="text-sm text-[var(--fg-subtle)]">
                  Not linked to a company or person.
                </p>
              )}
            </section>

            {statusField ? (
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm font-medium">{statusField.name}</span>
                {canWrite ? (
                  <StatusSelect
                    label={`${statusField.name} for ${entry.title}`}
                    value={(values[statusField.key] as string | undefined) ?? null}
                    options={statusOptions}
                    disabled={saving}
                    onChange={(next) => onStatusChange(entry, next)}
                    className="h-8 text-sm"
                  />
                ) : (
                  <CrmValueView
                    field={statusField}
                    value={values[statusField.key]}
                    timezone={timezone}
                  />
                )}
              </div>
            ) : null}

            <section aria-labelledby="entry-fields">
              <SectionHeading className="mb-1">
                <span id="entry-fields">Fields</span>
              </SectionHeading>
              <dl className="divide-y divide-[var(--border)]">
                {list.fields
                  .filter((f) => f.key !== statusField?.key)
                  .map((field) => (
                    <DataRow key={field.key} label={field.name}>
                      {editable(field) ? (
                        <EditableCrmValue
                          // A fresh editor per row: a half-typed value never follows to another.
                          key={`${entry.id}:${field.key}`}
                          field={field}
                          value={values[field.key]}
                          timezone={timezone}
                          entryTitle={entry.title}
                          onSave={(next) => saveValue(entry, field, next)}
                        />
                      ) : (
                        <CrmValueView field={field} value={values[field.key]} timezone={timezone} />
                      )}
                    </DataRow>
                  ))}
                {statusField ? (
                  <DataRow label={CRM_TIME_IN_STATUS_LABEL}>
                    <TimeInStatus timer={timer} now={now} timezone={timezone} detail />
                  </DataRow>
                ) : null}
                <DataRow label="Added">{formatDate(entry.created_at, timezone)}</DataRow>
              </dl>
            </section>

            <section aria-labelledby="entry-notes">
              <SectionHeading
                count={notesShown}
                action={
                  canWrite && linked && notesShown ? (
                    <ExportNotesLink recordId={linked.id} recordName={linked.name} />
                  ) : null
                }
              >
                <span id="entry-notes">Notes</span>
              </SectionHeading>
              {!current ? (
                <SkeletonText lines={4} />
              ) : current.error ? (
                <ErrorState
                  title="Notes unavailable"
                  message={current.error}
                  stillUsable="The fields above and the rest of the list."
                />
              ) : (
                <CrmNotesPanel
                  // A fresh box per row: a half-typed note never follows to another.
                  key={entry.id}
                  notes={current.detail?.notes ?? NO_NOTES}
                  timezone={timezone}
                  canWrite={canWrite}
                  affinitySyncOn={affinitySyncOn}
                  attach={{
                    entryIds: [entry.id],
                    recordIds:
                      list.entity_type !== 'deal' && entry.record_id ? [entry.record_id] : [],
                  }}
                  disabled={!current.detail}
                  empty="No notes on this entry yet."
                  onCountChange={(count) => setNoteCount({ entryId: entry.id, count })}
                />
              )}
            </section>

            {canWrite ? (
              <section
                aria-label="Remove from list"
                className="border-t border-[var(--border)] pt-4"
              >
                <Button variant="ghost" size="sm" onClick={() => onRemove(entry)}>
                  <ListX aria-hidden="true" />
                  Remove from {list.name}
                </Button>
                <p className="text-mini mt-1 text-[var(--fg-muted)]">
                  Takes the row off this list only: the profile and its notes stay. Undo is on the
                  message that follows, and the daily Affinity sync does not add it back.
                </p>
              </section>
            ) : null}
          </div>
        </Drawer>
      ) : null}
    </Dialog>
  );
}
