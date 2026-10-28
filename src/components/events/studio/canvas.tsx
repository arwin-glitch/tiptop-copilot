'use client';

import * as React from 'react';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Copy,
  EyeOff,
  Paintbrush,
  Trash2,
} from 'lucide-react';
import { EventPage } from '@/components/events/render/event-page';
import { filterDocForViewer } from '@/lib/events/visibility';
import { factsForViewer, viewerFor } from '@/lib/events/editor/preview';
import { PresenceTracker, softLockFor, presenceName } from '@/lib/events/editor/presence';
import { BLOCK_VARIANTS, isSectionKey, orderedSections } from '@/lib/events/schema';
import { cn } from '@/lib/util/cn';
import { useConfirm } from '@/components/ui/confirm';
import { DEVICE_WIDTH, useStudio } from './studio-context';

interface Box {
  id: string;
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * The canvas: WS2's real guest renderer (EventPage) inside a device frame.
 * The frame is its own scroller with paint containment and an inline-size
 * container, so container queries, sticky bars and fixed overlays behave as
 * on a phone. Larger devices scale down to fit.
 *
 * Clicking a section selects it (outline + floating toolbar). Plain-text
 * fields marked data-field="props.<key>" edit inline once their section is
 * selected (contentEditable plaintext-only; Enter or leaving saves, Esc
 * cancels). Links and buttons inside the page do nothing here.
 */
export function Canvas({
  previewOnly = false,
  onEditSection,
}: {
  previewOnly?: boolean;
  onEditSection?: () => void;
}) {
  const studio = useStudio();
  const { boot, doc, versionPreview } = studio;
  const areaRef = React.useRef<HTMLDivElement>(null);
  const frameRef = React.useRef<HTMLDivElement>(null);
  const [area, setArea] = React.useState({ width: 0, height: 0 });
  const [boxes, setBoxes] = React.useState<Box[]>([]);
  const [now, setNow] = React.useState(0);
  const [tracker] = React.useState(() => new PresenceTracker());
  const [confirm, confirmDialog] = useConfirm();

  const viewer = React.useMemo(
    () => viewerFor(studio.preview, boot.guests),
    [studio.preview, boot.guests],
  );
  const sourceDoc = versionPreview?.doc ?? doc;
  const shownDoc = React.useMemo(() => filterDocForViewer(sourceDoc, viewer), [sourceDoc, viewer]);
  const facts = React.useMemo(() => factsForViewer(boot.facts, viewer), [boot.facts, viewer]);
  const interactive = !previewOnly && !versionPreview;
  const selectedId = interactive ? studio.selectedId : null;

  // Track others' typing for the soft-lock timer, and tick a clock for it.
  const presence = studio.sessionState.presence;
  React.useEffect(() => {
    tracker.observe(presence);
    const id = window.setTimeout(() => setNow(Date.now()), 0);
    return () => window.clearTimeout(id);
  }, [presence, tracker]);
  React.useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(id);
  }, []);

  // Measure the area (the frame scales to it).
  React.useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setArea({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const deviceWidth = DEVICE_WIDTH[studio.device] ?? Math.max(320, area.width - 32);
  const scale = area.width ? Math.min(1, (area.width - 32) / deviceWidth) : 1;

  // Overlay boxes: the selected section and where others are, in area coordinates.
  const focusIds = React.useMemo(() => {
    const ids = new Set<string>();
    if (selectedId) ids.add(selectedId);
    for (const p of presence) {
      if (p.actorKey !== boot.actor.key && p.active && p.focusedSectionId)
        ids.add(p.focusedSectionId);
    }
    return [...ids];
  }, [boot.actor.key, presence, selectedId]);

  React.useEffect(() => {
    const frame = frameRef.current;
    const areaEl = areaRef.current;
    if (!frame || !areaEl) return;
    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const base = areaEl.getBoundingClientRect();
        const next: Box[] = [];
        for (const id of focusIds) {
          const el = frame.querySelector<HTMLElement>(`[data-section-id="${CSS.escape(id)}"]`);
          if (!el) continue;
          const r = el.getBoundingClientRect();
          next.push({
            id,
            top: r.top - base.top,
            left: r.left - base.left,
            width: r.width,
            height: r.height,
          });
        }
        setBoxes(next);
      });
    };
    measure();
    frame.addEventListener('scroll', measure, { passive: true });
    const resize = new ResizeObserver(measure);
    resize.observe(frame);
    if (frame.firstElementChild) resize.observe(frame.firstElementChild);
    return () => {
      cancelAnimationFrame(raf);
      frame.removeEventListener('scroll', measure);
      resize.disconnect();
    };
  }, [focusIds, shownDoc, scale, area.width, area.height]);

  // Delete (keyboard or toolbar) always asks first.
  const requestDelete = React.useCallback(
    async (sectionId: string) => {
      const section = doc.sections.find((s) => s.id === sectionId);
      if (!section || studio.structureDenied()) return;
      const yes = await confirm({
        title: `Delete ${studio.labelOf(section)}?`,
        description: 'You can undo this with Ctrl+Z.',
        confirmLabel: 'Delete',
        tone: 'danger',
      });
      if (yes) studio.deleteSection(sectionId);
    },
    [confirm, doc.sections, studio],
  );
  React.useEffect(() => {
    const onDelete = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      if (id) void requestDelete(id);
    };
    window.addEventListener('studio:delete', onDelete);
    return () => window.removeEventListener('studio:delete', onDelete);
  }, [requestDelete]);

  const lock = interactive
    ? softLockFor(
        selectedId,
        presence,
        { actorKey: boot.actor.key, owner: boot.actor.owner },
        tracker,
        studio.overridden,
        now || 0,
      )
    : null;

  /* ------------------------------------------------------- inline editing */

  const editing = React.useRef<{
    el: HTMLElement;
    sectionId: string;
    key: string;
    before: string;
  } | null>(null);

  function stopEditing(commit: boolean) {
    const current = editing.current;
    if (!current) return;
    editing.current = null;
    const text = (current.el.textContent ?? '').replace(/\s+/g, ' ').trim();
    current.el.removeAttribute('contenteditable');
    studio.session.setTyping(false);
    if (!commit) {
      current.el.textContent = current.before;
      return;
    }
    if (text !== current.before) {
      studio.updateSection(current.sectionId, { [current.key]: text });
    }
  }

  function startEditing(el: HTMLElement, sectionId: string) {
    const key = el.getAttribute('data-field') ?? '';
    if (!isSectionKey(key) || !key.startsWith('props.')) return;
    if (studio.readOnly || studio.sectionDenied(sectionId, key)) return;
    // A soft-locked section edits only after "Edit anyway".
    if (lock) return;
    stopEditing(true);
    editing.current = { el, sectionId, key, before: el.textContent ?? '' };
    try {
      el.setAttribute('contenteditable', 'plaintext-only');
      if (el.contentEditable !== 'plaintext-only') el.setAttribute('contenteditable', 'true');
    } catch {
      el.setAttribute('contenteditable', 'true');
    }
    el.focus();
    studio.session.setTyping(true);
  }

  function onFrameClick(event: React.MouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (editing.current?.el.contains(target)) return;
    // Nothing on the page navigates or submits inside Studio.
    if (target.closest('a, button, input, select, textarea, form, label')) event.preventDefault();
    if (!interactive) return;
    const sectionEl = target.closest<HTMLElement>('[data-section-id]');
    if (!sectionEl) {
      studio.select(null);
      return;
    }
    const sectionId = sectionEl.getAttribute('data-section-id')!;
    const fieldEl = target.closest<HTMLElement>('[data-field]');
    if (studio.selectedId === sectionId && fieldEl) startEditing(fieldEl, sectionId);
    else studio.select(sectionId);
  }

  function onFrameKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!editing.current) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      stopEditing(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      stopEditing(false);
    }
  }

  function onFramePaste(event: React.ClipboardEvent<HTMLDivElement>) {
    if (!editing.current) return;
    event.preventDefault();
    const text = event.clipboardData.getData('text/plain').replace(/\s+/g, ' ');
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    range.insertNode(document.createTextNode(text));
    range.collapse(false);
  }

  /* ------------------------------------------------------------ toolbar */

  const ordered = orderedSections(doc.sections);
  const selected = selectedId ? doc.sections.find((s) => s.id === selectedId) : undefined;
  const selectedBox = boxes.find((b) => b.id === selectedId);
  const variants = selected ? (BLOCK_VARIANTS[selected.type] as readonly string[]) : [];
  const variantIndex = selected ? Math.max(0, variants.indexOf(selected.variant)) : 0;
  const structureDenied = studio.structureDenied();
  const variantDenied = selected
    ? studio.sectionDenied(selected.id, 'variant')
    : 'Outside your scope';
  const hideDenied = selected
    ? studio.sectionDenied(selected.id, 'visibility')
    : 'Outside your scope';

  const frameHeight = area.height ? area.height / scale : undefined;
  const framePalette =
    sourceDoc.theme.mode === 'dark' ? sourceDoc.theme.paletteDark : sourceDoc.theme.palette;

  return (
    <div
      ref={areaRef}
      className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-[var(--bg-sunken)]"
      data-studio-canvas=""
    >
      <div
        className="absolute top-0 left-1/2 -translate-x-1/2 overflow-hidden"
        style={{ width: deviceWidth * scale, height: area.height || '100%' }}
      >
        <div
          style={{
            width: deviceWidth,
            height: frameHeight ?? '100%',
            transform: scale < 1 ? `scale(${scale})` : undefined,
            transformOrigin: 'top left',
          }}
        >
          <div
            ref={frameRef}
            data-studio-frame=""
            data-device={studio.device}
            className={cn(
              'h-full scrollbar-thin overflow-x-hidden overflow-y-auto',
              studio.device !== 'fit' && 'shadow-overlay',
            )}
            // The page paints its own theme; these are only the frame's
            // fallback, so nothing of Kraken's colour scheme leaks in.
            style={{
              containerType: 'inline-size',
              contain: 'paint',
              backgroundColor: framePalette.bg,
              color: framePalette.text,
              colorScheme: sourceDoc.theme.mode === 'dark' ? 'dark' : 'light',
            }}
            onClickCapture={onFrameClick}
            onKeyDownCapture={onFrameKeyDown}
            onPasteCapture={onFramePaste}
            onBlurCapture={(event) => {
              if (editing.current && event.target === editing.current.el) stopEditing(true);
            }}
          >
            <EventPage
              doc={shownDoc}
              facts={facts}
              media={studio.media}
              viewer={viewer}
              mode={previewOnly ? 'preview' : 'studio'}
              motion={studio.motion}
              rsvp={null}
              selectedSectionId={selectedId}
            />
          </div>
        </div>
      </div>

      {/* Overlays live outside the scaled frame so they stay full size. */}
      {interactive ? (
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          {boxes.map((box) => {
            const others = presence.filter(
              (p) => p.actorKey !== boot.actor.key && p.active && p.focusedSectionId === box.id,
            );
            const mine = box.id === selectedId;
            const color = mine ? 'var(--primary)' : (others[0]?.color ?? 'var(--primary)');
            return (
              <div
                key={box.id}
                className="absolute rounded-sm"
                style={{
                  top: box.top,
                  left: box.left,
                  width: box.width,
                  height: box.height,
                  boxShadow: `inset 0 0 0 2px ${color}`,
                }}
              >
                {others.length ? (
                  <span
                    className="absolute top-1 right-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-white"
                    style={{ backgroundColor: others[0]!.color }}
                  >
                    {others.map((p) => presenceName(p)).join(', ')}
                    {others.some((p) => p.typing) ? ' · typing' : ''}
                  </span>
                ) : null}
              </div>
            );
          })}

          {selected && selectedBox ? (
            <div
              role="toolbar"
              aria-label={`${studio.labelOf(selected)} section`}
              className="shadow-lifted pointer-events-auto absolute flex max-w-[calc(100%-1rem)] flex-wrap items-center gap-0.5 rounded-md border border-[var(--border-strong)] bg-[var(--bg-overlay)] p-0.5"
              style={{
                top: toolbarTop(selectedBox, area.height),
                left: Math.max(8, Math.min(selectedBox.left + 8, area.width - 340)),
              }}
            >
              <ToolButton
                label="Move up"
                disabled={Boolean(structureDenied) || ordered[0]?.id === selected.id}
                onClick={() => studio.stepSection(selected.id, -1)}
              >
                <ChevronUp />
              </ToolButton>
              <ToolButton
                label="Move down"
                disabled={Boolean(structureDenied) || ordered.at(-1)?.id === selected.id}
                onClick={() => studio.stepSection(selected.id, 1)}
              >
                <ChevronDown />
              </ToolButton>
              <ToolButton
                label="Duplicate"
                disabled={Boolean(structureDenied)}
                onClick={() => studio.duplicateSection(selected.id)}
              >
                <Copy />
              </ToolButton>
              <ToolButton
                label={hideDenied ?? 'Hide'}
                disabled={Boolean(hideDenied)}
                onClick={() =>
                  studio.updateSection(
                    selected.id,
                    { visibility: { mode: 'hidden', tags: selected.visibility.tags } },
                    `Hide ${studio.labelOf(selected)}`,
                  )
                }
              >
                <EyeOff />
              </ToolButton>
              <ToolButton
                label="Delete"
                disabled={Boolean(structureDenied)}
                onClick={() => void requestDelete(selected.id)}
              >
                <Trash2 />
              </ToolButton>
              {variants.length > 1 ? (
                <span className="flex items-center border-l border-[var(--border)] pl-0.5">
                  <ToolButton
                    label="Previous layout"
                    disabled={Boolean(variantDenied)}
                    onClick={() =>
                      studio.updateSection(
                        selected.id,
                        {
                          variant:
                            variants[(variantIndex - 1 + variants.length) % variants.length]!,
                        },
                        'Change layout',
                      )
                    }
                  >
                    <ChevronLeft />
                  </ToolButton>
                  <span className="px-1 text-xs whitespace-nowrap text-[var(--fg-muted)]">
                    Layout {variantIndex + 1}/{variants.length}
                  </span>
                  <ToolButton
                    label="Next layout"
                    disabled={Boolean(variantDenied)}
                    onClick={() =>
                      studio.updateSection(
                        selected.id,
                        { variant: variants[(variantIndex + 1) % variants.length]! },
                        'Change layout',
                      )
                    }
                  >
                    <ChevronRight />
                  </ToolButton>
                </span>
              ) : null}
              <ToolButton
                label="Style"
                onClick={() => {
                  window.dispatchEvent(new CustomEvent('studio:inspector', { detail: 'style' }));
                  onEditSection?.();
                }}
              >
                <Paintbrush />
              </ToolButton>
            </div>
          ) : null}

          {lock && selectedBox ? (
            <div
              role="status"
              className="shadow-lifted pointer-events-auto absolute flex items-center gap-2 rounded-md px-2 py-1 text-xs text-white"
              style={{
                top: Math.max(4, Math.min(selectedBox.top + 8, area.height - 40)),
                right: 12,
                backgroundColor: lock.by.color,
              }}
            >
              <span>{presenceName(lock.by)} is editing</span>
              <button
                type="button"
                className="rounded bg-white/20 px-1.5 py-0.5 font-medium hover:bg-white/30 disabled:opacity-60"
                disabled={!lock.canOverride}
                onClick={() => studio.override(lock.by.focusedSectionId ?? selectedId ?? '')}
              >
                {lock.canOverride ? 'Edit anyway' : `Edit anyway in ${lock.overrideInSeconds}s`}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {confirmDialog}
    </div>
  );
}

/** Above the section when there is room, else just below it, else inside its top. */
function toolbarTop(box: Box, areaHeight: number): number {
  const above = box.top - 44;
  if (above >= 4) return above;
  const below = box.top + box.height + 4;
  if (below + 44 <= areaHeight) return below;
  return Math.max(4, box.top + 4);
}

function ToolButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex size-8 items-center justify-center rounded text-[var(--fg-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)] disabled:opacity-35 [&_svg]:size-4"
    >
      {children}
    </button>
  );
}
