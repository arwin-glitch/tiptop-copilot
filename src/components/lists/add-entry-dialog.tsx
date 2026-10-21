'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { Plus, UserPlus, X } from 'lucide-react';
import {
  addCrmEntryAction,
  createCrmRecordAction,
  searchCrmRecordsAction,
} from '@/app/actions/crm';
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
 *
 * On a company or person list, someone not in the CRM yet can be made here
 * ("New company" / "New person", with a website or an email): the record is
 * created first — or, when one with that domain or address already exists,
 * that one is used instead of a duplicate — and then added to the list.
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
  // Making a new company or person (not on a deal list).
  const [creating, setCreating] = React.useState(false);
  const [newName, setNewName] = React.useState('');
  const [identity, setIdentity] = React.useState('');
  const [place, setPlace] = React.useState('');
  const canCreate = list.entity_type !== 'deal';

  const reset = () => {
    setQuery('');
    setResults([]);
    setSearched('');
    setPicked(null);
    setTitle('');
    setStatus('');
    setCreating(false);
    setNewName('');
    setIdentity('');
    setPlace('');
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
  const canSave = creating
    ? Boolean(newName.trim() || identity.trim())
    : Boolean(picked || title.trim());

  const save = () =>
    startSaving(async () => {
      let record = picked;
      if (creating) {
        const made = await createCrmRecordAction({
          kind,
          name: newName.trim(),
          ...(kind === 'company' ? { domain: identity.trim() } : { email: identity.trim() }),
          location: place.trim(),
        }).catch(() => null);
        if (!made) {
          toast.error(`The ${noun} could not be added: no connection.`);
          return;
        }
        if (!made.ok || !made.data) {
          toast.error(made.error?.message ?? `The ${noun} could not be added.`, {
            description: made.error?.stillUsable,
          });
          return;
        }
        record = made.data.record;
        if (made.data.existed) {
          toast.info(`${record.name} was already in the CRM, so that record is used.`, {
            description:
              made.data.matchedBy === 'name'
                ? 'Matched by name. Give a website or email to tell two apart.'
                : `Matched by ${made.data.matchedBy === 'domain' ? 'website' : 'email'}.`,
          });
        }
      }
      const result = await addCrmEntryAction(list.id, {
        recordId: record?.id ?? null,
        title: title.trim() || null,
        values: statusField && status ? { [statusField.key]: status } : {},
      }).catch(() => null);
      // Made (or found) now: a retry adds this record rather than making it again.
      if (creating && record) {
        setCreating(false);
        setPicked(record);
      }
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
                {creating ? null : shown.length > 0 ? (
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
                    {canCreate
                      ? `No ${noun} by that name yet. Make a new one below, or type a name to add the row without a linked record.`
                      : `No ${noun} by that name yet. Type the name below to add the row without a linked record.`}
                  </p>
                ) : null}
                {canCreate && !creating ? (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="mt-1 h-auto px-0"
                    onClick={() => {
                      setCreating(true);
                      setNewName(query.includes('@') || query.includes('.') ? '' : query.trim());
                      setIdentity(query.includes('@') || query.includes('.') ? query.trim() : '');
                    }}
                  >
                    <UserPlus aria-hidden="true" />
                    New {noun}
                  </Button>
                ) : null}
              </>
            )}
          </Field>

          {creating ? (
            <fieldset className="space-y-3 rounded-md border border-[var(--border)] p-3">
              <legend className="px-1 text-sm font-medium">New {noun}</legend>
              <Field label="Name" htmlFor="add-entry-new-name">
                <Input
                  id="add-entry-new-name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  maxLength={500}
                  autoComplete="off"
                />
              </Field>
              <Field
                label={kind === 'company' ? 'Website' : 'Email'}
                htmlFor="add-entry-new-identity"
                hint={
                  kind === 'company'
                    ? 'A company already here with this website is used instead of a copy.'
                    : 'Someone already here with this email is used instead of a copy.'
                }
              >
                <Input
                  id="add-entry-new-identity"
                  type={kind === 'company' ? 'text' : 'email'}
                  value={identity}
                  onChange={(e) => setIdentity(e.target.value)}
                  placeholder={kind === 'company' ? 'example.com' : 'name@example.com'}
                  autoComplete="off"
                />
              </Field>
              <Field label="Location" htmlFor="add-entry-new-place">
                <Input
                  id="add-entry-new-place"
                  value={place}
                  onChange={(e) => setPlace(e.target.value)}
                  maxLength={300}
                  placeholder="City, state"
                  autoComplete="off"
                />
              </Field>
              <Button type="button" variant="ghost" size="sm" onClick={() => setCreating(false)}>
                Pick someone already here instead
              </Button>
            </fieldset>
          ) : null}

          {list.entity_type === 'deal' || (!picked && !creating) ? (
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
