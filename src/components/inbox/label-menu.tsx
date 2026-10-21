'use client';

import * as React from 'react';
import { FieldLabel } from '@/components/ui/card';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { isNumberedLabel, type LabelChange, type MailLabel } from '@/lib/email/inbox-actions';
import { cn } from '@/lib/util/cn';

const ITEM =
  'flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1.5 text-sm hover:bg-[var(--bg-hover)]';

/** Above this many labels the menu offers a filter. */
const FILTER_FROM = 8;

type State = 'on' | 'some' | 'off';

/**
 * Gmail's "Label as", for one thread or every selected one: the person's own
 * labels, never a system one. A numbered label ("1: …") is a move, shown as a
 * choice of one: picking it takes the thread out of the other numbered labels,
 * so a sorter that files mail into them is not fought. The other labels go on
 * and off freely. Every change is a tap; the menu never applies one itself.
 */
export function LabelMenu({
  choices,
  current,
  onChange,
  open,
  onOpenChange,
  children,
}: {
  choices: readonly MailLabel[];
  /** The label ids on each thread the change is for. */
  current: readonly (readonly string[])[];
  onChange: (change: LabelChange) => void;
  /** Controlled open state, for the `l` key; left out, the menu keeps its own. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The trigger. */
  children: React.ReactNode;
}) {
  const [ownOpen, setOwnOpen] = React.useState(false);
  const isOpen = open ?? ownOpen;
  const setOpen = onOpenChange ?? setOwnOpen;
  const [filter, setFilter] = React.useState('');
  const id = React.useId();

  const state = (labelId: string): State => {
    const having = current.filter((ids) => ids.includes(labelId)).length;
    if (current.length > 0 && having === current.length) return 'on';
    return having > 0 ? 'some' : 'off';
  };
  const q = filter.trim().toLowerCase();
  const shown = q ? choices.filter((l) => l.name.toLowerCase().includes(q)) : choices;
  const numbered = shown.filter((l) => isNumberedLabel(l.name));
  const plain = shown.filter((l) => !isNumberedLabel(l.name));

  return (
    <Popover
      open={isOpen}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setFilter('');
      }}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent aria-label="Label" className="w-72">
        <FieldLabel as="p" className="px-1.5 pt-0.5 pb-2">
          Label
        </FieldLabel>
        {choices.length > FILTER_FROM ? (
          <input
            type="search"
            aria-label="Find a label"
            placeholder="Find a label"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="mb-2 h-8 w-full rounded-md border border-[var(--border-control)] bg-[var(--bg-raised)] px-2 text-sm text-[var(--fg)] placeholder:text-[var(--fg-subtle)]"
          />
        ) : null}
        {choices.length === 0 ? (
          <p className="px-1.5 py-1 text-sm text-[var(--fg-muted)]">
            No labels of your own in Gmail yet.
          </p>
        ) : shown.length === 0 ? (
          <p className="px-1.5 py-1 text-sm text-[var(--fg-muted)]">No label matches.</p>
        ) : null}
        {numbered.length > 0 ? (
          // Buttons, not radios: arrowing through a radio group checks each
          // one it passes, and every check here would be a move in Gmail.
          <div role="group" aria-labelledby={`${id}-move`} className="mb-1">
            <p id={`${id}-move`} className="text-mini px-1.5 pb-0.5 text-[var(--fg-muted)]">
              Move to
            </p>
            {numbered.map((l) => {
              const on = state(l.id) === 'on';
              return (
                <button
                  key={l.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => {
                    if (!on) onChange({ add: [l.id], remove: [] });
                    setOpen(false);
                    setFilter('');
                  }}
                  className={cn(ITEM, 'w-full text-left')}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'grid size-3.5 shrink-0 place-items-center rounded-full border border-[var(--border-control)]',
                      on && 'border-[var(--accent)]',
                    )}
                  >
                    {on ? <span className="size-1.5 rounded-full bg-[var(--accent)]" /> : null}
                  </span>
                  <span className="min-w-0 truncate">{l.name}</span>
                </button>
              );
            })}
          </div>
        ) : null}
        {plain.length > 0 ? (
          <fieldset>
            {numbered.length > 0 ? (
              <legend className="text-mini px-1.5 pb-0.5 text-[var(--fg-muted)]">Labels</legend>
            ) : null}
            {plain.map((l) => {
              const s = state(l.id);
              return (
                <label key={l.id} className={ITEM}>
                  <Check
                    state={s}
                    onToggle={() =>
                      onChange(
                        s === 'on' ? { add: [], remove: [l.id] } : { add: [l.id], remove: [] },
                      )
                    }
                  />
                  <span className="min-w-0 truncate">{l.name}</span>
                </label>
              );
            })}
          </fieldset>
        ) : null}
        {numbered.length > 0 ? (
          <p className="text-mini border-t border-[var(--border)] px-1.5 pt-2 text-[var(--fg-subtle)]">
            A numbered label is a move: picking one takes the thread out of the others.
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/**
 * A checkbox that also shows "some of them" when only part of a selection
 * has the label: the native indeterminate state, which reads as mixed.
 */
function Check({ state, onToggle }: { state: State; onToggle: () => void }) {
  const ref = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'some';
  }, [state]);
  return <input ref={ref} type="checkbox" checked={state === 'on'} onChange={onToggle} />;
}
