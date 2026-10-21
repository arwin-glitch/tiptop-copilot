'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ListPlus } from 'lucide-react';
import { saveCrmViewAsListAction } from '@/app/actions/crm';
import type { ListViewList } from '@/components/lists/list-view';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/form';
import type { CrmListParams } from '@/lib/crm/view';

const NOUN = { person: 'people', company: 'companies', deal: 'deals' } as const;

/**
 * "Save as list": the rows the view on screen shows — its search, status
 * chips and filters, in its order — as a new list made in Copilot. Applied on
 * the server across the whole list, not just this page, and opened once made.
 * The new list starts without the old one's columns; each row keeps its name
 * and its company or person.
 */
export function SaveAsListDialog({
  list,
  params,
  total,
}: {
  list: Pick<ListViewList, 'id' | 'name' | 'entity_type'>;
  params: CrmListParams;
  /** How many rows the view holds, when the page knows. */
  total: number | null;
}) {
  const router = useRouter();
  const filtered = params.q !== '' || params.statuses.length > 0 || params.conditions.length > 0;
  const suggested = filtered ? `${list.name} (filtered)` : `Copy of ${list.name}`;
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState(suggested);
  const [saving, startSaving] = React.useTransition();

  const save = () =>
    startSaving(async () => {
      const result = await saveCrmViewAsListAction(list.id, {
        name: name.trim(),
        q: params.q,
        statuses: params.statuses,
        conditions: params.conditions,
        sort: params.sort,
        dir: params.dir,
      }).catch(() => null);
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
      const { id, name: saved, added, truncated } = result.data;
      toast.success(
        `Saved ${added.toLocaleString('en-US')} ${added === 1 ? 'row' : 'rows'} as ${saved}`,
        truncated ? { description: 'The view held more; the first ones were saved.' } : undefined,
      );
      setOpen(false);
      router.push(`/lists/${id}`);
    });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setName(suggested);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="secondary" size="sm">
          <ListPlus aria-hidden="true" />
          Save as list
        </Button>
      </DialogTrigger>
      <DialogContent
        title="Save as a new list"
        description={
          total === null
            ? `The ${NOUN[list.entity_type]} this view shows go on a new list.`
            : `The ${total.toLocaleString('en-US')} ${total === 1 ? 'row' : 'rows'} this view shows${filtered ? ' (with its search and filters)' : ''} go on a new list.`
        }
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) save();
          }}
        >
          <Field label="Name of the new list" htmlFor="save-as-list-name">
            <Input
              id="save-as-list-name"
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
              disabled={!name.trim() || saving || total === 0}
            >
              Save list
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
