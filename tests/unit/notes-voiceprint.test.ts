import { afterEach, describe, expect, it } from 'vitest';
import { resetEnvCache } from '@/lib/config/env';
import {
  openIdentifiers,
  sealIdentifiers,
  voiceprintSealingAvailable,
} from '@/lib/notes/voiceprint-seal';
import { BrowserWhisperTranscriber } from '@/lib/transcribe/browser-whisper';
import { MockTranscriber } from '@/lib/transcribe/mock';
import { mockVoiceIdentifiers } from '@/lib/transcribe/mock-script';
import {
  cosine,
  decodeVoiceprint,
  encodeVoiceprint,
  isVoiceprint,
  syntheticVoiceprint,
} from '@/lib/transcribe/voiceprint';

/**
 * Voice profiles (D-076): voiceprints (speaker embeddings made in the
 * recorder's browser) sealed at rest with VOICEPRINT_ENC_KEY and bound to
 * their profile, enrolment settings, and the voiceprint codec. Nothing is
 * called; every voiceprint here is a made-up vector.
 */

const PROFILE = '3b9d2f2c-6a7e-4c1b-9d8e-1f2a3b4c5d6e';
const OTHER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const SAVED = { demo: process.env.DEMO_MODE, key: process.env.VOICEPRINT_ENC_KEY };

afterEach(() => {
  process.env.DEMO_MODE = SAVED.demo;
  if (SAVED.key === undefined) delete process.env.VOICEPRINT_ENC_KEY;
  else process.env.VOICEPRINT_ENC_KEY = SAVED.key;
  resetEnvCache();
});

function useKey(fill: number) {
  process.env.VOICEPRINT_ENC_KEY = Buffer.alloc(32, fill).toString('base64');
  resetEnvCache();
}

describe('sealing voice identifiers', () => {
  it('opens what it sealed, for the same profile only', () => {
    useKey(3);
    const sealed = sealIdentifiers(['id-one', 'id-two'], PROFILE);
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;
    expect(sealed.value.ciphertext).not.toContain('id-one');
    const opened = openIdentifiers(sealed.value, PROFILE);
    expect(opened).toEqual({ ok: true, value: ['id-one', 'id-two'] });
    // Moved onto someone else's profile: refused.
    expect(openIdentifiers(sealed.value, OTHER).ok).toBe(false);
  });

  it('cannot be opened with another key', () => {
    useKey(3);
    const sealed = sealIdentifiers(['id-one'], PROFILE);
    useKey(4);
    expect(sealed.ok && openIdentifiers(sealed.value, PROFILE).ok).toBe(false);
  });

  it('refuses to enrol anyone without the key outside demo mode', () => {
    process.env.DEMO_MODE = 'false';
    delete process.env.VOICEPRINT_ENC_KEY;
    resetEnvCache();
    expect(voiceprintSealingAvailable()).toBe(false);
    const sealed = sealIdentifiers(['id-one'], PROFILE);
    expect(sealed.ok).toBe(false);
    if (!sealed.ok) expect(sealed.error.code).toBe('not_configured');
  });

  it('refuses a key that is not 32 bytes', () => {
    process.env.DEMO_MODE = 'false';
    process.env.VOICEPRINT_ENC_KEY = Buffer.alloc(16, 1).toString('base64');
    resetEnvCache();
    expect(voiceprintSealingAvailable()).toBe(false);
  });
});

describe('enrolment settings', () => {
  it('a solo clip is told apart like a mixed track and recognises nobody', () => {
    const session = new BrowserWhisperTranscriber().session({
      meetingId: PROFILE,
      track: 'mixed',
      language: 'en',
      knownVoices: [],
      vocabulary: [],
      purpose: 'enrollment',
    });
    expect(session).toMatchObject({ provider: 'browser-whisper', track: 'mixed', knownVoices: [] });
  });

  it('the demo plays an enrolment script and posts a made-up voiceprint', () => {
    const session = new MockTranscriber().session({
      meetingId: 'm',
      track: 'mixed',
      language: 'en',
      knownVoices: [],
      vocabulary: [],
      purpose: 'enrollment',
    });
    expect(session.sessionConfig).toMatchObject({ script: 'voice-enrollment', enrollment: true });
    const [print] = mockVoiceIdentifiers('dana@acmerobotics.example');
    expect(print && isVoiceprint(print)).toBe(true);
    expect(mockVoiceIdentifiers('DANA@acmerobotics.example')).toEqual(
      mockVoiceIdentifiers('dana@acmerobotics.example'),
    );
  });
});

describe('the voiceprint codec', () => {
  it('round-trips a vector at unit length', () => {
    const vector = syntheticVoiceprint('a made-up voice');
    const decoded = decodeVoiceprint(encodeVoiceprint(vector.map((v) => v * 3)));
    expect(decoded).not.toBeNull();
    expect(decoded).toHaveLength(512);
    expect(cosine(decoded!, vector)).toBeCloseTo(1, 5);
  });

  it('refuses what is not a voiceprint', () => {
    expect(decodeVoiceprint('not base64!')).toBeNull();
    expect(decodeVoiceprint('AAAA')).toBeNull(); // one float: too few dimensions
    expect(decodeVoiceprint(encodeVoiceprint(new Float32Array(512)))).toBeNull(); // all zeros
    const nan = new DataView(new ArrayBuffer(512 * 4));
    nan.setFloat32(0, Number.NaN, true);
    let binary = '';
    for (const b of new Uint8Array(nan.buffer)) binary += String.fromCharCode(b);
    expect(decodeVoiceprint(btoa(binary))).toBeNull();
  });

  it('tells two made-up voices apart', () => {
    expect(cosine(syntheticVoiceprint('one'), syntheticVoiceprint('two'))).toBeLessThan(0.3);
  });
});
