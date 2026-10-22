import { afterEach, describe, expect, it } from 'vitest';
import { resetEnvCache } from '@/lib/config/env';
import {
  openIdentifiers,
  sealIdentifiers,
  voiceprintSealingAvailable,
} from '@/lib/notes/voiceprint-seal';
import { AssemblyAITranscriber } from '@/lib/transcribe/assemblyai';
import { MockTranscriber } from '@/lib/transcribe/mock';
import { mockVoiceIdentifiers } from '@/lib/transcribe/mock-script';
import { getSpeakersMessage, speakerIdentifiersFor } from '@/lib/transcribe/socket-url';
import { speechmaticsStartRecognition } from '@/lib/transcribe/speechmatics';

/**
 * Voice profiles (D-076): identifiers sealed at rest with VOICEPRINT_ENC_KEY
 * and bound to their profile, enrolment sessions, and the GetSpeakers
 * helpers the recorder uses. No vendor is called; the identifiers here are
 * made up.
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

describe('enrolment sessions', () => {
  it('Speechmatics: a diarized mic clip that recognises nobody', () => {
    const start = speechmaticsStartRecognition(
      'mic',
      'en',
      [{ label: PROFILE, identifiers: ['x'] }],
      [],
      'enrollment',
    ) as { transcription_config: Record<string, unknown> };
    expect(start.transcription_config).toMatchObject({
      diarization: 'speaker',
      operating_point: 'enhanced',
      speaker_diarization_config: { max_speakers: 2 },
    });
    expect(JSON.stringify(start)).not.toContain('speaker_identifiers');
  });

  it('a meeting mic stays undiarized; the meeting audio recognises consented voices by profile id', () => {
    const mic = speechmaticsStartRecognition(
      'mic',
      'en',
      [{ label: PROFILE, identifiers: ['x'] }],
      [],
    ) as {
      transcription_config: Record<string, unknown>;
    };
    expect(mic.transcription_config.diarization).toBeUndefined();
    const system = speechmaticsStartRecognition(
      'system',
      'en',
      [{ label: PROFILE, identifiers: ['x'] }],
      [],
    );
    expect(JSON.stringify(system)).toContain(`"label":"${PROFILE}"`);
  });

  it('AssemblyAI cannot remember a voice, and says so before calling anyone', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response('{}');
    }) as unknown as typeof fetch;
    const minted = await new AssemblyAITranscriber('test-key-not-real', fetchImpl).mintSession({
      meetingId: 'm',
      track: 'mic',
      language: 'en',
      knownSpeakers: [],
      vocabulary: [],
      purpose: 'enrollment',
    });
    expect(minted.ok).toBe(false);
    expect(called).toBe(false);
  });

  it('the demo plays an enrolment script instead of opening a socket', async () => {
    const minted = await new MockTranscriber().mintSession({
      meetingId: 'm',
      track: 'mic',
      language: 'en',
      knownSpeakers: [],
      vocabulary: [],
      purpose: 'enrollment',
    });
    expect(minted.ok && minted.value.sessionConfig).toMatchObject({
      script: 'voice-enrollment',
      enrollment: true,
    });
    expect(mockVoiceIdentifiers('dana@acmerobotics.example')).toHaveLength(2);
  });
});

describe('GetSpeakers', () => {
  it('asks for the identifiers and keeps only the voice asked about', () => {
    expect(JSON.parse(getSpeakersMessage())).toEqual({ message: 'GetSpeakers', final: true });
    const result = {
      message: 'SpeakersResult',
      speakers: [
        { label: 'S1', speaker_identifiers: ['a1', 'a2'] },
        { label: 'S2', speaker_identifiers: ['b1'] },
      ],
    };
    expect(speakerIdentifiersFor(result, 'S2')).toEqual(['b1']);
    expect(speakerIdentifiersFor(result, 'S9')).toBeNull();
    expect(speakerIdentifiersFor({ message: 'AddTranscript' }, 'S1')).toBeNull();
  });
});
