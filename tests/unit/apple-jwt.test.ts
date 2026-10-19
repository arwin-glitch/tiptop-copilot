import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { apnsProviderToken, loadP8, mintAppleJwt } from '../../scripts/lib/apple-jwt.mjs';

/**
 * The ES256 token the phone-alert sender signs for Apple's push service,
 * with a throwaway P-256 key made in the test: never a real key.
 */

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const P8 = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const PUBLIC = createPublicKey(privateKey);

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('the APNs provider token', () => {
  it('is {alg, kid} and {iss, iat}, signed ES256 as raw r||s', () => {
    const now = Date.parse('2026-10-19T15:00:00Z');
    const token = apnsProviderToken(loadP8(P8), { keyId: 'ABC123DEFG', teamId: 'DEF123GHIJ', now });
    const [head, body, signature] = token.split('.') as [string, string, string];
    expect(decode(head)).toEqual({ alg: 'ES256', kid: 'ABC123DEFG' });
    expect(decode(body)).toEqual({ iss: 'DEF123GHIJ', iat: now / 1000 });
    const raw = Buffer.from(signature, 'base64url');
    expect(raw).toHaveLength(64);
    expect(
      verify(
        'sha256',
        Buffer.from(`${head}.${body}`),
        { key: PUBLIC, dsaEncoding: 'ieee-p1363' },
        raw,
      ),
    ).toBe(true);
    expect(token).not.toMatch(/[=+/]/);
  });

  it('signs any claims the same way', () => {
    const token = mintAppleJwt(loadP8(P8), { kid: 'K', typ: 'JWT' }, { aud: 'appstoreconnect-v1' });
    const [head, body, signature] = token.split('.') as [string, string, string];
    expect(decode(head)).toEqual({ alg: 'ES256', kid: 'K', typ: 'JWT' });
    expect(decode(body)).toEqual({ aud: 'appstoreconnect-v1' });
    expect(
      verify(
        'sha256',
        Buffer.from(`${head}.${body}`),
        { key: PUBLIC, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true);
  });
});

describe('reading the .p8 as pasted', () => {
  it('takes the file text, its line breaks escaped, or the file in base64', () => {
    const der = privateKey.export({ format: 'der', type: 'pkcs8' });
    for (const pasted of [
      P8,
      `\n  ${P8}  \n`,
      P8.trim().replace(/\n/g, '\\n'),
      Buffer.from(P8).toString('base64'),
      der.toString('base64'),
    ]) {
      expect(loadP8(pasted).asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
    }
  });

  it('refuses anything else without repeating it', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ format: 'pem', type: 'pkcs8' })
      .toString();
    expect(() => loadP8(rsa)).toThrow('The key is not a P-256 (ES256) key.');
    expect(() => loadP8('')).toThrow('The key is empty.');
    expect(() => loadP8(null)).toThrow('The key is empty.');
    let message = '';
    try {
      loadP8('-----BEGIN PRIVATE KEY-----\nc2VjcmV0LXNoYXBlZA==\n-----END PRIVATE KEY-----');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('The key is not a .p8 private key.');
    expect(message).not.toContain('c2VjcmV0');
  });
});
