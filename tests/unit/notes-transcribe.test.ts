import { afterEach, describe, expect, it } from 'vitest';
import { resetEnvCache } from '@/lib/config/env';
import { BrowserWhisperTranscriber } from '@/lib/transcribe/browser-whisper';
import {
  baseClusterKey,
  clusterKeyFor,
  isClusterKey,
  nextSplitKey,
  trackOfClusterKey,
} from '@/lib/transcribe/cluster';
import { getTranscriber, setTranscriberForTesting } from '@/lib/transcribe';
import { MockTranscriber } from '@/lib/transcribe/mock';
import {
  MOCK_CALL_DURATION_MS,
  MOCK_CALL_GUESTS,
  MOCK_CALL_LINES,
  MOCK_CALL_PEOPLE,
  mockTranscriptEvents,
  streamMockCall,
} from '@/lib/transcribe/mock-script';
import {
  SEGMENTATION_MODEL,
  SPEAKER_EMBEDDING_MODEL,
  SPEECH_MODEL_CHOICES,
  WHISPER_CHOICES,
  canRun,
  formatMb,
  modelFileUrl,
  whisperFiles,
  whisperModelFor,
  whisperVariant,
} from '@/lib/transcribe/models';
import type { SpeechSessionInput } from '@/lib/transcribe/transcriber';
import { applyVocabulary, prepareVocabulary } from '@/lib/transcribe/vocabulary';

/**
 * The speech-to-text seam (D-076), zero spend: the server only hands out
 * settings, Whisper runs in the recorder's browser, and demo mode always gets
 * the mock. No key, no vendor, no paid path anywhere.
 */

const SAVED = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in SAVED)) delete process.env[key];
  Object.assign(process.env, SAVED);
  resetEnvCache();
  setTranscriberForTesting(null);
});

const KNOWN = {
  label: '0d000000-0000-4000-8000-000000000001',
  voiceprint: 'AAAAAA==',
  modelVersion: 'fake-voiceprint@1',
};

const INPUT: SpeechSessionInput = {
  meetingId: 'meeting-1',
  track: 'system',
  language: 'en',
  knownVoices: [KNOWN],
  vocabulary: ['Acme Robotics', 'Dana Reyes', 'Acme Robotics'],
};

describe('cluster keys', () => {
  it('keys lines by track and vendor label, never by name', () => {
    expect(clusterKeyFor('mic', 'S9')).toBe('mic');
    expect(clusterKeyFor('system', 'S1')).toBe('sys:S1');
    expect(clusterKeyFor('mixed', 'S2')).toBe('mix:S2');
    expect(clusterKeyFor('system', 'Dana Reyes')).toBe('sys:unknown');
    expect(clusterKeyFor('system', null)).toBe('sys:unknown');
    expect(isClusterKey('sys:0d000000-0000-4000-8000-000000000001')).toBe(true);
    expect(isClusterKey('sys:S1#2')).toBe(true);
    expect(isClusterKey('Guest 1')).toBe(false);
  });

  it('names splits and finds their track', () => {
    expect(nextSplitKey('sys:S1', ['sys:S1'])).toBe('sys:S1#2');
    expect(nextSplitKey('sys:S1#2', ['sys:S1', 'sys:S1#2'])).toBe('sys:S1#3');
    expect(baseClusterKey('mix:S2#4')).toBe('mix:S2');
    expect(trackOfClusterKey('mic#2')).toBe('mic');
    expect(trackOfClusterKey('sys:S1')).toBe('system');
    expect(trackOfClusterKey('mix:S1')).toBe('mixed');
  });
});

describe('the scripted call', () => {
  it('is a fictional three-person call plus one unnamed voice', () => {
    expect(MOCK_CALL_PEOPLE.map((p) => p.name)).toEqual([null, 'Dana Reyes', 'Priya Shah', null]);
    for (const p of MOCK_CALL_PEOPLE) if (p.email) expect(p.email).toMatch(/@[a-z]+\.example$/);
    expect(MOCK_CALL_GUESTS.map((g) => g.name)).toEqual(['Dana Reyes', 'Priya Shah']);
    expect(MOCK_CALL_DURATION_MS).toBeGreaterThan(120_000);
    // Lines are in time order and never overlap.
    for (let i = 1; i < MOCK_CALL_LINES.length; i += 1) {
      expect(MOCK_CALL_LINES[i]!.startMs).toBeGreaterThanOrEqual(MOCK_CALL_LINES[i - 1]!.endMs);
    }
  });

  it('puts the recorder on the mic and everyone else on the meeting audio', () => {
    const events = mockTranscriptEvents(['mic', 'system']);
    expect(events).toHaveLength(MOCK_CALL_LINES.length);
    expect(new Set(events.filter((e) => e.track === 'mic').map((e) => e.speakerLabel))).toEqual(
      new Set([null]),
    );
    expect(new Set(events.filter((e) => e.track === 'system').map((e) => e.speakerLabel))).toEqual(
      new Set(['S1', 'S2', 'S3']),
    );
    // Mic-only mode hears the recorder alone.
    expect(mockTranscriptEvents(['mic']).every((e) => e.track === 'mic')).toBe(true);
  });

  it('is one diarized track in person', () => {
    const events = mockTranscriptEvents(['mixed']);
    expect(events).toHaveLength(MOCK_CALL_LINES.length);
    expect(new Set(events.map((e) => e.speakerLabel))).toEqual(new Set(['S1', 'S2', 'S3', 'S4']));
  });

  it('streams in scaled time, with partials, and stops when aborted', async () => {
    const seen: string[] = [];
    for await (const e of streamMockCall({
      tracks: ['mic', 'system'],
      speed: 100_000,
      partials: true,
    })) {
      seen.push(e.type);
    }
    expect(seen.filter((t) => t === 'final')).toHaveLength(MOCK_CALL_LINES.length);
    expect(seen[0]).toBe('partial');

    const controller = new AbortController();
    let count = 0;
    for await (const e of streamMockCall({
      tracks: ['system'],
      speed: 100_000,
      signal: controller.signal,
    })) {
      void e;
      count += 1;
      if (count === 2) controller.abort();
    }
    expect(count).toBe(2);

    const resumed = [];
    for await (const e of streamMockCall({
      tracks: ['mic', 'system'],
      speed: 100_000,
      fromMs: 100_000,
    })) {
      resumed.push(e);
    }
    expect(resumed.every((e) => e.endMs > 100_000)).toBe(true);
  });
});

describe('the transcribers', () => {
  it('the mock plays the scripted call and needs no model', () => {
    const session = new MockTranscriber().session(INPUT);
    expect(session.provider).toBe('mock');
    expect(session.sessionConfig).toEqual({ script: 'acme-intro', track: 'system' });
    expect(session.audio).toEqual({ sampleRate: 16000, encoding: 'pcm_s16le', channels: 1 });
    expect(session).not.toHaveProperty('token');
    expect(session).not.toHaveProperty('wsUrl');
  });

  it('browser Whisper is only settings: no key, no address, nothing to pay for', () => {
    const session = new BrowserWhisperTranscriber().session(INPUT);
    expect(session).toMatchObject({
      track: 'system',
      provider: 'browser-whisper',
      language: 'en',
      knownVoices: [KNOWN],
      sessionConfig: {},
    });
    expect(session.vocabulary).toContain('Dana Reyes');
    expect(JSON.stringify(session)).not.toMatch(/token|wss:|https:|key/i);
  });

  it('never gives the mic anyone else’s voiceprint: every mic word is the recorder’s', () => {
    expect(new BrowserWhisperTranscriber().session({ ...INPUT, track: 'mic' }).knownVoices).toEqual(
      [],
    );
    expect(new MockTranscriber().session({ ...INPUT, track: 'mic' }).knownVoices).toEqual([]);
  });

  it('demo mode always gets the mock; everywhere else, Whisper in the browser', () => {
    process.env.DEMO_MODE = 'true';
    resetEnvCache();
    expect(getTranscriber().provider).toBe('mock');
    process.env.DEMO_MODE = 'false';
    resetEnvCache();
    expect(getTranscriber().provider).toBe('browser-whisper');
  });
});

describe('the model catalog', () => {
  it('pins every model to an exact revision on huggingface.co', () => {
    const pinned = [
      ...SPEECH_MODEL_CHOICES.flatMap((c) => [
        WHISPER_CHOICES[c].english,
        WHISPER_CHOICES[c].multilingual,
      ]),
      SEGMENTATION_MODEL,
      SPEAKER_EMBEDDING_MODEL,
    ];
    for (const m of pinned) expect(m.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(modelFileUrl(WHISPER_CHOICES.fast.english, 'onnx/encoder_model.onnx')).toBe(
      'https://huggingface.co/onnx-community/whisper-base.en/resolve/51eefc0af78b103839eda9e7e4f4186acc6517fe/onnx/encoder_model.onnx',
    );
  });

  it('runs a full-precision encoder and a 4-bit decoder on WebGPU, 8-bit on the processor', () => {
    expect(whisperFiles(whisperVariant('fast', 'webgpu', false)!)).toEqual([
      'onnx/encoder_model.onnx',
      'onnx/decoder_model_merged_q4.onnx',
    ]);
    expect(whisperFiles(whisperVariant('fast', 'wasm', false)!)).toEqual([
      'onnx/encoder_model_quantized.onnx',
      'onnx/decoder_model_merged_quantized.onnx',
    ]);
  });

  it('keeps Best to a graphics chip with 16-bit support', () => {
    expect(canRun('best', 'wasm', true)).toBe(false);
    expect(canRun('best', 'webgpu', false)).toBe(false);
    expect(canRun('best', 'webgpu', true)).toBe(true);
    expect(canRun('fast', 'wasm', false)).toBe(true);
    expect(whisperVariant('best', 'wasm', true)).toBeNull();
  });

  it('picks English-only weights for an English meeting', () => {
    expect(whisperModelFor('fast', 'en').id).toBe('onnx-community/whisper-base.en');
    expect(whisperModelFor('fast', 'en-US').id).toBe('onnx-community/whisper-base.en');
    expect(whisperModelFor('better', 'fr').id).toBe('onnx-community/whisper-small');
  });

  it('shows download sizes in plain units, smallest first', () => {
    const sizes = SPEECH_MODEL_CHOICES.map((c) => WHISPER_CHOICES[c].webgpu.downloadMb);
    expect([...sizes].sort((a, b) => a - b)).toEqual(sizes);
    expect(formatMb(210.6)).toBe('211 MB');
    expect(formatMb(1612.9)).toBe('1.6 GB');
  });
});

describe('vocabulary', () => {
  it('fixes the capitals of a known name, whole words only', () => {
    const terms = prepareVocabulary(['Acme Robotics', 'Dana Reyes', 'Acme', 'Al']);
    expect(terms[0]).toBe('Acme Robotics');
    expect(terms).not.toContain('Al');
    expect(applyVocabulary('we met dana reyes from acme robotics today', terms)).toBe(
      'we met Dana Reyes from Acme Robotics today',
    );
    expect(applyVocabulary('acmeville is not acme', terms)).toBe('acmeville is not Acme');
  });

  it('never swaps one word for another', () => {
    const terms = prepareVocabulary(['Priya Shah']);
    expect(applyVocabulary('maria shaw said hi', terms)).toBe('maria shaw said hi');
  });
});
