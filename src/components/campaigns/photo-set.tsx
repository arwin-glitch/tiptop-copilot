'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { ImageIcon, Trash2, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Select } from '@/components/ui/form';
import { MAX_ATTACHMENT_BYTES, UPLOAD_CHUNK_BYTES, formatBytes } from '@/lib/campaigns/limits';
import {
  MAX_PHOTO_BYTES,
  PHOTO_ACCEPT,
  isPhotoName,
  type CampaignPhotoView,
  type PhotoUploadOutcome,
} from '@/lib/campaigns/photos';
import { campaignCall, jsonBody } from './campaign-api';

/** Someone a photo can be given to. */
export interface PhotoRecipient {
  id: string;
  label: string;
  photoId: string | null;
}

/** Photos listed before "Show all": the set is a list to check, not a page to scroll. */
const SHOWN = 12;

/**
 * The campaign's photos, one per person: upload them (matched to people by
 * file name as each lands), see who got which, give the unmatched ones out by
 * hand, or take one away. Every change answers with the whole set, and the
 * recipient rows above follow on the next refresh.
 */
export function PhotoSet({
  campaignId,
  photos: initial,
  recipients,
  sharedBytes,
  onChange,
  onBusy,
}: {
  campaignId: string;
  photos: CampaignPhotoView[];
  recipients: PhotoRecipient[];
  /** What the shared attachments already put on every email. */
  sharedBytes: number;
  onChange: () => void;
  /** Tells the composer an upload is under way, so it holds the next step until it lands. */
  onBusy: (what: string | null) => void;
}) {
  // The latest set: from the server's answer to a change here, until the
  // page's own copy (refreshed after it) arrives.
  const [held, setHeld] = React.useState({ source: initial, photos: initial });
  let photos = held.photos;
  if (held.source !== initial) {
    setHeld({ source: initial, photos: initial });
    photos = initial;
  }
  const setPhotos = (next: CampaignPhotoView[]) => setHeld({ source: initial, photos: next });

  const [uploading, setUploading] = React.useState<{ name: string; done: number } | null>(null);
  const [working, setWorking] = React.useState<string | null>(null);
  const [showAll, setShowAll] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const abort = React.useRef<AbortController | null>(null);

  React.useEffect(
    () => () => {
      abort.current?.abort();
      abort.current = null;
      onBusy(null);
    },
    [onBusy],
  );

  const unmatched = photos.filter((p) => !p.recipients.length);
  const free = recipients.filter((r) => !r.photoId);
  const shown = showAll ? photos : photos.slice(0, SHOWN);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    const controller = new AbortController();
    abort.current = controller;
    onBusy('the photo upload');
    const outcomes: PhotoUploadOutcome[] = [];
    for (const file of Array.from(files)) {
      if (controller.signal.aborted) break;
      if (!isPhotoName(file.name)) {
        toast.error(`${file.name} is not a photo. Use JPG, PNG, GIF, WebP or HEIC files.`);
        continue;
      }
      if (file.size > MAX_PHOTO_BYTES) {
        toast.error(`${file.name} is over ${formatBytes(MAX_PHOTO_BYTES)}.`);
        continue;
      }
      if (sharedBytes + file.size > MAX_ATTACHMENT_BYTES) {
        toast.error(
          `With the shared attachments, ${file.name} would take an email over ${formatBytes(MAX_ATTACHMENT_BYTES)}.`,
        );
        continue;
      }
      const uploadId = crypto.randomUUID();
      const count = Math.max(1, Math.ceil(file.size / UPLOAD_CHUNK_BYTES));
      let failed: string | null = null;
      for (let index = 0; index < count && !failed; index++) {
        if (controller.signal.aborted) break;
        setUploading({ name: file.name, done: Math.round((index / count) * 100) });
        const r = await campaignCall<{
          complete: boolean;
          photos?: CampaignPhotoView[];
          outcome?: PhotoUploadOutcome;
        }>(`/api/campaigns/${campaignId}/photos`, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/octet-stream',
            'x-upload-id': uploadId,
            'x-chunk-index': String(index),
            'x-chunk-count': String(count),
            'x-file-name': encodeURIComponent(file.name),
            'x-file-type': file.type || 'application/octet-stream',
            'x-file-size': String(file.size),
          },
          body: file.slice(index * UPLOAD_CHUNK_BYTES, (index + 1) * UPLOAD_CHUNK_BYTES),
        });
        if (controller.signal.aborted) break;
        if (!r.ok) failed = r.message;
        else if (r.data.complete) {
          if (r.data.photos) setPhotos(r.data.photos);
          if (r.data.outcome) outcomes.push(r.data.outcome);
        }
      }
      if (failed) toast.error(failed);
    }
    if (controller.signal.aborted) return;
    abort.current = null;
    setUploading(null);
    onBusy(null);
    if (inputRef.current) inputRef.current.value = '';
    if (outcomes.length) {
      const matched = outcomes.filter((o) => o.matchedTo);
      const left = outcomes.length - matched.length;
      toast.success(
        `${outcomes.length} ${outcomes.length === 1 ? 'photo' : 'photos'} added: ${matched.length} matched${
          matched.length
            ? ` (${matched
                .slice(0, 3)
                .map((o) => o.matchedTo)
                .join(', ')}${matched.length > 3 ? ', …' : ''})`
            : ''
        }${left ? `, ${left} not matched: pick who gets ${left === 1 ? 'it' : 'them'} below` : ''}.`,
      );
    }
    onChange();
  };

  const change = async (what: string, run: () => Promise<boolean>) => {
    setWorking(what);
    onBusy('the photo change');
    const done = await run();
    setWorking(null);
    onBusy(null);
    if (done) onChange();
  };

  const assign = (photoId: string, recipientId: string) =>
    change(photoId, async () => {
      const r = await campaignCall<{ photos: CampaignPhotoView[] }>(
        `/api/campaigns/${campaignId}/photos`,
        jsonBody('PATCH', { recipientId, photoId }),
      );
      if (!r.ok) {
        toast.error(r.message);
        return false;
      }
      setPhotos(r.data.photos);
      return true;
    });

  const remove = (photoId: string) =>
    change(photoId, async () => {
      const r = await campaignCall<{ photos: CampaignPhotoView[] }>(
        `/api/campaigns/${campaignId}/photos?photo=${encodeURIComponent(photoId)}`,
        { method: 'DELETE' },
      );
      if (!r.ok) {
        toast.error(r.message);
        return false;
      }
      setPhotos(r.data.photos);
      return true;
    });

  const match = () =>
    change('match', async () => {
      const r = await campaignCall<{ matched: number; photos: CampaignPhotoView[] }>(
        `/api/campaigns/${campaignId}/photos`,
        jsonBody('PATCH', { match: true }),
      );
      if (!r.ok) {
        toast.error(r.message);
        return false;
      }
      setPhotos(r.data.photos);
      toast.success(
        r.data.matched
          ? `Matched ${r.data.matched} ${r.data.matched === 1 ? 'photo' : 'photos'} by file name.`
          : 'No more photos match anyone by file name.',
      );
      return true;
    });

  return (
    <Card>
      <CardContent className="space-y-3 pt-4">
        <section aria-labelledby="campaign-photos-heading" className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="campaign-photos-heading" className="font-serif text-base font-semibold">
              Photos, one per person{' '}
              <span className="text-sm font-normal text-[var(--fg-muted)]">(optional)</span>
            </h2>
            <span className="text-xs text-[var(--fg-muted)]">
              {photos.length} {photos.length === 1 ? 'photo' : 'photos'}
              {unmatched.length ? `, ${unmatched.length} not matched` : ''}
            </span>
          </div>
          <p className="text-xs text-[var(--fg-muted)]">
            Each person&rsquo;s email carries their own photo as an attachment, beside any shared
            ones. Name files after the person (Jane Doe.jpg, jane_doe.png or jane@acme.example.jpg)
            and they are matched as they upload; a name that fits nobody, or two people, waits for
            you to pick. Up to {formatBytes(MAX_PHOTO_BYTES)} each.
          </p>
          {photos.length ? (
            <ul aria-label="Photos" className="space-y-2">
              {shown.map((p) => (
                <li
                  key={p.id}
                  className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--border)] px-2.5 py-2 text-sm"
                >
                  <ImageIcon
                    className="size-4 shrink-0 text-[var(--fg-subtle)]"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
                  <span className="text-xs text-[var(--fg-subtle)]">{formatBytes(p.size)}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${p.name}`}
                    loading={working === p.id}
                    disabled={uploading !== null || working !== null}
                    onClick={() => void remove(p.id)}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                  <div className="basis-full text-xs">
                    {p.recipients.length ? (
                      <span className="text-[var(--ok)]">
                        For {p.recipients.map((r) => r.label).join(', ')}
                      </span>
                    ) : (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[var(--warn)]">Not matched. {p.unmatched}</span>
                        {free.length ? (
                          <Select
                            aria-label={`Who gets ${p.name}`}
                            value=""
                            disabled={uploading !== null || working !== null}
                            onChange={(e) => {
                              if (e.target.value) void assign(p.id, e.target.value);
                            }}
                            className="h-8 w-auto max-w-60 text-xs"
                          >
                            <option value="">Give it to…</option>
                            {free.map((r) => (
                              <option key={r.id} value={r.id}>
                                {r.label}
                              </option>
                            ))}
                          </Select>
                        ) : null}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
          {photos.length > shown.length ? (
            <Button variant="link" size="sm" className="px-0" onClick={() => setShowAll(true)}>
              Show all {photos.length}
            </Button>
          ) : null}
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={PHOTO_ACCEPT}
            className="sr-only"
            id="campaign-photos"
            aria-label="Add photos"
            tabIndex={-1}
            onChange={(e) => void upload(e.target.files)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              loading={uploading !== null}
              disabled={working !== null}
              onClick={() => inputRef.current?.click()}
            >
              {uploading ? null : <ImageIcon aria-hidden="true" />}
              {uploading ? `Uploading ${uploading.name} (${uploading.done}%)` : 'Add photos'}
            </Button>
            {unmatched.length && free.length ? (
              <Button
                variant="ghost"
                size="sm"
                loading={working === 'match'}
                disabled={uploading !== null || working !== null}
                onClick={() => void match()}
              >
                {working === 'match' ? null : <Wand2 aria-hidden="true" />}
                Match by file name
              </Button>
            ) : null}
          </div>
        </section>
      </CardContent>
    </Card>
  );
}
