'use client';

import { Loader2, RefreshCw, Sparkles } from 'lucide-react';
import type { NotesRequestView } from '@/lib/types/notes';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/util/cn';

/**
 * Where Arwin's notes are (D-076): written by Arwin's Claude routine through
 * the Ask bridge, which takes a minute or three. Until they arrive the page
 * keeps working: the Quick notes (or the notes already there) stay readable,
 * and the transcript and notepad are usable. Plain words, no spinner-only
 * states: it always says what is shown meanwhile and what happens next.
 */
export function ArwinNotesStatus({
  request,
  showingQuick,
  demo,
  busy,
  onAskAgain,
  className,
}: {
  request: NotesRequestView;
  /** The notes on the page are the Quick notes (not an earlier version of Arwin's). */
  showingQuick: boolean;
  demo: boolean;
  busy: boolean;
  onAskAgain: () => void;
  className?: string;
}) {
  if (request.status === 'ready') return null;

  if (request.status === 'pending') {
    const meanwhile = showingQuick
      ? 'Meanwhile these are Quick notes: your typed notes and the key lines. The transcript and your notepad work as usual.'
      : 'These are the notes you had. They change when the new ones arrive.';
    let extra: string | null = null;
    if (demo)
      extra = "Demo workspace: Arwin's routine is not connected here, so these stay as they are.";
    else if (!request.connected) {
      extra =
        "Arwin's routine is not connected yet, so this can take a long time. Quick notes stay meanwhile.";
    } else if (!request.fired) {
      extra = 'Kraken could not reach Arwin yet and keeps trying.';
    }
    return (
      <div
        role="status"
        aria-live="polite"
        data-arwin-status="pending"
        className={cn(
          'flex items-start gap-2.5 rounded-md border border-l-2 border-[var(--border)] border-l-[var(--gold)] bg-[var(--note-soft)] px-3 py-2.5 text-sm',
          className,
        )}
      >
        <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-[var(--gold)]" aria-hidden />
        <div className="min-w-0">
          <p className="font-medium">
            {request.reason === 'template' || request.reason === 'regenerate'
              ? 'Arwin is rewriting your notes - usually '
              : 'Arwin is writing your notes - usually '}
            <span className="whitespace-nowrap">1-3 minutes</span>
          </p>
          <p className="mt-0.5 text-[var(--fg-muted)]">{meanwhile}</p>
          {extra ? <p className="mt-0.5 text-[var(--fg-muted)]">{extra}</p> : null}
          {request.omittedLines > 0 ? (
            <p className="mt-0.5 text-xs text-[var(--fg-subtle)]">
              A long meeting: {request.omittedLines} lines from the middle were left out of what
              Arwin reads. The whole transcript stays here.
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div
      role="status"
      data-arwin-status={request.status}
      className={cn(
        'flex flex-wrap items-start gap-2.5 rounded-md border border-[var(--warn)]/30 bg-[var(--warn-soft)] px-3 py-2.5 text-sm',
        className,
      )}
    >
      <Sparkles className="mt-0.5 size-4 shrink-0 text-[var(--warn)]" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium">Arwin&apos;s notes did not arrive.</p>
        <p className="mt-0.5 text-[var(--fg-muted)]">
          {request.error ?? 'No answer came back.'}{' '}
          {showingQuick ? 'These are the Quick notes.' : 'These are the notes you had.'}
        </p>
      </div>
      <Button size="sm" variant="secondary" loading={busy} onClick={onAskAgain}>
        {busy ? null : <RefreshCw aria-hidden />} Ask Arwin again
      </Button>
    </div>
  );
}
