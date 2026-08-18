import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { FieldLabel } from '@/components/ui/card';
import { Notice, PlainText } from '@/components/ui/feedback';
import type { MeetingNote } from '@/lib/types/domain';
import { formatDate, relativeTime } from '@/lib/util/time';

/**
 * Meeting notes, rendered wherever a deal or company shows its record.
 *
 * The note body goes through `PlainText` like every other piece of text
 * somebody else wrote: displayed verbatim, never interpreted. A flagged note
 * gets the same treatment as a flagged email — the warning and the full text,
 * because a note that quietly disappeared would be worse than one that is
 * visibly suspect.
 */
export function MeetingNoteList({ notes, timezone }: { notes: MeetingNote[]; timezone?: string }) {
  if (notes.length === 0) {
    return (
      <p className="text-sm text-[var(--fg-subtle)]">
        No meeting notes yet. Notes arrive automatically once the Granola webhook is connected —
        Diagnostics shows whether it is.
      </p>
    );
  }

  return (
    <ul className="space-y-2">
      {notes.map((note) => (
        <li key={note.id} className="rounded-md border border-[var(--border)] p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-medium">{note.title}</p>
            <span
              className="text-mini shrink-0 text-[var(--fg-subtle)]"
              title={timezone ? formatDate(note.occurred_at, timezone) : undefined}
            >
              {relativeTime(note.occurred_at)}
            </span>
          </div>

          <p className="text-mini mt-0.5 text-[var(--fg-subtle)]">
            {note.attendees.length > 0
              ? note.attendees.map((a) => a.name ?? a.email).join(', ')
              : 'No attendees recorded'}
            {' · '}from Granola
          </p>

          {note.injection_flagged ? (
            <Notice tone="warn" className="mt-2">
              <p className="font-medium">This note contains text aimed at an AI assistant.</p>
              <p className="mt-1 text-[var(--fg-muted)]">
                It was treated as data, not instructions. The full text is shown below.
              </p>
            </Notice>
          ) : null}

          <details className="mt-2">
            <summary className="text-mini cursor-pointer text-[var(--fg-muted)]">
              Read the note
            </summary>
            <PlainText text={note.content} className="mt-2 text-[var(--fg-muted)]" />
          </details>

          {note.source_url ? (
            <p className="mt-2">
              <a
                href={note.source_url}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="text-mini text-[var(--accent)] underline-offset-2 hover:underline"
              >
                Open in Granola
              </a>
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** Section headline with the provenance made explicit. */
export function MeetingNotesHeading({ count }: { count: number }) {
  return (
    <span className="flex items-center gap-2">
      Meetings
      <Badge tone="outline">
        <span className="tabular">{count}</span>
      </Badge>
      <FieldLabel as="span">from Granola</FieldLabel>
    </span>
  );
}
