'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  Check,
  CloudOff,
  History,
  Loader2,
  Maximize2,
  Monitor,
  Pause,
  Redo2,
  Send,
  Share2,
  Smartphone,
  Tablet,
  Undo2,
} from 'lucide-react';
import { toast } from 'sonner';
import { studioFetch } from '@/lib/events/editor/api';
import {
  DEFAULT_PREVIEW_TAGS,
  previewLabel,
  type PreviewChoice,
} from '@/lib/events/editor/preview';
import { publishDiff } from '@/lib/events/editor/publish';
import { cn } from '@/lib/util/cn';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/form';
import { HistoryDrawer } from './history-drawer';
import { PresenceAvatars } from './presence-avatars';
import { PublishDialog } from './publish-dialog';
import { useEditorRevision, useStudio, type Device } from './studio-context';

const SAVE_TEXT = {
  saved: 'Saved',
  saving: 'Saving…',
  offline: 'Offline – changes kept',
  conflict: 'Conflict',
  paused: 'Paused – changes kept',
  error: 'Not saved',
} as const;

function SaveState() {
  const { sessionState, editor } = useStudio();
  useEditorRevision(editor);
  const state = sessionState.save;
  const icon =
    state === 'saved' ? (
      <Check aria-hidden="true" className="size-3.5" />
    ) : state === 'saving' ? (
      <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
    ) : state === 'offline' ? (
      <CloudOff aria-hidden="true" className="size-3.5" />
    ) : state === 'paused' ? (
      <Pause aria-hidden="true" className="size-3.5" />
    ) : (
      <AlertTriangle aria-hidden="true" className="size-3.5" />
    );
  return (
    <span
      role="status"
      aria-live="polite"
      data-save-state={state}
      title={sessionState.saveMessage ?? undefined}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs',
        state === 'saved' && 'text-[var(--fg-muted)]',
        (state === 'conflict' || state === 'error') && 'bg-[var(--danger-soft)] text-[var(--fg)]',
        (state === 'offline' || state === 'paused') && 'bg-[var(--warn-soft)] text-[var(--fg)]',
      )}
    >
      {icon}
      {SAVE_TEXT[state]}
    </span>
  );
}

const DEVICES: { id: Device; label: string; icon: React.ReactNode }[] = [
  { id: 'desktop', label: 'Desktop (1280)', icon: <Monitor aria-hidden="true" /> },
  { id: 'tablet', label: 'Tablet (768)', icon: <Tablet aria-hidden="true" /> },
  { id: 'phone', label: 'Phone (390)', icon: <Smartphone aria-hidden="true" /> },
  { id: 'fit', label: 'Fit to window', icon: <Maximize2 aria-hidden="true" /> },
];

function encodePreview(choice: PreviewChoice): string {
  switch (choice.kind) {
    case 'tag':
      return `tag:${choice.tag}`;
    case 'guest':
      return `guest:${choice.guestId}`;
    default:
      return choice.kind;
  }
}

function decodePreview(value: string): PreviewChoice {
  if (value.startsWith('tag:')) return { kind: 'tag', tag: value.slice(4) };
  if (value.startsWith('guest:')) return { kind: 'guest', guestId: value.slice(6) };
  if (value === 'public' || value === 'sample' || value === 'going') return { kind: value };
  return { kind: 'studio' };
}

export function TopBar() {
  const studio = useStudio();
  const { boot, editor, doc } = studio;
  useEditorRevision(editor);
  const [publishOpen, setPublishOpen] = React.useState(false);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [reviewBusy, setReviewBusy] = React.useState(false);

  const changes = React.useMemo(
    () =>
      studio.publishedDoc ? publishDiff(studio.publishedDoc, doc, studio.labelOf).length : null,
    [studio.publishedDoc, doc, studio.labelOf],
  );

  const tags = [...new Set([...DEFAULT_PREVIEW_TAGS, ...boot.tags])];

  async function readyForReview() {
    if (!boot.endpoints.review) return;
    setReviewBusy(true);
    await studio.session.flush();
    const response = await studioFetch(boot.endpoints.review, { method: 'POST', json: {} });
    setReviewBusy(false);
    if (response.ok) toast.success('TipTop has been told your changes are ready for review.');
    else toast.error(response.error.message);
  }

  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-[var(--border)] bg-[var(--bg-raised)] px-3 py-2">
      <div className="flex min-w-0 flex-1 basis-60 items-center gap-2">
        {boot.backHref ? (
          <Link
            href={boot.backHref}
            className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-sm text-[var(--fg-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]"
          >
            <ArrowLeft aria-hidden="true" className="size-4" />
            <span>Events</span>
          </Link>
        ) : null}
        <h1 className="min-w-0 truncate font-serif text-lg font-semibold">{boot.title}</h1>
        <SaveState />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <PresenceAvatars />
        <span className="flex items-center">
          <Button
            variant="ghost"
            size="icon"
            aria-label={editor.undoLabel ? `Undo ${editor.undoLabel}` : 'Undo'}
            title="Undo (Ctrl+Z)"
            disabled={!editor.canUndo || studio.readOnly}
            onClick={() => editor.undo()}
          >
            <Undo2 />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={editor.redoLabel ? `Redo ${editor.redoLabel}` : 'Redo'}
            title="Redo (Shift+Ctrl+Z)"
            disabled={!editor.canRedo || studio.readOnly}
            onClick={() => editor.redo()}
          >
            <Redo2 />
          </Button>
        </span>

        <div role="group" aria-label="Device" className="hidden items-center sm:flex">
          {DEVICES.map((d) => (
            <Button
              key={d.id}
              variant="ghost"
              size="icon"
              aria-label={d.label}
              aria-pressed={studio.device === d.id}
              title={d.label}
              className={cn(studio.device === d.id && 'bg-[var(--bg-hover)] text-[var(--fg)]')}
              onClick={() => studio.setDevice(d.id)}
            >
              {d.icon}
            </Button>
          ))}
        </div>

        <label className="sr-only" htmlFor="studio-motion">
          Motion preview
        </label>
        <Select
          id="studio-motion"
          className="h-8 w-auto text-xs"
          value={studio.motion}
          onChange={(e) => studio.setMotion(e.target.value as typeof studio.motion)}
        >
          <option value="full">Motion: full</option>
          <option value="reduced">Motion: reduced</option>
          <option value="off">Motion: off</option>
        </Select>

        <label className="sr-only" htmlFor="studio-preview-as">
          Preview as
        </label>
        <Select
          id="studio-preview-as"
          className="h-8 w-auto max-w-48 text-xs"
          value={encodePreview(studio.preview)}
          onChange={(e) => studio.setPreview(decodePreview(e.target.value))}
        >
          <option value="studio">Preview as: everything</option>
          <option value="public">Public visitor</option>
          <option value="sample">Invited guest (Sarah)</option>
          {boot.guests.slice(0, 50).map((g) => (
            <option key={g.id} value={`guest:${g.id}`}>
              {previewLabel({ kind: 'guest', guestId: g.id }, boot.guests)}
            </option>
          ))}
          <option value="going">Going guest</option>
          {tags.map((tag) => (
            <option key={tag} value={`tag:${tag}`}>
              Going · {tag}
            </option>
          ))}
        </Select>

        <Button
          variant="ghost"
          size="sm"
          onClick={() => studio.setFullPreview(true)}
          title="Full-screen preview (P)"
        >
          Preview
        </Button>

        {boot.capabilities.viewHistory ? (
          <Button variant="ghost" size="sm" onClick={() => setHistoryOpen(true)}>
            <History aria-hidden="true" />
            History
          </Button>
        ) : null}
        {boot.shareHref ? (
          <Button variant="ghost" size="sm" asChild>
            <Link href={boot.shareHref}>
              <Share2 aria-hidden="true" />
              Share
            </Link>
          </Button>
        ) : null}
        {boot.capabilities.publish ? (
          <Button variant="primary" size="sm" onClick={() => setPublishOpen(true)}>
            <Send aria-hidden="true" />
            Publish
            {changes ? (
              <span
                className="rounded-full bg-[var(--primary-fg)] px-1.5 text-[11px] text-[var(--primary)]"
                aria-label={`${changes} changes since publishing`}
              >
                {changes}
              </span>
            ) : null}
          </Button>
        ) : boot.endpoints.review && boot.actor.role === 'editor' ? (
          <Button
            variant="primary"
            size="sm"
            loading={reviewBusy}
            disabled={studio.readOnly}
            onClick={() => void readyForReview()}
          >
            <BadgeCheck aria-hidden="true" />
            Ready for review
          </Button>
        ) : null}
      </div>
      {publishOpen ? <PublishDialog open onOpenChange={setPublishOpen} /> : null}
      {historyOpen ? <HistoryDrawer open onOpenChange={setHistoryOpen} /> : null}
    </header>
  );
}
