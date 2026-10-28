'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Building2, ListPlus, UserPlus } from 'lucide-react';
import {
  addCrmRecordsToListAction,
  createCrmRecordAction,
  crmListsForAction,
  type CrmListChoice,
} from '@/app/actions/crm';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from '@/components/ui/dialog';
import { SkeletonText } from '@/components/ui/feedback';
import { Field, Input, Select } from '@/components/ui/form';
import type { CrmRecordKind } from '@/lib/types/domain';

/**
 * The dialogs that put companies and people into the CRM and onto lists:
 * "New company" / "New person", and a list picker that "Add to list" on a
 * profile and on Find & save both use.
 */

/**
 * "New company" or "New person": made in Kraken, keyed on its website or
 * email so the daily Affinity sync adopts it rather than copying it. One the
 * CRM already has opens instead of being made twice.
 */
export function NewRecordDialog({ kind }: { kind: CrmRecordKind }) {
  const router = useRouter();
  const noun = kind === 'company' ? 'company' : 'person';
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [identity, setIdentity] = React.useState('');
  const [place, setPlace] = React.useState('');
  const [saving, startSaving] = React.useTransition();
  const id = `new-${noun}`;

  const reset = () => {
    setName('');
    setIdentity('');
    setPlace('');
  };

  const save = () =>
    startSaving(async () => {
      const result = await createCrmRecordAction({
        kind,
        name: name.trim(),
        ...(kind === 'company' ? { domain: identity.trim() } : { email: identity.trim() }),
        location: place.trim(),
      }).catch(() => null);
      if (!result) {
        toast.error(`The ${noun} could not be added: no connection.`);
        return;
      }
      if (!result.ok || !result.data) {
        toast.error(result.error?.message ?? `The ${noun} could not be added.`, {
          description: result.error?.stillUsable,
        });
        return;
      }
      const { record, existed, matchedBy } = result.data;
      if (existed) {
        toast.info(`${record.name} is already in the CRM. Opening it.`, {
          description:
            matchedBy === 'name'
              ? 'Matched by name. Give a website or email to add someone else of that name.'
              : `Matched by ${matchedBy === 'domain' ? 'website' : 'email'}.`,
        });
      } else {
        toast.success(`Added ${record.name}`);
      }
      setOpen(false);
      reset();
      router.push(`/lists/records/${record.id}`);
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
        <Button variant="secondary" size="sm">
          {kind === 'company' ? <Building2 aria-hidden="true" /> : <UserPlus aria-hidden="true" />}
          New {noun}
        </Button>
      </DialogTrigger>
      <DialogContent
        title={`New ${noun}`}
        description={
          kind === 'company'
            ? 'Added to the CRM. A company already here with this website opens instead.'
            : 'Added to the CRM. Someone already here with this email opens instead.'
        }
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() || identity.trim()) save();
          }}
        >
          <Field label="Name" htmlFor={`${id}-name`}>
            <Input
              id={`${id}-name`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={500}
              autoComplete="off"
            />
          </Field>
          <Field label={kind === 'company' ? 'Website' : 'Email'} htmlFor={`${id}-identity`}>
            <Input
              id={`${id}-identity`}
              type={kind === 'company' ? 'text' : 'email'}
              value={identity}
              onChange={(e) => setIdentity(e.target.value)}
              placeholder={kind === 'company' ? 'example.com' : 'name@example.com'}
              autoComplete="off"
            />
          </Field>
          <Field label="Location" htmlFor={`${id}-place`}>
            <Input
              id={`${id}-place`}
              value={place}
              onChange={(e) => setPlace(e.target.value)}
              maxLength={300}
              placeholder="City, state"
              autoComplete="off"
            />
          </Field>
          <DialogFooter>
            <Button
              type="submit"
              variant="primary"
              loading={saving}
              disabled={!(name.trim() || identity.trim()) || saving}
            >
              Add {noun}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Pick one of the lists a company or person can go on, then `onPick` it.
 * The lists are read when the dialog opens, so a list made a moment ago is
 * there.
 */
export function ListPickerDialog({
  kind,
  title,
  description,
  triggerLabel,
  confirmLabel,
  onPick,
}: {
  kind: CrmRecordKind;
  title: string;
  description: string;
  triggerLabel: string;
  confirmLabel: string;
  /** Resolves to true when done, which closes the dialog. */
  onPick: (list: CrmListChoice) => Promise<boolean>;
}) {
  const [open, setOpen] = React.useState(false);
  const [lists, setLists] = React.useState<CrmListChoice[] | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [chosen, setChosen] = React.useState('');
  const [saving, startSaving] = React.useTransition();
  const selectId = React.useId();

  React.useEffect(() => {
    if (!open) return;
    let live = true;
    crmListsForAction(kind).then(
      (result) => {
        if (!live) return;
        if (result.ok && result.data) {
          setLists(result.data);
          setProblem(null);
        } else {
          setLists([]);
          setProblem(result.error?.message ?? 'The lists could not be read just now.');
        }
      },
      () => {
        if (live) {
          setLists([]);
          setProblem('The lists could not be read: no connection.');
        }
      },
    );
    return () => {
      live = false;
    };
  }, [open, kind]);

  const pick = () => {
    const list = lists?.find((l) => l.id === chosen);
    if (!list) return;
    startSaving(async () => {
      if (await onPick(list)) {
        setOpen(false);
        setChosen('');
      }
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setChosen('');
      }}
    >
      <DialogTrigger asChild>
        <Button variant="secondary" size="sm">
          <ListPlus aria-hidden="true" />
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent title={title} description={description}>
        {lists === null ? (
          <SkeletonText lines={2} />
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              pick();
            }}
          >
            {problem ? <p className="text-sm text-[var(--danger)]">{problem}</p> : null}
            {lists.length === 0 && !problem ? (
              <p className="text-sm text-[var(--fg-muted)]">
                There is no {kind === 'company' ? 'company' : 'person'} list yet. Make one with “New
                list” under Knowledge → Affinity lists.
              </p>
            ) : (
              <Field label="List" htmlFor={selectId}>
                <Select id={selectId} value={chosen} onChange={(e) => setChosen(e.target.value)}>
                  <option value="">Choose a list</option>
                  {lists.map((l) => (
                    <option key={l.id} value={l.id}>
                      {`${l.name} (${l.entryCount.toLocaleString('en-US')})${l.source === 'copilot' ? ' · made in Kraken' : ''}`}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <DialogFooter>
              <Button type="submit" variant="primary" loading={saving} disabled={!chosen || saving}>
                {confirmLabel}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** A profile's "Add to list": this company or person onto one of the lists. */
export function AddRecordToListButton({
  recordId,
  recordName,
  kind,
}: {
  recordId: string;
  recordName: string;
  kind: CrmRecordKind;
}) {
  const router = useRouter();
  return (
    <ListPickerDialog
      kind={kind}
      title={`Add ${recordName} to a list`}
      description={`Pick a ${kind === 'company' ? 'company' : 'person'} list.`}
      triggerLabel="Add to list"
      confirmLabel="Add to list"
      onPick={async (list) => {
        const result = await addCrmRecordsToListAction(list.id, [recordId]).catch(() => null);
        if (!result || !result.ok || !result.data) {
          toast.error(result?.error?.message ?? 'Could not add to the list: no connection.');
          return false;
        }
        if (result.data.added) toast.success(`Added ${recordName} to ${list.name}`);
        else toast.info(`${recordName} is already on ${list.name}`);
        React.startTransition(() => router.refresh());
        return true;
      }}
    />
  );
}
