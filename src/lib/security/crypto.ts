import 'server-only';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { env } from '@/lib/config/env';
import { err, ok, type Result } from '@/lib/util/result';

/**
 * Authenticated encryption for provider refresh/access tokens.
 *
 * AES-256-GCM with a random 12-byte IV per record and the integration id bound
 * in as additional authenticated data, so a ciphertext cannot be moved between
 * integrations. `key_version` is stored alongside so keys can be rotated
 * without a migration.
 */

export const CURRENT_KEY_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

export interface SealedToken {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
}

function keyMaterial(): Result<Buffer> {
  const raw = env().encryptionKey;
  if (!raw) {
    return err(
      'not_configured',
      'APP_ENCRYPTION_KEY is not set. Provider tokens cannot be stored.',
    );
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(raw, 'base64');
  } catch {
    return err('not_configured', 'APP_ENCRYPTION_KEY is not valid base64.');
  }
  if (buf.length !== 32) {
    return err(
      'not_configured',
      `APP_ENCRYPTION_KEY must decode to exactly 32 bytes; got ${buf.length}.`,
    );
  }
  return ok(buf);
}

export function encryptionAvailable(): boolean {
  return keyMaterial().ok;
}

export function sealToken(plaintext: string, aad: string): Result<SealedToken> {
  const key = keyMaterial();
  if (!key.ok) return key;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key.value, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ok({
    ciphertext: ct.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    keyVersion: CURRENT_KEY_VERSION,
  });
}

export function openToken(sealed: SealedToken, aad: string): Result<string> {
  const key = keyMaterial();
  if (!key.ok) return key;
  if (sealed.keyVersion !== CURRENT_KEY_VERSION) {
    return err(
      'internal',
      `Token was sealed with key version ${sealed.keyVersion}; current is ${CURRENT_KEY_VERSION}.`,
    );
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key.value, Buffer.from(sealed.iv, 'base64'));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(sealed.authTag, 'base64'));
    const pt = Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
      decipher.final(),
    ]);
    return ok(pt.toString('utf8'));
  } catch {
    // Wrong key, tampered ciphertext, or mismatched AAD all land here. We do not
    // distinguish, because distinguishing leaks information.
    return err('internal', 'Stored provider token could not be decrypted. Reconnect the account.');
  }
}

/* ------------------------------------------------------------- signatures */

function sessionKey(): Buffer {
  const secret = env().sessionSecret;
  if (secret && secret.length >= 32) return Buffer.from(secret, 'utf8');
  if (env().demoMode) {
    // Demo mode gets a stable per-process key so cookies survive navigation but
    // never persist across restarts. Never used in a real deployment.
    return demoSessionKey();
  }
  throw new Error('SESSION_SECRET must be set to at least 32 characters.');
}

let demoKey: Buffer | null = null;
function demoSessionKey(): Buffer {
  if (!demoKey) demoKey = randomBytes(32);
  return demoKey;
}

export function sign(payload: string): string {
  return createHmac('sha256', sessionKey()).update(payload).digest('base64url');
}

export function signedValue(payload: string): string {
  return `${Buffer.from(payload, 'utf8').toString('base64url')}.${sign(payload)}`;
}

export function verifySignedValue(token: string): string | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const encoded = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  let payload: string;
  try {
    payload = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;
  return payload;
}

/** One-way hash of a client IP for audit logs. Never store the raw address. */
export function hashIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  return createHmac('sha256', sessionKey()).update(ip).digest('hex').slice(0, 32);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
