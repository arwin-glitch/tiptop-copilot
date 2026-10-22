import 'server-only';
import { z } from 'zod';
import type { DataStore } from '@/lib/db/store';
import {
  actorKey,
  actorOrganizationId,
  type EventActor,
  type EventViewer,
  type MediaMap,
  type ResolvedMedia,
  type ResolvedMediaVariant,
} from '@/lib/events/contracts';
import { ImageRefused, processImage, sniff } from '@/lib/events/media-process';
import { scrubVideoMetadata } from '@/lib/events/video-meta';
import type { EventDoc } from '@/lib/events/schema';
import { recordAudit } from '@/lib/security/audit';
import { log } from '@/lib/security/redact';
import { normalizeMimeType } from '@/lib/storage/allowed-types';
import {
  absoluteUrl,
  getEventStorage,
  type EventBucket,
  type EventStorage,
} from '@/lib/storage/event-storage';
import type {
  EventMedia,
  EventMediaKind,
  EventMediaVariant,
  EventRecord,
} from '@/lib/types/domain';
import { newId, sha256 } from '@/lib/util/hash';
import { err, ok, type Result } from '@/lib/util/result';
import { auditUserId, capabilitiesFor, cleanText, guard, notFound } from './event-access';

/**
 * Event media (D-075).
 *
 * Pipeline: the browser asks for a signed upload URL (createUploadUrl) and
 * PUTs the original straight to the private event-originals bucket; then
 * asks to process it (processMedia). Processing reads the bytes back, decides
 * what the file IS from its bytes, and for images re-encodes with sharp
 * (lib/events/media-process.ts): rotate() (which also strips EXIF/GPS), AVIF +
 * WebP at 640/1080/1920, a JPEG/PNG fallback, a thumbhash and the top five
 * colours. Derivatives of UNGATED media go to the public event-media bucket
 * under content-hashed paths; GATED media stays private and is served as
 * 15-minute signed URLs. Videos (MP4/WebM) are stored as uploaded after a
 * byte check, with a poster image linked from a separate upload; files
 * (PDF/PPTX/DOCX, the Materials block) never leave the private bucket.
 *
 * Pages reference media by id. resolveMedia turns the ids a (viewer-filtered)
 * document references into URLs; the renderer never sees a storage path.
 *
 * Outside editors may upload within their link (20 an hour per link, 200 MB
 * a day per event across links), never gated media or files.
 */

export interface UploadTicket {
  mediaId: string;
  /**
   * Where the browser PUTs the raw file: `fetch(uploadUrl, { method: 'PUT',
   * body: file, headers: { 'Content-Type': file.type } })`. A Supabase signed
   * upload URL in production; /api/event-media/upload in demo mode.
   */
  uploadUrl: string;
  /** The token the upload must carry (already inside uploadUrl). */
  token: string;
  path: string;
  maxBytes: number;
}

/** What each kind accepts (declared type at ticket time; bytes re-checked when processed). */
export const MEDIA_KIND_RULES: Record<
  EventMediaKind,
  { types: readonly string[]; maxBytes: number }
> = {
  image: {
    types: ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'],
    maxBytes: 25 * 1024 * 1024,
  },
  logo: {
    types: ['image/png', 'image/webp', 'image/jpeg', 'image/avif'],
    maxBytes: 10 * 1024 * 1024,
  },
  // The public bucket's 30 MB cap: a video is stored as uploaded.
  video: { types: ['video/mp4', 'video/webm'], maxBytes: 30 * 1024 * 1024 },
  file: {
    types: [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
    maxBytes: 50 * 1024 * 1024,
  },
};

export const GRANT_UPLOADS_PER_HOUR = 20;
export const GRANT_BYTES_PER_DAY = 200 * 1024 * 1024;
/** Gated media and files: 15-minute signed URLs. */
export const SIGNED_URL_SECONDS = 15 * 60;
const UPLOAD_URL_SECONDS = 2 * 60 * 60;

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

const uploadInput = z.object({
  kind: z.enum(['image', 'video', 'logo', 'file']),
  contentType: z.string().max(120),
  bytes: z.number().int().min(1),
  name: z.string().max(400),
  gated: z.boolean().optional(),
  /** Measured by the browser for videos (sharp cannot read video). */
  width: z.number().int().min(1).max(16_384).optional(),
  height: z.number().int().min(1).max(16_384).optional(),
  durationMs: z
    .number()
    .int()
    .min(0)
    .max(6 * 60 * 60 * 1000)
    .optional(),
});

function refuse<T>(message: string): Result<T> {
  return err('forbidden', message);
}

function bucketOf(media: Pick<EventMedia, 'gated' | 'kind'>): EventBucket {
  return media.gated || media.kind === 'file' ? 'private' : 'public';
}

/** A file name to keep as a label: no folders, no control characters. */
function cleanName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  return cleanText(base, 255) || 'upload';
}

async function loadEvent(
  store: DataStore,
  organizationId: string,
  eventId: string,
): Promise<EventRecord | null> {
  return store.get('events', organizationId, eventId);
}

async function loadMedia(
  store: DataStore,
  organizationId: string,
  eventId: string,
  mediaId: string,
): Promise<EventMedia | null> {
  const media = await store.get('event_media', organizationId, mediaId);
  return media && media.event_id === eventId ? media : null;
}

/* ----------------------------------------------------------------- upload */

export async function createUploadUrl(
  store: DataStore,
  actor: EventActor,
  eventId: string,
  input: {
    kind: EventMediaKind;
    contentType: string;
    bytes: number;
    name: string;
    gated?: boolean;
    width?: number;
    height?: number;
    durationMs?: number;
  },
): Promise<Result<UploadTicket>> {
  const caps = capabilitiesFor(actor, eventId);
  if (!caps.ok) return caps;
  if (!caps.value.uploadMedia) return refuse('Your link does not allow uploads.');
  const parsed = uploadInput.safeParse(input);
  if (!parsed.success) return err('invalid_input', 'That upload could not be read.');
  const req = parsed.data;
  if (actor.kind !== 'owner' && (req.gated || req.kind === 'file')) {
    return refuse('Only TipTop can add gated media or files.');
  }
  const contentType = normalizeMimeType(req.contentType);
  if (contentType === 'image/heic' || contentType === 'image/heif') {
    return err(
      'unsupported_media_type',
      'HEIC photos are converted before upload. Save it as JPEG and try again.',
    );
  }
  if (contentType === 'image/svg+xml') {
    return err('unsupported_media_type', 'SVG files are not accepted. Upload a PNG instead.');
  }
  if (contentType === 'video/quicktime') {
    return err('unsupported_media_type', 'Export the video as MP4 and try again.');
  }
  const rules = MEDIA_KIND_RULES[req.kind];
  if (!rules.types.includes(contentType)) {
    return err('unsupported_media_type', `That file type is not accepted for ${req.kind}s.`);
  }
  if (req.bytes > rules.maxBytes) {
    return err('too_large', `That file is over ${Math.round(rules.maxBytes / 1024 / 1024)} MB.`);
  }
  const organizationId = actorOrganizationId(actor);
  const key = actorKey(actor);

  return guard(
    'createUploadUrl',
    async () => {
      const event = await loadEvent(store, organizationId, eventId);
      if (!event) return notFound();
      await sweepStaleUploads(store, organizationId, eventId);
      if (actor.kind === 'grant') {
        if (event.editing_paused)
          return refuse('Editing is paused. TipTop will reopen it when ready.');
        const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const recent = await store.count('event_media', organizationId, {
          eq: { event_id: eventId, created_by_actor: key },
          gte: { created_at: hourAgo },
        });
        if (recent >= GRANT_UPLOADS_PER_HOUR) {
          return err('rate_limited', 'That is a lot of uploads at once. Try again in an hour.');
        }
        const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const today = await store.list('event_media', organizationId, {
          eq: { event_id: eventId },
          gte: { created_at: dayAgo },
        });
        const used = today
          .filter((m) => m.created_by_actor.startsWith('g:'))
          .reduce((sum, m) => sum + (m.bytes ?? 0), 0);
        if (used + req.bytes > GRANT_BYTES_PER_DAY) {
          return err('rate_limited', 'Today’s upload allowance for this event is used up.');
        }
      }

      const mediaId = newId();
      const path = `${organizationId}/${eventId}/${mediaId}/original.${EXTENSIONS[contentType] ?? 'bin'}`;
      const ticket = await getEventStorage().signedUpload(path, {
        contentType,
        maxBytes: rules.maxBytes,
        expiresInSeconds: UPLOAD_URL_SECONDS,
      });
      if (!ticket.ok) return ticket;

      const now = new Date().toISOString();
      const row: EventMedia = {
        id: mediaId,
        organization_id: organizationId,
        event_id: eventId,
        kind: req.kind,
        status: 'uploaded',
        original_path: path,
        original_name: cleanName(req.name),
        content_type: contentType,
        bytes: req.bytes,
        variants: [],
        poster_path: null,
        width: req.kind === 'video' ? (req.width ?? null) : null,
        height: req.kind === 'video' ? (req.height ?? null) : null,
        duration_ms: req.kind === 'video' ? (req.durationMs ?? null) : null,
        thumbhash: null,
        colors: [],
        alt: null,
        decorative: false,
        gated: req.kind === 'file' ? true : req.gated === true,
        error: null,
        created_by_actor: key,
        created_at: now,
        updated_at: now,
      };
      await store.insert('event_media', row);
      return ok({
        mediaId,
        uploadUrl: ticket.value.url,
        token: ticket.value.token,
        path,
        maxBytes: rules.maxBytes,
      });
    },
    { internal: 'That upload could not be prepared just now.' },
  );
}

/* ------------------------------------------------------------- processing */

interface Processed {
  variants: EventMediaVariant[];
  width: number | null;
  height: number | null;
  thumbhash: string | null;
  colors: string[];
  bytes: number;
}

class ProcessingRefused extends Error {}

/** Turn the stored original into derivatives in the media's bucket. */
async function derive(
  storage: EventStorage,
  media: EventMedia,
  original: Uint8Array,
): Promise<Processed> {
  const rules = MEDIA_KIND_RULES[media.kind];
  if (original.byteLength > rules.maxBytes) {
    throw new ProcessingRefused(
      `That file is over ${Math.round(rules.maxBytes / 1024 / 1024)} MB.`,
    );
  }
  const type = sniff(original);
  const bucket = bucketOf(media);
  const base = `${media.organization_id}/${media.event_id}/${sha256(original).slice(0, 40)}`;

  if (media.kind === 'image' || media.kind === 'logo') {
    let image;
    try {
      image = await processImage(original, { logo: media.kind === 'logo' });
    } catch (error) {
      if (error instanceof ImageRefused) throw new ProcessingRefused(error.message);
      throw error;
    }
    const variants: EventMediaVariant[] = [];
    for (const v of image.variants) {
      const path = `${base}.${v.w}.${v.format}`;
      const stored = await storage.put(bucket, path, v.data, v.contentType);
      if (!stored.ok) throw new ProcessingRefused('That image could not be stored just now.');
      variants.push({ w: v.w, format: v.format, path, bytes: v.data.byteLength });
    }
    return {
      variants,
      width: image.width,
      height: image.height,
      thumbhash: image.thumbhash,
      colors: image.colors,
      bytes: original.byteLength,
    };
  }

  if (media.kind === 'video') {
    if (type !== 'mp4' && type !== 'webm') {
      throw new ProcessingRefused('That file is not an MP4 or WebM video.');
    }
    // No transcoder here, so the location/device metadata phones write is
    // wiped in place before the file can reach the public bucket.
    const scrubbed = scrubVideoMetadata(original, type);
    if (!scrubbed.ok) throw new ProcessingRefused(scrubbed.reason);
    const path = `${base}.${media.width ?? 0}.${type}`;
    const stored = await storage.put(bucket, path, scrubbed.bytes, `video/${type}`);
    if (!stored.ok) throw new ProcessingRefused('That video could not be stored just now.');
    return {
      variants: [{ w: media.width ?? 0, format: type, path, bytes: original.byteLength }],
      width: media.width,
      height: media.height,
      thumbhash: null,
      colors: [],
      bytes: original.byteLength,
    };
  }

  // Files (Materials): checked, never re-encoded, never public.
  const declared = media.content_type ?? '';
  const format = EXTENSIONS[declared];
  const matches =
    (format === 'pdf' && type === 'pdf') ||
    ((format === 'pptx' || format === 'docx') && type === 'zip');
  if (!matches || !format)
    throw new ProcessingRefused('That file is not the PDF, deck or document it says it is.');
  return {
    variants: [
      {
        w: 0,
        format: format as EventMediaVariant['format'],
        path: media.original_path,
        bytes: original.byteLength,
      },
    ],
    width: null,
    height: null,
    thumbhash: null,
    colors: [],
    bytes: original.byteLength,
  };
}

async function markFailed(store: DataStore, media: EventMedia, message: string) {
  await store.update('event_media', media.organization_id, media.id, {
    status: 'failed',
    error: message.slice(0, 500),
    updated_at: new Date().toISOString(),
  });
  // A refused original is never kept: it would only use up the storage plan.
  const removed = await getEventStorage().remove('private', [media.original_path]);
  if (!removed.ok) log.warn('Event media: a refused original could not be removed');
}

/** How far an upload may exceed the size its ticket declared (rounding, headers). */
const DECLARED_SLACK = 1.05;

/**
 * Uploads whose ticket ran out (2 hours) without being processed: the row and
 * any original that arrived are removed. Runs whenever a new upload starts.
 */
async function sweepStaleUploads(store: DataStore, organizationId: string, eventId: string) {
  const cutoff = new Date(Date.now() - UPLOAD_URL_SECONDS * 1000).toISOString();
  const stale = await store.list('event_media', organizationId, {
    eq: { event_id: eventId, status: 'uploaded' },
    lt: { created_at: cutoff },
  });
  if (!stale.length) return;
  await getEventStorage().remove(
    'private',
    stale.map((m) => m.original_path),
  );
  for (const m of stale) await store.remove('event_media', organizationId, m.id);
}

/** Process an uploaded original. Idempotent: a ready item comes back as it is. */
export async function processMedia(
  store: DataStore,
  actor: EventActor,
  eventId: string,
  mediaId: string,
): Promise<Result<EventMedia>> {
  const caps = capabilitiesFor(actor, eventId);
  if (!caps.ok) return caps;
  if (!caps.value.uploadMedia) return refuse('Your link does not allow uploads.');
  const organizationId = actorOrganizationId(actor);

  return guard(
    'processMedia',
    async () => {
      const event = await loadEvent(store, organizationId, eventId);
      if (!event) return notFound();
      if (actor.kind === 'grant' && event.editing_paused) {
        return refuse('Editing is paused. TipTop will reopen it when ready.');
      }
      const media = await loadMedia(store, organizationId, eventId, mediaId);
      if (!media) return err('not_found', 'That upload does not exist.');
      if (media.status === 'ready') return ok(media);

      const storage = getEventStorage();
      const original = await storage.get('private', media.original_path);
      if (!original.ok) {
        return err('not_found', 'The upload has not arrived yet. Try again in a moment.', {
          retryable: true,
        });
      }
      // An outside link is charged for what actually arrived, not what its
      // ticket declared: a file bigger than declared, or one that takes the
      // event past its daily allowance, is refused and deleted.
      if (actor.kind === 'grant') {
        const actual = original.value.byteLength;
        if (actual > (media.bytes ?? 0) * DECLARED_SLACK + 1024) {
          await markFailed(store, media, 'The file is bigger than it said it was.');
          return err('too_large', 'That file is bigger than it said it was. Upload it again.');
        }
        const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const today = await store.list('event_media', organizationId, {
          eq: { event_id: eventId },
          gte: { created_at: dayAgo },
        });
        const used = today
          .filter((m) => m.id !== media.id && m.created_by_actor.startsWith('g:'))
          .filter((m) => m.status !== 'failed')
          .reduce((sum, m) => sum + (m.bytes ?? 0), 0);
        if (used + actual > GRANT_BYTES_PER_DAY) {
          await markFailed(store, media, 'Today’s upload allowance for this event is used up.');
          return err('rate_limited', 'Today’s upload allowance for this event is used up.');
        }
      }
      let processed: Processed;
      try {
        processed = await derive(storage, media, original.value);
      } catch (error) {
        if (error instanceof ProcessingRefused) {
          await markFailed(store, media, error.message);
          return err('unsupported_media_type', error.message);
        }
        throw error;
      }
      const updated = await store.update('event_media', organizationId, media.id, {
        status: 'ready',
        error: null,
        bytes: processed.bytes,
        variants: processed.variants,
        width: processed.width,
        height: processed.height,
        thumbhash: processed.thumbhash,
        colors: processed.colors,
        updated_at: new Date().toISOString(),
      });
      await recordAudit(store, {
        organizationId,
        userId: auditUserId(actor),
        action: 'event.media_uploaded',
        entityType: 'event',
        entityId: eventId,
        metadata: {
          media: media.id,
          kind: media.kind,
          bytes: processed.bytes,
          gated: media.gated,
          by: actor.kind,
        },
      });
      return ok(updated);
    },
    { internal: 'That file could not be processed just now.' },
  );
}

/* ----------------------------------------------------------------- update */

/** Derivative objects a media row holds (in its bucket), not counting the original. */
function objectsOf(media: EventMedia): string[] {
  return media.variants.map((v) => v.path).filter((p) => p !== media.original_path);
}

/**
 * Remove the stored objects of some media rows, keeping any object a row
 * outside that set still uses (duplicated events share content-hashed
 * derivatives and originals; one photo uploaded twice shares derivatives).
 */
async function removeUnshared(
  store: DataStore,
  storage: EventStorage,
  organizationId: string,
  rows: EventMedia[],
  options: { includeOriginals: boolean },
): Promise<void> {
  if (!rows.length) return;
  const leaving = new Set(rows.map((m) => m.id));
  const others = (
    await store.list('event_media', organizationId, undefined, { limit: 5000 })
  ).filter((m) => !leaving.has(m.id));
  const used = new Set<string>();
  for (const m of others) {
    used.add(`private:${m.original_path}`);
    for (const v of m.variants) used.add(`${bucketOf(m)}:${v.path}`);
    if (m.poster_path) used.add(`${bucketOf(m)}:${m.poster_path}`);
  }
  const drop: Record<EventBucket, Set<string>> = { public: new Set(), private: new Set() };
  for (const m of rows) {
    const bucket = bucketOf(m);
    for (const p of objectsOf(m)) {
      if (!used.has(`${bucket}:${p}`)) drop[bucket].add(p);
    }
    if (options.includeOriginals && !used.has(`private:${m.original_path}`)) {
      drop.private.add(m.original_path);
    }
  }
  if (drop.public.size) await storage.remove('public', [...drop.public]);
  if (drop.private.size) await storage.remove('private', [...drop.private]);
}

const updateInput = z.object({
  alt: z.string().max(500).nullable().optional(),
  decorative: z.boolean().optional(),
  gated: z.boolean().optional(),
  /** Videos: an image of this event (processed, gated the same way) as the poster. */
  posterMediaId: z.string().uuid().nullable().optional(),
});

/**
 * Alt text, decorative, the poster of a video, and (owners only) gated.
 * Changing `gated` re-processes the original into the other bucket and
 * removes the old derivatives (a public copy may linger in CDN caches).
 */
export async function updateMedia(
  store: DataStore,
  actor: EventActor,
  eventId: string,
  mediaId: string,
  patch: {
    alt?: string | null;
    decorative?: boolean;
    gated?: boolean;
    posterMediaId?: string | null;
  },
): Promise<Result<EventMedia>> {
  const caps = capabilitiesFor(actor, eventId);
  if (!caps.ok) return caps;
  if (!caps.value.uploadMedia && !caps.value.editContent) {
    return refuse('Your link does not allow changing media.');
  }
  const parsed = updateInput.safeParse(patch);
  if (!parsed.success) return err('invalid_input', 'That change could not be read.');
  const input = parsed.data;
  if (input.gated !== undefined && actor.kind !== 'owner') {
    return refuse('Only TipTop can change who sees a file.');
  }
  const organizationId = actorOrganizationId(actor);

  return guard('updateMedia', async () => {
    const event = await loadEvent(store, organizationId, eventId);
    if (!event) return notFound();
    if (actor.kind === 'grant' && event.editing_paused) {
      return refuse('Editing is paused. TipTop will reopen it when ready.');
    }
    const media = await loadMedia(store, organizationId, eventId, mediaId);
    if (!media) return err('not_found', 'That upload does not exist.');

    const next: Partial<EventMedia> = { updated_at: new Date().toISOString() };
    if (input.alt !== undefined)
      next.alt = input.alt === null ? null : cleanText(input.alt, 500) || null;
    if (input.decorative !== undefined) next.decorative = input.decorative;

    if (input.posterMediaId !== undefined) {
      if (media.kind !== 'video') return err('invalid_input', 'Only a video has a poster.');
      if (input.posterMediaId === null) next.poster_path = null;
      else {
        const poster = await loadMedia(store, organizationId, eventId, input.posterMediaId);
        if (!poster || poster.kind !== 'image' || poster.status !== 'ready') {
          return err('invalid_input', 'Pick a processed image of this event as the poster.');
        }
        if (poster.gated !== media.gated) {
          return err('invalid_input', 'The poster must be gated the same way as the video.');
        }
        const best =
          poster.variants.find((v) => v.format === 'jpg') ??
          [...poster.variants].sort((a, b) => b.w - a.w).find((v) => v.format === 'webp');
        if (!best) return err('invalid_input', 'That image has no usable size yet.');
        next.poster_path = best.path;
      }
    }

    const storage = getEventStorage();
    if (input.gated !== undefined && input.gated !== media.gated) {
      if (media.kind === 'file') {
        return err(
          'invalid_input',
          'Files are always private and shown only to qualifying guests.',
        );
      }
      if (media.kind === 'video' && media.poster_path) next.poster_path = null;
      const moved: EventMedia = { ...media, gated: input.gated };
      if (media.status === 'ready') {
        const original = await storage.get('private', media.original_path);
        if (!original.ok) return err('not_found', 'The original of that file is missing.');
        let processed: Processed;
        try {
          processed = await derive(storage, moved, original.value);
        } catch (error) {
          if (error instanceof ProcessingRefused)
            return err('unsupported_media_type', error.message);
          throw error;
        }
        next.variants = processed.variants;
        await removeUnshared(store, storage, organizationId, [media], { includeOriginals: false });
      }
      next.gated = input.gated;
    }

    const updated = await store.update('event_media', organizationId, media.id, next);
    return ok(updated);
  });
}

export async function listMedia(
  store: DataStore,
  actor: EventActor,
  eventId: string,
): Promise<Result<EventMedia[]>> {
  const caps = capabilitiesFor(actor, eventId);
  if (!caps.ok) return caps;
  if (!caps.value.viewDraft) return notFound();
  const organizationId = actorOrganizationId(actor);
  return guard('listMedia', async () => {
    const event = await loadEvent(store, organizationId, eventId);
    if (!event) return notFound();
    return ok(
      await store.list(
        'event_media',
        organizationId,
        { eq: { event_id: eventId } },
        { orderBy: [{ field: 'created_at', direction: 'desc' }], limit: 500 },
      ),
    );
  });
}

/** Studio's media library: every item of the event, resolved (no storage paths). */
export async function listResolvedMedia(
  store: DataStore,
  actor: EventActor,
  eventId: string,
): Promise<Result<ResolvedMedia[]>> {
  const rows = await listMedia(store, actor, eventId);
  if (!rows.ok) return rows;
  const map = await resolveMediaRows(rows.value, { withholdGated: actor.kind !== 'owner' });
  if (!map.ok) return map;
  return ok(rows.value.map((m) => map.value[m.id]!).filter(Boolean));
}

/** Owners only; refused while the draft or the live page still uses it. */
export async function deleteMedia(
  store: DataStore,
  actor: EventActor,
  eventId: string,
  mediaId: string,
): Promise<Result<true>> {
  if (actor.kind !== 'owner') return refuse('Only TipTop can delete media.');
  const organizationId = actor.organizationId;
  return guard('deleteMedia', async () => {
    const event = await loadEvent(store, organizationId, eventId);
    if (!event) return notFound();
    const media = await loadMedia(store, organizationId, eventId, mediaId);
    if (!media) return err('not_found', 'That upload does not exist.');
    const inUse = [event.draft_doc, event.published_doc].some((d) =>
      d ? mediaIdsInJson(d).includes(mediaId) : false,
    );
    if (inUse) {
      return err('conflict', 'That file is still on the page. Remove it there first.');
    }
    // A video using this image as its poster loses the poster.
    const posters = await store.list('event_media', organizationId, {
      eq: { event_id: eventId, kind: 'video' },
    });
    const ownPaths = new Set(media.variants.map((v) => v.path));
    for (const v of posters) {
      if (v.poster_path && ownPaths.has(v.poster_path)) {
        await store.update('event_media', organizationId, v.id, { poster_path: null });
      }
    }
    await removeUnshared(store, getEventStorage(), organizationId, [media], {
      includeOriginals: true,
    });
    await store.remove('event_media', organizationId, media.id);
    await recordAudit(store, {
      organizationId,
      userId: actor.userId,
      action: 'event.media_deleted',
      entityType: 'event',
      entityId: eventId,
      metadata: { media: media.id, kind: media.kind },
    });
    return ok(true);
  });
}

/**
 * Remove every stored object of an event's media (deleting the event), keeping
 * objects another event's media still shares.
 */
export async function removeEventMediaObjects(
  store: DataStore,
  organizationId: string,
  eventId: string,
): Promise<void> {
  const rows = await store.list('event_media', organizationId, { eq: { event_id: eventId } });
  try {
    await removeUnshared(store, getEventStorage(), organizationId, rows, {
      includeOriginals: true,
    });
  } catch (error) {
    log.warn('Could not remove the media files of a deleted event', {
      event: eventId,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/* ------------------------------------------------------------------ reads */

const MEDIA_KEY_RE = /mediaId$/;

function mediaIdsInJson(value: unknown): string[] {
  const ids = new Set<string>();
  const walk = (v: unknown, key = ''): void => {
    if (Array.isArray(v)) v.forEach((x) => walk(x));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, k);
    } else if (typeof v === 'string' && MEDIA_KEY_RE.test(key)) ids.add(v);
  };
  walk(value);
  return [...ids];
}

/** Every media id a document references (hero, backgrounds, galleries, logos…). */
export function mediaIdsIn(doc: EventDoc): string[] {
  return mediaIdsInJson(doc);
}

export interface ResolveOptions {
  /** Absolute URLs (share cards rendered server-side, emails). */
  absolute?: boolean;
  /** Leave gated media out entirely (the public share card). */
  excludeGated?: boolean;
  /**
   * Keep gated media in the map but with no URLs (outside editors and viewer
   * links: they see the draft's gated sections, never the LP files in them).
   */
  withholdGated?: boolean;
}

const RESOLVED_FORMATS = new Set<ResolvedMediaVariant['format']>([
  'avif',
  'webp',
  'jpg',
  'png',
  'mp4',
  'webm',
]);

/** Resolve rows into URLs: public URLs for ungated media, signed URLs for gated media and files. */
export async function resolveMediaRows(
  rows: EventMedia[],
  options: ResolveOptions = {},
): Promise<Result<MediaMap>> {
  const storage = getEventStorage();
  const wanted = rows.filter((m) => !(options.excludeGated && bucketOf(m) === 'private'));

  // One batch of signatures for every private object these rows need.
  const privatePaths = new Set<string>();
  for (const m of wanted) {
    if (m.status !== 'ready' || bucketOf(m) !== 'private' || m.kind === 'file') continue;
    if (options.withholdGated) continue;
    for (const v of m.variants) privatePaths.add(v.path);
    if (m.poster_path) privatePaths.add(m.poster_path);
  }
  const signed = new Map<string, string | null>();
  if (privatePaths.size) {
    const list = [...privatePaths];
    const urls = await storage.signedUrls(list, SIGNED_URL_SECONDS);
    if (!urls.ok) return urls;
    list.forEach((p, i) => signed.set(p, urls.value[i] ?? null));
  }
  const fix = (url: string | null) => (options.absolute ? absoluteUrl(url) : url);
  const urlFor = (m: EventMedia, objectPath: string): string | null =>
    fix(
      bucketOf(m) === 'private' ? (signed.get(objectPath) ?? null) : storage.publicUrl(objectPath),
    );

  const map: MediaMap = {};
  for (const m of wanted) {
    let variants: ResolvedMediaVariant[] = [];
    let src: string | null = null;
    const withheld = options.withholdGated === true && bucketOf(m) === 'private';
    if (m.status === 'ready' && !withheld) {
      if (m.kind === 'file') {
        const urls = await storage.signedUrls([m.original_path], SIGNED_URL_SECONDS, {
          download: m.original_name ?? undefined,
        });
        src = urls.ok ? fix(urls.value[0] ?? null) : null;
      } else {
        variants = m.variants
          .filter((v) => RESOLVED_FORMATS.has(v.format as ResolvedMediaVariant['format']))
          .map((v) => ({
            w: v.w,
            format: v.format as ResolvedMediaVariant['format'],
            url: urlFor(m, v.path) ?? '',
          }))
          .filter((v) => v.url !== '');
        const best =
          m.kind === 'video'
            ? variants[0]
            : ([...variants].sort((a, b) => b.w - a.w).find((v) => v.format === 'webp') ??
              variants.find((v) => v.format === 'jpg' || v.format === 'png'));
        src = best?.url ?? null;
      }
    }
    map[m.id] = {
      id: m.id,
      kind: m.kind,
      width: m.width,
      height: m.height,
      alt: m.alt,
      decorative: m.decorative,
      thumbhash: m.thumbhash,
      colors: m.colors,
      variants,
      src,
      posterUrl: m.status === 'ready' && m.poster_path ? urlFor(m, m.poster_path) : null,
      fileName: m.kind === 'file' ? m.original_name : null,
      gated: bucketOf(m) === 'private',
      status: m.status,
    };
  }
  return ok(map);
}

/**
 * Resolve the media a (viewer-filtered) document references into URLs the
 * renderer can use. Only ids of THIS event resolve; anything else is left
 * out and the renderer shows its placeholder. The document must already be
 * filtered for the viewer (filterDocForViewer): every id left in it is one
 * the viewer may see, so gated media resolves to 15-minute signed URLs —
 * except for outside links (viewer kind 'editor' or 'viewer'), who get gated
 * items with no URLs at all (Studio shows a "private" placeholder).
 */
export async function resolveMedia(
  store: DataStore,
  organizationId: string,
  eventId: string,
  doc: EventDoc,
  viewer: EventViewer,
  options: ResolveOptions = {},
): Promise<Result<MediaMap>> {
  const ids = mediaIdsIn(doc);
  if (!ids.length) return ok({});
  // Outside links see the draft's gated sections (to edit around them), never
  // the private files in them.
  const outsider = viewer.kind === 'editor' || viewer.kind === 'viewer';
  return guard('resolveMedia', async () => {
    const rows = await store.list('event_media', organizationId, {
      eq: { event_id: eventId },
      in: { id: ids },
    });
    return resolveMediaRows(rows, { ...options, withholdGated: options.withholdGated || outsider });
  });
}
