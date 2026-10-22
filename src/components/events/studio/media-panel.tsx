'use client';

import * as React from 'react';
import { Upload } from 'lucide-react';
import { toast } from 'sonner';
import type { ResolvedMedia } from '@/lib/events/contracts';
import { studioFetch, withMediaId } from '@/lib/events/editor/api';
import { mediaIdsInDoc, type StudioMediaItem } from '@/lib/events/editor/publish';
import { cn } from '@/lib/util/cn';
import { Button } from '@/components/ui/button';
import { Input, Switch } from '@/components/ui/form';
import { useStudio } from './studio-context';

const ACCEPT = 'image/jpeg,image/png,image/webp,image/avif,image/gif,video/mp4,video/webm';
const MAX_BYTES = 50 * 1024 * 1024;

interface UploadTicket {
  mediaId: string;
  uploadUrl: string;
  token?: string;
}

/**
 * The event's media: upload straight to storage (WS1's signed upload URL,
 * then processing: re-encoded, EXIF and GPS stripped), alt text, the
 * decorative toggle, and each file's processing status. SVG and HEIC are
 * refused here. Media is placed on the page by id from the inspector.
 */
export function MediaPanel() {
  const studio = useStudio();
  const { boot, mediaItems, setMediaItems, addMedia } = studio;
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const used = new Set(mediaIdsInDoc(studio.doc));
  const canUpload =
    boot.capabilities.uploadMedia && Boolean(boot.endpoints.mediaUploadUrl) && !studio.readOnly;
  const canEdit =
    (boot.capabilities.editContent || boot.capabilities.editDesign) && !studio.readOnly;

  async function upload(file: File) {
    if (!boot.endpoints.mediaUploadUrl || !boot.endpoints.mediaProcess) return;
    if (/svg/i.test(file.type) || /\.svg$/i.test(file.name)) {
      toast.error('SVG files cannot be used on event pages. Export it as PNG first.');
      return;
    }
    if (/heic|heif/i.test(file.type) || /\.(heic|heif)$/i.test(file.name)) {
      toast.error('HEIC photos are not supported. Export it as JPEG first (Share → Save as JPEG).');
      return;
    }
    if (file.size > MAX_BYTES) {
      toast.error('That file is over 50 MB.');
      return;
    }
    const kind = file.type.startsWith('video/') ? 'video' : 'image';
    setBusy(file.name);
    const ticket = await studioFetch<{ ticket?: UploadTicket } & Partial<UploadTicket>>(
      boot.endpoints.mediaUploadUrl,
      {
        method: 'POST',
        json: { kind, contentType: file.type, bytes: file.size, name: file.name.slice(0, 200) },
      },
    );
    if (!ticket.ok) {
      setBusy(null);
      toast.error(
        ticket.status === 404 ? 'Media uploads are still being built.' : ticket.error.message,
      );
      return;
    }
    const t = (ticket.value.ticket ?? ticket.value) as UploadTicket;
    try {
      const put = await fetch(t.uploadUrl, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type, 'x-upsert': 'false' },
      });
      if (!put.ok) throw new Error(String(put.status));
    } catch {
      setBusy(null);
      toast.error('The upload did not finish. Try again.');
      return;
    }
    setMediaItems((items) => [
      ...items,
      {
        id: t.mediaId,
        kind,
        status: 'uploaded',
        alt: null,
        decorative: false,
        name: file.name,
        colors: [],
        previewUrl: null,
      },
    ]);
    const processed = await studioFetch<{ media: ResolvedMedia | null }>(
      withMediaId(boot.endpoints.mediaProcess, t.mediaId),
      { method: 'POST', json: {} },
    );
    setBusy(null);
    if (processed.ok) {
      const done = processed.value.media;
      setMediaItems((items) =>
        items.map((m) =>
          m.id === t.mediaId
            ? {
                ...m,
                status: done?.status ?? 'ready',
                alt: done?.alt ?? m.alt,
                decorative: done?.decorative ?? m.decorative,
                colors: done?.colors ?? m.colors,
                previewUrl: done?.src ?? done?.posterUrl ?? null,
              }
            : m,
        ),
      );
      if (done) addMedia(done);
      toast.success('Ready to use. Add alt text so everyone can follow the page.');
    } else {
      setMediaItems((items) =>
        items.map((m) => (m.id === t.mediaId ? { ...m, status: 'failed' } : m)),
      );
      toast.error(processed.error.message);
    }
  }

  async function patch(
    item: StudioMediaItem,
    change: { alt?: string | null; decorative?: boolean },
  ) {
    if (!boot.endpoints.mediaPatch) return;
    setMediaItems((items) => items.map((m) => (m.id === item.id ? { ...m, ...change } : m)));
    const response = await studioFetch(withMediaId(boot.endpoints.mediaPatch, item.id), {
      method: 'PATCH',
      json: change,
    });
    if (!response.ok) {
      toast.error(
        response.status === 404 ? 'Media editing is still being built.' : response.error.message,
      );
    }
  }

  return (
    <div className="space-y-3 p-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Media</h2>
        {canUpload ? (
          <>
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPT}
              className="sr-only"
              aria-label="Choose a photo or video"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void upload(file);
              }}
            />
            <Button size="sm" loading={busy !== null} onClick={() => inputRef.current?.click()}>
              <Upload aria-hidden="true" />
              Upload
            </Button>
          </>
        ) : null}
      </div>
      {busy ? <p className="text-xs text-[var(--fg-muted)]">Uploading {busy}…</p> : null}
      {boot.mediaNote ? <p className="text-xs text-[var(--fg-muted)]">{boot.mediaNote}</p> : null}
      {mediaItems.length === 0 ? (
        <p className="text-xs text-[var(--fg-muted)]">
          No photos or videos yet. Uploads stay in this event&apos;s storage, re-encoded with
          location data removed.
        </p>
      ) : null}
      <ul aria-label="Media library" className="space-y-2">
        {mediaItems.map((item) => (
          <MediaRow
            key={item.id}
            item={item}
            used={used.has(item.id)}
            canEdit={canEdit}
            onPatch={(change) => void patch(item, change)}
          />
        ))}
      </ul>
    </div>
  );
}

function MediaRow({
  item,
  used,
  canEdit,
  onPatch,
}: {
  item: StudioMediaItem;
  used: boolean;
  canEdit: boolean;
  onPatch: (change: { alt?: string | null; decorative?: boolean }) => void;
}) {
  const [alt, setAlt] = React.useState(item.alt ?? '');
  const needsAlt =
    (item.kind === 'image' || item.kind === 'logo') && !item.decorative && !alt.trim();
  return (
    <li className="rounded-md border border-[var(--border)] p-2">
      <div className="flex items-start gap-2">
        {item.previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- an event-media URL, not a page asset
          <img src={item.previewUrl} alt="" className="size-12 shrink-0 rounded object-cover" />
        ) : (
          <span
            aria-hidden="true"
            className="flex size-12 shrink-0 items-center justify-center rounded bg-[var(--bg-sunken)] text-[10px] text-[var(--fg-muted)] uppercase"
          >
            {item.kind}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium">
            {item.name ?? `${item.kind} ${item.id.slice(0, 6)}`}
          </p>
          <p className="text-[11px] text-[var(--fg-muted)]">
            <span
              className={cn(
                item.status === 'failed' && 'text-[var(--danger)]',
                item.status === 'uploaded' && 'text-[var(--warn)]',
              )}
            >
              {item.status === 'ready'
                ? 'Ready'
                : item.status === 'uploaded'
                  ? 'Processing…'
                  : 'Failed'}
            </span>
            {used ? ' · on the page' : ''}
          </p>
        </div>
      </div>
      {item.kind !== 'video' && item.kind !== 'file' ? (
        <div className="mt-2 space-y-1.5">
          <label className="sr-only" htmlFor={`alt-${item.id}`}>
            Alt text
          </label>
          <Input
            id={`alt-${item.id}`}
            placeholder={
              item.decorative ? 'Decorative: no alt text needed' : 'Describe it for screen readers'
            }
            value={alt}
            maxLength={500}
            disabled={!canEdit || item.decorative}
            aria-invalid={needsAlt || undefined}
            onChange={(e) => setAlt(e.target.value)}
            onBlur={() => {
              if (alt !== (item.alt ?? '')) onPatch({ alt: alt.trim() || null });
            }}
            className="h-8 text-xs"
          />
          <label className="flex items-center justify-between gap-2 text-[11px]">
            Decorative (no alt text)
            <Switch
              checked={item.decorative}
              disabled={!canEdit}
              onCheckedChange={(checked) => onPatch({ decorative: checked })}
            />
          </label>
          {needsAlt && used ? (
            <p className="text-[11px] text-[var(--danger)]">Needs alt text before publishing.</p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
