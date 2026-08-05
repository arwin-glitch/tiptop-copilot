import 'server-only';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { env } from '@/lib/config/env';
import { signedValue, verifySignedValue } from '@/lib/security/crypto';
import { err, ok, type Result } from '@/lib/util/result';

/**
 * Private object storage for attachments and uploaded documents.
 *
 * The bucket is private. Access is always via a short-lived signed URL minted
 * *after* an authorization check in the route handler — there is no public
 * path and no method here that makes one.
 */

export interface StorageProvider {
  readonly kind: 'supabase' | 'local';
  put(objectPath: string, data: Uint8Array, contentType: string): Promise<Result<string>>;
  get(objectPath: string): Promise<Result<Uint8Array>>;
  remove(objectPath: string): Promise<Result<true>>;
  /** Time-limited URL. Never returns a permanent or public link. */
  signedUrl(objectPath: string, expiresInSeconds: number): Promise<Result<string>>;
}

export class SupabaseStorageProvider implements StorageProvider {
  readonly kind = 'supabase' as const;

  private client() {
    const e = env();
    if (!e.supabaseUrl || !e.supabaseServiceRoleKey) return null;
    return createClient(e.supabaseUrl, e.supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  async put(objectPath: string, data: Uint8Array, contentType: string): Promise<Result<string>> {
    const client = this.client();
    if (!client) return err('not_configured', 'Supabase storage is not configured.');
    const { error } = await client.storage
      .from(env().supabaseStorageBucket)
      .upload(objectPath, data, { contentType, upsert: true });
    if (error) return err('internal', `Upload failed: ${error.message}`);
    return ok(objectPath);
  }

  async get(objectPath: string): Promise<Result<Uint8Array>> {
    const client = this.client();
    if (!client) return err('not_configured', 'Supabase storage is not configured.');
    const { data, error } = await client.storage
      .from(env().supabaseStorageBucket)
      .download(objectPath);
    if (error || !data) return err('not_found', 'That stored file could not be read.');
    return ok(new Uint8Array(await data.arrayBuffer()));
  }

  async remove(objectPath: string): Promise<Result<true>> {
    const client = this.client();
    if (!client) return err('not_configured', 'Supabase storage is not configured.');
    const { error } = await client.storage.from(env().supabaseStorageBucket).remove([objectPath]);
    if (error) return err('internal', `Delete failed: ${error.message}`);
    return ok(true);
  }

  async signedUrl(objectPath: string, expiresInSeconds: number): Promise<Result<string>> {
    const client = this.client();
    if (!client) return err('not_configured', 'Supabase storage is not configured.');
    const { data, error } = await client.storage
      .from(env().supabaseStorageBucket)
      .createSignedUrl(objectPath, expiresInSeconds);
    if (error || !data?.signedUrl) return err('not_found', 'Could not sign a URL for that file.');
    return ok(data.signedUrl);
  }
}

/**
 * Filesystem-backed storage for demo mode. Signed URLs are HMAC-signed
 * app-relative paths served by an authenticated route, so the expiry and
 * authorization semantics match the real provider rather than being bypassed.
 */
export class LocalStorageProvider implements StorageProvider {
  readonly kind = 'local' as const;

  private root(): string {
    const base = env().demoDataDir;
    return path.isAbsolute(base)
      ? path.join(base, 'storage')
      : path.join(process.cwd(), base, 'storage');
  }

  private resolve(objectPath: string): Result<string> {
    const root = this.root();
    const full = path.resolve(root, objectPath);
    // Refuse anything that escapes the storage root.
    if (!full.startsWith(path.resolve(root) + path.sep)) {
      return err('forbidden', 'Invalid storage path.');
    }
    return ok(full);
  }

  async put(objectPath: string, data: Uint8Array): Promise<Result<string>> {
    const full = this.resolve(objectPath);
    if (!full.ok) return full;
    await mkdir(path.dirname(full.value), { recursive: true });
    await writeFile(full.value, data);
    return ok(objectPath);
  }

  async get(objectPath: string): Promise<Result<Uint8Array>> {
    const full = this.resolve(objectPath);
    if (!full.ok) return full;
    try {
      return ok(new Uint8Array(await readFile(full.value)));
    } catch {
      return err('not_found', 'That stored file could not be read.');
    }
  }

  async remove(objectPath: string): Promise<Result<true>> {
    const full = this.resolve(objectPath);
    if (!full.ok) return full;
    try {
      await unlink(full.value);
    } catch {
      // Already gone is a success for our purposes.
    }
    return ok(true);
  }

  async signedUrl(objectPath: string, expiresInSeconds: number): Promise<Result<string>> {
    const payload = JSON.stringify({
      p: objectPath,
      exp: Date.now() + expiresInSeconds * 1000,
    });
    return ok(`/api/files/local?token=${encodeURIComponent(signedValue(payload))}`);
  }
}

/** Verify a locally-signed storage token. Returns the object path or null. */
export function verifyLocalStorageToken(token: string): string | null {
  const payload = verifySignedValue(token);
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as { p: string; exp: number };
    if (typeof parsed.exp !== 'number' || parsed.exp < Date.now()) return null;
    if (typeof parsed.p !== 'string' || parsed.p.includes('..')) return null;
    return parsed.p;
  } catch {
    return null;
  }
}
