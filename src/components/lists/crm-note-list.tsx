import * as React from 'react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Notice, PlainText } from '@/components/ui/feedback';
import type { CrmNote } from '@/lib/types/domain';
import { formatDate, relativeTime } from '@/lib/util/time';

/** Past this, a note shows its opening and a control for the rest. */
const PREVIEW_CHARS = 700;

/**
 * CRM notes, newest first, wherever a list entry or a record shows them.
 *
 * An imported note is somebody else's text — sometimes a pasted email thread —
 * so it gets the meeting-note treatment: rendered through `PlainText`, never
 * interpreted, and a flagged note keeps its full text under the warning
 * rather than disappearing. Affinity notes can run to thousands of words; a
 * long one opens with a preview so a page of them stays scannable.
 *
 * No hooks, so it renders on the server (a profile) and in the client side
 * panel alike.
 */
export function CrmNoteList({
  notes,
  timezone,
  empty = 'No notes yet.',
  about,
  label = 'Notes',
  actions,
  editing,
}: {
  notes: readonly CrmNote[];
  timezone: string;
  empty?: string;
  /**
   * The records each note is about, by note id, linked to their profiles:
   * for a stream of notes read away from any one record (Meetings).
   */
  about?: Readonly<Record<string, readonly { id: string; name: string }[]>>;
  /** Accessible name of the list. */
  label?: string;
  /** Controls for a note (edit, delete, why it is read-only), from a client caller. */
  actions?: (note: CrmNote) => React.ReactNode;
  /** The note being edited, and the editor shown in place of its text. */
  editing?: { id: string; editor: React.ReactNode } | null;
}) {
  if (notes.length === 0) {
    return <p className="text-sm text-[var(--fg-subtle)]">{empty}</p>;
  }
  return (
    <ul className="space-y-2" aria-label={label}>
      {notes.map((note) => (
        <CrmNoteItem
          key={note.id}
          note={note}
          timezone={timezone}
          about={about?.[note.id]}
          actions={actions?.(note)}
          editor={editing?.id === note.id ? editing.editor : null}
        />
      ))}
    </ul>
  );
}

function CrmNoteItem({
  note,
  timezone,
  about,
  actions,
  editor,
}: {
  note: CrmNote;
  timezone: string;
  about?: readonly { id: string; name: string }[];
  actions?: React.ReactNode;
  editor?: React.ReactNode;
}) {
  // An imported note whose date could not be read has none. It says so,
  // rather than borrowing the import's time and passing a 2019 note off as
  // written today.
  const when = note.occurred_at;
  const long = note.content.length > PREVIEW_CHARS;
  return (
    <li className="rounded-md border border-[var(--border)] p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="min-w-0 text-sm font-medium">
          {note.title || (note.entity_names.length ? note.entity_names.join(', ') : 'Note')}
        </p>
        {when ? (
          <span
            className="text-mini shrink-0 text-[var(--fg-subtle)]"
            title={formatDate(when, timezone)}
          >
            {relativeTime(when)}
          </span>
        ) : null}
      </div>
      <p className="text-mini mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[var(--fg-subtle)]">
        <span>{note.author ?? 'Unknown author'}</span>
        <span aria-hidden="true">·</span>
        {when ? (
          <span>{formatDate(when, timezone)}</span>
        ) : (
          <span title={`Imported ${formatDate(note.created_at, timezone)}`}>Date unknown</span>
        )}
        <Badge tone="outline" className="ml-1">
          {note.source === 'affinity' ? 'From Affinity' : 'Copilot'}
        </Badge>
        {actions ? <span className="ml-auto flex items-center gap-1">{actions}</span> : null}
      </p>
      {about?.length ? (
        <p className="text-mini mt-0.5 text-[var(--fg-subtle)]">
          About{' '}
          {about.map((r, i) => (
            <React.Fragment key={r.id}>
              {i > 0 ? ', ' : null}
              <Link
                href={`/lists/records/${r.id}`}
                className="text-[var(--accent)] underline-offset-2 hover:underline"
              >
                {r.name}
              </Link>
            </React.Fragment>
          ))}
        </p>
      ) : null}

      {note.injection_flagged ? (
        <Notice tone="warn" className="mt-2">
          <p className="font-medium">This note contains text aimed at an AI assistant.</p>
          <p className="mt-1 text-[var(--fg-muted)]">
            It was treated as data, not instructions. The full text is shown below.
          </p>
        </Notice>
      ) : null}

      {editor ? (
        <div className="mt-2">{editor}</div>
      ) : long ? (
        <>
          <PlainText
            text={`${note.content.slice(0, PREVIEW_CHARS).trimEnd()}…`}
            className="mt-2 text-[var(--fg-muted)]"
          />
          <details className="mt-1.5">
            <summary className="text-mini cursor-pointer text-[var(--fg-muted)]">
              Read the whole note
            </summary>
            <PlainText text={note.content} className="mt-2 text-[var(--fg-muted)]" />
          </details>
        </>
      ) : (
        <PlainText text={note.content} className="mt-2 text-[var(--fg-muted)]" />
      )}
    </li>
  );
}
