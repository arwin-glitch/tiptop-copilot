'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { Columns3 } from 'lucide-react';
import { addCrmListFieldAction } from '@/app/actions/crm';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/form';
import { CRM_COPILOT_FIELD_TYPES, CRM_FIELD_TYPE_LABELS } from '@/lib/crm/fields';
import type { CrmField } from '@/lib/types/domain';

type CopilotFieldType = (typeof CRM_COPILOT_FIELD_TYPES)[number];

/**
 * "Add column": a custom field of the list's own, made in Kraken. Its values
 * are set from a row's side panel. The Affinity sync never takes a Kraken
 * column over, even when an Affinity field has the same name.
 */
export function AddColumnDialog({
  listId,
  listName,
  onAdded,
}: {
  listId: string;
  listName: string;
  onAdded: (field: CrmField) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [type, setType] = React.useState<CopilotFieldType>('text');
  const [choices, setChoices] = React.useState('');
  const [saving, startSaving] = React.useTransition();
  const needsChoices = type === 'status' || type === 'multi';
  const options = choices
    .split('\n')
    .map((c) => c.trim())
    .filter(Boolean);

  const reset = () => {
    setName('');
    setType('text');
    setChoices('');
  };

  const save = () =>
    startSaving(async () => {
      const result = await addCrmListFieldAction(listId, {
        name: name.trim(),
        type,
        options: needsChoices ? options : [],
      }).catch(() => null);
      if (!result) {
        toast.error('The column could not be added: no connection.');
        return;
      }
      if (!result.ok || !result.data) {
        toast.error(result.error?.message ?? 'The column could not be added.', {
          description: result.error?.stillUsable,
        });
        return;
      }
      toast.success(`Added the column ${result.data.field.name}`, {
        description: 'Open a row to fill it in.',
      });
      setOpen(false);
      reset();
      onAdded(result.data.field);
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
          <Columns3 aria-hidden="true" />
          Add column
        </Button>
      </DialogTrigger>
      <DialogContent
        title={`Add a column to ${listName}`}
        description="A column of your own. Fill it in from a row's side panel; the Affinity sync never overwrites it."
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() && (!needsChoices || options.length)) save();
          }}
        >
          <Field label="Column name" htmlFor="add-column-name">
            <Input
              id="add-column-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={200}
              placeholder="e.g. Table, Invited by, RSVP"
              autoComplete="off"
            />
          </Field>
          <Field label="Kind" htmlFor="add-column-type">
            <Select
              id="add-column-type"
              value={type}
              onChange={(e) => setType(e.target.value as CopilotFieldType)}
            >
              {CRM_COPILOT_FIELD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {CRM_FIELD_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          </Field>
          {needsChoices ? (
            <Field label="Choices, one per line" htmlFor="add-column-choices">
              <Textarea
                id="add-column-choices"
                value={choices}
                onChange={(e) => setChoices(e.target.value)}
                rows={4}
                placeholder={'Invited\nYes\nNo'}
              />
            </Field>
          ) : null}
          <DialogFooter>
            <Button
              type="submit"
              variant="primary"
              loading={saving}
              disabled={!name.trim() || (needsChoices && !options.length) || saving}
            >
              Add column
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
