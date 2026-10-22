'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { Check, Cpu, Mic, Trash2 } from 'lucide-react';
import {
  detectSpeechHardware,
  deviceFor,
  removeDownloadedModels,
  speakerModelsCached,
  whisperCached,
  type SpeechHardware,
} from '@/lib/capture/model-cache';
import { SetupTest, SETUP_TEST_MS } from '@/lib/capture/setup-test';
import {
  speechPreferencesStore,
  writeSpeechPreferences,
  type SpeechPreferences,
} from '@/lib/capture/speech-preferences';
import type { DevicePreference } from '@/lib/capture/speech-protocol';
import {
  SPEAKER_MODELS_MB,
  SPEECH_MODEL_CHOICES,
  WHISPER_CHOICES,
  canRun,
  formatMb,
  whisperVariant,
  type SpeechModelChoice,
} from '@/lib/transcribe/models';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/form';
import { cn } from '@/lib/util/cn';
import { LevelMeter } from './level-meter';

/**
 * Settings, Notes, Speech (D-076): which free Whisper model this computer
 * runs, where (the graphics chip or the processor), what each one downloads,
 * and a five-second "Test my setup". Kept in this browser: the model is
 * downloaded and cached here, and what keeps up depends on this computer.
 */

const DEVICE_WORDS: Record<DevicePreference, string> = {
  auto: 'Automatic (graphics chip when there is one)',
  webgpu: 'Graphics chip (WebGPU)',
  wasm: 'Processor only',
};

/** What this browser has downloaded, for the "Downloaded" badges. */
async function readCache(
  hardware: SpeechHardware,
  device: DevicePreference,
): Promise<{ whisper: Partial<Record<SpeechModelChoice, boolean>>; voices: boolean }> {
  const whisper: Partial<Record<SpeechModelChoice, boolean>> = {};
  for (const choice of SPEECH_MODEL_CHOICES) {
    whisper[choice] = await whisperCached(choice, deviceFor(device, hardware), hardware.f16);
  }
  return { whisper, voices: await speakerModelsCached() };
}

export function SpeechSettings() {
  // This browser's choice; the server renders the default and the page catches up.
  const prefs = React.useSyncExternalStore(
    speechPreferencesStore.subscribe,
    speechPreferencesStore.getSnapshot,
    speechPreferencesStore.getServerSnapshot,
  );
  const [hardware, setHardware] = React.useState<SpeechHardware | null>(null);
  const [cache, setCache] = React.useState<{
    whisper: Partial<Record<SpeechModelChoice, boolean>>;
    voices: boolean;
  }>({ whisper: {}, voices: false });
  const [cacheVersion, bumpCache] = React.useReducer((n: number) => n + 1, 0);
  const [test] = React.useState(() => new SetupTest());
  const testState = React.useSyncExternalStore(
    test.subscribe,
    test.getSnapshot,
    test.getServerSnapshot,
  );
  const deviceId = React.useId();
  const tested = testState.phase === 'done';

  React.useEffect(() => {
    let live = true;
    void detectSpeechHardware().then((h) => {
      if (live) setHardware(h);
    });
    return () => {
      live = false;
    };
  }, []);

  // Re-read the cache when the device changes, after a test downloads a model, or after Remove.
  React.useEffect(() => {
    if (!hardware) return;
    let live = true;
    void readCache(hardware, prefs.device).then((next) => {
      if (live) setCache(next);
    });
    return () => {
      live = false;
    };
  }, [hardware, prefs.device, cacheVersion, tested]);

  const device = hardware ? deviceFor(prefs.device, hardware) : 'wasm';
  const f16 = hardware?.f16 ?? false;
  const cached = cache.whisper;
  const voicesCached = cache.voices;

  const save = (next: SpeechPreferences) => writeSpeechPreferences(next);

  const busy = ['recording', 'loading', 'transcribing'].includes(testState.phase);

  return (
    <div className="space-y-6" data-testid="speech-settings">
      <div className="space-y-1">
        <h2 className="text-sm font-medium">Speech on this computer</h2>
        <p className="text-note max-w-2xl text-[var(--fg-muted)]">
          Copilot turns speech into text right here, with the free Whisper model: no paid service,
          and the audio never leaves this computer. Each model downloads once from huggingface.co
          and stays in this browser. The microphone is always you; Copilot tells the other voices
          apart on this computer too.
        </p>
        <p className="text-mini text-[var(--fg-muted)]" data-testid="speech-hardware">
          <Cpu className="mr-1 inline size-3.5 align-[-2px]" aria-hidden="true" />
          {!hardware
            ? 'Checking this computer…'
            : hardware.webgpu
              ? `This browser may use the graphics chip${hardware.f16 ? ' (all three models run here)' : ' (Best needs a newer chip)'}.`
              : 'No graphics chip access in this browser: Whisper runs on the processor (Fast and Better).'}
        </p>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-note mb-1 font-medium">Model</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {SPEECH_MODEL_CHOICES.map((choice) => {
            const spec = WHISPER_CHOICES[choice];
            const variant = whisperVariant(choice, device, f16);
            const runs = !hardware || canRun(choice, device, f16);
            const active = prefs.model === choice;
            return (
              <button
                key={choice}
                type="button"
                aria-pressed={active}
                disabled={!runs}
                data-testid={`speech-model-${choice}`}
                onClick={() => save({ ...prefs, model: choice })}
                className={cn(
                  'flex min-w-0 flex-col items-start gap-1 rounded-md border px-3 py-2.5 text-left text-sm disabled:cursor-not-allowed disabled:opacity-50',
                  active
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                    : 'border-[var(--border-strong)] bg-[var(--bg-raised)] hover:bg-[var(--bg-hover)]',
                )}
              >
                <span className="flex w-full items-center justify-between gap-2">
                  <span className="font-medium text-[var(--fg)]">{spec.label}</span>
                  {cached[choice] ? (
                    <Badge tone="ok" className="gap-1">
                      <Check className="size-3" aria-hidden="true" /> Downloaded
                    </Badge>
                  ) : null}
                </span>
                <span className="text-mini text-[var(--fg-muted)]">{spec.blurb}</span>
                <span className="text-mini text-[var(--fg-muted)]">
                  {variant
                    ? `${formatMb(variant.downloadMb)} once, on ${device === 'webgpu' ? 'the graphics chip' : 'the processor'}`
                    : 'Needs a graphics chip with 16-bit support'}
                </span>
              </button>
            );
          })}
        </div>
        <p className="text-mini text-[var(--fg-muted)]">
          Telling voices apart adds {formatMb(SPEAKER_MODELS_MB)} once
          {voicesCached ? ' (downloaded)' : ''}. If a model cannot run when a meeting starts,
          Copilot uses Fast and says so.
        </p>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor={deviceId} className="text-note font-medium">
          Where it runs
        </label>
        <Select
          id={deviceId}
          value={prefs.device}
          onChange={(e) => save({ ...prefs, device: e.target.value as DevicePreference })}
        >
          {(Object.keys(DEVICE_WORDS) as DevicePreference[]).map((d) => (
            <option key={d} value={d}>
              {DEVICE_WORDS[d]}
            </option>
          ))}
        </Select>
      </div>

      <div
        className="space-y-3 rounded-md bg-[var(--bg-sunken)] px-3 py-3"
        data-testid="speech-test"
      >
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            size="sm"
            onClick={() => void test.run(prefs)}
            disabled={busy || !hardware?.wasm}
            loading={busy}
          >
            <Mic aria-hidden="true" /> Test my setup
          </Button>
          <span className="text-note text-[var(--fg-muted)]">
            {testState.phase === 'recording'
              ? `Say a sentence or two… ${testState.secondsLeft}s`
              : testState.phase === 'loading'
                ? testState.totalMb > 1
                  ? `Downloading the model… ${Math.round((testState.progress ?? 0) * 100)}% of ${formatMb(testState.totalMb)} (first time only)`
                  : 'Getting the model ready…'
                : testState.phase === 'transcribing'
                  ? 'Transcribing on this computer…'
                  : `Records ${SETUP_TEST_MS / 1000} seconds of your microphone and transcribes them here. Nothing is sent or saved.`}
          </span>
        </div>
        {testState.phase === 'recording' ? (
          <LevelMeter label="Your microphone" level={testState.level} tone="mic" />
        ) : null}
        {testState.phase === 'done' && testState.result ? (
          <div className="space-y-1 text-sm" data-testid="speech-test-result">
            <p className="text-[var(--fg)]">
              &ldquo;{testState.result.text || '(nothing heard)'}&rdquo;
            </p>
            <p
              className={cn(
                'text-note',
                testState.result.keepsUp ? 'text-[var(--ok)]' : 'text-[var(--warn)]',
              )}
            >
              {`${(testState.result.audioMs / 1000).toFixed(0)} seconds transcribed in ${(testState.result.elapsedMs / 1000).toFixed(1)} s with ${testState.result.model ? WHISPER_CHOICES[testState.result.model].label : 'Whisper'} on ${testState.result.device === 'webgpu' ? 'the graphics chip' : 'the processor'}. `}
              {testState.result.keepsUp
                ? 'This computer keeps up.'
                : 'This computer is slow with this model: try Fast. A recording never loses words; it finishes after Stop.'}
            </p>
          </div>
        ) : null}
        {testState.phase === 'error' ? (
          <p role="alert" className="text-sm text-[var(--danger)]">
            {testState.error}
          </p>
        ) : null}
      </div>

      <div>
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            const removed = await removeDownloadedModels();
            bumpCache();
            toast.success(
              removed ? 'Downloaded models removed from this browser.' : 'Nothing to remove.',
            );
          }}
        >
          <Trash2 aria-hidden="true" /> Remove downloaded models
        </Button>
      </div>
    </div>
  );
}
