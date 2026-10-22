'use client';

import * as React from 'react';
import { NOTES_API } from '@/lib/notes/api';
import { clusterKeyFor } from '@/lib/transcribe/cluster';
import { streamMockCall } from '@/lib/transcribe/mock-script';
import {
  NOTES_LIMITS,
  type ConsentMethod,
  type MeetingResponse,
  type MeetingView,
  type SegmentUpload,
  type StopRecordingResponse,
  type SttTokenResponse,
  type TranscriptTrack,
  type UploadSegmentsResponse,
} from '@/lib/types/notes';
import { notesCall } from './api-client';

/**
 * The meeting page's recorder (D-076), in the order the contract sets:
 * POST /start with the consent step → POST /stt-token → lines posted to
 * /segments with a rising seq (a retried batch is safe) → /pause → /stop,
 * with the last lines posted first.
 *
 * In demo mode the speech provider is 'mock' and this plays the scripted,
 * fictional call from lib/transcribe/mock-script.ts. Live audio (microphone
 * plus the meeting tab, straight to the speech vendor) is the web recorder's
 * job (lib/capture, the capture workstream); until it is wired in here,
 * `liveCapture` is false and the page says so instead of offering Start on a
 * real provider. No audio is ever stored or sent to Copilot's server: only
 * finished lines of text.
 */

/** Flips to true when lib/capture's recorder is mounted behind this hook. */
export const LIVE_CAPTURE_AVAILABLE = false;

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
  /** Recording can run here: the mock in demo mode, or the live recorder once wired. */
  canRecord: boolean;
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
}

function initialPhase(meeting: MeetingView): RecorderPhase {
  if (meeting.status === 'recording' || meeting.status === 'paused') {
    return meeting.isRecorder ? 'interrupted' : 'recording';
  }
  if (meeting.status === 'processing' || meeting.status === 'ready') return 'stopped';
  return 'idle';
}

export function useRecorder(options: RecorderOptions): RecorderHandle {
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

  const canRecord = demo || LIVE_CAPTURE_AVAILABLE;

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
    if (minted.provider !== 'mock' && !LIVE_CAPTURE_AVAILABLE) {
      setError(
        'Live capture needs the browser recorder, which is not in this version yet. Stop, and use Granola for this call.',
      );
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
    const res = await notesCall<Omit<StopRecordingResponse, 'ok'>>(
      'POST',
      NOTES_API.stop(meetingId),
      { reason: 'user', recordedMs: Math.round(accumulated.current) },
    );
    if (!res.ok) {
      setError(res.message);
      setPhase('interrupted');
      return null;
    }
    latest.current.onMeeting(res.meeting);
    setPhase('stopped');
    return { ...res, ok: true };
  }, [flush, meetingId]);

  return { phase, elapsedMs, partial, error, callEnded, canRecord, start, pause, resume, stop };
}
