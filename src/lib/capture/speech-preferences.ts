import { isSpeechModelChoice, type SpeechModelChoice } from '@/lib/transcribe/models';
import type { DevicePreference } from './speech-protocol';

/**
 * Which Whisper model this computer runs (D-076): Fast, Better or Best, and
 * whether to use the graphics chip. Kept in this browser, not on the server,
 * because the model is downloaded and cached by this browser and what keeps
 * up depends on this computer. A private window or blocked storage falls back
 * to Fast on whatever the browser has.
 */

const KEY = 'copilot.notes.speech.v1';
const EVENT = 'copilot:speech-preferences';

export interface SpeechPreferences {
  model: SpeechModelChoice;
  device: DevicePreference;
}

export const DEFAULT_SPEECH_PREFERENCES: SpeechPreferences = { model: 'fast', device: 'auto' };

function isDevice(value: unknown): value is DevicePreference {
  return value === 'auto' || value === 'webgpu' || value === 'wasm';
}

/** The last choice made on this page, for a browser that blocks storage. */
let memory: SpeechPreferences | null = null;

export function readSpeechPreferences(): SpeechPreferences {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return memory ?? DEFAULT_SPEECH_PREFERENCES;
    const parsed = JSON.parse(raw) as Partial<SpeechPreferences>;
    return {
      model: isSpeechModelChoice(parsed.model) ? parsed.model : DEFAULT_SPEECH_PREFERENCES.model,
      device: isDevice(parsed.device) ? parsed.device : DEFAULT_SPEECH_PREFERENCES.device,
    };
  } catch {
    return memory ?? DEFAULT_SPEECH_PREFERENCES;
  }
}

export function writeSpeechPreferences(preferences: SpeechPreferences): void {
  memory = preferences;
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(preferences));
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
  try {
    globalThis.dispatchEvent?.(new CustomEvent(EVENT, { detail: preferences }));
  } catch {
    // No window (a test): nothing listens.
  }
}

let cached: { raw: string; value: SpeechPreferences } | null = null;

/**
 * The choice as an external store for useSyncExternalStore: the same object
 * until it changes, and the default on the server (which cannot see this
 * browser's choice).
 */
export const speechPreferencesStore = {
  subscribe: (listener: () => void) => onSpeechPreferences(() => listener()),
  getSnapshot: (): SpeechPreferences => {
    const value = readSpeechPreferences();
    const raw = JSON.stringify(value);
    if (!cached || cached.raw !== raw) cached = { raw, value };
    return cached.value;
  },
  getServerSnapshot: (): SpeechPreferences => DEFAULT_SPEECH_PREFERENCES,
};

/** Call `listener` when the choice changes in this tab or another. */
export function onSpeechPreferences(listener: (p: SpeechPreferences) => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const local = () => listener(readSpeechPreferences());
  const storage = (event: StorageEvent) => {
    if (event.key === KEY) local();
  };
  window.addEventListener(EVENT, local);
  window.addEventListener('storage', storage);
  return () => {
    window.removeEventListener(EVENT, local);
    window.removeEventListener('storage', storage);
  };
}
