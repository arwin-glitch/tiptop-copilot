'use client';

import * as React from 'react';
import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import type { MailLabel } from '@/lib/email/inbox-actions';
import { LABEL_COLOR_GRID } from '@/lib/email/label-colors';
import { cn } from '@/lib/util/cn';

/**
 * Gmail's "Label color" for one label: its fixed grid (the Gmail API takes
 * no other colours). Picking a swatch is the change; nothing happens before.
 */
export function LabelColorDialog({
  label,
  onClose,
  onPick,
}: {
  label: MailLabel | null;
  onClose: () => void;
  onPick: (color: { bg: string; fg: string }) => void;
}) {
  return (
    <Dialog open={label !== null} onOpenChange={(o) => !o && onClose()}>
      {label ? (
        <DialogContent
          title={`Label color: ${label.name}`}
          description="Gmail's own label colours; the label shows in this colour in Gmail too."
        >
          <div role="radiogroup" aria-label="Label colors" className="grid grid-cols-8 gap-1.5">
            {LABEL_COLOR_GRID.map((c) => {
              const current = label.color?.bg.toLowerCase() === c.bg;
              return (
                <button
                  key={c.bg}
                  type="button"
                  role="radio"
                  aria-checked={current}
                  aria-label={c.bg}
                  title={c.bg}
                  onClick={() => onPick(c)}
                  style={{ backgroundColor: c.bg, color: c.fg }}
                  className={cn(
                    'grid size-7 place-items-center rounded-md border border-[var(--border)] text-xs font-semibold focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--focus)]',
                    current && 'ring-2 ring-[var(--gold)] ring-offset-1',
                  )}
                >
                  {current ? <Check className="size-3.5" aria-hidden /> : 'a'}
                </button>
              );
            })}
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

/** Gmail's "Edit label": a new name. Sublabels follow it (the server renames them too). */
export function LabelRenameDialog({
  label,
  onClose,
  onSave,
}: {
  label: MailLabel | null;
  onClose: () => void;
  onSave: (name: string) => void;
}) {
  const [name, setName] = React.useState('');
  const [forId, setForId] = React.useState<string | null>(null);
  if (label && forId !== label.id) {
    setForId(label.id);
    setName(label.name);
  }
  return (
    <Dialog open={label !== null} onOpenChange={(o) => !o && onClose()}>
      {label ? (
        <DialogContent title="Edit label">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const clean = name.trim();
              if (!clean || clean === label.name) return onClose();
              onSave(clean);
            }}
          >
            <label htmlFor="edit-label-name" className="text-sm text-[var(--fg-muted)]">
              Label name:
            </label>
            <input
              id="edit-label-name"
              autoFocus
              value={name}
              maxLength={225}
              onChange={(e) => setName(e.target.value)}
              className="mt-2 h-9 w-full rounded-md border border-[var(--border-control)] bg-[var(--bg-raised)] px-3 text-sm"
            />
            <p className="mt-2 text-xs text-[var(--fg-subtle)]">
              Use a slash to nest it under another label, as in Gmail: Parent/Child.
            </p>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={!name.trim()}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
