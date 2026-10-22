import type {
  ConsentMethod,
  CaptureSource,
  MeetingKind,
  MeetingView,
  SpeakerView,
  StopReason,
  TranscriberProvider,
  TranscriptTrack,
} from '@/lib/types/notes';
import { NOTES_LIMITS } from '@/lib/types/notes';

/**
 * The web recorder's own shapes (D-076, WS3). Client-safe: no server import.
 *
 * The recorder captures audio in the browser and streams it straight to the
 * speech vendor; the server only mints short-lived keys and stores finished
 * lines. Nothing here carries audio beyond the in-memory reconnect buffer,
 * which is never written anywhere.
 */

/**
 * 'call': two tracks, the microphone (the person at this computer) and the
 * meeting audio from a shared tab or screen (everyone else).
 * 'mic_only': one diarized track from the microphone alone, for in-person
 * meetings, phones (the iPhone Home Screen app) and Zoom desktop on a Mac.
 */
export type RecorderMode = 'call' | 'mic_only';

export type RecorderStatus =
  'idle' | 'starting' | 'recording' | 'paused' | 'stopping' | 'stopped' | 'error';

/** One speech socket's state, as the UI shows it. */
export type SocketState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed' | 'failed';

export interface TrackSnapshot {
  track: TranscriptTrack;
  /** 0..1, smoothed for a meter. */
  level: number;
  /** The capture is live (false after the browser ended it, e.g. "Stop sharing"). */
  live: boolean;
  /** The device muted the track (an iPhone with its screen off, another app took the mic). */
  muted: boolean;
  socket: SocketState;
  /** How long this track has heard nothing, in ms. */
  silentMs: number;
  /** Audio received on this track, in ms of the recording. */
  heardMs: number;
}

export type RecorderWarningCode =
  | 'no_meeting_audio'
  | 'meeting_audio_ended'
  | 'mic_ended'
  | 'track_muted'
  | 'offline'
  | 'reconnecting'
  | 'audio_gap'
  | 'upload_retrying'
  | 'uploads_pending'
  | 'silence_autostop_soon'
  | 'screen_was_off'
  | 'keep_screen_open'
  | 'left_page';

export interface RecorderWarning {
  code: RecorderWarningCode;
  message: string;
  track?: TranscriptTrack;
  /** What the person can do about it, when there is a button for it. */
  action?: 'share_again' | 'retry_mic' | 'resume';
}

export interface RecorderError {
  code: string;
  message: string;
  stillUsable?: string;
}

/** A transcript line as the live view shows it, before the server has it or after. */
export interface LiveLine {
  /** Stable for React keys: `${track}:${startMs}`. */
  key: string;
  track: TranscriptTrack;
  clusterKey: string;
  speakerLabel: string | null;
  startMs: number;
  endMs: number;
  text: string;
  final: boolean;
  /** Set once the line has a seq (it is queued for, or stored by, the server). */
  seq: number | null;
}

export interface UploadSnapshot {
  /** Lines waiting to reach the server. */
  pending: number;
  /** The highest seq the server has confirmed. */
  lastSeq: number | null;
  /** The last attempt failed and a retry is scheduled. */
  retrying: boolean;
  /** A refusal that retrying cannot fix (the meeting was stopped elsewhere, Notes turned off). */
  fatal: RecorderError | null;
}

export interface RecorderCapabilities {
  /** getUserMedia exists (and the page is a secure context). */
  microphone: boolean;
  /** getDisplayMedia exists: Chrome or Edge on a computer. Never on a phone. */
  meetingAudio: boolean;
  audioWorklet: boolean;
  wakeLock: boolean;
  /** iPhone or iPad (Safari or the Home Screen app). */
  ios: boolean;
  /** Opened from the Home Screen (display-mode: standalone). */
  standalone: boolean;
  /** A phone or tablet: the recorder must stay in the foreground. */
  mobile: boolean;
  platform: 'windows' | 'mac' | 'chromeos' | 'linux' | 'ios' | 'android' | 'other';
}

/** A name from the Meet extension, lined up with the recording's clock. */
export interface RosterInterval {
  name: string;
  startMs: number;
  endMs: number;
}

export interface RosterSnapshot {
  /** The extension is installed, switched on, and talking to this page. */
  connected: boolean;
  participants: string[];
  intervals: RosterInterval[];
}

export interface RecorderSnapshot {
  meetingId: string;
  status: RecorderStatus;
  mode: RecorderMode;
  provider: TranscriberProvider | null;
  /** Recorded time, pauses excluded. */
  elapsedMs: number;
  tracks: Partial<Record<TranscriptTrack, TrackSnapshot>>;
  warnings: RecorderWarning[];
  /** Finished lines, oldest first (the most recent LIVE_LINES_KEPT). */
  lines: LiveLine[];
  /** The words being said right now, per track. */
  partials: Partial<Record<TranscriptTrack, LiveLine>>;
  /** The meeting's voices, from the server's last answer: names by clusterKey. */
  speakers: SpeakerView[];
  upload: UploadSnapshot;
  error: RecorderError | null;
  stopReason: StopReason | null;
  /** The server's meeting after the last start, pause or stop. */
  meeting: MeetingView | null;
  roster: RosterSnapshot;
  capabilities: RecorderCapabilities;
}

/** What start() needs: the consent step, confirmed by the person, and where it records from. */
export interface StartOptions {
  consent: { confirmed: true; method: ConsentMethod; noticeText?: string | null };
  captureSource?: CaptureSource;
  kind?: MeetingKind;
}

/** The numbers the recorder runs on. Tests and the demo shorten them; production uses these. */
export interface RecorderTuning {
  uploadIntervalMs: number;
  reconnectBufferMs: number;
  noMeetingAudioWarningMs: number;
  silenceAutoStopMs: number;
  /** The "stopping soon" warning shows this long before a silence auto-stop. */
  silenceAutoStopWarningMs: number;
  /** After the shared tab or screen ends, stop when the mic has also been quiet this long. */
  callEndedGraceMs: number;
  /** RMS above this counts as sound (about -48 dBFS). */
  silenceThreshold: number;
  /** A finished socket may take this long to send its last lines. */
  finishTimeoutMs: number;
  /** Stop waits this long for queued lines to upload before telling the server. */
  drainTimeoutMs: number;
  /** Leaving the page pauses the recording after this grace (a re-render is not leaving). */
  unmountPauseMs: number;
  /** Reconnect waits, in order; the last repeats. */
  reconnectBackoffMs: number[];
  /** The mock vendor plays the scripted call this many times faster than real time. */
  mockSpeed: number;
}

export const DEFAULT_TUNING: RecorderTuning = {
  uploadIntervalMs: NOTES_LIMITS.uploadIntervalMs,
  reconnectBufferMs: NOTES_LIMITS.reconnectBufferSeconds * 1000,
  noMeetingAudioWarningMs: NOTES_LIMITS.noMeetingAudioWarningSeconds * 1000,
  silenceAutoStopMs: NOTES_LIMITS.silenceAutoStopMinutes * 60_000,
  silenceAutoStopWarningMs: 60_000,
  callEndedGraceMs: 2 * 60_000,
  silenceThreshold: 0.004,
  finishTimeoutMs: 5000,
  drainTimeoutMs: 15_000,
  unmountPauseMs: 1500,
  reconnectBackoffMs: [500, 1000, 2000, 4000, 8000, 15_000],
  mockSpeed: 1,
};

/** Finished lines the live view keeps in memory (the server has them all). */
export const LIVE_LINES_KEPT = 400;

/** The audio every vendor session gets: 16 kHz mono PCM16. */
export const CAPTURE_RATE = 16_000;
export const SAMPLES_PER_MS = CAPTURE_RATE / 1000;
/** The worklet posts audio in chunks this long (AssemblyAI wants 50 to 1000 ms). */
export const CHUNK_MS = 100;
