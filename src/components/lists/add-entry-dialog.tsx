'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { Plus, X } from 'lucide-react';
import { addCrmEntryAction, searchCrmRecordsAction } from '@/app/actions/crm';
import type { ListViewList } from '@/components/lists/list-view';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/form';
import type { CrmRecordSummary } from '@/lib/services/crm';
import type { CrmField, CrmListEntry } from '@/lib/types/domain';
import { cn } from '@/lib/util/cn';

const SEARCH_DEBOUNCE_MS = 200;

/**
 * "Add entry": pick a company or person already in the CRM, or just type a
 * name. A deal list takes a name and, optionally, the company the deal is
 * with; a company or person list takes the record (a name alone makes an
 * unlinked row, as Affinity allows). The record search is the same ranked
 * search as the profiles use — exact name first, then prefixes.
 */
export function AddEntryDialog({
  list,
  statusField,
  statusOptions,
  onAdded,
}: {
  list: ListViewList;
  statusField: CrmField | null;
  statusOptions: string[];
  onAdded: (entry: CrmListEntry) => void;
}) {
  const kind = list.entity_type === 'person' ? 'person' : 'company';
  const noun = kind === 'person' ? 'person' : 'company';
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [results, setResults] = React.useState<CrmRecordSummary[]>([]);
  const [searched, setSearched] = React.useState('');
  const [picked, setPicked] = React.useState<CrmRecordSummary | null>(null);
  const [title, setTitle] = React.useState('');
  const [status, setStatus] = React.useState('');
  const [saving, startSaving] = React.useTransition();

  const reset = () => {
    setQuery('');
    setResults([]);
    setSearched('');
    setPicked(null);
    setTitle('');
    setStatus('');
  };

  React.useEffect(() => {
    const q = query.trim();
    if (q.length < 2 || picked) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const result = await searchCrmRecordsAction(q, kind).catch(() => null);
      if (cancelled) return;
      setResults(result?.ok ? (result.data ?? []) : []);
      setSearched(q);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, kind, picked]);

  const shown = query.trim().length >= 2 && !picked ? results : [];
  const canSave = Boolean(picked || title.trim());

  const save = () =>
    startSaving(async () => {
      const result = await addCrmEntryAction(list.id, {
        recordId: picked?.id ?? null,
        title: title.trim() || null,
        values: statusField && status ? { [statusField.key]: status } : {},
      }).catch(() => null);
      if (!result) {
        toast.error('The entry could not be added: no connection.');
        return;
      }
      if (!result.ok || !result.data) {
        toast.error(result.error?.message ?? 'The entry could not be added.', {
          description: result.error?.stillUsable,
        });
        return;
      }
      toast.success(`Added ${result.data.entry.title} to ${list.name}`);
      setOpen(false);
      reset();
      onAdded(result.data.entry);
    });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="primary" size="sm">
          <Plus aria-hidden="true" />
          Add entry
        </Button>
      </DialogTrigger>
      <DialogContent
        title={`Add to ${list.name}`}
        description={
          list.entity_type === 'deal'
            ? 'Name the deal, and pick the company it is with if it is already here.'
            : `Pick the ${noun}, or type a name to add it without a linked record.`
        }
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSave) save();
          }}
        >
          <Field label={kind === 'person' ? 'Person' : 'Company'} htmlFor="add-entry-record">
            {picked ? (
              <div className="flex items-center justify-between gap-2 rounded-md border border-[var(--border-strong)] bg-[var(--bg-sunken)] px-3 py-2 text-sm">
                <span className="min-w-0 truncate">
                  <span className="font-medium">{picked.name}</span>
                  {picked.domain || picked.primary_email ? (
                    <span className="text-[var(--fg-muted)]">
                      {' '}
                      · {picked.domain ?? picked.primary_email}
                    </span>
                  ) : null}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${picked.name}`}
                  onClick={() => setPicked(null)}
                  className="rounded p-0.5 text-[var(--fg-subtle)] hover:text-[var(--fg)]"
                >
                  <X className="size-3.5" aria-hidden="true" />
                </button>
              </div>
            ) : (
              <>
                <Input
                  id="add-entry-record"
                  type="search"
                  autoComplete="off"
                  placeholder={kind === 'person' ? 'Name or email' : 'Name or domain'}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                {shown.length > 0 ? (
                  <ul
                    aria-label={`Matching ${noun === 'person' ? 'people' : 'companies'}`}
                    className="mt-1.5 max-h-56 space-y-0.5 overflow-y-auto rounded-md border border-[var(--border)] p-1"
                  >
                    {shown.map((r) => (
                      <li key={r.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setPicked(r);
                            if (list.entity_type !== 'deal') setTitle('');
                          }}
                          className={cn(
                            'flex w-full items-baseline justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-[var(--bg-hover)]',
                          )}
                        >
                          <span className="truncate font-medium">{r.name}</span>
                          <span className="text-mini shrink-0 text-[var(--fg-subtle)]">
                            {r.domain ?? r.primary_email ?? ''}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : query.trim().length >= 2 && searched === query.trim() ? (
                  <p className="mt-1.5 text-xs text-[var(--fg-muted)]">
                    No {noun} by that name yet. Type the name below to add the row without a linked
                    record.
                  </p>
                ) : null}
              </>
            )}
          </Field>

          {list.entity_type === 'deal' || !picked ? (
            <Field
              label={list.entity_type === 'deal' ? 'Deal name' : 'Name'}
              htmlFor="add-entry-title"
              hint={
                list.entity_type === 'deal' && picked
                  ? `Leave blank to use ${picked.name}.`
                  : undefined
              }
            >
              <Input
                id="add-entry-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={500}
                placeholder={list.entity_type === 'deal' ? 'e.g. Seed round' : undefined}
              />
            </Field>
          ) : null}

          {statusField ? (
            <Field label={statusField.name} htmlFor="add-entry-status">
              <Select
                id="add-entry-status"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="">No {statusField.name.toLowerCase()}</option>
                {statusOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}

          <DialogFooter>
            <Button type="submit" variant="primary" loading={saving} disabled={!canSave || saving}>
              Add entry
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
