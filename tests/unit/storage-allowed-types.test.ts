import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '@/lib/config/env';
import {
  BUCKET_ALLOWED_MIME_TYPES,
  BUCKET_BASE_MIME_TYPES,
  BUCKET_HEIC_MIGRATION_FILE,
  BUCKET_HEIC_MIME_TYPES,
  isMimeTypeRefusal,
  normalizeMimeType,
} from '@/lib/storage/allowed-types';
import { LocalStorageProvider, SupabaseStorageProvider } from '@/lib/storage/provider';
import { statusForError } from '@/lib/util/result';

/**
 * The storage bucket's allowed content types, as the app knows them, held to
 * the migrations that set them; and the demo/test storage refusing what the
 * real bucket refuses. Production once stored every campaign photo piece as
 * application/octet-stream, which the bucket refuses, and every test passed
 * because the demo storage took anything: these keep that from happening
 * again.
 */

// Supabase's client, answering uploads as each test says: no network.
const { upload } = vi.hoisted(() => ({ upload: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ storage: { from: () => ({ upload }) } }),
}));

const MIGRATIONS = path.resolve(import.meta.dirname, '../../supabase/migrations');
const read = (file: string) => readFileSync(path.join(MIGRATIONS, file), 'utf8');

/** The quoted strings in the bucket insert's `array[...]`. */
function bucketArray(sql: string): string[] {
  const insert = sql.slice(sql.indexOf('insert into storage.buckets'));
  const array = /array\[([\s\S]*?)\]/.exec(insert)?.[1] ?? '';
  return [...array.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

describe('the allowed types mirror the migrations', () => {
  it('the base list is the one the bucket is created with', () => {
    expect([...BUCKET_BASE_MIME_TYPES]).toEqual(
      bucketArray(read('20260101000700_storage_and_bootstrap.sql')),
    );
  });

  it('the HEIC migration adds exactly the HEIC types, each only when missing', () => {
    const sql = read(path.basename(BUCKET_HEIC_MIGRATION_FILE));
    const statements = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements).toHaveLength(BUCKET_HEIC_MIME_TYPES.length);
    statements.forEach((statement, i) => {
      const type = BUCKET_HEIC_MIME_TYPES[i]!;
      const flat = statement.replace(/\s+/g, ' ');
      // Only the type list of the one bucket, and only when the type is not
      // already there: re-running is harmless and nothing else changes. A
      // null or empty list (Supabase allows every type for both) is left
      // alone: appending to an empty list would make the bucket HEIC-only.
      expect(flat).toBe(
        `update storage.buckets set allowed_mime_types = allowed_mime_types || array['${type}']::text[] where id = 'deal-attachments' and allowed_mime_types is not null and cardinality(allowed_mime_types) > 0 and not ('${type}' = any (allowed_mime_types))`,
      );
    });
  });

  it('everything allowed is the base list plus HEIC, with no duplicates', () => {
    expect(BUCKET_ALLOWED_MIME_TYPES).toEqual([
      ...BUCKET_BASE_MIME_TYPES,
      ...BUCKET_HEIC_MIME_TYPES,
    ]);
    expect(new Set(BUCKET_ALLOWED_MIME_TYPES).size).toBe(BUCKET_ALLOWED_MIME_TYPES.length);
    expect(BUCKET_ALLOWED_MIME_TYPES).not.toContain('application/octet-stream');
  });

  it('normalizes a declared type the way it is compared', () => {
    expect(normalizeMimeType(' Text/Plain; charset=UTF-8 ')).toBe('text/plain');
    expect(normalizeMimeType('')).toBe('');
    expect(normalizeMimeType(undefined)).toBe('');
  });
});

describe('the demo and test storage refuses what the bucket refuses', () => {
  const bytes = new Uint8Array([1, 2, 3]);

  it('refuses application/octet-stream, in Supabase’s words, as a user error', async () => {
    const storage = new LocalStorageProvider();
    const put = await storage.put('org/x/blob', bytes, 'application/octet-stream');
    expect(put.ok).toBe(false);
    if (put.ok) return;
    expect(put.error.code).toBe('unsupported_media_type');
    expect(put.error.message).toMatch(/mime type application\/octet-stream is not supported/);
    expect(statusForError(put.error.code)).toBe(415);
    expect(isMimeTypeRefusal(put.error)).toBe(true);
    // Nothing was written.
    expect((await storage.get('org/x/blob')).ok).toBe(false);
  });

  it('refuses an unknown or empty type and anything not lowercased exactly', async () => {
    const storage = new LocalStorageProvider();
    for (const type of [
      '',
      'application/zip',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'IMAGE/PNG',
    ]) {
      const put = await storage.put('org/x/blob', bytes, type);
      expect(!put.ok && put.error.code).toBe('unsupported_media_type');
    }
  });

  it('stores every allowed type', async () => {
    const storage = new LocalStorageProvider();
    for (const type of BUCKET_ALLOWED_MIME_TYPES) {
      const put = await storage.put(`org/x/${type.replace(/\W/g, '-')}`, bytes, type);
      expect(put.ok).toBe(true);
    }
  });

  it('acts as a bucket the HEIC migration has not reached when told to', async () => {
    const before = new LocalStorageProvider({ allowedMimeTypes: BUCKET_BASE_MIME_TYPES });
    const refused = await before.put('org/x/photo', bytes, 'image/heic');
    expect(!refused.ok && refused.error.code).toBe('unsupported_media_type');
    const after = new LocalStorageProvider();
    expect((await after.put('org/x/photo', bytes, 'image/heic')).ok).toBe(true);
  });
});

describe('isMimeTypeRefusal', () => {
  it('knows Supabase Storage refusing a type', () => {
    expect(
      isMimeTypeRefusal({
        message: 'mime type application/octet-stream is not supported',
        status: 400,
        statusCode: '415',
      }),
    ).toBe(true);
    expect(isMimeTypeRefusal({ message: 'Invalid', statusCode: '415' })).toBe(true);
    expect(isMimeTypeRefusal({ message: 'Invalid', status: 415 })).toBe(true);
  });

  it('leaves every other storage failure alone', () => {
    expect(isMimeTypeRefusal({ message: 'Bucket not found', statusCode: '404' })).toBe(false);
    expect(isMimeTypeRefusal({ message: 'fetch failed' })).toBe(false);
    expect(isMimeTypeRefusal({ message: 'The object exceeded the maximum allowed size' })).toBe(
      false,
    );
  });
});

describe('the Supabase storage provider', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvCache();
    upload.mockReset();
  });

  function configured() {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.example');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key-for-tests-only');
    resetEnvCache();
    return new SupabaseStorageProvider();
  }

  it('turns the bucket refusing a type into unsupported_media_type, not a 500', async () => {
    upload.mockResolvedValue({
      data: null,
      error: { message: 'mime type image/heic is not supported', statusCode: '415', status: 400 },
    });
    const put = await configured().put('org/x/photo', new Uint8Array([1]), 'image/heic');
    expect(upload).toHaveBeenCalledWith('org/x/photo', expect.any(Uint8Array), {
      contentType: 'image/heic',
      upsert: true,
    });
    expect(!put.ok && put.error.code).toBe('unsupported_media_type');
    expect(!put.ok && statusForError(put.error.code)).toBe(415);
  });

  it('keeps any other upload failure as it was', async () => {
    upload.mockResolvedValue({ data: null, error: { message: 'fetch failed' } });
    const put = await configured().put('org/x/photo', new Uint8Array([1]), 'image/png');
    expect(!put.ok && put.error).toMatchObject({
      code: 'internal',
      message: 'Upload failed: fetch failed',
    });
  });
});
