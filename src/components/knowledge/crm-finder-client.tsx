'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ListPlus, Search } from 'lucide-react';
import { addFinderToListAction, saveFinderAsListAction } from '@/app/actions/crm';
import { ListPickerDialog } from '@/components/lists/record-dialogs';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/form';
import { FilterChip, FilterChipRow } from '@/components/ui/toolbar';
import { CRM_FINDER_YEAR_CHOICES, finderHref, type CrmFinderCriteria } from '@/lib/crm/finder';
import type { CrmRecordKind } from '@/lib/types/domain';

/** A list the "On list" menu offers. */
export interface FinderListOption {
  id: string;
  name: string;
  entityType: 'company' | 'person' | 'deal';
}

/**
 * The search form: people or companies, then any of a name, a place, how
 * recently you were in touch and a list. Searching goes through the URL, so
 * a search can be bookmarked and the server reads every match, not a page.
 */
export function FinderForm({
  criteria,
  lists,
}: {
  criteria: CrmFinderCriteria;
  lists: FinderListOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [kind, setKind] = React.useState<CrmRecordKind>(criteria.kind);
  const [q, setQ] = React.useState(criteria.q);
  const [place, setPlace] = React.useState(criteria.place);
  const [years, setYears] = React.useState(criteria.years ? String(criteria.years) : '');
  const [listId, setListId] = React.useState(criteria.listId ?? '');
  // A deal list's rows are about companies.
  const offered = lists.filter((l) =>
    kind === 'person' ? l.entityType === 'person' : l.entityType !== 'person',
  );

  const search = (next: Partial<CrmFinderCriteria> = {}) =>
    startTransition(() =>
      router.push(
        finderHref({
          kind,
          q: q.trim(),
          place: place.trim(),
          years: years ? Number(years) : null,
          listId: offered.some((l) => l.id === listId) ? listId : null,
          ...next,
        }),
        { scroll: false },
      ),
    );

  return (
    <form
      role="search"
      aria-label="Find people and companies"
      className="space-y-3 rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)] p-4"
      onSubmit={(e) => {
        e.preventDefault();
        search();
      }}
    >
      <FilterChipRow aria-label="Find">
        {(['person', 'company'] as const).map((k) => (
          <FilterChip
            key={k}
            label={k === 'person' ? 'People' : 'Companies'}
            pressed={kind === k}
            onToggle={() => {
              setKind(k);
              setListId('');
            }}
          />
        ))}
      </FilterChipRow>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Name, email or website" htmlFor="finder-q">
          <Input
            id="finder-q"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            maxLength={200}
            placeholder={kind === 'person' ? 'Name or email' : 'Name or website'}
            autoComplete="off"
          />
        </Field>
        <Field label="Where" htmlFor="finder-place">
          <Input
            id="finder-place"
            value={place}
            onChange={(e) => setPlace(e.target.value)}
            maxLength={200}
            placeholder="A city, e.g. Austin"
            autoComplete="off"
          />
        </Field>
        <Field label="In touch within" htmlFor="finder-years">
          <Select id="finder-years" value={years} onChange={(e) => setYears(e.target.value)}>
            <option value="">Any time</option>
            {CRM_FINDER_YEAR_CHOICES.map((n) => (
              <option key={n} value={n}>
                The last {n === 1 ? 'year' : `${n} years`}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="On list" htmlFor="finder-list">
          <Select id="finder-list" value={listId} onChange={(e) => setListId(e.target.value)}>
            <option value="">Any list, or none</option>
            {offered.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-mini text-[var(--fg-muted)]">
          Last contact is the later of your own mail and calendar and Affinity’s dates.
        </p>
        <Button type="submit" variant="primary" size="sm" loading={pending}>
          <Search aria-hidden="true" />
          Search
        </Button>
      </div>
    </form>
  );
}

/**
 * What to do with the matches: save them all as a new list, or add them all
 * to a list that exists. The server works the matches out again from the
 * criteria, so the list gets every match, not just the rows on screen.
 */
export function FinderActions({
  criteria,
  total,
  suggestedName,
}: {
  criteria: CrmFinderCriteria;
  total: number;
  suggestedName: string;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState(suggestedName);
  const [saving, startSaving] = React.useTransition();
  const input = {
    kind: criteria.kind,
    q: criteria.q,
    place: criteria.place,
    years: criteria.years,
    listId: criteria.listId,
  };
  const noun = criteria.kind === 'company' ? 'companies' : 'people';

  const save = () =>
    startSaving(async () => {
      const result = await saveFinderAsListAction(input, name.trim()).catch(() => null);
      if (!result) {
        toast.error('The list could not be saved: no connection.');
        return;
      }
      if (!result.ok || !result.data) {
        toast.error(result.error?.message ?? 'The list could not be saved.', {
          description: result.error?.stillUsable,
        });
        return;
      }
      toast.success(
        `Saved ${result.data.added.toLocaleString('en-US')} ${noun} as ${result.data.name}`,
      );
      setOpen(false);
      router.push(`/lists/${result.data.id}`);
    });

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) setName(suggestedName);
        }}
      >
        <DialogTrigger asChild>
          <Button variant="primary" size="sm">
            <ListPlus aria-hidden="true" />
            Save as list
          </Button>
        </DialogTrigger>
        <DialogContent
          title="Save these as a new list"
          description={`All ${total.toLocaleString('en-US')} ${noun} this search found go on a new list made in Copilot, ready for a campaign.`}
        >
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) save();
            }}
          >
            <Field label="Name of the new list" htmlFor="finder-list-name">
              <Input
                id="finder-list-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={300}
                autoComplete="off"
              />
            </Field>
            <DialogFooter>
              <Button
                type="submit"
                variant="primary"
                loading={saving}
                disabled={!name.trim() || saving}
              >
                Save list
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <ListPickerDialog
        kind={criteria.kind}
        title={`Add these ${noun} to a list`}
        description={`All ${total.toLocaleString('en-US')} go on the list you pick; any already on it stay as they are.`}
        triggerLabel="Add to list"
        confirmLabel="Add them"
        onPick={async (list) => {
          const result = await addFinderToListAction(input, list.id).catch(() => null);
          if (!result || !result.ok || !result.data) {
            toast.error(result?.error?.message ?? 'Could not add them: no connection.');
            return false;
          }
          const { added, already } = result.data;
          toast.success(`Added ${added.toLocaleString('en-US')} to ${list.name}`, {
            description: already
              ? `${already.toLocaleString('en-US')} ${already === 1 ? 'was' : 'were'} on it already.`
              : undefined,
            action: { label: 'Open list', onClick: () => router.push(`/lists/${list.id}`) },
          });
          return true;
        }}
      />
    </div>
  );
}
