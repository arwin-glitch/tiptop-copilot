import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiResult } from '@/lib/capture/api-client';
import type { PcmChunk } from '@/lib/capture/audio-graph';
import { MeetingRecorder, type GraphLike, type RecorderDeps } from '@/lib/capture/recorder';
import type { RecorderCapabilities, RecorderTuning } from '@/lib/capture/types';
import { mockTranscriptEvents } from '@/lib/transcribe/mock-script';
import type {
  MeetingView,
  SegmentUpload,
  SttSession,
  TranscriptTrack,
  UploadSegmentsResponse,
} from '@/lib/types/notes';
import { NEVER_RECORD_MESSAGE } from '@/lib/types/notes';

/**
 * The web recorder end to end in Node (D-076, WS3), with stand-ins for the
 * devices, the audio graph and the server, and the real mock vendor:
 * consent before anything, nothing captured when the server refuses, lines
 * uploaded in order, pause closing the sockets, resume with fresh keys, and
 * stop draining before it tells the server.
 */

const SPEED = 10;
const MEETING = '00000000-0000-4000-8000-00000000f001';

class FakeTrack {
  enabled = true;
  stopped = false;
  private listeners = new Map<string, (() => void)[]>();
  addEventListener(type: string, l: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), l]);
  }
  stop() {
    this.stopped = true;
  }
  fire(type: string) {
    for (const l of this.listeners.get(type) ?? []) l();
  }
}

class FakeStream {
  readonly track = new FakeTrack();
  getAudioTracks() {
    return [this.track];
  }
  getTracks() {
    return [this.track];
  }
}

class FakeGraph implements GraphLike {
  sampleRate = 16000;
  frame = 0;
  closed = false;
  handlers = new Map<TranscriptTrack, (c: PcmChunk) => void>();
  active = new Map<TranscriptTrack, boolean>();
  get currentFrame() {
    return this.frame;
  }
  attach(track: TranscriptTrack, _s: MediaStream, onChunk: (c: PcmChunk) => void, active = true) {
    this.handlers.set(track, onChunk);
    this.active.set(track, active);
  }
  setActive(track: TranscriptTrack, a: boolean) {
    this.active.set(track, a);
  }
  setAllActive(a: boolean) {
    for (const t of this.handlers.keys()) this.active.set(t, a);
  }
  detach(track: TranscriptTrack) {
    this.handlers.delete(track);
  }
  has(track: TranscriptTrack) {
    return this.handlers.has(track);
  }
  async resume() {}
  async close() {
    this.closed = true;
  }
  /** One 100 ms render of every attached, active track. */
  tick(rms: Partial<Record<TranscriptTrack, number>> = {}) {
    for (const [track, h] of this.handlers) {
      if (this.active.get(track) === false) continue;
      const level = rms[track] ?? 0.2;
      h({ track, frame: this.frame, samples: new Int16Array(1600), rms: level, peak: level });
    }
    this.frame += 1600;
  }
}

const meetingView = (over: Partial<MeetingView> = {}): MeetingView => ({
  id: MEETING,
  qualifiedId: `copilot:${MEETING}`,
  title: 'Demo call',
  kind: 'video',
  platform: null,
  captureSource: 'web',
  status: 'recording',
  providerEventId: null,
  recurringEventId: null,
  calendarId: null,
  scheduledStart: null,
  scheduledEnd: null,
  startedAt: '2026-10-22T12:00:00.000Z',
  endedAt: null,
  recordedMs: 0,
  visibility: 'private',
  folderId: null,
  templateId: null,
  recordedBy: null,
  isRecorder: true,
  consent: { state: 'confirmed', method: 'chat_notice', at: null, neverRecord: null },
  lastSeq: null,
  injectionFlagged: false,
  deletedAt: null,
  createdAt: '2026-10-22T12:00:00.000Z',
  updatedAt: '2026-10-22T12:00:00.000Z',
  ...over,
});

const ok = <T>(value: T): ApiResult<T> => ({ ok: true, value });

function setup(
  opts: {
    startRefusal?: 'never_record';
    mode?: 'call' | 'mic_only';
    tuning?: Partial<RecorderTuning>;
  } = {},
) {
  const calls: string[] = [];
  const stored = new Map<number, SegmentUpload>();
  const graphs: FakeGraph[] = [];
  const streams: FakeStream[] = [];
  let minted = 0;
  const caps: RecorderCapabilities = {
    microphone: true,
    meetingAudio: true,
    audioWorklet: true,
    wakeLock: true,
    ios: false,
    standalone: false,
    mobile: false,
    platform: 'windows',
  };
  const session = (track: TranscriptTrack): SttSession => ({
    track,
    provider: 'mock',
    wsUrl: null,
    token: `mock_${(minted += 1)}`,
    expiresAt: '2026-10-22T12:01:00.000Z',
    sessionConfig: { script: 'acme-intro', track },
    audio: { sampleRate: 16000, encoding: 'pcm_s16le', channels: 1 },
  });
  const wake = { held: 0, released: 0 };
  const deps: Partial<RecorderDeps> = {
    capabilities: () => caps,
    microphone: async () => {
      calls.push('mic');
      const s = new FakeStream();
      streams.push(s);
      return s as unknown as MediaStream;
    },
    meetingAudio: async () => {
      calls.push('share');
      const s = new FakeStream();
      streams.push(s);
      return s as unknown as MediaStream;
    },
    createGraph: async () => {
      const g = new FakeGraph();
      graphs.push(g);
      return g;
    },
    wakeLock: {
      supported: true,
      hold: async () => {
        wake.held += 1;
        return true;
      },
      release: async () => {
        wake.released += 1;
      },
    },
    isOnline: () => true,
    win: null,
    doc: null,
    now: () => Date.now(),
    client: {
      start: async (_id, body) => {
        calls.push(`start:${body.consent.method}`);
        if (opts.startRefusal === 'never_record') {
          return {
            ok: false,
            error: {
              code: 'forbidden',
              message: NEVER_RECORD_MESSAGE,
              status: 403,
              retryable: false,
              details: { never_record: 'Legal' },
            },
          };
        }
        return ok({ ok: true as const, meeting: meetingView() });
      },
      pause: async (_id, paused) => {
        calls.push(`pause:${paused}`);
        return ok({
          ok: true as const,
          meeting: meetingView({ status: paused ? 'paused' : 'recording' }),
        });
      },
      stop: async (_id, body) => {
        calls.push(`stop:${body.reason}:${body.recordedMs}`);
        return ok({
          ok: true as const,
          meeting: meetingView({ status: 'processing' }),
          finalize: { queued: true },
        });
      },
      sttToken: async (_id, tracks) => {
        calls.push(`token:${tracks.join('+')}`);
        return ok({ ok: true as const, provider: 'mock' as const, sessions: tracks.map(session) });
      },
      uploadSegments: async (_id, segments) => {
        calls.push(`segments:${segments.length}`);
        let accepted = 0;
        for (const s of segments) {
          if (!stored.has(s.seq)) {
            stored.set(s.seq, s);
            accepted += 1;
          }
        }
        const value: UploadSegmentsResponse = {
          ok: true,
          accepted,
          duplicates: segments.length - accepted,
          dropped: 0,
          lastSeq: Math.max(...stored.keys()),
          speakers: [],
        };
        return ok(value);
      },
      listSegments: async () =>
        ok({
          ok: true as const,
          segments: [],
          speakers: [],
          lastSeq: null,
          status: 'recording' as const,
        }),
    },
  };
  const recorder = new MeetingRecorder(MEETING, {
    mode: opts.mode ?? 'call',
    tuning: { mockSpeed: SPEED, uploadIntervalMs: 100, unmountPauseMs: 50, ...opts.tuning },
    deps,
  });
  const graph = () => graphs[graphs.length - 1]!;
  const run = async (seconds: number, rms?: Partial<Record<TranscriptTrack, number>>) => {
    for (let i = 0; i < seconds * 10; i += 1) {
      graph().tick(rms);
      await vi.advanceTimersByTimeAsync(2);
    }
  };
  return { recorder, calls, stored, graphs, graph, streams, run, wake, caps };
}

const consent = { confirmed: true as const, method: 'chat_notice' as const };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the meeting recorder', () => {
  it('refuses to start without the consent step, before touching any device', async () => {
    const t = setup();
    const started = await t.recorder.start({ consent: { confirmed: false } } as never);
    expect(started).toBe(false);
    expect(t.calls).toEqual([]);
    expect(t.recorder.getSnapshot()).toMatchObject({
      status: 'error',
      error: { code: 'consent_required' },
    });
  });

  it('asks for the devices, then the server, then the keys: in that order', async () => {
    const t = setup();
    const started = await t.recorder.start({ consent });
    expect(started).toBe(true);
    expect(t.calls.slice(0, 4)).toEqual(['share', 'mic', 'start:chat_notice', 'token:mic+system']);
    expect(t.recorder.getSnapshot().status).toBe('recording');
    expect(t.wake.held).toBe(1);
  });

  it('a never-record meeting releases the devices and sends no audio anywhere', async () => {
    const t = setup({ startRefusal: 'never_record' });
    expect(await t.recorder.start({ consent })).toBe(false);
    expect(t.calls).toEqual(['share', 'mic', 'start:chat_notice']);
    expect(t.streams.every((s) => s.track.stopped)).toBe(true);
    expect(t.graphs[0]?.closed).toBe(true);
    expect(t.recorder.getSnapshot().error).toMatchObject({
      code: 'never_record',
      message: NEVER_RECORD_MESSAGE,
    });
  });

  it('records the call: both meters move, lines upload with a rising seq', async () => {
    const t = setup();
    await t.recorder.start({ consent });
    await vi.advanceTimersByTimeAsync(50); // sockets open
    await t.run(14);
    await vi.advanceTimersByTimeAsync(300);
    const snap = t.recorder.getSnapshot();
    expect(snap.tracks.mic?.level).toBeGreaterThan(0);
    expect(snap.tracks.system?.level).toBeGreaterThan(0);
    expect(snap.tracks.mic?.socket).toBe('open');
    const seqs = [...t.stored.keys()];
    expect(seqs).toEqual(seqs.map((_, i) => i));
    const texts = [...t.stored.values()].map((s) => s.text);
    const script = mockTranscriptEvents(['mic', 'system']).map((e) => e.text);
    expect(new Set(texts)).toEqual(new Set(script));
    expect(texts).toHaveLength(script.length);
    expect(
      [...t.stored.values()].filter((s) => s.track === 'mic').every((s) => s.clusterKey === 'mic'),
    ).toBe(true);
    expect([...t.stored.values()].find((s) => s.track === 'system')?.clusterKey).toBe('sys:S1');
    expect(snap.lines.length).toBe(script.length);
    expect(snap.lines.every((l) => l.seq !== null)).toBe(true);
  });

  it('pause closes the sockets and stops listening; resume asks for fresh keys', async () => {
    const t = setup();
    await t.recorder.start({ consent });
    await vi.advanceTimersByTimeAsync(50);
    await t.run(2);
    const pausing = t.recorder.pause();
    await vi.advanceTimersByTimeAsync(50); // the sockets finish their last lines
    await pausing;
    let snap = t.recorder.getSnapshot();
    expect(snap.status).toBe('paused');
    expect(snap.tracks.mic?.socket).toBe('closed');
    expect(snap.tracks.system?.socket).toBe('closed');
    expect(t.calls).toContain('pause:true');
    expect(t.graph().active.get('mic')).toBe(false);
    expect(t.streams.every((s) => s.track.enabled === false)).toBe(true);
    const heard = snap.elapsedMs;
    await t.run(2); // nothing is taken while paused
    expect(t.recorder.getSnapshot().elapsedMs).toBe(heard);

    await t.recorder.resume();
    await vi.advanceTimersByTimeAsync(200);
    snap = t.recorder.getSnapshot();
    expect(snap.status).toBe('recording');
    expect(t.calls.filter((c) => c.startsWith('token:'))).toEqual([
      'token:mic+system',
      'token:mic+system',
    ]);
    expect(t.calls).toContain('pause:false');
    expect(snap.tracks.mic?.socket).toBe('open');
  });

  it('stop drains the lines, then tells the server with the recorded time', async () => {
    const t = setup();
    await t.recorder.start({ consent });
    await vi.advanceTimersByTimeAsync(50);
    await t.run(5);
    const stopping = t.recorder.stop('user');
    await vi.advanceTimersByTimeAsync(500);
    await stopping;
    const snap = t.recorder.getSnapshot();
    expect(snap.status).toBe('stopped');
    expect(snap.stopReason).toBe('user');
    const stopCall = t.calls.find((c) => c.startsWith('stop:'));
    expect(stopCall).toBe('stop:user:5000');
    // Every segment upload came before the stop.
    expect(t.calls.lastIndexOf('stop:user:5000')).toBeGreaterThan(
      t.calls.map((c) => c.startsWith('segments:')).lastIndexOf(true),
    );
    expect(t.streams.every((s) => s.track.stopped)).toBe(true);
    expect(t.graph().closed).toBe(true);
    expect(t.wake.released).toBeGreaterThan(0);
  });

  it('warns when there is no meeting audio, and clears it when sound arrives', async () => {
    const t = setup({ tuning: { noMeetingAudioWarningMs: 1000 } });
    await t.recorder.start({ consent });
    await vi.advanceTimersByTimeAsync(50);
    await t.run(1.5, { system: 0 });
    await vi.advanceTimersByTimeAsync(100);
    expect(t.recorder.getSnapshot().warnings.map((w) => w.code)).toContain('no_meeting_audio');
    await t.run(0.2, { system: 0.3 });
    await vi.advanceTimersByTimeAsync(100);
    expect(t.recorder.getSnapshot().warnings.map((w) => w.code)).not.toContain('no_meeting_audio');
  });

  it('stops itself after the silence limit', async () => {
    const t = setup({ tuning: { silenceAutoStopMs: 2000, silenceAutoStopWarningMs: 500 } });
    await t.recorder.start({ consent });
    await vi.advanceTimersByTimeAsync(50);
    await t.run(1.7, { mic: 0, system: 0 });
    await vi.advanceTimersByTimeAsync(100);
    expect(t.recorder.getSnapshot().warnings.map((w) => w.code)).toContain('silence_autostop_soon');
    await t.run(0.5, { mic: 0, system: 0 });
    await vi.advanceTimersByTimeAsync(500);
    const snap = t.recorder.getSnapshot();
    expect(snap.status).toBe('stopped');
    expect(snap.stopReason).toBe('silence');
    expect(t.calls.find((c) => c.startsWith('stop:'))).toMatch(/^stop:silence:/);
  });

  it('when sharing stops it says so, and sharing again picks the meeting back up', async () => {
    const t = setup();
    await t.recorder.start({ consent });
    await vi.advanceTimersByTimeAsync(50);
    const shared = t.streams[0]!;
    shared.track.fire('ended');
    await vi.advanceTimersByTimeAsync(50);
    let snap = t.recorder.getSnapshot();
    expect(snap.warnings.find((w) => w.code === 'meeting_audio_ended')?.action).toBe('share_again');
    expect(snap.tracks.system?.live).toBe(false);
    expect(await t.recorder.shareMeetingAudioAgain()).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    snap = t.recorder.getSnapshot();
    expect(snap.tracks.system?.live).toBe(true);
    expect(snap.warnings.map((w) => w.code)).not.toContain('meeting_audio_ended');
    expect(t.calls.filter((c) => c === 'token:system')).toHaveLength(1);
  });

  it('records one diarized track in mic-only mode', async () => {
    const t = setup({ mode: 'mic_only' });
    await t.recorder.start({ consent });
    expect(t.calls).not.toContain('share');
    expect(t.calls).toContain('token:mixed');
    await vi.advanceTimersByTimeAsync(50);
    await t.run(14);
    await vi.advanceTimersByTimeAsync(300);
    const keys = new Set([...t.stored.values()].map((s) => s.clusterKey));
    expect([...keys].every((k) => k.startsWith('mix:'))).toBe(true);
    expect(keys.size).toBe(4);
  });

  it('leaving the page pauses the recording and lets go of the devices', async () => {
    const t = setup();
    const unsubscribe = t.recorder.subscribe(() => undefined);
    await t.recorder.start({ consent });
    await vi.advanceTimersByTimeAsync(50);
    unsubscribe();
    await vi.advanceTimersByTimeAsync(200);
    const snap = t.recorder.getSnapshot();
    expect(snap.status).toBe('paused');
    expect(snap.warnings.find((w) => w.code === 'left_page')?.action).toBe('resume');
    expect(t.streams.every((s) => s.track.stopped)).toBe(true);
    expect(t.calls).toContain('pause:true');
    // Coming back and pressing Resume asks for the devices again.
    t.recorder.subscribe(() => undefined);
    expect(await t.recorder.resume()).toBe(true);
    expect(t.calls.filter((c) => c === 'mic')).toHaveLength(2);
    expect(t.recorder.getSnapshot().status).toBe('recording');
  });

  it('a refusal to save lines for good stops the recording', async () => {
    const t = setup();
    await t.recorder.start({ consent });
    await vi.advanceTimersByTimeAsync(50);
    const deps = (t.recorder as unknown as { depsOverride: Partial<RecorderDeps> }).depsOverride;
    deps.client!.uploadSegments = async () => ({
      ok: false,
      error: {
        code: 'conflict',
        message: 'This meeting is not being recorded.',
        status: 409,
        retryable: false,
      },
    });
    await t.run(6);
    await vi.advanceTimersByTimeAsync(4000);
    const snap = t.recorder.getSnapshot();
    expect(snap.status).toBe('error');
    expect(snap.error?.code).toBe('conflict');
  });
});
