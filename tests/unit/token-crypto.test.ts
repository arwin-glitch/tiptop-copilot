import { afterEach, describe, expect, it } from 'vitest';
import {
  CURRENT_KEY_VERSION,
  encryptionAvailable,
  hashIp,
  openToken,
  randomToken,
  sealToken,
  sign,
  signedValue,
  verifySignedValue,
} from '@/lib/security/crypto';
import { resetEnvCache } from '@/lib/config/env';

/**
 * AES-256-GCM for provider tokens.
 *
 * The property that matters beyond "it round-trips": the integration id is
 * bound in as additional authenticated data, so a ciphertext lifted from one
 * integration row cannot be decrypted against another.
 */

const KEY = process.env.APP_ENCRYPTION_KEY;

afterEach(() => {
  if (KEY === undefined) delete process.env.APP_ENCRYPTION_KEY;
  else process.env.APP_ENCRYPTION_KEY = KEY;
  resetEnvCache();
});

describe('sealToken / openToken', () => {
  it('round-trips a refresh token', () => {
    const sealed = sealToken('1//0g-fake-refresh-token', 'integration-a');
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;

    expect(sealed.value.keyVersion).toBe(CURRENT_KEY_VERSION);
    const opened = openToken(sealed.value, 'integration-a');
    expect(opened.ok).toBe(true);
    if (opened.ok) expect(opened.value).toBe('1//0g-fake-refresh-token');
  });

  it('never stores the plaintext anywhere in the sealed record', () => {
    const secret = 'super-secret-refresh-value';
    const sealed = sealToken(secret, 'integration-a');
    if (!sealed.ok) throw new Error('seal failed');
    expect(JSON.stringify(sealed.value)).not.toContain(secret);
  });

  it('uses a fresh IV per record, so identical plaintext yields different ciphertext', () => {
    const a = sealToken('same-token', 'integration-a');
    const b = sealToken('same-token', 'integration-a');
    if (!a.ok || !b.ok) throw new Error('seal failed');
    expect(a.value.iv).not.toBe(b.value.iv);
    expect(a.value.ciphertext).not.toBe(b.value.ciphertext);
  });

  it('refuses to open a ciphertext under a different integration id', () => {
    const sealed = sealToken('token', 'integration-a');
    if (!sealed.ok) throw new Error('seal failed');

    const moved = openToken(sealed.value, 'integration-b');
    expect(moved.ok).toBe(false);
    if (!moved.ok) {
      expect(moved.error.code).toBe('internal');
      // The message must not distinguish tampering from a wrong key.
      expect(moved.error.message).toContain('Reconnect');
    }
  });

  it('rejects a tampered ciphertext', () => {
    const sealed = sealToken('token', 'integration-a');
    if (!sealed.ok) throw new Error('seal failed');
    const bytes = Buffer.from(sealed.value.ciphertext, 'base64');
    bytes[0] = bytes[0]! ^ 0xff;

    const opened = openToken(
      { ...sealed.value, ciphertext: bytes.toString('base64') },
      'integration-a',
    );
    expect(opened.ok).toBe(false);
  });

  it('rejects a tampered auth tag', () => {
    const sealed = sealToken('token', 'integration-a');
    if (!sealed.ok) throw new Error('seal failed');
    const tag = Buffer.from(sealed.value.authTag, 'base64');
    tag[0] = tag[0]! ^ 0xff;

    expect(
      openToken({ ...sealed.value, authTag: tag.toString('base64') }, 'integration-a').ok,
    ).toBe(false);
  });

  it('refuses an unknown key version instead of guessing', () => {
    const sealed = sealToken('token', 'integration-a');
    if (!sealed.ok) throw new Error('seal failed');
    const opened = openToken({ ...sealed.value, keyVersion: 99 }, 'integration-a');
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.error.message).toContain('key version 99');
  });
});

describe('key configuration', () => {
  it('reports a typed failure rather than throwing when the key is absent', () => {
    delete process.env.APP_ENCRYPTION_KEY;
    resetEnvCache();

    expect(encryptionAvailable()).toBe(false);
    const sealed = sealToken('token', 'integration-a');
    expect(sealed.ok).toBe(false);
    if (!sealed.ok) expect(sealed.error.code).toBe('not_configured');
  });

  it('rejects a key that does not decode to 32 bytes', () => {
    process.env.APP_ENCRYPTION_KEY = Buffer.alloc(16, 1).toString('base64');
    resetEnvCache();

    const sealed = sealToken('token', 'integration-a');
    expect(sealed.ok).toBe(false);
    if (!sealed.ok) expect(sealed.error.message).toContain('32 bytes');
  });
});

describe('signed values', () => {
  it('round-trips a payload', () => {
    const token = signedValue('user-123|org-456');
    expect(verifySignedValue(token)).toBe('user-123|org-456');
  });

  it('rejects a payload whose signature does not match', () => {
    const token = signedValue('user-123');
    const forged = `${Buffer.from('user-999', 'utf8').toString('base64url')}.${token.split('.')[1]}`;
    expect(verifySignedValue(forged)).toBeNull();
  });

  it('rejects a truncated or malformed token', () => {
    expect(verifySignedValue('')).toBeNull();
    expect(verifySignedValue('nodot')).toBeNull();
    expect(verifySignedValue('.onlysig')).toBeNull();
    expect(verifySignedValue(`${signedValue('x')}extra`)).toBeNull();
  });

  it('produces a stable signature for the same payload', () => {
    expect(sign('abc')).toBe(sign('abc'));
    expect(sign('abc')).not.toBe(sign('abd'));
  });
});

describe('hashIp', () => {
  it('is one-way, stable, and never returns the address', () => {
    const hashed = hashIp('203.0.113.42');
    expect(hashed).not.toBeNull();
    expect(hashed).not.toContain('203.0.113.42');
    expect(hashed).toHaveLength(32);
    expect(hashIp('203.0.113.42')).toBe(hashed);
    expect(hashIp('203.0.113.43')).not.toBe(hashed);
  });

  it('passes null through rather than hashing an empty string', () => {
    expect(hashIp(null)).toBeNull();
    expect(hashIp(undefined)).toBeNull();
    expect(hashIp('')).toBeNull();
  });
});

describe('randomToken', () => {
  it('is url-safe and does not repeat', () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
