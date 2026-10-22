import { describe, expect, it } from 'vitest';
import { VAD_RATE, VadChunker, int16ToFloat, type SpeechChunk } from '@/lib/capture/vad';
import { pieces, silence, speech } from '../helpers/speech-worker';

/**
 * Voice-activity chunking for on-device Whisper (D-076): speech is cut where
 * people pause (5 to 25 seconds a stretch), silence is never sent, a forced
 * cut overlaps the next stretch, and every sample keeps its place on the
 * stream's clock.
 */

function run(chunker: VadChunker, ...parts: Int16Array[]): SpeechChunk[] {
  const out: SpeechChunk[] = [];
  for (const piece of pieces(...parts)) out.push(...chunker.push(int16ToFloat(piece)));
  return out;
}

const seconds = (samples: number) => samples / VAD_RATE;

describe('the voice-activity chunker', () => {
  it('sends nothing for silence', () => {
    const vad = new VadChunker();
    expect(run(vad, silence(30_000))).toEqual([]);
    expect(vad.flush()).toEqual([]);
    expect(vad.open).toBe(false);
  });

  it('ends a short turn at a long pause, with a little audio before the first word', () => {
    const vad = new VadChunker();
    const chunks = run(vad, silence(1000), speech(3000), silence(2000));
    expect(chunks).toHaveLength(1);
    const [chunk] = chunks;
    expect(chunk!.forced).toBe(false);
    expect(chunk!.overlapSamples).toBe(0);
    // Starts just before the speech (pre-roll), on the stream's clock.
    expect(seconds(chunk!.startSample)).toBeGreaterThan(0.7);
    expect(seconds(chunk!.startSample)).toBeLessThanOrEqual(1);
    // Ends inside the pause, not seconds later.
    const end = seconds(chunk!.startSample + chunk!.audio.length);
    expect(end).toBeGreaterThan(4);
    expect(end).toBeLessThan(5);
    expect(chunk!.speechMs).toBeGreaterThan(2500);
  });

  it('cuts at the first pause once a stretch is five seconds long', () => {
    const vad = new VadChunker();
    const chunks = run(vad, speech(6000), silence(700), speech(3000), silence(2000));
    expect(chunks).toHaveLength(2);
    expect(seconds(chunks[0]!.audio.length)).toBeGreaterThan(6);
    expect(seconds(chunks[0]!.audio.length)).toBeLessThan(6.8);
    expect(seconds(chunks[1]!.startSample)).toBeGreaterThan(6);
    expect(chunks.every((c) => !c.forced)).toBe(true);
  });

  it('keeps a short pause inside a stretch under five seconds', () => {
    const vad = new VadChunker();
    const chunks = run(vad, speech(2000), silence(700), speech(2000), silence(2000));
    expect(chunks).toHaveLength(1);
  });

  it('cuts speech with no pause at 25 seconds and overlaps the next stretch by a second', () => {
    const vad = new VadChunker();
    const chunks = run(vad, speech(40_000), silence(2000));
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const [first, second] = chunks;
    expect(first!.forced).toBe(true);
    expect(seconds(first!.audio.length)).toBeLessThanOrEqual(25.1);
    expect(second!.overlapSamples).toBe(VAD_RATE);
    // The overlap is the second before the cut.
    expect(second!.startSample).toBe(first!.startSample + first!.audio.length - VAD_RATE);
  });

  it('drops a click or a cough', () => {
    const vad = new VadChunker();
    expect(run(vad, silence(500), speech(100), silence(3000))).toEqual([]);
  });

  it('learns the room: a steady fan is not speech, a voice over it is', () => {
    const vad = new VadChunker();
    // A steady hum about 30 dB under the voice.
    const fan = (ms: number) =>
      Int16Array.from({ length: Math.round(ms * 16) }, (_, i) =>
        Math.round(Math.sin((2 * Math.PI * 120 * i) / 16_000) * 300),
      );
    expect(run(vad, fan(6000))).toEqual([]);
    const loud = speech(3000);
    const chunks = run(vad, fan(1000), loud, fan(2500));
    expect(chunks).toHaveLength(1);
  });

  it('closes the open stretch when the stream ends', () => {
    const vad = new VadChunker();
    expect(run(vad, speech(2000))).toEqual([]);
    expect(vad.open).toBe(true);
    expect(vad.current()?.audio.length).toBeGreaterThan(VAD_RATE);
    const flushed = vad.flush();
    expect(flushed).toHaveLength(1);
    expect(vad.open).toBe(false);
  });

  it('counts audio it is still holding, for the backlog', () => {
    const vad = new VadChunker();
    run(vad, speech(3000));
    expect(seconds(vad.pendingSamples)).toBeGreaterThan(2.5);
    expect(seconds(vad.receivedSamples)).toBeCloseTo(3, 1);
  });
});
