'use client';

import * as React from 'react';
import { NOTES_API } from '@/lib/notes/api';
import { meetingRecorder } from '@/lib/capture/recorder';
import { useMeetingRecorder, type MeetingRecorderApi } from '@/lib/capture/use-meeting-recorder';
import type { RecorderSnapshot } from '@/lib/capture/types';
import { clusterKeyFor } from '@/lib/transcribe/cluster';
import { streamMockCall } from '@/lib/transcribe/mock-script';
import {
  NOTES_LIMITS,
  type ApplyRosterRequest,
  type ConsentMethod,
  type MeetingResponse,
  type MeetingView,
  type SegmentUpload,
  type StopReason,
  type StopRecordingResponse,
  type SttTokenResponse,
  type TranscriptTrack,
  type UploadSegmentsResponse,
} from '@/lib/types/notes';
import { notesCall } from './api-client';

/**
 * The meeting page's recorder (D-076), in the order the contract sets:
 * POST /start with the consent step, POST /stt-token, lines posted to
 * /segments with a rising seq (a retried batch is safe), /pause, then /stop
 * with the last lines and the notepad saved first.
 *
 * Two engines sit behind one handle:
 * - 'live': the browser recorder (lib/capture). The microphone is the person
 *   at this computer, the shared meeting tab or screen is everyone else, each
 *   streamed straight to the speech vendor with a 60-second key. In demo mode
 *   it talks to the mock vendor, so the whole pipeline runs with no vendor.
 * - 'scripted': demo mode only. Plays the fictional call from
 *   lib/transcribe/mock-script.ts with no microphone at all, so the demo works
 *   on any machine and the screen tests need no fake devices.
 * No audio is ever stored or sent to Copilot's server: only finished lines of text.
 */

/** The browser recorder (lib/capture) is mounted behind this hook. */
export const LIVE_CAPTURE_AVAILABLE = true;

/** Which engine records: the browser recorder, or the demo's scripted call. */
export type CaptureEngine = 'live' | 'scripted';

export type RecorderPhase =
  'idle' | 'starting' | 'recording' | 'paused' | 'interrupted' | 'stopping' | 'stopped' | 'error';

export interface LivePartial {
  clusterKey: string;
  track: TranscriptTrack;
  text: string;
}

export interface StartInput {
  method: ConsentMethod;
  noticeText: string | null;
  /** 'call': the mic is you, the meeting audio is everyone else. 'in_person': one shared mic. */
  mode: 'call' | 'in_person';
}

export interface RecorderHandle {
  phase: RecorderPhase;
  elapsedMs: number;
  partial: LivePartial | null;
  error: string | null;
  /** The scripted call finished (demo); the recording stays on until Stop. */
  callEnded: boolean;
  /** Recording can run here: the browser can record (live), or demo mode (scripted). */
  canRecord: boolean;
  /** Why not, in plain words, when it cannot. */
  cannotRecordReason: string | null;
  /** The browser can hear a meeting tab or screen (Chrome or Edge on a computer). */
  callAudioAvailable: boolean;
  /** The browser recorder while it captures (meters, warnings); null for the scripted call. */
  capture: MeetingRecorderApi | null;
  start(input: StartInput): Promise<boolean>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<StopRecordingResponse | null>;
}

export interface RecorderOptions {
  meetingId: string;
  /** The meeting as the page last read it. */
  meeting: MeetingView;
  /** Where the last stored line ended, to pick up after a reload. */
  lastLineEndMs: number;
  demo: boolean;
  /** Playback speed of the scripted call (demo only). */
  mockSpeed: number;
  onMeeting(meeting: MeetingView): void;
  /** Lines were stored: refresh the transcript now. */
  onUploaded(): void;
  /** Runs before /stop: the notepad saves, so the notes job reads every typed word. */
  beforeStop?: () => Promise<void>;
  /** Which engine records (the page decides: 'scripted' only in demo mode). */
  engine: CaptureEngine;
  /** The recorder stopped by itself (silence, the call ended): read the notes as after Stop. */
  onAutoStopped?: (reason: StopReason) => void;
}

function initialPhase(meeting: MeetingView): RecorderPhase {
  if (meeting.status === 'recording' || meeting.status === 'paused') {
    return meeting.isRecorder ? 'interrupted' : 'recording';
  }
  if (meeting.status === 'processing' || meeting.status === 'ready') return 'stopped';
  return 'idle';
}

/**
 * The recorder the meeting page uses. Both engines are mounted (each is inert
 * until started) and the page's engine answers; the engine never changes for
 * the life of the page.
 */
export function useRecorder(options: RecorderOptions): RecorderHandle {
  const scripted = useScriptedRecorder(options, options.engine === 'scripted');
  const live = useLiveRecorder(options, options.engine === 'live');
  return options.engine === 'live' ? live : scripted;
}

type StopResult =
  { ok: true; value: Omit<StopRecordingResponse, 'ok'> } | { ok: false; message: string };

/** Tell the server to stop (the last lines and the notepad are saved by then). */
async function stopOnServer(
  meetingId: string,
  reason: StopReason,
  recordedMs: number,
): Promise<StopResult> {
  const res = await notesCall<Omit<StopRecordingResponse, 'ok'>>(
    'POST',
    NOTES_API.stop(meetingId),
    { reason, recordedMs: Math.max(0, Math.round(recordedMs)) },
  );
  return res.ok ? { ok: true, value: res } : { ok: false, message: res.message };
}

/* ============================================================ scripted == */

function useScriptedRecorder(options: RecorderOptions, enabled: boolean): RecorderHandle {
  const { meetingId, demo, mockSpeed } = options;
  const [phase, setPhase] = React.useState<RecorderPhase>(() => initialPhase(options.meeting));
  const [elapsedMs, setElapsedMs] = React.useState(options.meeting.recordedMs);
  const [partial, setPartial] = React.useState<LivePartial | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [callEnded, setCallEnded] = React.useState(false);

  const latest = React.useRef(options);
  React.useEffect(() => {
    latest.current = options;
  });

  const nextSeq = React.useRef((options.meeting.lastSeq ?? -1) + 1);
  const queue = React.useRef<SegmentUpload[]>([]);
  const inflight = React.useRef<Promise<void> | null>(null);
  const flushTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const abort = React.useRef<AbortController | null>(null);
  const clock = React.useRef(options.lastLineEndMs);
  const tracks = React.useRef<TranscriptTrack[]>(
    options.meeting.kind === 'in_person' ? ['mixed'] : ['mic', 'system'],
  );
  const accumulated = React.useRef(options.meeting.recordedMs);
  const runningSince = React.useRef<number | null>(null);

  // The scripted call is demo mode's alone.
  const canRecord = enabled && demo;

  // The visible timer: recorded time, pauses excluded.
  React.useEffect(() => {
    if (phase !== 'recording' || runningSince.current === null) return;
    const tick = () =>
      setElapsedMs(accumulated.current + (Date.now() - (runningSince.current ?? Date.now())));
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [phase]);

  const holdClock = () => {
    if (runningSince.current !== null) {
      accumulated.current += Date.now() - runningSince.current;
      runningSince.current = null;
    }
    setElapsedMs(accumulated.current);
  };

  // flush retries itself through this ref (a callback cannot name itself).
  const flushAgain = React.useRef<() => Promise<void>>(async () => {});
  const flush = React.useCallback(async (): Promise<void> => {
    if (inflight.current) return inflight.current;
    if (queue.current.length === 0) return;
    const batch = queue.current.slice(0, NOTES_LIMITS.maxSegmentsPerRequest);
    const run = (async () => {
      const res = await notesCall<Omit<UploadSegmentsResponse, 'ok'>>(
        'POST',
        NOTES_API.segments(meetingId),
        { segments: batch },
      );
      if (res.ok) {
        const sent = new Set(batch.map((b) => b.seq));
        queue.current = queue.current.filter((u) => !sent.has(u.seq));
        latest.current.onUploaded();
      } else {
        // Kept in memory and tried again: the seq makes a repeat harmless.
        if (!flushTimer.current) {
          flushTimer.current = setTimeout(() => {
            flushTimer.current = null;
            void flushAgain.current();
          }, 2_000);
        }
      }
    })();
    inflight.current = run;
    try {
      await run;
    } finally {
      inflight.current = null;
    }
    if (queue.current.length > 0 && !flushTimer.current) {
      flushTimer.current = setTimeout(() => {
        flushTimer.current = null;
        void flushAgain.current();
      }, 300);
    }
  }, [meetingId]);

  React.useEffect(() => {
    flushAgain.current = flush;
  }, [flush]);

  const scheduleFlush = React.useCallback(() => {
    if (flushTimer.current) return;
    flushTimer.current = setTimeout(() => {
      flushTimer.current = null;
      void flush();
    }, 400);
  }, [flush]);

  const mintSessions = React.useCallback(async (): Promise<boolean> => {
    const minted = await notesCall<Omit<SttTokenResponse, 'ok'>>(
      'POST',
      NOTES_API.sttToken(meetingId),
      { tracks: tracks.current },
    );
    if (!minted.ok) {
      setError(minted.message);
      return false;
    }
    if (minted.provider !== 'mock') {
      setError('The scripted demo call runs only in demo mode. Reload the page to record live.');
      return false;
    }
    return true;
  }, [meetingId]);

  const play = React.useCallback(
    async (fromMs: number) => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      setCallEnded(false);
      try {
        for await (const event of streamMockCall({
          tracks: tracks.current,
          speed: mockSpeed,
          partials: true,
          fromMs,
          signal: controller.signal,
        })) {
          const clusterKey = clusterKeyFor(event.track, event.speakerLabel);
          if (event.type === 'partial') {
            setPartial({ clusterKey, track: event.track, text: event.text });
            continue;
          }
          clock.current = event.endMs;
          setPartial(null);
          queue.current.push({
            seq: nextSeq.current++,
            track: event.track,
            clusterKey,
            vendorLabel: event.speakerLabel,
            startMs: event.startMs,
            endMs: event.endMs,
            text: event.text,
            confidence: event.confidence,
            isFinal: true,
          });
          scheduleFlush();
        }
        if (!controller.signal.aborted) setCallEnded(true);
      } finally {
        if (abort.current === controller) abort.current = null;
      }
    },
    [mockSpeed, scheduleFlush],
  );

  // Leaving the page stops the playback; lines already queued are posted.
  React.useEffect(
    () => () => {
      abort.current?.abort();
      if (flushTimer.current) clearTimeout(flushTimer.current);
    },
    [],
  );

  const start = React.useCallback(
    async (input: StartInput): Promise<boolean> => {
      if (!canRecord) return false;
      setError(null);
      setPhase('starting');
      tracks.current = input.mode === 'in_person' ? ['mixed'] : ['mic', 'system'];
      const started = await notesCall<Omit<MeetingResponse, 'ok'>>(
        'POST',
        NOTES_API.start(meetingId),
        {
          consent: { confirmed: true, method: input.method, noticeText: input.noticeText },
          captureSource: 'web',
          kind: input.mode === 'in_person' ? 'in_person' : undefined,
        },
      );
      if (!started.ok) {
        setError(started.message);
        setPhase('idle');
        return false;
      }
      latest.current.onMeeting(started.meeting);
      if (!(await mintSessions())) {
        setPhase('interrupted');
        return false;
      }
      accumulated.current = started.meeting.recordedMs;
      runningSince.current = Date.now();
      setPhase('recording');
      void play(clock.current);
      return true;
    },
    [canRecord, meetingId, mintSessions, play],
  );

  const pause = React.useCallback(async () => {
    abort.current?.abort();
    setPartial(null);
    holdClock();
    setPhase('paused');
    void flush();
    const res = await notesCall<Omit<MeetingResponse, 'ok'>>('POST', NOTES_API.pause(meetingId), {
      paused: true,
    });
    if (res.ok) latest.current.onMeeting(res.meeting);
    else setError(res.message);
  }, [flush, meetingId]);

  const resume = React.useCallback(async () => {
    setError(null);
    const current = latest.current.meeting;
    if (current.status === 'paused' || phase === 'paused') {
      const res = await notesCall<Omit<MeetingResponse, 'ok'>>('POST', NOTES_API.pause(meetingId), {
        paused: false,
      });
      if (!res.ok) {
        setError(res.message);
        return;
      }
      latest.current.onMeeting(res.meeting);
    }
    // A fresh key on every reconnect: the old one only opened the old socket.
    if (!(await mintSessions())) return;
    if (phase === 'interrupted') {
      clock.current = Math.max(clock.current, latest.current.lastLineEndMs);
      nextSeq.current = Math.max(nextSeq.current, (current.lastSeq ?? -1) + 1);
    }
    runningSince.current = Date.now();
    setPhase('recording');
    void play(clock.current);
  }, [meetingId, mintSessions, phase, play]);

  const stop = React.useCallback(async (): Promise<StopRecordingResponse | null> => {
    abort.current?.abort();
    setPartial(null);
    holdClock();
    setPhase('stopping');
    // The last lines first, then the notepad, then Stop (which writes the notes).
    for (let i = 0; i < 5 && (queue.current.length > 0 || inflight.current); i++) {
      if (flushTimer.current) {
        clearTimeout(flushTimer.current);
        flushTimer.current = null;
      }
      await flush();
    }
    await latest.current.beforeStop?.();
    const res = await stopOnServer(meetingId, 'user', accumulated.current);
    if (!res.ok) {
      setError(res.message);
      setPhase('interrupted');
      return null;
    }
    latest.current.onMeeting(res.value.meeting);
    setPhase('stopped');
    return { ...res.value, ok: true };
  }, [flush, meetingId]);

  return {
    phase,
    elapsedMs,
    partial,
    error,
    callEnded,
    canRecord,
    cannotRecordReason: canRecord ? null : 'The scripted call runs only in demo mode.',
    callAudioAvailable: true,
    capture: null,
    start,
    pause,
    resume,
    stop,
  };
}

/* ================================================================ live == */

const ROSTER_EVERY_MS = 20_000;

function livePhase(status: RecorderSnapshot['status'], meeting: MeetingView): RecorderPhase {
  const serverLive = meeting.status === 'recording' || meeting.status === 'paused';
  const done = meeting.status === 'processing' || meeting.status === 'ready';
  switch (status) {
    case 'starting':
    case 'recording':
    case 'paused':
    case 'stopping':
    case 'stopped':
      return status;
    case 'idle':
    case 'error':
      // Nothing captures in this tab: a recording on the server was interrupted
      // (a reload, a closed tab) for its recorder, and is live for a viewer.
      if (serverLive) return meeting.isRecorder ? 'interrupted' : 'recording';
      return done ? 'stopped' : 'idle';
  }
}

/** The words being said right now: the newest partial across the tracks. */
function newestPartial(state: RecorderSnapshot): LivePartial | null {
  let best: LivePartial | null = null;
  let bestEnd = -1;
  for (const line of Object.values(state.partials)) {
    if (!line || !line.text.trim() || line.endMs < bestEnd) continue;
    bestEnd = line.endMs;
    best = { clusterKey: line.clusterKey, track: line.track, text: line.text };
  }
  return best;
}

function useLiveRecorder(options: RecorderOptions, enabled: boolean): RecorderHandle {
  const { meetingId, demo, mockSpeed } = options;
  const rec = useMeetingRecorder({
    meetingId,
    mode: options.meeting.kind === 'in_person' ? 'mic_only' : 'call',
    // Demo mode plays the mock vendor faster than real time.
    tuning: demo ? { mockSpeed } : undefined,
  });
  const state = rec.state;
  const latest = React.useRef(options);
  React.useEffect(() => {
    latest.current = options;
  });
  const userStopping = React.useRef(false);

  // The server's meeting after each start, pause and stop, and every stored line.
  React.useEffect(() => {
    if (enabled && state.meeting) latest.current.onMeeting(state.meeting);
  }, [enabled, state.meeting]);
  React.useEffect(() => {
    if (enabled && state.upload.lastSeq !== null) latest.current.onUploaded();
  }, [enabled, state.upload.lastSeq]);

  // A stop the recorder made by itself (15 minutes of silence, the call ended).
  const previous = React.useRef(state.status);
  React.useEffect(() => {
    const was = previous.current;
    previous.current = state.status;
    if (!enabled || userStopping.current) return;
    if (state.status === 'stopped' && was !== 'stopped' && state.stopReason) {
      latest.current.onAutoStopped?.(state.stopReason);
    }
  }, [enabled, state.status, state.stopReason]);

  // The Meet extension's names (opt-in, consented recordings only) go to the
  // naming ladder as the meeting app's roster: names and times, never stored.
  const postedRoster = React.useRef('');
  const postRoster = React.useCallback(async () => {
    const intervals = meetingRecorder(meetingId).getSnapshot().roster.intervals;
    const last = intervals.at(-1);
    if (!last) return;
    const key = `${intervals.length}:${last.endMs}`;
    if (key === postedRoster.current) return;
    postedRoster.current = key;
    const body: ApplyRosterRequest = {
      turns: intervals.slice(-5000).map((iv) => {
        const startMs = Math.max(0, Math.round(iv.startMs));
        return {
          name: iv.name.trim().slice(0, 200) || 'Guest',
          startMs,
          endMs: Math.max(startMs, Math.round(iv.endMs)),
        };
      }),
    };
    await notesCall('POST', NOTES_API.roster(meetingId), body);
  }, [meetingId]);
  React.useEffect(() => {
    if (!enabled || state.status !== 'recording' || !state.roster.connected) return;
    const timer = setInterval(() => void postRoster(), ROSTER_EVERY_MS);
    return () => clearInterval(timer);
  }, [enabled, state.status, state.roster.connected, postRoster]);

  const caps = state.capabilities;
  const canRecord = enabled && caps.microphone && caps.audioWorklet;
  const meeting = options.meeting;
  const phase = livePhase(state.status, meeting);
  const capturing = ['recording', 'paused', 'stopping', 'stopped'].includes(state.status);

  /** Start the browser recorder. Called straight from the click: the share picker needs it. */
  const startCapture = (method: ConsentMethod, noticeText: string | null, inPerson: boolean) => {
    rec.setMode(inPerson ? 'mic_only' : 'call');
    return rec.start({
      consent: { confirmed: true, method, noticeText },
      ...(inPerson ? { kind: 'in_person' as const } : {}),
    });
  };

  const start = async (input: StartInput): Promise<boolean> =>
    canRecord ? startCapture(input.method, input.noticeText, input.mode === 'in_person') : false;

  const pause = async () => {
    await rec.pause();
  };

  const resume = async () => {
    if (state.status === 'paused') {
      await rec.resume();
      return;
    }
    // After a reload: the recorder starts again on the same meeting, which
    // keeps its consent, its lines and its clock.
    const m = latest.current.meeting;
    await startCapture(m.consent.method ?? 'other', null, m.kind === 'in_person');
  };

  const stop = async (): Promise<StopRecordingResponse | null> => {
    userStopping.current = true;
    try {
      await latest.current.beforeStop?.();
      await postRoster().catch(() => undefined);
      const running = state.status === 'recording' || state.status === 'paused';
      if (!running) {
        // Nothing captures in this tab (interrupted by a reload): stop on the server.
        const res = await stopOnServer(meetingId, 'user', latest.current.meeting.recordedMs);
        if (!res.ok) return null;
        latest.current.onMeeting(res.value.meeting);
        return { ...res.value, ok: true };
      }
      await rec.stop('user');
      const after = meetingRecorder(meetingId).getSnapshot();
      const m = after.meeting;
      if (after.status !== 'stopped' || !m || (m.status !== 'processing' && m.status !== 'ready')) {
        return null;
      }
      latest.current.onMeeting(m);
      return { ok: true, meeting: m, finalize: { queued: true } };
    } finally {
      userStopping.current = false;
    }
  };

  const err = state.error;
  return {
    phase,
    elapsedMs: capturing ? state.elapsedMs : meeting.recordedMs,
    partial: newestPartial(state),
    error: err ? [err.message, err.stillUsable].filter(Boolean).join(' ') : null,
    callEnded: false,
    canRecord,
    cannotRecordReason: canRecord
      ? null
      : 'This browser cannot record. Use Chrome on a computer, or Safari on an iPhone.',
    callAudioAvailable: caps.meetingAudio,
    capture: enabled ? rec : null,
    start,
    pause,
    resume,
    stop,
  };
}
