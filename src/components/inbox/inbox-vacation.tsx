'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { Loader2, TreePalm } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { useConfirm } from '@/components/ui/confirm';
import { FormatBar } from '@/components/inbox/compose-window';
import { TurnOnSettings } from '@/components/inbox/inbox-settings';
import {
  MAX_VACATION_SUBJECT,
  VACATION_OFF,
  vacationActive,
  vacationConfirmText,
  vacationProblem,
  type VacationSettings,
} from '@/lib/email/vacation';

type Access = 'on' | 'off' | 'demo' | 'not_connected';

export interface VacationRead {
  access: Access;
  mailbox: string | null;
  vacation: VacationSettings | null;
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const j = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return j?.error?.message ?? fallback;
}

export async function readVacation(): Promise<VacationRead | { error: string }> {
  try {
    const r = await fetch('/api/inbox/vacation', { cache: 'no-store' });
    if (!r.ok) return { error: await errorMessage(r, 'Gmail did not answer.') };
    return (await r.json()) as VacationRead;
  } catch {
    return { error: 'Could not reach Kraken. Try again.' };
  }
}

/** Save the responder; `null` from a refusal (already toasted). */
async function writeVacation(v: VacationSettings): Promise<VacationSettings | null> {
  try {
    const r = await fetch('/api/inbox/vacation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(v),
    });
    if (!r.ok) {
      toast.error(await errorMessage(r, 'Gmail did not save that. Try again.'));
      return null;
    }
    return ((await r.json()) as { vacation: VacationSettings }).vacation;
  } catch {
    toast.error('Could not reach Kraken. Try again.');
    return null;
  }
}

/** `YYYY-MM-DD` in the reader's zone, for a date input. */
const dayOf = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
/** A date input's day as the start (or, for the last day, the end) of that day locally. */
const instantOf = (day: string, end: boolean) => {
  if (!day) return null;
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(y!, m! - 1, d! + (end ? 1 : 0));
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
};

/**
 * "Vacation responder is ON", across the top of the Inbox while Gmail is
 * auto-replying, with Turn off (one click: turning it off answers no one)
 * and the settings.
 */
export function VacationBanner({
  vacation,
  onTurnOff,
  onOpen,
}: {
  vacation: VacationSettings | null;
  onTurnOff: () => void;
  onOpen: () => void;
}) {
  if (!vacationActive(vacation)) return null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--gold-rule)] bg-[var(--accent-soft)] px-3 py-2 text-sm"
    >
      <TreePalm className="size-4 text-[var(--gold)]" aria-hidden />
      <span className="font-medium">Vacation responder is ON</span>
      <span className="text-[var(--fg-muted)]">
        {vacation!.subject ? `“${vacation!.subject}”` : 'Gmail is auto-replying'}
        {vacation!.end ? ` · ends ${dayOf(vacation!.end)}` : ''}
      </span>
      <span className="ml-auto flex gap-1">
        <Button size="sm" variant="ghost" onClick={onOpen}>
          Settings
        </Button>
        <Button size="sm" variant="secondary" onClick={onTurnOff}>
          Turn off
        </Button>
      </span>
    </div>
  );
}

/** Turn the responder off now: one click, no confirm (it stops auto-replies). */
export async function turnOffVacation(v: VacationSettings): Promise<VacationSettings | null> {
  const saved = await writeVacation({ ...v, enabled: false });
  if (saved) toast.success('Vacation responder turned off');
  return saved;
}

/**
 * Gmail's Vacation responder setting: on or off, first and last day,
 * subject, message, and who gets it. Saving it ON is an auto-reply rule, so
 * Save asks first, in plain words, and only Turn on in that question saves.
 */
export function VacationDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (v: VacationSettings) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent
          title="Vacation responder"
          description="Gmail replies on its own to mail you get while you are away."
          className="max-w-xl"
        >
          <VacationBody
            onDone={(v) => {
              if (v) onSaved(v);
              onOpenChange(false);
            }}
          />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

const FIELD =
  'h-9 w-full rounded-md border border-[var(--border-control)] bg-[var(--bg-raised)] px-2 text-sm focus-visible:border-[var(--accent)] focus-visible:outline-none';

function VacationBody({ onDone }: { onDone: (saved: VacationSettings | null) => void }) {
  const [read, setRead] = React.useState<VacationRead | { error: string } | null>(null);
  const [v, setV] = React.useState<VacationSettings>(VACATION_OFF);
  const [busy, setBusy] = React.useState(false);
  const [confirm, confirmDialog] = useConfirm();
  const editor = React.useRef<HTMLDivElement>(null);
  const id = React.useId();

  React.useEffect(() => {
    let live = true;
    void readVacation().then((r) => {
      if (!live) return;
      setRead(r);
      if ('vacation' in r && r.vacation) setV(r.vacation);
    });
    return () => {
      live = false;
    };
  }, []);
  const editable = Boolean(
    read && 'access' in read && (read.access === 'on' || read.access === 'demo'),
  );
  const startHtml = read && 'vacation' in read ? (read.vacation?.html ?? '') : '';
  React.useEffect(() => {
    if (editor.current) editor.current.innerHTML = startHtml;
  }, [startHtml, editable]);

  const save = async () => {
    const next = { ...v, html: editor.current?.innerHTML ?? v.html };
    const problem = vacationProblem(next);
    if (problem) {
      toast.error(problem);
      return;
    }
    if (next.enabled) {
      const yes = await confirm({
        title: 'Turn on auto-replies?',
        description: vacationConfirmText(next, read && 'mailbox' in read ? read.mailbox : null),
        confirmLabel: 'Turn on vacation responder',
      });
      if (!yes) return;
    }
    setBusy(true);
    const saved = await writeVacation(next);
    setBusy(false);
    if (!saved) return;
    toast.success(saved.enabled ? 'Vacation responder is on' : 'Vacation responder is off');
    onDone(saved);
  };

  if (!read) {
    return (
      <p className="flex items-center gap-2 text-sm text-[var(--fg-muted)]">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Reading Gmail…
      </p>
    );
  }
  if ('error' in read) return <p className="text-sm text-[var(--danger)]">{read.error}</p>;
  if (!editable) {
    return (
      <div className="space-y-3">
        <TurnOnSettings access={read.access} what="vacation responder" />
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onDone(null)}>
            Close
          </Button>
        </DialogFooter>
      </div>
    );
  }
  const set = (patch: Partial<VacationSettings>) => setV((cur) => ({ ...cur, ...patch }));
  return (
    <div className="space-y-3 text-sm">
      <fieldset className="flex gap-4">
        <legend className="sr-only">Vacation responder</legend>
        {[false, true].map((on) => (
          <label key={String(on)} className="flex items-center gap-1.5">
            <input
              type="radio"
              name={`${id}-on`}
              checked={v.enabled === on}
              onChange={() => set({ enabled: on })}
            />
            {on ? 'Vacation responder on' : 'Vacation responder off'}
          </label>
        ))}
      </fieldset>
      <div className="grid grid-cols-2 gap-3">
        <label className="space-y-1">
          <span className="text-[var(--fg-muted)]">First day</span>
          <input
            type="date"
            className={FIELD}
            value={dayOf(v.start)}
            onChange={(e) => set({ start: instantOf(e.target.value, false) })}
          />
        </label>
        <label className="space-y-1">
          <span className="text-[var(--fg-muted)]">Last day (optional)</span>
          <input
            type="date"
            className={FIELD}
            value={v.end ? dayOf(new Date(new Date(v.end).getTime() - 1).toISOString()) : ''}
            onChange={(e) => set({ end: instantOf(e.target.value, true) })}
          />
        </label>
      </div>
      <label className="block space-y-1">
        <span className="text-[var(--fg-muted)]">Subject</span>
        <input
          className={FIELD}
          value={v.subject}
          maxLength={MAX_VACATION_SUBJECT}
          onChange={(e) => set({ subject: e.target.value })}
        />
      </label>
      <div className="space-y-1">
        <span id={`${id}-msg`} className="text-[var(--fg-muted)]">
          Message
        </span>
        <div className="rounded-md border border-[var(--border-control)]">
          <div className="border-b border-[var(--border)] px-1 py-0.5">
            <FormatBar editor={editor} disabled={busy} onChange={() => undefined} />
          </div>
          <div
            ref={editor}
            role="textbox"
            aria-multiline="true"
            aria-labelledby={`${id}-msg`}
            contentEditable={!busy}
            suppressContentEditableWarning
            className="min-h-28 p-2 leading-relaxed break-words focus-visible:outline-none [&_a]:text-[var(--accent)] [&_a]:underline"
          />
        </div>
      </div>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={v.contactsOnly}
          onChange={(e) => set({ contactsOnly: e.target.checked })}
        />
        Only send a response to people in my Contacts
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={v.domainOnly}
          onChange={(e) => set({ domainOnly: e.target.checked })}
        />
        Only send a response to people in {read.mailbox?.split('@')[1] ?? 'my organization'}
      </label>
      {read.access === 'demo' ? (
        <p className="text-xs text-[var(--fg-muted)]">Demo: nothing reaches Gmail.</p>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onDone(null)}>
          Cancel
        </Button>
        <Button type="button" variant="primary" disabled={busy} onClick={() => void save()}>
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          Save changes
        </Button>
      </DialogFooter>
      {confirmDialog}
    </div>
  );
}
