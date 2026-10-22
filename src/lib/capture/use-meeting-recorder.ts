'use client';

import * as React from 'react';
import type { StopReason, TranscriptTrack } from '@/lib/types/notes';
import { meetingRecorder, type RecorderOptions } from './recorder';
import type {
  RecorderMode,
  RecorderSnapshot,
  RecorderTuning,
  RecorderWarningCode,
  StartOptions,
} from './types';

/**
 * The meeting page's recorder (D-076, WS3), as a React hook.
 *
 *   const rec = useMeetingRecorder({ meetingId, mode: 'call' });
 *   // From the Start click, after the consent box is ticked:
 *   rec.start({ consent: { confirmed: true, method: 'chat_notice' } });
 *   rec.state.status, rec.state.tracks.mic?.level, rec.state.lines, rec.state.warnings …
 *
 * start(), resume() and shareMeetingAudioAgain() must be called from a click:
 * the browser shows the share picker only then. start() refuses unless the
 * consent step is confirmed, and nothing is captured before the server has
 * logged that consent and checked the never-record list.
 *
 * Leaving the page pauses the recording and lets go of the microphone (pass
 * keepAliveWhenUnmounted to carry on across pages; then show a recording
 * indicator wherever the person goes). Speaker names come from
 * `state.speakers` (the server's SpeakerView list) by each line's clusterKey.
 */

export interface UseMeetingRecorderOptions {
  meetingId: string;
  mode?: RecorderMode;
  tuning?: Partial<RecorderTuning>;
  keepAliveWhenUnmounted?: boolean;
  /** Tests only: stand-ins for the browser and the server. */
  deps?: RecorderOptions['deps'];
}

export interface MeetingRecorderApi {
  state: RecorderSnapshot;
  start: (options: StartOptions) => Promise<boolean>;
  pause: () => Promise<boolean>;
  resume: () => Promise<boolean>;
  stop: (reason?: StopReason) => Promise<boolean>;
  shareMeetingAudioAgain: () => Promise<boolean>;
  retryMicrophone: () => Promise<boolean>;
  dismissWarning: (code: RecorderWarningCode) => void;
  setMode: (mode: RecorderMode) => void;
  /** "Remember this voice": one voice's voiceprint from this computer's speech worker, or null. */
  voiceIdentifiers: (
    track: TranscriptTrack,
    vendorLabel: string,
  ) => Promise<{ identifiers: string[]; modelVersion: string } | null>;
}

export function useMeetingRecorder(options: UseMeetingRecorderOptions): MeetingRecorderApi {
  const { meetingId, mode, tuning, keepAliveWhenUnmounted, deps } = options;
  // One recorder per meeting for the life of the page; options are read when it is made.
  const recorder = React.useMemo(
    () => meetingRecorder(meetingId, { mode, tuning, keepAliveWhenUnmounted, deps }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [meetingId],
  );
  React.useEffect(() => {
    if (mode) recorder.setMode(mode);
  }, [recorder, mode]);
  const state = React.useSyncExternalStore(
    recorder.subscribe,
    recorder.getSnapshot,
    recorder.getServerSnapshot,
  );
  return React.useMemo(
    () => ({
      state,
      start: (o: StartOptions) => recorder.start(o),
      pause: () => recorder.pause(),
      resume: () => recorder.resume(),
      stop: (reason?: StopReason) => recorder.stop(reason),
      shareMeetingAudioAgain: () => recorder.shareMeetingAudioAgain(),
      retryMicrophone: () => recorder.retryMicrophone(),
      dismissWarning: (code: RecorderWarningCode) => recorder.dismissWarning(code),
      setMode: (m: RecorderMode) => recorder.setMode(m),
      voiceIdentifiers: (track: TranscriptTrack, label: string) =>
        recorder.voiceIdentifiers(track, label),
    }),
    [recorder, state],
  );
}
