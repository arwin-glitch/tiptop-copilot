'use client';

import { Pencil, RefreshCw } from 'lucide-react';
import { DRAFT_MODEL } from '@/lib/notes/draft';
import type {
  CopilotNoteView,
  EnhancedBlock,
  SegmentView,
  SpeakerView,
  TemplateView,
} from '@/lib/types/notes';
import { AiBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/feedback';
import { cn } from '@/lib/util/cn';
import { ArwinNotesStatus } from './arwin-notes-status';
import { SourcePopover } from './source-popover';
import { TemplatePicker } from './template-picker';

/**
 * The notes after Stop (D-076). Lines the person typed stay in full ink with
 * a gold rule (they are kept word for word); what was written for them is a
 * lighter tone, and each such point carries a source mark that opens the
 * transcript lines behind it. First the Quick notes (rules, at once), then
 * Arwin's notes when his Claude routine sends them; the status above says
 * which, and that Arwin is still writing. Regenerate, switch the template,
 * or Edit the typed notes.
 */
export function EnhancedNotes({
  note,
  segments,
  speakers,
  templates,
  regenerating,
  demo = false,
  onRegenerate,
  onTemplate,
  onEdit,
  onJump,
}: {
  note: CopilotNoteView;
  segments: readonly SegmentView[];
  speakers: readonly SpeakerView[];
  templates: readonly TemplateView[];
  regenerating: boolean;
  /** The demo workspace: Arwin's routine is never connected there. */
  demo?: boolean;
  onRegenerate: () => void;
  onTemplate: (templateId: string | null) => void;
  onEdit: () => void;
  onJump: (seq: number) => void;
}) {
  const typedCount = note.blocks.filter((b) => b.source === 'typed').length;
  const quick = note.model === DRAFT_MODEL;
  return (
    <section
      aria-label="Enhanced notes"
      data-enhanced-notes=""
      data-notes-kind={quick ? 'quick' : 'arwin'}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] pb-3">
        <TemplatePicker
          templates={templates}
          value={note.templateId}
          onChange={onTemplate}
          disabled={regenerating}
        />
        <Button size="sm" variant="secondary" onClick={onRegenerate} loading={regenerating}>
          <RefreshCw aria-hidden /> Regenerate
        </Button>
        <Button size="sm" variant="ghost" onClick={onEdit}>
          <Pencil aria-hidden /> Edit
        </Button>
        <span className="ml-auto flex items-center gap-2">
          <AiBadge label={quick ? 'Quick notes' : 'Written by Arwin'} />
        </span>
      </div>

      {note.request ? (
        <ArwinNotesStatus
          request={note.request}
          showingQuick={quick}
          demo={demo}
          busy={regenerating}
          onAskAgain={onRegenerate}
          className="mt-3"
        />
      ) : null}

      {note.stale ? (
        <Notice className="mt-3">
          Names changed since these notes were written. Regenerate to use the new names.
        </Notice>
      ) : null}

      <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--fg-muted)]">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-3 w-0.5 rounded bg-[var(--gold)]" /> Your words (
          {typedCount})
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-3 w-0.5 rounded bg-[var(--border-strong)]" />{' '}
          {quick ? 'Picked from the transcript' : 'Written by Arwin'}, with its source
        </span>
      </p>

      {note.blocks.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--fg-muted)]">
          Nothing to show yet. Regenerate once the transcript has lines.
        </p>
      ) : (
        <div className="mt-3 space-y-1.5">
          {note.blocks.map((block) => (
            <Block
              key={block.id}
              block={block}
              segments={segments}
              speakers={speakers}
              onJump={onJump}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function Block({
  block,
  segments,
  speakers,
  onJump,
}: {
  block: EnhancedBlock;
  segments: readonly SegmentView[];
  speakers: readonly SpeakerView[];
  onJump: (seq: number) => void;
}) {
  const typed = block.source === 'typed';
  const indent = block.depth === 2 ? 'ml-8' : block.depth === 1 ? 'ml-4' : '';
  const tone = typed
    ? 'border-l-2 border-[var(--gold)] pl-2.5 text-[var(--fg)]'
    : 'border-l-2 border-transparent pl-2.5 text-[var(--fg-muted)]';
  const source = typed ? null : (
    <SourcePopover
      ranges={block.sources}
      segments={segments}
      speakers={speakers}
      onJump={onJump}
      label={block.text.slice(0, 60)}
    />
  );
  const marker = typed ? <span className="sr-only">(your note) </span> : null;

  if (block.kind === 'heading') {
    return (
      <h3
        data-source={block.source}
        className={cn(
          'pt-2 font-serif text-base font-semibold',
          tone,
          typed ? '' : 'text-[var(--fg)]',
        )}
      >
        {marker}
        {block.text}
        {source}
      </h3>
    );
  }
  if (block.kind === 'checkbox') {
    return (
      <p data-source={block.source} className={cn('flex items-start gap-2 text-sm', tone, indent)}>
        <input
          type="checkbox"
          checked={Boolean(block.checked)}
          readOnly
          disabled
          aria-label={block.checked ? 'Done' : 'Not done'}
          className="mt-1 size-3.5 accent-[var(--accent)]"
        />
        <span>
          {marker}
          {block.text}
          {source}
        </span>
      </p>
    );
  }
  if (block.kind === 'bullet') {
    return (
      <p
        data-source={block.source}
        className={cn('flex gap-2 text-sm leading-relaxed', tone, indent)}
      >
        <span aria-hidden>•</span>
        <span>
          {marker}
          {block.text}
          {source}
        </span>
      </p>
    );
  }
  return (
    <p data-source={block.source} className={cn('text-sm leading-relaxed', tone, indent)}>
      {marker}
      {block.text}
      {source}
    </p>
  );
}
