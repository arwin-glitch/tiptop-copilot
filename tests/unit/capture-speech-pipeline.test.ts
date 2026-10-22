import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAKE_VOICEPRINT_MODEL, FakeModelAdapter } from '@/lib/capture/fake-adapter';
import { SpeechPipeline, type ModelAdapter } from '@/lib/capture/speech-pipeline';
import type { FromWorker, ToWorker, WorkerConfig } from '@/lib/capture/speech-protocol';
import {
  cosine,
  decodeVoiceprint,
  encodeVoiceprint,
  syntheticVoiceprint,
} from '@/lib/transcribe/voiceprint';
import type { KnownVoice, TranscriptEvent } from '@/lib/types/notes';
import { pieces, silence, speech } from '../helpers/speech-worker';

/**
 * The speech worker's pipeline (D-076) with a fake model in place of Whisper
 * and the speaker models: chunking, the queue, who's talking, enrolled voices,
 * falling behind and catching up, finishing, and failing plainly.
 */

const CONFIG: WorkerConfig = {
  choice: 'fast',
  device: 'auto',
  language: 'en',
  adapter: 'fake',
};

function harness(adapter: ModelAdapter = new FakeModelAdapter()) {
  const out: FromWorker[] = [];
  const pipeline = new SpeechPipeline(adapter, (m) => out.push(m), { partials: false });
  const send = (m: ToWorker) => pipeline.handle(m);
  send({ type: 'init', config: CONFIG });
  const start = (
    streamId: string,
    track: 'mic' | 'system' | 'mixed',
    knownVoices: KnownVoice[] = [],
    vocabulary: string[] = [],
  ) => send({ type: 'start', streamId, track, diarize: track !== 'mic', knownVoices, vocabulary });
  const audio = (streamId: string, ...parts: Int16Array[]) => {
    for (const samples of pieces(...parts)) send({ type: 'audio', streamId, samples });
  };
  const events = (streamId: string): TranscriptEvent[] =>
    out.flatMap((m) => (m.type === 'event' && m.streamId === streamId ? [m.event] : []));
  return { pipeline, out, send, start, audio, events };
}

const settle = () => vi.advanceTimersByTimeAsync(50);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('the speech pipeline', () => {
  it('loads, starts a stream, and says when it is ready', async () => {
    const h = harness();
    h.start('s1', 'mic');
    await settle();
    expect(h.out.some((m) => m.type === 'started' && m.streamId === 's1')).toBe(true);
    const statuses = h.out.flatMap((m) => (m.type === 'status' ? [m.status] : []));
    expect(statuses[0]?.phase).toBe('loading');
    expect(statuses.at(-1)).toMatchObject({ phase: 'ready', device: 'wasm', model: 'fast' });
    expect(statuses.some((s) => s.progress !== null && s.progress > 0 && s.progress < 1)).toBe(
      true,
    );
  });

  it('turns speech into finished lines on the stream’s clock; the mic is always the recorder', async () => {
    const h = harness();
    h.start('mic', 'mic');
    h.audio('mic', silence(1000), speech(3000), silence(2000), speech(2000), silence(2000));
    await settle();
    const lines = h.events('mic');
    expect(lines).toHaveLength(2);
    expect(lines.every((e) => e.type === 'final' && e.speakerLabel === null)).toBe(true);
    expect(lines[0]!.startMs).toBeGreaterThan(700);
    expect(lines[0]!.endMs).toBeLessThan(5000);
    expect(lines[1]!.startMs).toBeGreaterThan(lines[0]!.endMs);
  });

  it('never sends silence to the model', async () => {
    const adapter = new FakeModelAdapter();
    const h = harness(adapter);
    h.start('mic', 'mic');
    h.audio('mic', silence(60_000));
    await settle();
    expect(adapter.calls).toBe(0);
    expect(h.events('mic')).toEqual([]);
  });

  it('tells the meeting’s voices apart: Speaker A, then B', async () => {
    const h = harness();
    h.start('sys', 'system');
    h.audio(
      'sys',
      speech(3000),
      silence(2000),
      speech(3000),
      silence(2000),
      speech(3000),
      silence(2000),
    );
    await settle();
    expect(h.events('sys').map((e) => e.speakerLabel)).toEqual(['A', 'B', 'A']);
  });

  it('names an enrolled voice by its profile id, and skips a voiceprint from another model', async () => {
    const profile = '0d000000-0000-4000-8000-000000000042';
    const other = '0d000000-0000-4000-8000-000000000043';
    const h = harness(new FakeModelAdapter({ voiceFor: () => 'dana' }));
    h.start('sys', 'system', [
      {
        label: profile,
        voiceprint: encodeVoiceprint(syntheticVoiceprint('dana')),
        modelVersion: FAKE_VOICEPRINT_MODEL,
      },
      {
        label: other,
        voiceprint: encodeVoiceprint(syntheticVoiceprint('dana')),
        modelVersion: 'another-model@1',
      },
    ]);
    h.audio('sys', speech(3000), silence(2000));
    await settle();
    expect(h.events('sys').map((e) => e.speakerLabel)).toEqual([profile]);
  });

  it('spells the invite’s names the invite’s way', async () => {
    const h = harness(new FakeModelAdapter({ textFor: () => 'we met dana reyes yesterday.' }));
    h.start('mic', 'mic', [], ['Dana Reyes']);
    h.audio('mic', speech(3000), silence(2000));
    await settle();
    expect(h.events('mic')[0]?.text).toBe('we met Dana Reyes yesterday.');
  });

  it('drops the words an overlapping chunk repeats', async () => {
    const texts = ['the robot arm ships in', 'ships in March with the new gripper.'];
    const h = harness(new FakeModelAdapter({ textFor: (n) => texts[n - 1] ?? 'and more.' }));
    h.start('mic', 'mic');
    h.audio('mic', speech(30_000), silence(2000));
    await settle();
    expect(
      h
        .events('mic')
        .slice(0, 2)
        .map((e) => e.text),
    ).toEqual(['the robot arm ships in', 'March with the new gripper.']);
  });

  it('drops a single short word an overlapping chunk repeats ("the deal")', async () => {
    const texts = ['we finally signed the', 'the deal on Friday.'];
    const h = harness(new FakeModelAdapter({ textFor: (n) => texts[n - 1] ?? 'and more.' }));
    h.start('mic', 'mic');
    h.audio('mic', speech(30_000), silence(2000));
    await settle();
    expect(
      h
        .events('mic')
        .slice(0, 2)
        .map((e) => e.text),
    ).toEqual(['we finally signed the', 'deal on Friday.']);
  });

  it('compares an overlap with the last words said, not only the last short line', async () => {
    // The first chunk ends in two lines, the last only one word long; the
    // overlap repeats the two words across them.
    class TwoLines extends FakeModelAdapter {
      private n = 0;
      override async transcribe(audio: Float32Array) {
        this.n += 1;
        const seconds = audio.length / 16_000;
        if (this.n === 1) {
          return {
            text: 'we finally signed the deal.',
            segments: [
              { startS: 0, endS: seconds - 1, text: 'we finally signed the' },
              { startS: seconds - 1, endS: seconds, text: 'deal.' },
            ],
          };
        }
        const text = this.n === 2 ? 'the deal. Then we celebrated.' : 'and more.';
        return { text, segments: [{ startS: 0, endS: seconds, text }] };
      }
    }
    const h = harness(new TwoLines());
    h.start('mic', 'mic');
    h.audio('mic', speech(30_000), silence(2000));
    await settle();
    expect(
      h
        .events('mic')
        .slice(0, 3)
        .map((e) => e.text),
    ).toEqual(['we finally signed the', 'deal.', 'Then we celebrated.']);
  });

  it('drops an invented "Thank you." from a near-silent chunk, but keeps a real one', async () => {
    const h = harness(new FakeModelAdapter({ textFor: () => 'Thank you.' }));
    h.start('mic', 'mic');
    h.audio('mic', speech(400), silence(2000), speech(3000), silence(2000));
    await settle();
    expect(h.events('mic').map((e) => e.text)).toEqual(['Thank you.']);
  });

  it('falls behind without losing anything, then catches up before saying it finished', async () => {
    const h = harness(new FakeModelAdapter({ delayMs: 4000 }));
    h.start('mic', 'mic');
    for (let i = 0; i < 4; i += 1) h.audio('mic', speech(3000), silence(2000));
    await vi.advanceTimersByTimeAsync(100);
    const backlog = h.out.flatMap((m) => (m.type === 'progress' ? [m.backlogMs] : []));
    expect(Math.max(...backlog)).toBeGreaterThan(5000);
    h.send({ type: 'finish', streamId: 'mic' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.out.some((m) => m.type === 'finished')).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    const finishedAt = h.out.findIndex((m) => m.type === 'finished');
    expect(finishedAt).toBeGreaterThan(-1);
    const lines = h.events('mic');
    expect(lines).toHaveLength(4);
    // Every line came before 'finished'.
    const lastEvent = h.out.map((m) => m.type).lastIndexOf('event');
    expect(lastEvent).toBeLessThan(finishedAt);
    const last = h.out.filter((m) => m.type === 'progress').at(-1);
    expect(last).toMatchObject({ backlogMs: 0 });
  });

  it('finishing transcribes the sentence still being said', async () => {
    const h = harness();
    h.start('mic', 'mic');
    h.audio('mic', speech(2500));
    await settle();
    expect(h.events('mic')).toEqual([]);
    h.send({ type: 'finish', streamId: 'mic' });
    await settle();
    expect(h.events('mic')).toHaveLength(1);
    expect(h.out.at(-1)).toMatchObject({ type: 'finished', streamId: 'mic' });
  });

  it('gives one voice’s voiceprint on request, and nothing for a voice never heard', async () => {
    const h = harness(new FakeModelAdapter({ voiceFor: () => 'priya' }));
    h.start('sys', 'system');
    h.audio('sys', speech(3000), silence(2000));
    await settle();
    h.send({ type: 'voiceprint', streamId: 'sys', requestId: 7, label: 'A' });
    h.send({ type: 'voiceprint', streamId: 'sys', requestId: 8, label: 'Q' });
    const answers = h.out.flatMap((m) => (m.type === 'voiceprint' ? [m] : []));
    const a = answers.find((m) => m.requestId === 7);
    expect(a?.modelVersion).toBe(FAKE_VOICEPRINT_MODEL);
    expect(cosine(decodeVoiceprint(a!.voiceprint!)!, syntheticVoiceprint('priya'))).toBeGreaterThan(
      0.99,
    );
    expect(answers.find((m) => m.requestId === 8)).toMatchObject({
      voiceprint: null,
      modelVersion: null,
    });
  });

  it('says plainly when the model cannot load, and stops', async () => {
    const h = harness(
      new FakeModelAdapter({ failLoad: { message: 'No model here.', retryable: false } }),
    );
    h.start('mic', 'mic');
    h.audio('mic', speech(3000), silence(2000));
    await settle();
    expect(h.out.find((m) => m.type === 'fatal')).toEqual({
      type: 'fatal',
      message: 'No model here.',
      retryable: false,
    });
    expect(h.events('mic')).toEqual([]);
  });

  it('runs the five-second setup test and reports the timing', async () => {
    const h = harness();
    h.send({ type: 'test', requestId: 3, samples: speech(5000) });
    await settle();
    const result = h.out.find((m) => m.type === 'test-result');
    expect(result).toMatchObject({ requestId: 3, audioMs: 5000, model: 'fast', device: 'wasm' });
    expect(result && 'text' in result ? result.text : '').toMatch(/Line 1/);
  });

  it('a closed stream’s queued audio is dropped, not transcribed', async () => {
    const adapter = new FakeModelAdapter({ delayMs: 1000 });
    const h = harness(adapter);
    h.start('mic', 'mic');
    h.audio('mic', speech(3000), silence(2000), speech(3000), silence(2000));
    h.send({ type: 'close', streamId: 'mic' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(adapter.calls).toBeLessThanOrEqual(1);
  });
});
