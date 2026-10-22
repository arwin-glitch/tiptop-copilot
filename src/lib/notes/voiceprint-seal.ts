import 'server-only';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '@/lib/config/env';
import type { VoiceIdentifier } from '@/lib/types/notes';
import { err, ok, type Result } from '@/lib/util/result';

/**
 * Voice identifiers at rest (D-076): AES-256-GCM with VOICEPRINT_ENC_KEY (32
 * random bytes, base64, set on Render by a person), a fresh 12-byte IV per
 * row, and the voice profile's id bound in as additional data, so a sealed
 * identifier cannot be moved onto someone else's profile.
 *
 * Voiceprints are biometric identifiers (Texas Bus. & Com. Code 503.001):
 * without the key nothing is enrolled, and nothing here ever logs, returns or
 * exports an identifier. Demo mode, which has no key and only fictional
 * people, seals with a random key that lives as long as the process.
 */

export const VOICEPRINT_KEY_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';

let demoKey: Buffer | null = null;

function keyMaterial(): Result<Buffer> {
  const e = env();
  if (!e.voiceprintEncKey) {
    if (e.demoMode) {
      demoKey ??= randomBytes(32);
      return ok(demoKey);
    }
    return err(
      'not_configured',
      'Voice profiles are not set up yet: VOICEPRINT_ENC_KEY is not set, so no voice can be remembered.',
      { stillUsable: 'Names still come from the mic, the calendar and taps.' },
    );
  }
  let key: Buffer;
  try {
    key = Buffer.from(e.voiceprintEncKey, 'base64');
  } catch {
    return err('not_configured', 'VOICEPRINT_ENC_KEY is not valid base64.');
  }
  if (key.length !== 32) {
    return err('not_configured', 'VOICEPRINT_ENC_KEY must decode to exactly 32 bytes.');
  }
  return ok(key);
}

export function voiceprintSealingAvailable(): boolean {
  return keyMaterial().ok;
}

/** Seal one profile's identifiers (the vendor's opaque strings) as one row's ciphertext. */
export function sealIdentifiers(
  identifiers: readonly string[],
  profileId: string,
): Result<VoiceIdentifier['identifier_enc']> {
  const key = keyMaterial();
  if (!key.ok) return key;
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key.value, iv);
  cipher.setAAD(Buffer.from(`voice:${profileId}`, 'utf8'));
  const ct = Buffer.concat([cipher.update(JSON.stringify(identifiers), 'utf8'), cipher.final()]);
  return ok({
    ciphertext: ct.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    keyVersion: VOICEPRINT_KEY_VERSION,
  });
}

/** Open a sealed row; a wrong key, a moved row or a tampered one is one plain failure. */
export function openIdentifiers(
  sealed: VoiceIdentifier['identifier_enc'],
  profileId: string,
): Result<string[]> {
  const key = keyMaterial();
  if (!key.ok) return key;
  if (sealed.keyVersion !== VOICEPRINT_KEY_VERSION) {
    return err('internal', 'A voice identifier was sealed with another key version.');
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key.value, Buffer.from(sealed.iv, 'base64'));
    decipher.setAAD(Buffer.from(`voice:${profileId}`, 'utf8'));
    decipher.setAuthTag(Buffer.from(sealed.authTag, 'base64'));
    const pt = Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    const parsed = JSON.parse(pt) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'string')) {
      return err('internal', 'A voice identifier could not be read.');
    }
    return ok(parsed as string[]);
  } catch {
    return err('internal', 'A voice identifier could not be read.');
  }
}
