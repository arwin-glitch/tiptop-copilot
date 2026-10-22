import { isSpeechModelChoice } from '@/lib/transcribe/models';
import type { SpeechPreferences } from './speech-preferences';
import type { AdapterKind } from './speech-protocol';
import type { RecorderTuning } from './types';

/**
 * Demo mode lets the sound-check page shorten the recorder's clocks from the
 * address bar, so the end-to-end tests can see a silence auto-stop or a
 * reconnect without waiting out the real 15 minutes. Read only in demo mode
 * (the page checks); production always runs on DEFAULT_TUNING.
 *
 *   ?speed=8          play the demo call 8x faster
 *   ?silence=4000     auto-stop after 4 s of silence (warning 1 s before)
 *   ?threshold=0.99   what counts as sound (raise it to make the fake mic "silent")
 *   ?nomeeting=3000   "no meeting audio" after 3 s
 *   ?upload=500       post lines every 0.5 s
 *   ?engine=fake      the on-device engine with the fake model (no download)
 *   ?engine=on-device the real on-device Whisper (&model=fast|better|best, &device=auto|webgpu|wasm)
 */

type Params = Record<string, string | string[] | undefined>;

function num(params: Params, key: string, min: number, max: number): number | undefined {
  const raw = params[key];
  const value = Number(Array.isArray(raw) ? raw[0] : raw);
  if (raw === undefined || !Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(min, value));
}

export function demoTuning(params: Params): Partial<RecorderTuning> {
  const out: Partial<RecorderTuning> = {};
  const speed = num(params, 'speed', 0.25, 50);
  if (speed !== undefined) out.mockSpeed = speed;
  const silence = num(params, 'silence', 1000, 60 * 60_000);
  if (silence !== undefined) {
    out.silenceAutoStopMs = silence;
    out.silenceAutoStopWarningMs = Math.min(60_000, Math.round(silence / 4));
  }
  const threshold = num(params, 'threshold', 0, 1);
  if (threshold !== undefined) out.silenceThreshold = threshold;
  const noMeeting = num(params, 'nomeeting', 1000, 10 * 60_000);
  if (noMeeting !== undefined) out.noMeetingAudioWarningMs = noMeeting;
  const upload = num(params, 'upload', 250, 30_000);
  if (upload !== undefined) out.uploadIntervalMs = upload;
  return out;
}

function one(params: Params, key: string): string | undefined {
  const raw = params[key];
  return Array.isArray(raw) ? raw[0] : raw;
}

/** The on-device engine to try instead of the scripted call (demo mode only), or undefined. */
export function demoEngine(
  params: Params,
): { adapter: AdapterKind; preferences?: SpeechPreferences } | undefined {
  const engine = one(params, 'engine');
  if (engine === 'fake') return { adapter: 'fake' };
  if (engine !== 'on-device') return undefined;
  const model = one(params, 'model');
  const device = one(params, 'device');
  return {
    adapter: 'transformers',
    preferences: {
      model: isSpeechModelChoice(model) ? model : 'fast',
      device: device === 'webgpu' || device === 'wasm' ? device : 'auto',
    },
  };
}
