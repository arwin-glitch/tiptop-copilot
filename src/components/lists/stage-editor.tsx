'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, ListOrdered, Plus, X } from 'lucide-react';
import { setCrmStatusOptionsAction } from '@/app/actions/crm';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/form';
import { isNumberedStage, moveStage, sortStatusOptions } from '@/lib/crm/view';
import type { CrmField } from '@/lib/types/domain';

/**
 * "Edit stages": the pipeline's stages as a person shapes them after the
 * import. An import only knows the stages some row used on the day of the
 * export, in an order it had to guess for unnumbered ones, and a status can
 * only be set to a stage that exists — so this is where a stage nobody was
 * in gets added and an LP pipeline gets its real order.
 *
 * Numbered stages ("3. First Meeting") sort by their number and stay put;
 * the others move with the arrows. A stage can be removed once no entry is
 * in it (the server checks; the counts here only disable the obvious case).
 * Renaming is left out on purpose: entries hold the label itself.
 */
export function StageEditor({
  listId,
  field,
  options,
  counts,
  onSaved,
}: {
  listId: string;
  field: CrmField;
  /** The stages in pipeline order (sortStatusOptions). */
  options: string[];
  /** Entries per stage across the whole list, when known. */
  counts: Record<string, number> | null;
  onSaved: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState(options);
  const [adding, setAdding] = React.useState('');
  const [saving, startSaving] = React.useTransition();
  const uid = React.useId();

  const changed = draft.length !== options.length || draft.some((o, i) => o !== options[i]);
  const label = adding.trim();
  const duplicate = draft.some((o) => o.toLowerCase() === label.toLowerCase());

  const add = () => {
    if (!label || duplicate) return;
    // A numbered stage takes its place by number; any other goes last.
    setDraft((current) => sortStatusOptions([...current, label.slice(0, 200)]));
    setAdding('');
  };

  const save = () =>
    startSaving(async () => {
      const result = await setCrmStatusOptionsAction(listId, field.key, draft).catch(() => null);
      if (!result) {
        toast.error('The stages could not be saved: no connection.');
        return;
      }
      if (!result.ok) {
        toast.error(result.error?.message ?? 'The stages could not be saved.', {
          description: result.error?.stillUsable,
        });
        return;
      }
      toast.success(`Saved the stages of ${field.name}.`);
      setOpen(false);
      onSaved();
    });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setDraft(options);
          setAdding('');
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="secondary" size="sm">
          <ListOrdered aria-hidden="true" />
          Edit stages
        </Button>
      </DialogTrigger>
      <DialogContent
        title={`Stages of ${field.name}`}
        description="Numbered stages sort by their number; move the others into pipeline order. A stage can be removed once no entry is in it."
      >
        <ol className="space-y-1.5" aria-label={`Stages of ${field.name}`}>
          {draft.map((stage, i) => {
            const held = counts?.[stage] ?? 0;
            const numbered = isNumberedStage(stage);
            const canUp = moveStage(draft, i, -1)[i] !== stage;
            const canDown = moveStage(draft, i, 1)[i] !== stage;
            return (
              <li
                key={stage}
                className="flex items-center gap-2 rounded-md border border-[var(--border)] px-2.5 py-1.5"
              >
                <span className="min-w-0 flex-1 truncate text-sm">{stage}</span>
                {held > 0 ? (
                  <span className="tabular shrink-0 text-xs text-[var(--fg-muted)]">
                    {held.toLocaleString('en-US')} {held === 1 ? 'entry' : 'entries'}
                  </span>
                ) : null}
                {numbered ? null : (
                  <>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Move ${stage} up`}
                      disabled={!canUp || saving}
                      onClick={() => setDraft((current) => moveStage(current, i, -1))}
                    >
                      <ArrowUp aria-hidden="true" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Move ${stage} down`}
                      disabled={!canDown || saving}
                      onClick={() => setDraft((current) => moveStage(current, i, 1))}
                    >
                      <ArrowDown aria-hidden="true" />
                    </Button>
                  </>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${stage}`}
                  title={held > 0 ? `Move its ${held} entries to another stage first` : undefined}
                  disabled={held > 0 || draft.length === 1 || saving}
                  onClick={() => setDraft((current) => current.filter((o) => o !== stage))}
                >
                  <X aria-hidden="true" />
                </Button>
              </li>
            );
          })}
        </ol>

        <form
          className="mt-4 flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <Field
            label="New stage"
            htmlFor={`${uid}-new`}
            hint={duplicate && label ? `${label} is already a stage.` : undefined}
            className="min-w-0 flex-1"
          >
            <Input
              id={`${uid}-new`}
              value={adding}
              maxLength={200}
              placeholder="Term sheet"
              disabled={saving}
              aria-describedby={duplicate && label ? `${uid}-new-hint` : undefined}
              onChange={(e) => setAdding(e.target.value)}
            />
          </Field>
          <Button type="submit" variant="secondary" disabled={!label || duplicate || saving}>
            <Plus aria-hidden="true" />
            Add
          </Button>
        </form>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} disabled={!changed} onClick={save}>
            Save stages
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
