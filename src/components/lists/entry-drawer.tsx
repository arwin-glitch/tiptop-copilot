'use client';

import * as React from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { ArrowUpRight } from 'lucide-react';
import { addCrmNoteAction, getCrmEntryAction } from '@/app/actions/crm';
import { CrmNoteList } from '@/components/lists/crm-note-list';
import { CrmValueView } from '@/components/lists/crm-value';
import { ExportNotesLink } from '@/components/lists/export-notes-link';
import { TimeInStatus } from '@/components/lists/list-table';
import { StatusSelect } from '@/components/lists/status-select';
import type { ListViewList } from '@/components/lists/list-view';
import { DataRow, SectionHeading } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Dialog, Drawer } from '@/components/ui/dialog';
import { ErrorState, SkeletonText } from '@/components/ui/feedback';
import { Textarea } from '@/components/ui/form';
import { CRM_TIME_IN_STATUS_LABEL, type CrmTimeInStatus } from '@/lib/crm/saved-views';
import type { CrmEntryDetail, CrmRecordSummary } from '@/lib/services/crm';
import type { CrmField, CrmListEntry, CrmNote, CrmValue } from '@/lib/types/domain';
import { formatDate } from '@/lib/util/time';

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
  onClose,
  onStatusChange,
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
  onClose: () => void;
  onStatusChange: (entry: CrmListEntry, next: string | null) => void;
}) {
  const entryId = entry?.id ?? null;
  const [loaded, setLoaded] = React.useState<Loaded | null>(null);
  const [draft, setDraft] = React.useState('');
  const [posting, startPosting] = React.useTransition();

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

  const addNote = () => {
    if (!entry) return;
    const content = draft.trim();
    if (!content) return;
    startPosting(async () => {
      const result = await addCrmNoteAction({
        content,
        entryIds: [entry.id],
        recordIds: list.entity_type !== 'deal' && entry.record_id ? [entry.record_id] : [],
      }).catch(() => null);
      if (!result) {
        toast.error('The note could not be saved: no connection. Your text is still in the box.');
        return;
      }
      if (!result.ok || !result.data) {
        toast.error(result.error?.message ?? 'The note could not be saved.', {
          description: result.error?.stillUsable,
        });
        return;
      }
      const note: CrmNote = result.data.note;
      setDraft('');
      setLoaded((prev) =>
        prev && prev.entryId === entry.id && prev.detail
          ? { ...prev, detail: { ...prev.detail, notes: [note, ...prev.detail.notes] } }
          : prev,
      );
      toast.success('Note added');
    });
  };

  return (
    <Dialog
      open={entry !== null}
      onOpenChange={(open) => {
        if (!open) {
          setDraft('');
          onClose();
        }
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
                      <CrmValueView field={field} value={values[field.key]} timezone={timezone} />
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
                count={current?.detail?.notes.length}
                action={
                  canWrite && linked && current?.detail?.notes.length ? (
                    <ExportNotesLink recordId={linked.id} recordName={linked.name} />
                  ) : null
                }
              >
                <span id="entry-notes">Notes</span>
              </SectionHeading>
              {canWrite ? (
                <form
                  className="mb-4 space-y-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    addNote();
                  }}
                >
                  <Textarea
                    aria-label="New note"
                    placeholder="Add a note — a call, a decision, what happens next"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    rows={3}
                    maxLength={500_000}
                  />
                  <div className="flex justify-end">
                    <Button
                      type="submit"
                      variant="primary"
                      size="sm"
                      loading={posting}
                      disabled={!draft.trim() || posting || !current?.detail}
                    >
                      Add note
                    </Button>
                  </div>
                </form>
              ) : null}
              {!current ? (
                <SkeletonText lines={4} />
              ) : current.error ? (
                <ErrorState
                  title="Notes unavailable"
                  message={current.error}
                  stillUsable="The fields above and the rest of the list."
                />
              ) : (
                <CrmNoteList
                  notes={current.detail?.notes ?? []}
                  timezone={timezone}
                  empty="No notes on this entry yet."
                />
              )}
            </section>
          </div>
        </Drawer>
      ) : null}
    </Dialog>
  );
}
