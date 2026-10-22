'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { DraftEditor } from '@/lib/events/editor/draft-editor';
import { readBackup, StudioSession } from '@/lib/events/editor/session';
import { cn } from '@/lib/util/cn';
import { BlockGallery } from './block-gallery';
import { Canvas } from './canvas';
import { CommandPalette } from './command-palette';
import { ConflictDialog } from './conflict-dialog';
import { Inspector } from './inspector';
import { LeftRail } from './left-rail';
import { LostScreen, StudioBanners } from './studio-banners';
import { StudioProvider, useEditorRevision, useStudio } from './studio-context';
import type { StudioBootstrap } from './studio-types';
import { TopBar } from './top-bar';

/**
 * Studio (D-075): the event page editor. Full screen outside the app shell
 * for owners (/events/[id]/studio) and the same component for outside
 * editors (/e/edit/[id]), gated by the capabilities in the bootstrap.
 *
 *   top bar      back · title · save state · who is here · undo/redo ·
 *                device · motion · preview as · history · share · publish
 *   left rail    sections outline (drag to reorder) · theme · brand ·
 *                effects · media
 *   canvas       the real guest renderer (EventPage) in a device frame
 *   inspector    page settings, or the selected section's content, style,
 *                motion, visibility and activity
 *
 * On a phone the three columns become one, switched by a tab bar, so
 * nothing ever scrolls sideways.
 */
export function Studio({ boot }: { boot: StudioBootstrap }) {
  const [editor] = React.useState(() => new DraftEditor({ doc: boot.doc, version: boot.version }));
  const [session] = React.useState(
    () =>
      new StudioSession({
        eventId: boot.eventId,
        actorKey: boot.actor.key,
        endpoints: boot.endpoints,
        editor,
        editingPaused: boot.editingPaused,
        publishedVersion: boot.publishedVersion,
        readOnly: boot.actor.role === 'viewer',
      }),
  );

  const restored = React.useRef(false);
  React.useEffect(() => {
    session.start();
    // Unsaved ops an earlier tab kept in this browser (offline, closed early),
    // once per page load.
    const saved = restored.current ? [] : readBackup(boot.eventId, boot.actor.key);
    restored.current = true;
    if (saved.length && boot.actor.role !== 'viewer') {
      const n = editor.restoreBackup(saved);
      if (n) toast.message(`Restored ${n} unsaved change${n === 1 ? '' : 's'} from this browser.`);
    }
    return () => session.stop();
  }, [boot.actor.key, boot.actor.role, boot.eventId, editor, session]);

  return (
    <StudioProvider boot={boot} editor={editor} session={session}>
      <StudioLayout />
    </StudioProvider>
  );
}

type PhonePane = 'outline' | 'canvas' | 'inspector';

function StudioLayout() {
  const studio = useStudio();
  const { editor, session, sessionState } = studio;
  const [pane, setPane] = React.useState<PhonePane>('canvas');
  useEditorRevision(editor);

  // Leaving with unsaved changes asks first (only then).
  React.useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!editor.hasUnsaved) return;
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [editor]);

  // Notices from the editor (can't undo, refused changes) as toasts.
  const notices = editor.notices;
  React.useEffect(() => {
    for (const notice of notices) {
      if (notice.tone === 'error') toast.error(notice.text);
      else if (notice.tone === 'warning') toast.warning(notice.text);
      else toast.message(notice.text);
      editor.dismissNotice(notice.id);
    }
  }, [editor, notices]);

  useStudioShortcuts();

  if (sessionState.lost) return <LostScreen outside={studio.boot.actor.outside} />;

  if (studio.fullPreview) {
    return (
      <div className="flex h-dvh flex-col bg-[var(--bg-sunken)]">
        <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] bg-[var(--bg-raised)] px-3 py-2 text-sm">
          <span className="font-medium">Full-screen preview</span>
          <button
            type="button"
            className="rounded-md border border-[var(--border-strong)] px-3 py-1.5 text-sm hover:bg-[var(--bg-hover)]"
            onClick={() => studio.setFullPreview(false)}
          >
            Back to editing
          </button>
        </div>
        <Canvas previewOnly />
      </div>
    );
  }

  return (
    <div
      className="flex h-dvh min-w-0 flex-col overflow-hidden bg-[var(--bg)] text-[var(--fg)]"
      onPointerDown={() => session.markActivity()}
      onKeyDown={() => session.markActivity()}
    >
      <TopBar />
      <StudioBanners />
      {/* Phone: one pane at a time. */}
      <nav
        aria-label="Studio panes"
        className="flex shrink-0 border-b border-[var(--border)] bg-[var(--bg-raised)] lg:hidden"
      >
        {(
          [
            ['outline', 'Sections'],
            ['canvas', 'Page'],
            ['inspector', 'Edit'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={pane === id}
            onClick={() => setPane(id)}
            className={cn(
              'min-h-11 flex-1 text-sm font-medium',
              pane === id
                ? 'border-b-2 border-[var(--primary)] text-[var(--fg)]'
                : 'text-[var(--fg-muted)]',
            )}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="flex min-h-0 min-w-0 flex-1">
        <aside
          aria-label="Page outline and design"
          className={cn(
            'min-h-0 w-full shrink-0 flex-col border-r border-[var(--border)] bg-[var(--bg-raised)] lg:flex lg:w-72',
            pane === 'outline' ? 'flex' : 'hidden',
          )}
        >
          <LeftRail onPick={() => setPane('canvas')} />
        </aside>
        <div
          role="region"
          aria-label="Page preview"
          className={cn(
            'min-h-0 min-w-0 flex-1 flex-col lg:flex',
            pane === 'canvas' ? 'flex' : 'hidden',
          )}
        >
          <Canvas onEditSection={() => setPane('inspector')} />
        </div>
        <aside
          aria-label="Inspector"
          className={cn(
            'min-h-0 w-full shrink-0 flex-col border-l border-[var(--border)] bg-[var(--bg-raised)] lg:flex lg:w-80',
            pane === 'inspector' ? 'flex' : 'hidden',
          )}
        >
          <Inspector />
        </aside>
      </div>
      <BlockGallery />
      <ConflictDialog />
      <CommandPalette />
    </div>
  );
}

function editable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  );
}

/**
 * Cmd/Ctrl+Z undo, Shift+Cmd+Z redo, Cmd+D duplicate, Alt+↑/↓ move, Delete,
 * Esc deselect, / add section, Cmd+K command palette, P full-screen preview.
 * Typing in a field keeps its own keys (Esc still deselects).
 */
function useStudioShortcuts() {
  const studio = useStudio();
  const ref = React.useRef(studio);
  React.useEffect(() => {
    ref.current = studio;
  });
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const s = ref.current;
      const mod = event.metaKey || event.ctrlKey;
      const inField = editable(event.target);
      if (event.key === 'Escape') {
        if (s.fullPreview) s.setFullPreview(false);
        else if (!inField) s.select(null);
        return;
      }
      if (mod && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent('studio:palette'));
        return;
      }
      if (inField) return;
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) s.editor.redo();
        else s.editor.undo();
        return;
      }
      if (mod && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        s.editor.redo();
        return;
      }
      if (mod && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void s.session.flush();
        return;
      }
      if (mod && event.key.toLowerCase() === 'd' && s.selectedId) {
        event.preventDefault();
        s.duplicateSection(s.selectedId);
        return;
      }
      if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown') && s.selectedId) {
        event.preventDefault();
        s.stepSection(s.selectedId, event.key === 'ArrowUp' ? -1 : 1);
        return;
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && s.selectedId && !mod) {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent('studio:delete', { detail: s.selectedId }));
        return;
      }
      if (event.key === '/' && !mod) {
        event.preventDefault();
        s.openGallery(s.selectedId);
        return;
      }
      if (event.key.toLowerCase() === 'p' && !mod && !event.altKey) {
        event.preventDefault();
        s.setFullPreview(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
