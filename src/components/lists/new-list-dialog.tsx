'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { createCrmListAction } from '@/app/actions/crm';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/form';
import type { CrmEntityType } from '@/lib/types/domain';

/**
 * "New list": an empty list made in Copilot — people, companies or deals —
 * that opens straight away, ready for "Add entry", columns and rows saved from
 * elsewhere. What Affinity's own "New list" did, now that nothing else makes
 * one.
 */
export function NewListDialog() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [kind, setKind] = React.useState<CrmEntityType>('person');
  const [saving, startSaving] = React.useTransition();

  const save = () =>
    startSaving(async () => {
      const result = await createCrmListAction({ name: name.trim(), entityType: kind }).catch(
        () => null,
      );
      if (!result) {
        toast.error('The list could not be made: no connection.');
        return;
      }
      if (!result.ok || !result.data) {
        toast.error(result.error?.message ?? 'The list could not be made.', {
          description: result.error?.stillUsable,
        });
        return;
      }
      toast.success(`Made ${result.data.name}`);
      setOpen(false);
      setName('');
      router.push(`/lists/${result.data.id}`);
    });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="primary" size="sm">
          <Plus aria-hidden="true" />
          New list
        </Button>
      </DialogTrigger>
      <DialogContent
        title="New list"
        description="An empty list made in Copilot. Add people or companies to it, give it columns, or send a campaign to it."
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) save();
          }}
        >
          <Field label="Name" htmlFor="new-list-name">
            <Input
              id="new-list-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={300}
              placeholder="e.g. Founders to invite"
              autoComplete="off"
            />
          </Field>
          <Field label="It holds" htmlFor="new-list-kind">
            <Select
              id="new-list-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as CrmEntityType)}
            >
              <option value="person">People</option>
              <option value="company">Companies</option>
              <option value="deal">Deals</option>
            </Select>
          </Field>
          <DialogFooter>
            <Button
              type="submit"
              variant="primary"
              loading={saving}
              disabled={!name.trim() || saving}
            >
              Make the list
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
