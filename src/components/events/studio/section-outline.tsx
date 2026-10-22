'use client';

import * as React from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ChevronDown, ChevronUp, Eye, EyeOff, GripVertical, Lock, Plus } from 'lucide-react';
import { blockRegistry } from '@/lib/events/blocks';
import { inSectionScope } from '@/lib/events/capabilities';
import { sectionSummary } from '@/lib/events/editor/fields';
import { orderedSections, type EventSection } from '@/lib/events/schema';
import { cn } from '@/lib/util/cn';
import { Avatar } from './presence-avatars';
import { useStudio } from './studio-context';

const VISIBILITY_BADGE: Record<string, string> = {
  registered: 'Registered',
  going: 'Going',
  hidden: 'Hidden',
};

/**
 * The page outline: sections in order, drag to reorder (dnd-kit, with
 * keyboard reordering and screen-reader announcements), ↑/↓ buttons as the
 * fallback, an eye to hide, lock and visibility badges, and who is where.
 * "+ Add section" opens the block gallery; a + between rows inserts there.
 */
export function SectionOutline({ onPick }: { onPick: () => void }) {
  const studio = useStudio();
  const { doc, labelOf } = studio;
  const ordered = orderedSections(doc.sections);
  const canStructure = !studio.structureDenied() && !studio.readOnly;
  // A stable id, so dnd-kit's screen-reader ids match between server and client.
  const dndId = React.useId();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const nameOf = (id: string | number) => {
    const s = ordered.find((x) => x.id === id);
    return s ? labelOf(s) : 'section';
  };
  const positionOf = (id: string | number) => ordered.findIndex((x) => x.id === id) + 1;
  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      `Picked up ${nameOf(active.id)}, position ${positionOf(active.id)} of ${ordered.length}.`,
    onDragOver: ({ active, over }) =>
      over
        ? `${nameOf(active.id)} is over position ${positionOf(over.id)} of ${ordered.length}.`
        : `${nameOf(active.id)} is no longer over a position.`,
    onDragEnd: ({ active, over }) =>
      over
        ? `${nameOf(active.id)} dropped at position ${positionOf(over.id)} of ${ordered.length}.`
        : `${nameOf(active.id)} dropped.`,
    onDragCancel: ({ active }) => `Moving ${nameOf(active.id)} was cancelled.`,
  };

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const to = ordered.findIndex((s) => s.id === over.id);
    if (to >= 0) studio.moveSection(String(active.id), to);
  }

  return (
    <div className="p-2">
      <div className="mb-2 flex items-center justify-between px-1">
        <h2 className="text-sm font-semibold">Sections</h2>
        <span className="text-xs text-[var(--fg-muted)]">{ordered.length}</span>
      </div>
      {ordered.length === 0 ? (
        <p className="px-2 py-4 text-sm text-[var(--fg-muted)]">
          No sections yet. Add the first one below.
        </p>
      ) : null}
      <DndContext
        id={dndId}
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
        accessibility={{
          announcements,
          screenReaderInstructions: {
            draggable:
              'To move a section, press space or enter to pick it up, use the arrow keys to move it, then press space or enter again to drop it. Escape cancels.',
          },
        }}
      >
        <SortableContext items={ordered.map((s) => s.id)} strategy={verticalListSortingStrategy}>
          <ol aria-label="Page sections" className="space-y-0.5">
            {ordered.map((section, index) => (
              <OutlineRow
                key={section.id}
                section={section}
                index={index}
                count={ordered.length}
                canStructure={canStructure}
                onPick={onPick}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
      {canStructure ? (
        <button
          type="button"
          className="mt-2 flex min-h-10 w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-[var(--border-strong)] text-sm font-medium text-[var(--fg-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]"
          onClick={() => studio.openGallery(studio.selectedId ?? ordered.at(-1)?.id ?? null)}
        >
          <Plus aria-hidden="true" className="size-4" />
          Add section
        </button>
      ) : null}
    </div>
  );
}

function OutlineRow({
  section,
  index,
  count,
  canStructure,
  onPick,
}: {
  section: EventSection;
  index: number;
  count: number;
  canStructure: boolean;
  onPick: () => void;
}) {
  const studio = useStudio();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: section.id,
    disabled: !canStructure,
  });
  const label = studio.labelOf(section);
  const summary = sectionSummary(section, blockRegistry);
  const selected = studio.selectedId === section.id;
  const outOfScope = !inSectionScope(studio.boot.capabilities, section.id);
  const hidden = section.visibility.mode === 'hidden';
  const hideDenied = studio.sectionDenied(section.id, 'visibility');
  const here = studio.sessionState.presence.filter(
    (p) => p.actorKey !== studio.boot.actor.key && p.active && p.focusedSectionId === section.id,
  );
  const visibilityBadge =
    section.visibility.mode === 'tags'
      ? section.visibility.tags.slice(0, 2).join(', ') || 'Tags'
      : VISIBILITY_BADGE[section.visibility.mode];

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('group relative', isDragging && 'z-10 opacity-80')}
      data-outline-id={section.id}
    >
      {canStructure && index > 0 ? (
        <button
          type="button"
          aria-label={`Add a section above ${label}`}
          title="Add a section here"
          className="absolute -top-2 left-1/2 z-10 hidden size-5 -translate-x-1/2 items-center justify-center rounded-full border border-[var(--border-strong)] bg-[var(--bg-raised)] text-[var(--fg-muted)] group-hover:flex focus-visible:flex"
          onClick={() => {
            const ordered = orderedSections(studio.doc.sections);
            studio.openGallery(ordered[index - 1]?.id ?? null);
          }}
        >
          <Plus aria-hidden="true" className="size-3" />
        </button>
      ) : null}
      <div
        className={cn(
          'flex items-center gap-1 rounded-md border px-1 py-1',
          selected
            ? 'border-[var(--primary)] bg-[var(--accent-soft)]'
            : 'border-transparent hover:bg-[var(--bg-hover)]',
        )}
      >
        {canStructure ? (
          <button
            type="button"
            className="cursor-grab touch-none rounded p-1 text-[var(--fg-subtle)] hover:text-[var(--fg)]"
            aria-label={`Move ${label}`}
            {...attributes}
            {...listeners}
          >
            <GripVertical aria-hidden="true" className="size-4" />
          </button>
        ) : (
          <span className="w-1" />
        )}
        <button
          type="button"
          className="min-w-0 flex-1 rounded px-1 py-0.5 text-left"
          aria-current={selected ? 'true' : undefined}
          onClick={() => {
            studio.select(section.id);
            document
              .querySelector(`[data-studio-frame] [data-section-id="${section.id}"]`)
              ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            onPick();
          }}
        >
          <span
            className={cn(
              'block truncate text-sm font-medium',
              hidden && 'line-through opacity-60',
            )}
          >
            {label}
          </span>
          {summary && summary !== label ? (
            <span className="block truncate text-xs text-[var(--fg-muted)]">{summary}</span>
          ) : null}
        </button>
        {here.length ? (
          <span
            className="flex -space-x-1"
            aria-label={`Here: ${here.map((p) => p.name).join(', ')}`}
          >
            {here.slice(0, 2).map((p) => (
              <Avatar key={p.actorKey} person={p} size="sm" />
            ))}
          </span>
        ) : null}
        {visibilityBadge ? (
          <span className="rounded-full bg-[var(--neutral-soft)] px-1.5 text-[10px] font-medium text-[var(--fg-muted)]">
            {visibilityBadge}
          </span>
        ) : null}
        {outOfScope ? (
          <span title="Outside your scope" className="text-[var(--fg-subtle)]">
            <Lock aria-label="Outside your scope" className="size-3.5" />
          </span>
        ) : null}
        <button
          type="button"
          className="rounded p-1 text-[var(--fg-subtle)] hover:text-[var(--fg)] disabled:opacity-40"
          aria-label={hidden ? `Show ${label}` : `Hide ${label}`}
          title={hideDenied ?? (hidden ? 'Show' : 'Hide')}
          disabled={Boolean(hideDenied) || studio.readOnly}
          onClick={() =>
            studio.updateSection(
              section.id,
              {
                visibility: { mode: hidden ? 'everyone' : 'hidden', tags: section.visibility.tags },
              },
              hidden ? `Show ${label}` : `Hide ${label}`,
            )
          }
        >
          {hidden ? (
            <EyeOff aria-hidden="true" className="size-4" />
          ) : (
            <Eye aria-hidden="true" className="size-4" />
          )}
        </button>
        {canStructure ? (
          <span className="flex flex-col">
            <button
              type="button"
              className="rounded text-[var(--fg-subtle)] hover:text-[var(--fg)] disabled:opacity-30"
              aria-label={`Move ${label} up`}
              disabled={index === 0}
              onClick={() => studio.stepSection(section.id, -1)}
            >
              <ChevronUp aria-hidden="true" className="size-3.5" />
            </button>
            <button
              type="button"
              className="rounded text-[var(--fg-subtle)] hover:text-[var(--fg)] disabled:opacity-30"
              aria-label={`Move ${label} down`}
              disabled={index === count - 1}
              onClick={() => studio.stepSection(section.id, 1)}
            >
              <ChevronDown aria-hidden="true" className="size-3.5" />
            </button>
          </span>
        ) : null}
      </div>
    </li>
  );
}
