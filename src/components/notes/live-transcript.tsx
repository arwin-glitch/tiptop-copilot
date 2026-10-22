'use client';

import * as React from 'react';
import { Pencil, UserRoundSearch } from 'lucide-react';
import { formatOffset } from '@/lib/notes/api';
import type { SegmentView, SpeakerView } from '@/lib/types/notes';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/form';
import { cn } from '@/lib/util/cn';
import { groupLines, speakerLookup } from './helpers';
import { SpeakerChip } from './speaker-chip';
import type { LivePartial } from './use-recorder';

/**
 * The transcript in bubbles (D-076). The mic owner's lines are gold, on the
 * right; everyone else's emerald, on the left, under a name chip. Names come
 * from the voices (SpeakerView) by cluster key, so renaming a voice renames
 * every line at once. A line can be fixed in place (a number, a name); the
 * original is kept and the line says "edited". Transcript text is untrusted
 * and only ever rendered as text.
 */
export function LiveTranscript({
  segments,
  speakers,
  partial,
  live,
  highlightSeq,
  onOpenSpeaker,
  onEditLine,
  className,
  label = 'Transcript',
}: {
  segments: readonly SegmentView[];
  speakers: readonly SpeakerView[];
  partial: LivePartial | null;
  live: boolean;
  highlightSeq: number | null;
  onOpenSpeaker: (speaker: SpeakerView, line: SegmentView | null) => void;
  onEditLine: (seq: number, text: string) => Promise<boolean>;
  className?: string;
  label?: string;
}) {
  const resolve = React.useMemo(() => speakerLookup(speakers), [speakers]);
  const groups = React.useMemo(() => groupLines(segments, resolve), [segments, resolve]);
  const scroller = React.useRef<HTMLDivElement>(null);
  const pinned = React.useRef(true);

  // Follow the newest line while live, unless the reader scrolled up.
  React.useEffect(() => {
    const el = scroller.current;
    if (!el || !live || !pinned.current) return;
    el.scrollTop = el.scrollHeight;
  }, [segments.length, partial, live]);

  // A deep link (?t=) or a source popover lands on its line.
  React.useEffect(() => {
    if (highlightSeq === null) return;
    const target = scroller.current?.querySelector<HTMLElement>(`[data-seq="${highlightSeq}"]`);
    target?.scrollIntoView({ block: 'center' });
  }, [highlightSeq, segments.length]);

  const partialSpeaker = partial ? resolve(partial.clusterKey) : null;

  return (
    <div
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      }}
      role="log"
      aria-label={label}
      aria-live={live ? 'polite' : 'off'}
      data-transcript=""
      className={cn('scrollbar-thin space-y-3 overflow-y-auto', className)}
    >
      {groups.length === 0 && !partial ? (
        <p className="py-8 text-center text-sm text-[var(--fg-muted)]">
          {live ? 'Listening… the first words appear here.' : 'No transcript yet.'}
        </p>
      ) : null}
      {groups.map((group) => {
        const speaker = resolve(group.clusterKey);
        const mine = speaker.isOwner;
        return (
          <div
            key={`${group.clusterKey}-${group.lines[0]?.seq}`}
            className={cn('flex flex-col gap-1', mine ? 'items-end' : 'items-start')}
          >
            <SpeakerChip speaker={speaker} onOpen={(s) => onOpenSpeaker(s, null)} size="sm" />
            {group.lines.map((line) => (
              <Line
                key={line.seq}
                line={line}
                mine={mine}
                highlighted={line.seq === highlightSeq}
                speaker={speaker}
                onSomeoneElse={() => onOpenSpeaker(speaker, line)}
                onEdit={onEditLine}
              />
            ))}
          </div>
        );
      })}
      {partial && partialSpeaker ? (
        <div
          className={cn(
            'flex flex-col gap-1',
            partialSpeaker.isOwner ? 'items-end' : 'items-start',
          )}
          aria-hidden
        >
          <p
            className={cn(
              'max-w-[85%] rounded-2xl border border-dashed px-3 py-2 text-sm text-[var(--fg-muted)] italic',
              partialSpeaker.isOwner
                ? 'border-[var(--gold-rule)]'
                : 'border-[var(--border-control)]',
            )}
          >
            {partial.text}…
          </p>
        </div>
      ) : null}
    </div>
  );
}

function Line({
  line,
  mine,
  highlighted,
  speaker,
  onSomeoneElse,
  onEdit,
}: {
  line: SegmentView;
  mine: boolean;
  highlighted: boolean;
  speaker: SpeakerView;
  onSomeoneElse: () => void;
  onEdit: (seq: number, text: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(line.text);
  const [saving, setSaving] = React.useState(false);
  const at = formatOffset(line.startMs);

  if (editing) {
    return (
      <div className={cn('w-full max-w-[85%] space-y-1.5', mine && 'self-end')} data-seq={line.seq}>
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label={`Edit the line at ${at}`}
          className="min-h-16 text-sm"
          autoFocus
        />
        <div className={cn('flex gap-1.5', mine ? 'justify-end' : 'justify-start')}>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            loading={saving}
            disabled={!draft.trim() || saving}
            onClick={async () => {
              setSaving(true);
              const saved = await onEdit(line.seq, draft.trim());
              setSaving(false);
              if (saved) setEditing(false);
            }}
          >
            Save line
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      id={`line-${line.seq}`}
      data-seq={line.seq}
      className={cn('group flex max-w-[85%] items-end gap-1.5', mine && 'flex-row-reverse')}
    >
      <p
        className={cn(
          'rounded-2xl px-3 py-2 text-sm leading-relaxed break-words whitespace-pre-wrap text-[var(--fg)]',
          mine
            ? 'rounded-br-md border border-[var(--gold-rule)] bg-[color-mix(in_srgb,var(--gold)_14%,var(--bg-raised))]'
            : 'rounded-bl-md bg-[var(--accent-soft)]',
          highlighted && 'ring-2 ring-[var(--gold)]',
        )}
      >
        {line.text}
        {line.edited ? (
          <span
            className="ml-1.5 text-[10px] font-medium tracking-wide text-[var(--fg-subtle)] uppercase"
            title={line.originalText ? `Heard as: ${line.originalText}` : undefined}
          >
            edited
          </span>
        ) : null}
      </p>
      <span className="flex shrink-0 flex-col items-center gap-0.5 pb-1">
        <span className="tabular font-mono text-[10px] text-[var(--fg-subtle)]">{at}</span>
        <span className="flex gap-0.5 opacity-60 group-focus-within:opacity-100 group-hover:opacity-100">
          <button
            type="button"
            onClick={() => {
              setDraft(line.text);
              setEditing(true);
            }}
            className="rounded p-0.5 text-[var(--fg-subtle)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]"
            aria-label={`Edit the line at ${at}`}
            title="Fix this line"
          >
            <Pencil className="size-3" aria-hidden />
          </button>
          <button
            type="button"
            onClick={onSomeoneElse}
            className="rounded p-0.5 text-[var(--fg-subtle)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]"
            aria-label={`Who said the line at ${at}? (now ${speaker.displayName})`}
            title="Someone else said this"
          >
            <UserRoundSearch className="size-3" aria-hidden />
          </button>
        </span>
      </span>
    </div>
  );
}
