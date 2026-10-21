/**
 * The content types the private storage bucket (`deal-attachments`) accepts.
 *
 * This list MIRRORS THE MIGRATIONS, it does not decide anything: Supabase
 * refuses an upload whose content type is not in the bucket's
 * `allowed_mime_types` ("mime type application/octet-stream is not
 * supported"), whatever the app thinks. The base list is the one
 * `supabase/migrations/20260101000700_storage_and_bootstrap.sql` creates the
 * bucket with; `20261021001500_bucket_heic.sql` adds the HEIC types. The demo
 * and test storage (LocalStorageProvider) enforces the same list, so an upload
 * that production would refuse fails in tests too.
 * `tests/unit/storage-allowed-types.test.ts` holds this file to the SQL.
 *
 * To allow another type: write a migration first, then add it here.
 *
 * Pure (no server-only import), so pages can check a file before sending it.
 */

/** The bucket's list as `20260101000700_storage_and_bootstrap.sql` creates it. */
export const BUCKET_BASE_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
  'application/json',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;

/** Added by `20261021001500_bucket_heic.sql`, for HEIC campaign photos. */
export const BUCKET_HEIC_MIME_TYPES = ['image/heic', 'image/heif'] as const;

/** The migration that lets the bucket take HEIC photos. */
export const BUCKET_HEIC_MIGRATION_FILE = 'supabase/migrations/20261021001500_bucket_heic.sql';

/** Everything the bucket accepts once every migration is applied. */
export const BUCKET_ALLOWED_MIME_TYPES: readonly string[] = [
  ...BUCKET_BASE_MIME_TYPES,
  ...BUCKET_HEIC_MIME_TYPES,
];

/**
 * A declared content type as it is compared: lowercased, without parameters
 * ("Text/Plain; charset=UTF-8" → "text/plain"). "" when there is none.
 */
export function normalizeMimeType(type: string | null | undefined): string {
  return (type ?? '').split(';')[0]!.trim().toLowerCase();
}

/**
 * Whether the bucket stores an object with this content type. Exact, as
 * Supabase compares it: callers pass a normalized type.
 */
export function bucketAccepts(
  contentType: string,
  allowed: readonly string[] = BUCKET_ALLOWED_MIME_TYPES,
): boolean {
  return allowed.includes(contentType);
}

/**
 * Whether a storage error is the bucket refusing a content type. Supabase
 * Storage answers 415 with "mime type <type> is not supported"
 * (InvalidMimeType); the demo storage refuses with the same words.
 */
export function isMimeTypeRefusal(error: {
  message?: unknown;
  status?: unknown;
  statusCode?: unknown;
}): boolean {
  const message = typeof error.message === 'string' ? error.message : '';
  if (/mime type .* is not supported/i.test(message)) return true;
  return String(error.statusCode ?? '') === '415' || Number(error.status) === 415;
}

/** The demo storage's refusal, in Supabase's own words. */
export const mimeTypeRefusalMessage = (contentType: string) =>
  `mime type ${contentType || '(none)'} is not supported`;
