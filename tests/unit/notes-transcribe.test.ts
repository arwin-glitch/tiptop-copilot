import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '@/lib/config/env';
import { AssemblyAITranscriber, ASSEMBLYAI_TOKEN_URL } from '@/lib/transcribe/assemblyai';
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
import { openingMessageFor, socketUrlFor } from '@/lib/transcribe/socket-url';
import { SPEECHMATICS_MINT_URL, SpeechmaticsTranscriber } from '@/lib/transcribe/speechmatics';
import type { MintSessionInput } from '@/lib/transcribe/transcriber';

/**
 * The speech-to-text seam (D-076). Nothing here reaches a vendor: the
 * adapters get a fake fetch, and demo mode always gets the mock.
 */

const SAVED = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in SAVED)) delete process.env[key];
  Object.assign(process.env, SAVED);
  resetEnvCache();
  setTranscriberForTesting(null);
});

const INPUT: MintSessionInput = {
  meetingId: 'meeting-1',
  track: 'system',
  language: 'en',
  knownSpeakers: [{ label: '0d000000-0000-4000-8000-000000000001', identifiers: ['opaque-id'] }],
  vocabulary: ['Acme Robotics', 'Dana Reyes', 'Acme Robotics'],
  now: new Date('2026-10-22T15:00:00Z'),
};

function fakeFetch(status: number, body: unknown) {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch & {
    mock: { calls: [string, RequestInit][] };
  };
}

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

describe('the mock transcriber', () => {
  it('opens no socket and expires in 60 seconds', async () => {
    const session = await new MockTranscriber().mintSession(INPUT);
    expect(session.ok).toBe(true);
    if (!session.ok) return;
    expect(session.value.provider).toBe('mock');
    expect(session.value.wsUrl).toBeNull();
    expect(socketUrlFor(session.value)).toBeNull();
    expect(openingMessageFor(session.value)).toBeNull();
    expect(Date.parse(session.value.expiresAt) - INPUT.now!.getTime()).toBe(60_000);
    expect(session.value.audio).toEqual({ sampleRate: 16000, encoding: 'pcm_s16le', channels: 1 });
  });

  it('is what demo mode always gets', () => {
    process.env.DEMO_MODE = 'true';
    process.env.SPEECHMATICS_API_KEY = 'sm-test-not-a-real-key';
    resetEnvCache();
    expect(getTranscriber().provider).toBe('mock');
  });

  it('outside demo mode, a missing key refuses plainly and calls nobody', async () => {
    process.env.DEMO_MODE = 'false';
    delete process.env.SPEECHMATICS_API_KEY;
    delete process.env.TRANSCRIBER_PROVIDER;
    resetEnvCache();
    const t = getTranscriber();
    expect(t.provider).toBe('speechmatics');
    expect(t.available()).toBe(false);
    const minted = await t.mintSession(INPUT);
    expect(minted.ok).toBe(false);
    if (!minted.ok) expect(minted.error.code).toBe('not_configured');

    process.env.TRANSCRIBER_PROVIDER = 'assemblyai';
    resetEnvCache();
    expect(getTranscriber().provider).toBe('assemblyai');
  });
});

describe('Speechmatics', () => {
  it('mints a 60-second key with the server key as a Bearer token', async () => {
    const fetchImpl = fakeFetch(201, { apikey_id: 'x', key_value: 'temp-key-123' });
    const t = new SpeechmaticsTranscriber('sm-test-not-a-real-key', 'us', fetchImpl);
    const minted = await t.mintSession(INPUT);
    expect(minted.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(SPEECHMATICS_MINT_URL);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer sm-test-not-a-real-key',
    );
    expect(JSON.parse(String(init.body))).toEqual({ ttl: 60 });
    if (!minted.ok) return;
    expect(minted.value.wsUrl).toBe('wss://us.rt.speechmatics.com/v2');
    expect(socketUrlFor(minted.value)).toBe('wss://us.rt.speechmatics.com/v2?jwt=temp-key-123');
  });

  it('diarizes the meeting audio and recognises consented voices by profile id only', async () => {
    const t = new SpeechmaticsTranscriber('k', 'us', fakeFetch(201, { key_value: 'temp' }));
    const minted = await t.mintSession(INPUT);
    if (!minted.ok) throw new Error('mint failed');
    const start = JSON.parse(openingMessageFor(minted.value) ?? '{}');
    expect(start.message).toBe('StartRecognition');
    expect(start.audio_format).toEqual({ type: 'raw', encoding: 'pcm_s16le', sample_rate: 16000 });
    const config = start.transcription_config;
    expect(config.diarization).toBe('speaker');
    expect(config.operating_point).toBe('enhanced');
    expect(config.speaker_diarization_config.max_speakers).toBe(8);
    expect(config.speaker_diarization_config.speakers).toEqual([
      { label: INPUT.knownSpeakers[0]!.label, speaker_identifiers: ['opaque-id'] },
    ]);
    expect(config.additional_vocab).toEqual([
      { content: 'Acme Robotics' },
      { content: 'Dana Reyes' },
    ]);
  });

  it('does not diarize the mic: every word is the recorder’s', async () => {
    const t = new SpeechmaticsTranscriber('k', 'eu2', fakeFetch(201, { key_value: 'temp' }));
    const minted = await t.mintSession({ ...INPUT, track: 'mic' });
    if (!minted.ok) throw new Error('mint failed');
    const config = JSON.parse(openingMessageFor(minted.value) ?? '{}').transcription_config;
    expect(config.diarization).toBeUndefined();
    expect(config.speaker_diarization_config).toBeUndefined();
    expect(minted.value.wsUrl).toBe('wss://eu2.rt.speechmatics.com/v2');
  });

  it('says plainly when the key is refused or the vendor is down', async () => {
    const refused = await new SpeechmaticsTranscriber('k', 'us', fakeFetch(401, {})).mintSession(
      INPUT,
    );
    expect(!refused.ok && refused.error.code).toBe('provider_unauthorized');
    const down = await new SpeechmaticsTranscriber('k', 'us', fakeFetch(503, {})).mintSession(
      INPUT,
    );
    expect(!down.ok && down.error.code).toBe('provider_unavailable');
    const empty = await new SpeechmaticsTranscriber('k', 'us', fakeFetch(201, {})).mintSession(
      INPUT,
    );
    expect(!empty.ok && empty.error.code).toBe('provider_unavailable');
  });
});

describe('AssemblyAI', () => {
  it('mints a temporary token per session and puts the settings on the socket address', async () => {
    const fetchImpl = fakeFetch(200, { token: 'aai-temp' });
    const t = new AssemblyAITranscriber('aai-test-not-a-real-key', fetchImpl);
    const minted = await t.mintSession(INPUT);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url.startsWith(ASSEMBLYAI_TOKEN_URL)).toBe(true);
    expect(new URL(url).searchParams.get('expires_in_seconds')).toBe('60');
    expect((init.headers as Record<string, string>).Authorization).toBe('aai-test-not-a-real-key');
    if (!minted.ok) throw new Error('mint failed');
    const address = new URL(socketUrlFor(minted.value) ?? '');
    expect(address.origin + address.pathname).toBe('wss://streaming.assemblyai.com/v3/ws');
    expect(address.searchParams.get('token')).toBe('aai-temp');
    expect(address.searchParams.get('speaker_labels')).toBe('true');
    expect(address.searchParams.get('sample_rate')).toBe('16000');
    expect(openingMessageFor(minted.value)).toBeNull();
  });

  it('leaves speaker labels off the mic', async () => {
    const t = new AssemblyAITranscriber('k', fakeFetch(200, { token: 't' }));
    const minted = await t.mintSession({ ...INPUT, track: 'mic' });
    if (!minted.ok) throw new Error('mint failed');
    expect(new URL(socketUrlFor(minted.value) ?? '').searchParams.get('speaker_labels')).toBeNull();
  });
});
