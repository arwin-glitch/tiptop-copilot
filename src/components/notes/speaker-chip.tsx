'use client';

import { HelpCircle, Lock, Mic } from 'lucide-react';
import type { SpeakerView } from '@/lib/types/notes';
import { cn } from '@/lib/util/cn';
import { certaintyWords } from './helpers';

/**
 * A voice's name chip. A resolved voice shows its name; an unresolved one the
 * dashed "Guest 1 · Who is this?". Tapping either opens "This is…" (the
 * Who-is-this sheet), where one pick renames every line of the voice.
 * The mic owner's chip is gold, everyone else's emerald.
 */
export function SpeakerChip({
  speaker,
  onOpen,
  size = 'md',
  className,
}: {
  speaker: SpeakerView;
  onOpen?: (speaker: SpeakerView) => void;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const label = speaker.resolved ? speaker.displayName : `${speaker.displayName} · Who is this?`;
  const title = speaker.resolved
    ? `${speaker.displayName}: ${certaintyWords(speaker.certainty)}${speaker.locked ? ', locked' : ''}`
    : 'Not named yet. Tap to say who this is.';
  const body = (
    <>
      {speaker.isOwner ? (
        <Mic className="size-3" aria-hidden />
      ) : !speaker.resolved ? (
        <HelpCircle className="size-3" aria-hidden />
      ) : null}
      <span className="truncate">{label}</span>
      {speaker.resolved && speaker.locked && !speaker.isOwner ? (
        <Lock className="size-2.5 opacity-70" aria-hidden />
      ) : null}
    </>
  );
  const classes = cn(
    'inline-flex max-w-full items-center gap-1 rounded-full border font-medium whitespace-nowrap',
    size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-0.5 text-xs',
    speaker.isOwner
      ? 'border-[var(--gold-rule)] bg-[color-mix(in_srgb,var(--gold)_16%,var(--bg-raised))] text-[var(--fg)]'
      : speaker.resolved
        ? 'border-transparent bg-[var(--accent-soft)] text-[var(--fg)]'
        : 'border-dashed border-[var(--border-control)] bg-transparent text-[var(--fg-muted)]',
    onOpen && 'cursor-pointer hover:border-[var(--gold)] focus-visible:border-[var(--gold)]',
    className,
  );
  if (!onOpen) {
    return (
      <span className={classes} title={title} data-speaker={speaker.clusterKey}>
        {body}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={classes}
      title={title}
      aria-label={
        speaker.resolved
          ? `${speaker.displayName}: change who this is`
          : `${speaker.displayName}: who is this?`
      }
      data-speaker={speaker.clusterKey}
      onClick={() => onOpen(speaker)}
    >
      {body}
    </button>
  );
}
