import 'server-only';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { env } from '@/lib/config/env';
import { signedValue, verifySignedValue } from '@/lib/security/crypto';
import { err, ok, type Result } from '@/lib/util/result';
import {
  EVENT_MEDIA_BUCKET,
  EVENT_MEDIA_MAX_BYTES,
  EVENT_MEDIA_MIME_TYPES,
  EVENT_ORIGINALS_BUCKET,
  EVENT_ORIGINALS_MAX_BYTES,
  EVENT_ORIGINALS_MIME_TYPES,
  bucketAccepts,
  isMimeTypeRefusal,
  mimeTypeRefusalMessage,
  normalizeMimeType,
} from './allowed-types';
import { eventMediaPublicUrl } from './provider';

/**
 * Storage for event media (D-075): two buckets, kept apart from the private
 * deal-attachments provider in ./provider.ts.
 *
 *   public   `event-media`: processed derivatives of UNGATED media and the
 *            OG cards. World-readable by public URL, content-hashed paths.
 *   private  `event-originals`: the uploads as they arrived and every GATED
 *            derivative. Read only through short-lived signed URLs.
 *
 * Uploads never pass through Kraken: the browser PUTs the file straight to
 * a server-minted signed upload URL for the private bucket, then asks the
 * server to process it (lib/services/event-media.ts).
 *
 * Demo mode and tests use LocalEventStorage: the same two buckets as folders
 * under DEMO_DATA_DIR, the same type lists and size caps (so what Supabase
 * would refuse fails here too), HMAC-signed upload and download URLs served
 * by /api/event-media/* — routes that answer 404 unless this local storage is
 * the one in use.
 */

export type EventBucket = 'public' | 'private';

export interface EventSignedUpload {
  /** Where the browser PUTs the raw file bytes (Content-Type: the file's type). */
  url: string;
  /** The token embedded in the URL (Supabase's uploadToSignedUrl takes it apart). */
  token: string;
  path: string;
}

export interface EventStorage {
  readonly kind: 'supabase' | 'local' | 'none';
  /** A one-off upload URL for an original in the PRIVATE bucket. */
  signedUpload(
    objectPath: string,
    options: { contentType: string; maxBytes: number; expiresInSeconds: number },
  ): Promise<Result<EventSignedUpload>>;
  get(bucket: EventBucket, objectPath: string): Promise<Result<Uint8Array>>;
  /**
   * Store an object. Content-hashed derivative paths are written once: an
   * object already there is the same bytes and counts as success. `upsert`
   * (OG cards, re-rendered at the same version after a failed publish)
   * replaces.
   */
  put(
    bucket: EventBucket,
    objectPath: string,
    data: Uint8Array,
    contentType: string,
    options?: { upsert?: boolean },
  ): Promise<Result<string>>;
  remove(bucket: EventBucket, objectPaths: string[]): Promise<Result<true>>;
  /** Time-limited URLs for PRIVATE objects, in the order given (null: could not sign). */
  signedUrls(
    objectPaths: string[],
    expiresInSeconds: number,
    options?: { download?: string },
  ): Promise<Result<(string | null)[]>>;
  /** The permanent URL of a PUBLIC object (absolute for Supabase, app-relative locally). */
  publicUrl(objectPath: string): string | null;
}

export const EVENT_BUCKET_NAMES: Record<EventBucket, string> = {
  public: EVENT_MEDIA_BUCKET,
  private: EVENT_ORIGINALS_BUCKET,
};

const BUCKET_TYPES: Record<EventBucket, readonly string[]> = {
  public: EVENT_MEDIA_MIME_TYPES,
  private: EVENT_ORIGINALS_MIME_TYPES,
};

const BUCKET_MAX_BYTES: Record<EventBucket, number> = {
  public: EVENT_MEDIA_MAX_BYTES,
  private: EVENT_ORIGINALS_MAX_BYTES,
};

/** Object paths are plain relative paths: no `..`, no leading slash, no odd characters. */
export function safeObjectPath(objectPath: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,399}$/.test(objectPath) &&
    !objectPath.includes('..') &&
    !objectPath.includes('//')
  );
}

function refusal(contentType: string) {
  return err(
    'unsupported_media_type',
    `Storage refused it: ${mimeTypeRefusalMessage(contentType)}.`,
    { details: { contentType: contentType.slice(0, 100) } },
  );
}

/* --------------------------------------------------------------- supabase */

export class SupabaseEventStorage implements EventStorage {
  readonly kind = 'supabase' as const;

  private client() {
    const e = env();
    if (!e.supabaseUrl || !e.supabaseServiceRoleKey) return null;
    return createClient(e.supabaseUrl, e.supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  async signedUpload(
    objectPath: string,
    _options: { contentType: string; maxBytes: number; expiresInSeconds: number },
  ): Promise<Result<EventSignedUpload>> {
    const client = this.client();
    if (!client) return err('not_configured', 'Supabase storage is not configured.');
    if (!safeObjectPath(objectPath)) return err('invalid_input', 'Invalid storage path.');
    // Supabase signed upload URLs last two hours; the bucket enforces its own
    // size cap and type list, and processing re-checks both.
    const { data, error } = await client.storage
      .from(EVENT_ORIGINALS_BUCKET)
      .createSignedUploadUrl(objectPath);
    if (error || !data) return err('internal', 'Could not prepare that upload just now.');
    return ok({ url: data.signedUrl, token: data.token, path: data.path });
  }

  async get(bucket: EventBucket, objectPath: string): Promise<Result<Uint8Array>> {
    const client = this.client();
    if (!client) return err('not_configured', 'Supabase storage is not configured.');
    const { data, error } = await client.storage
      .from(EVENT_BUCKET_NAMES[bucket])
      .download(objectPath);
    if (error || !data) return err('not_found', 'That file has not arrived yet.');
    return ok(new Uint8Array(await data.arrayBuffer()));
  }

  async put(
    bucket: EventBucket,
    objectPath: string,
    data: Uint8Array,
    contentType: string,
    options: { upsert?: boolean } = {},
  ): Promise<Result<string>> {
    const client = this.client();
    if (!client) return err('not_configured', 'Supabase storage is not configured.');
    if (!safeObjectPath(objectPath)) return err('invalid_input', 'Invalid storage path.');
    const { error } = await client.storage
      .from(EVENT_BUCKET_NAMES[bucket])
      .upload(objectPath, data, {
        contentType,
        upsert: options.upsert === true,
        cacheControl: bucket === 'public' ? '31536000' : '3600',
      });
    if (error) {
      if (isMimeTypeRefusal(error)) return refusal(contentType);
      // Content-hashed: an object already at this path holds these bytes.
      if (!options.upsert && /already exists|duplicate/i.test(error.message)) {
        return ok(objectPath);
      }
      return err('internal', `Upload failed: ${error.message}`);
    }
    return ok(objectPath);
  }

  async remove(bucket: EventBucket, objectPaths: string[]): Promise<Result<true>> {
    if (!objectPaths.length) return ok(true);
    const client = this.client();
    if (!client) return err('not_configured', 'Supabase storage is not configured.');
    const { error } = await client.storage.from(EVENT_BUCKET_NAMES[bucket]).remove(objectPaths);
    if (error) return err('internal', `Delete failed: ${error.message}`);
    return ok(true);
  }

  async signedUrls(
    objectPaths: string[],
    expiresInSeconds: number,
    options: { download?: string } = {},
  ): Promise<Result<(string | null)[]>> {
    if (!objectPaths.length) return ok([]);
    const client = this.client();
    if (!client) return err('not_configured', 'Supabase storage is not configured.');
    const bucket = client.storage.from(EVENT_ORIGINALS_BUCKET);
    if (options.download && objectPaths.length === 1) {
      const { data, error } = await bucket.createSignedUrl(objectPaths[0]!, expiresInSeconds, {
        download: options.download,
      });
      return ok([error || !data?.signedUrl ? null : data.signedUrl]);
    }
    const { data, error } = await bucket.createSignedUrls(objectPaths, expiresInSeconds);
    if (error || !data) return err('internal', 'Could not sign those files just now.');
    const byPath = new Map(data.map((d) => [d.path, d.error ? null : d.signedUrl]));
    return ok(objectPaths.map((p) => byPath.get(p) ?? null));
  }

  publicUrl(objectPath: string): string | null {
    return eventMediaPublicUrl(objectPath);
  }
}

/* ------------------------------------------------------------------ local */

/** Payload of a local upload token (HMAC-signed with the session key). */
interface LocalUploadClaim {
  k: 'event-upload/v1';
  p: string;
  max: number;
  exp: number;
}

interface LocalReadClaim {
  k: 'event-read/v1';
  p: string;
  exp: number;
  d?: string;
}

/**
 * Demo/test storage on disk, mirroring the two buckets: the same content
 * types, the same caps, signed URLs that expire.
 */
export class LocalEventStorage implements EventStorage {
  readonly kind = 'local' as const;
  private readonly rootOverride: string | null;

  constructor(options: { root?: string } = {}) {
    this.rootOverride = options.root ?? null;
  }

  private root(): string {
    if (this.rootOverride) return path.resolve(this.rootOverride);
    const base = env().demoDataDir;
    // Demo/test storage only; never traced into the deployed bundle.
    const dir = path.isAbsolute(base)
      ? base
      : path.join(/*turbopackIgnore: true*/ process.cwd(), base);
    return path.join(dir, 'storage', 'events');
  }

  private resolve(bucket: EventBucket, objectPath: string): Result<string> {
    if (!safeObjectPath(objectPath)) return err('forbidden', 'Invalid storage path.');
    const root = path.resolve(this.root(), EVENT_BUCKET_NAMES[bucket]);
    const full = path.resolve(root, objectPath);
    if (!full.startsWith(root + path.sep)) return err('forbidden', 'Invalid storage path.');
    return ok(full);
  }

  async signedUpload(
    objectPath: string,
    options: { contentType: string; maxBytes: number; expiresInSeconds: number },
  ): Promise<Result<EventSignedUpload>> {
    if (!safeObjectPath(objectPath)) return err('invalid_input', 'Invalid storage path.');
    const claim: LocalUploadClaim = {
      k: 'event-upload/v1',
      p: objectPath,
      max: Math.min(options.maxBytes, EVENT_ORIGINALS_MAX_BYTES),
      exp: Date.now() + options.expiresInSeconds * 1000,
    };
    const token = signedValue(JSON.stringify(claim));
    return ok({
      url: `/api/event-media/upload?token=${encodeURIComponent(token)}`,
      token,
      path: objectPath,
    });
  }

  async get(bucket: EventBucket, objectPath: string): Promise<Result<Uint8Array>> {
    const full = this.resolve(bucket, objectPath);
    if (!full.ok) return full;
    try {
      return ok(new Uint8Array(await readFile(full.value)));
    } catch {
      return err('not_found', 'That file has not arrived yet.');
    }
  }

  async put(
    bucket: EventBucket,
    objectPath: string,
    data: Uint8Array,
    contentType: string,
  ): Promise<Result<string>> {
    const type = normalizeMimeType(contentType);
    if (!bucketAccepts(type, BUCKET_TYPES[bucket])) return refusal(type);
    if (data.byteLength > BUCKET_MAX_BYTES[bucket]) {
      return err('too_large', 'The object exceeded the maximum allowed size.');
    }
    const full = this.resolve(bucket, objectPath);
    if (!full.ok) return full;
    await mkdir(path.dirname(full.value), { recursive: true });
    await writeFile(full.value, data);
    return ok(objectPath);
  }

  async remove(bucket: EventBucket, objectPaths: string[]): Promise<Result<true>> {
    for (const objectPath of objectPaths) {
      const full = this.resolve(bucket, objectPath);
      if (!full.ok) continue;
      try {
        await unlink(full.value);
      } catch {
        // Already gone counts as removed.
      }
    }
    return ok(true);
  }

  async signedUrls(
    objectPaths: string[],
    expiresInSeconds: number,
    options: { download?: string } = {},
  ): Promise<Result<(string | null)[]>> {
    return ok(
      objectPaths.map((p) => {
        if (!safeObjectPath(p)) return null;
        const claim: LocalReadClaim = {
          k: 'event-read/v1',
          p,
          exp: Date.now() + expiresInSeconds * 1000,
          ...(options.download ? { d: options.download.slice(0, 120) } : {}),
        };
        return `/api/event-media/signed?token=${encodeURIComponent(signedValue(JSON.stringify(claim)))}`;
      }),
    );
  }

  publicUrl(objectPath: string): string | null {
    if (!safeObjectPath(objectPath)) return null;
    return `/api/event-media/${objectPath}`;
  }

  /* ---- for the /api/event-media routes ---- */

  /** The object a local upload token allows, or null. */
  static verifyUploadToken(token: string): { path: string; maxBytes: number } | null {
    const payload = verifySignedValue(token);
    if (!payload) return null;
    try {
      const claim = JSON.parse(payload) as Partial<LocalUploadClaim>;
      if (claim.k !== 'event-upload/v1') return null;
      if (typeof claim.exp !== 'number' || claim.exp < Date.now()) return null;
      if (typeof claim.p !== 'string' || !safeObjectPath(claim.p)) return null;
      if (typeof claim.max !== 'number' || claim.max <= 0) return null;
      return { path: claim.p, maxBytes: claim.max };
    } catch {
      return null;
    }
  }

  /** The private object a local read token allows, or null. */
  static verifyReadToken(token: string): { path: string; download: string | null } | null {
    const payload = verifySignedValue(token);
    if (!payload) return null;
    try {
      const claim = JSON.parse(payload) as Partial<LocalReadClaim>;
      if (claim.k !== 'event-read/v1') return null;
      if (typeof claim.exp !== 'number' || claim.exp < Date.now()) return null;
      if (typeof claim.p !== 'string' || !safeObjectPath(claim.p)) return null;
      return { path: claim.p, download: typeof claim.d === 'string' ? claim.d : null };
    } catch {
      return null;
    }
  }
}

/* ------------------------------------------------------------------- none */

/** No storage configured (Supabase keys missing outside demo mode): refuse plainly. */
class UnconfiguredEventStorage implements EventStorage {
  readonly kind = 'none' as const;
  private no<T>(): Promise<Result<T>> {
    return Promise.resolve(
      err('not_configured', 'Event media storage is not configured.', {
        stillUsable: 'Pages without uploaded media still work.',
      }),
    );
  }
  signedUpload() {
    return this.no<EventSignedUpload>();
  }
  get() {
    return this.no<Uint8Array>();
  }
  put() {
    return this.no<string>();
  }
  remove() {
    return this.no<true>();
  }
  signedUrls() {
    return this.no<(string | null)[]>();
  }
  publicUrl(): string | null {
    return null;
  }
}

/* ----------------------------------------------------------------- choice */

let storage: EventStorage | null = null;

/** Demo mode: local folders. Otherwise Supabase, or a plain refusal when unconfigured. */
export function getEventStorage(): EventStorage {
  if (storage) return storage;
  const e = env();
  if (e.demoMode) storage = new LocalEventStorage();
  else if (e.supabaseUrl && e.supabaseServiceRoleKey) storage = new SupabaseEventStorage();
  else storage = new UnconfiguredEventStorage();
  return storage;
}

/** Test hook: inject a storage (null: choose again from the environment). */
export function setEventStorageForTesting(next: EventStorage | null): void {
  storage = next;
}

/** An app-relative URL made absolute with APP_URL (share cards, emails); absolute URLs pass through. */
export function absoluteUrl(url: string | null): string | null {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  return `${env().appUrl.replace(/\/+$/, '')}${url.startsWith('/') ? '' : '/'}${url}`;
}

/** Content types of derivative files by extension (the local public route). */
export const DERIVATIVE_TYPES: Record<string, string> = {
  avif: 'image/avif',
  webp: 'image/webp',
  jpg: 'image/jpeg',
  png: 'image/png',
  mp4: 'video/mp4',
  webm: 'video/webm',
  gif: 'image/gif',
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  mov: 'video/quicktime',
};
