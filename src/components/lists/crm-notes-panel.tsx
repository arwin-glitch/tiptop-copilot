'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { Lock, Pencil, Trash2 } from 'lucide-react';
import { addCrmNoteAction, deleteCrmNoteAction, updateCrmNoteAction } from '@/app/actions/crm';
import { CrmNoteList } from '@/components/lists/crm-note-list';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Textarea } from '@/components/ui/form';
import { crmNoteLockReason } from '@/lib/crm/notes';
import type { CrmNote } from '@/lib/types/domain';

const NOTE_MAX = 500_000;

/**
 * The notes on a row or a profile, with a box to add one and, on each note
 * written in Copilot, Edit and Delete. A note from Affinity says why it is
 * read-only while the daily sync runs (crmNoteLockReason) instead of offering
 * controls that would be refused.
 *
 * Holds the notes it was given and its own changes to them; a fresh set from
 * the page (the side panel opening another row) replaces both.
 */
export function CrmNotesPanel({
  notes: given,
  timezone,
  canWrite,
  affinitySyncOn,
  attach,
  empty,
  disabled = false,
  onCountChange,
}: {
  notes: readonly CrmNote[];
  timezone: string;
  canWrite: boolean;
  affinitySyncOn: boolean;
  /** What a new note is attached to; null for no box. */
  attach: { recordIds?: string[]; entryIds?: string[] } | null;
  empty: string;
  /** Hold the box (the panel is still loading what the note attaches to). */
  disabled?: boolean;
  onCountChange?: (count: number) => void;
}) {
  const [notes, setNotes] = React.useState<readonly CrmNote[]>(given);
  const [seen, setSeen] = React.useState(given);
  if (seen !== given) {
    setSeen(given);
    setNotes(given);
  }
  const [draft, setDraft] = React.useState('');
  const [editing, setEditing] = React.useState<{ id: string; text: string } | null>(null);
  const [posting, startPosting] = React.useTransition();
  const [saving, startSaving] = React.useTransition();
  const [confirm, confirmDialog] = useConfirm();

  const update = (next: readonly CrmNote[]) => {
    setNotes(next);
    onCountChange?.(next.length);
  };

  const add = () => {
    const content = draft.trim();
    if (!content || !attach) return;
    startPosting(async () => {
      const result = await addCrmNoteAction({ content, ...attach }).catch(() => null);
      if (!result) {
        toast.error('The note could not be saved: no connection. Your text is still in the box.');
        return;
      }
      if (!result.ok || !result.data) {
        toast.error(result.error?.message ?? 'The note could not be saved.', {
          description: result.error?.stillUsable,
        });
        return;
      }
      setDraft('');
      update([result.data.note, ...notes]);
      toast.success('Note added');
    });
  };

  const saveEdit = () => {
    if (!editing) return;
    const { id, text } = editing;
    startSaving(async () => {
      const result = await updateCrmNoteAction(id, { content: text }).catch(() => null);
      if (!result || !result.ok || !result.data) {
        toast.error(result?.error?.message ?? 'The note could not be saved: no connection.');
        return;
      }
      const saved = result.data.note;
      update(notes.map((n) => (n.id === saved.id ? saved : n)));
      setEditing(null);
      toast.success('Note saved');
    });
  };

  const remove = async (note: CrmNote) => {
    const yes = await confirm({
      title: 'Delete this note?',
      description: 'It is removed from every list and profile it shows on. This cannot be undone.',
      confirmLabel: 'Delete note',
      tone: 'danger',
    });
    if (!yes) return;
    const result = await deleteCrmNoteAction(note.id).catch(() => null);
    if (!result || !result.ok) {
      toast.error(result?.error?.message ?? 'The note could not be deleted: no connection.');
      return;
    }
    update(notes.filter((n) => n.id !== note.id));
    toast.success('Note deleted');
  };

  const actions = (note: CrmNote): React.ReactNode => {
    if (!canWrite) return null;
    const locked = crmNoteLockReason(note, affinitySyncOn);
    if (locked) {
      return (
        <span
          className="inline-flex items-center gap-1 text-[var(--fg-subtle)]"
          title={locked}
          data-testid="note-locked"
        >
          <Lock className="size-3" aria-hidden="true" />
          Read-only while the Affinity sync runs
          <span className="sr-only">. {locked}</span>
        </span>
      );
    }
    const what = note.title || note.content.slice(0, 40);
    return (
      <>
        <button
          type="button"
          onClick={() => setEditing({ id: note.id, text: note.content })}
          aria-label={`Edit note: ${what}`}
          className="rounded p-1 hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]"
        >
          <Pencil className="size-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => void remove(note)}
          aria-label={`Delete note: ${what}`}
          className="rounded p-1 hover:bg-[var(--bg-hover)] hover:text-[var(--danger)]"
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
        </button>
      </>
    );
  };

  const editor = editing ? (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        saveEdit();
      }}
    >
      <Textarea
        aria-label="Edit note"
        value={editing.text}
        onChange={(e) => setEditing({ ...editing, text: e.target.value })}
        rows={4}
        maxLength={NOTE_MAX}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(null)}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          loading={saving}
          disabled={!editing.text.trim() || saving}
        >
          Save note
        </Button>
      </div>
    </form>
  ) : null;

  return (
    <>
      {canWrite && attach ? (
        <form
          className="mb-4 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <Textarea
            aria-label="New note"
            placeholder="Add a note — a call, a decision, what happens next"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            maxLength={NOTE_MAX}
          />
          <div className="flex justify-end">
            <Button
              type="submit"
              variant="primary"
              size="sm"
              loading={posting}
              disabled={!draft.trim() || posting || disabled}
            >
              Add note
            </Button>
          </div>
        </form>
      ) : null}
      <CrmNoteList
        notes={notes}
        timezone={timezone}
        empty={empty}
        actions={actions}
        editing={editing ? { id: editing.id, editor } : null}
      />
      {confirmDialog}
    </>
  );
}
