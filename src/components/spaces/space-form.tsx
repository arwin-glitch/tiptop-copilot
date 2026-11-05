'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { createSpaceAction, deleteSpaceAction, updateSpaceAction } from '@/app/actions/spaces';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from '@/components/ui/dialog';
import { Input, Label, Textarea } from '@/components/ui/form';
import { useConfirm } from '@/components/ui/confirm';

/**
 * Making a Space, or changing one: a name and what belongs in it (domains,
 * people's addresses, keywords). Opened from "New Space", from "Make a Space"
 * on a profile or deal (prefilled through the URL), or from Edit on a Space.
 * Saving only stores the Space; nothing in Gmail changes.
 */

export interface SpaceFormValues {
  name: string;
  description: string;
  domains: string;
  emails: string;
  keywords: string;
}

const EMPTY: SpaceFormValues = { name: '', description: '', domains: '', emails: '', keywords: '' };

export function SpaceFormDialog({
  mode,
  spaceId,
  initial,
  defaultOpen = false,
  source,
  triggerLabel,
}: {
  mode: 'create' | 'edit';
  spaceId?: string;
  initial?: Partial<SpaceFormValues>;
  defaultOpen?: boolean;
  source?: { kind: 'company' | 'person' | 'deal' | 'suggested'; ref: string };
  triggerLabel?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(defaultOpen);
  const [values, setValues] = React.useState<SpaceFormValues>({ ...EMPTY, ...initial });
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();
  const [confirm, confirmDialog] = useConfirm();

  const set = (key: keyof SpaceFormValues) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res =
        mode === 'create'
          ? await createSpaceAction({
              ...values,
              sourceKind: source?.kind ?? 'manual',
              sourceRef: source?.ref,
            })
          : await updateSpaceAction(spaceId!, values);
      if (!res.ok || !res.data) {
        setError(res.error?.message ?? 'That did not save.');
        return;
      }
      setOpen(false);
      if (mode === 'create') router.push(`/spaces/${res.data.id}`);
      else router.refresh();
    });
  };

  const remove = async () => {
    if (!spaceId) return;
    const yes = await confirm({
      title: 'Delete this Space?',
      description:
        'The Space, its rules and members go. Its action items stay in Tasks, and nothing in Gmail or the calendar changes.',
      confirmLabel: 'Delete Space',
      tone: 'danger',
    });
    if (!yes) return;
    startTransition(async () => {
      const res = await deleteSpaceAction(spaceId);
      if (!res.ok) {
        setError(res.error?.message ?? 'That did not delete.');
        return;
      }
      router.push('/spaces');
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {mode === 'create' ? (
          <Button variant="primary" size="sm">
            <Plus aria-hidden="true" />
            {triggerLabel ?? 'New Space'}
          </Button>
        ) : (
          <Button variant="secondary" size="sm">
            {triggerLabel ?? 'Edit Space'}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent
        title={mode === 'create' ? 'New Space' : 'Edit Space'}
        description="A Space gathers the emails and meeting notes that match these rules. Only you can see it until you invite people."
      >
        <form onSubmit={submit} className="space-y-3.5">
          <div className="space-y-1.5">
            <Label htmlFor="space-name">Name</Label>
            <Input
              id="space-name"
              value={values.name}
              onChange={set('name')}
              placeholder="Northwind Labs"
              maxLength={120}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="space-domains">Company domains</Label>
            <Input
              id="space-domains"
              value={values.domains}
              onChange={set('domains')}
              placeholder="northwind.example"
            />
            <p className="text-xs text-[var(--fg-muted)]">
              Mail from or to anyone at these domains. Separate with commas.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="space-emails">People&apos;s emails</Label>
            <Input
              id="space-emails"
              value={values.emails}
              onChange={set('emails')}
              placeholder="dana@partner.example"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="space-keywords">Keywords</Label>
            <Input
              id="space-keywords"
              value={values.keywords}
              onChange={set('keywords')}
              placeholder="Project Lighthouse"
            />
            <p className="text-xs text-[var(--fg-muted)]">
              Words or phrases in subjects, meeting titles and notes.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="space-description">Description (optional)</Label>
            <Textarea
              id="space-description"
              value={values.description}
              onChange={set('description')}
              className="min-h-16"
              maxLength={500}
            />
          </div>
          {error ? (
            <p role="alert" className="text-sm text-[var(--danger)]">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            {mode === 'edit' ? (
              <Button type="button" variant="ghost" size="sm" onClick={remove} className="mr-auto">
                Delete Space
              </Button>
            ) : null}
            <Button type="submit" variant="primary" size="sm" loading={pending}>
              {mode === 'create' ? 'Make Space' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
      {confirmDialog}
    </Dialog>
  );
}
