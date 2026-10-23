/**
 * The free, open models Copilot Notes runs in the browser (D-076). Every model
 * is pinned to an exact revision on huggingface.co, so what downloads today
 * is what downloads next month; the browser caches each file after its first
 * download (the Cache API, 'transformers-cache'), so a second meeting starts
 * without one.
 *
 * Client-safe. The Settings speech panel shows these sizes, the worker loads
 * these ids, and the cache check looks for these files.
 *
 * Speech: Whisper, in three sizes. WebGPU runs a full-precision encoder with
 * a 4-bit decoder (MatMulNBits has a WebGPU kernel; 8-bit does not); the
 * WebAssembly fallback runs 8-bit for both, which is what a CPU does well.
 * Who's talking: pyannote's segmentation model finds speaker turns within a
 * stretch of audio, and WavLM's speaker-verification head turns each turn
 * into a voice embedding, which the worker clusters across the meeting.
 */

export const SPEECH_MODEL_CHOICES = ['fast', 'better', 'best'] as const;
export type SpeechModelChoice = (typeof SPEECH_MODEL_CHOICES)[number];

export type SpeechDevice = 'webgpu' | 'wasm';

/** transformers.js dtype names, and the file suffix each one loads. */
export type ModelDtype = 'fp32' | 'fp16' | 'q8' | 'q4';
export const DTYPE_SUFFIX: Record<ModelDtype, string> = {
  fp32: '',
  fp16: '_fp16',
  q8: '_quantized',
  q4: '_q4',
};

export interface PinnedModel {
  id: string;
  revision: string;
}

export interface WhisperVariant {
  encoder: ModelDtype;
  decoder: ModelDtype;
  /** Download, in MB, every file included. */
  downloadMb: number;
}

export interface WhisperChoice {
  choice: SpeechModelChoice;
  label: string;
  /** What it is good for, in a few words. */
  blurb: string;
  /** English-only weights: better English for the same size. */
  english: PinnedModel;
  /** For a meeting in another language. */
  multilingual: PinnedModel;
  webgpu: WhisperVariant;
  /** Null when the model is too big to keep up without a graphics chip. */
  wasm: WhisperVariant | null;
  /** WebGPU must offer 16-bit floats ('shader-f16'). */
  needsF16: boolean;
}

/** Tokenizer and config files, about 4.5 MB together. */
const SMALL_FILES_MB = 4.5;

export const WHISPER_CHOICES: Record<SpeechModelChoice, WhisperChoice> = {
  fast: {
    choice: 'fast',
    label: 'Fast',
    blurb: 'Whisper Base. Keeps up on any recent computer.',
    english: {
      id: 'onnx-community/whisper-base.en',
      revision: '51eefc0af78b103839eda9e7e4f4186acc6517fe',
    },
    multilingual: {
      id: 'onnx-community/whisper-base',
      revision: '1846881b6b3a3024392c1eea3ad983695bc23925',
    },
    webgpu: { encoder: 'fp32', decoder: 'q4', downloadMb: 82.5 + 123.6 + SMALL_FILES_MB },
    wasm: { encoder: 'q8', decoder: 'q8', downloadMb: 23.2 + 53.7 + SMALL_FILES_MB },
    needsF16: false,
  },
  better: {
    choice: 'better',
    label: 'Better',
    blurb: 'Whisper Small. Fewer mistakes on names and numbers.',
    english: {
      id: 'onnx-community/whisper-small.en',
      revision: '482fb8ba081b6e906f92efe103622316b2a0cc69',
    },
    multilingual: {
      id: 'onnx-community/whisper-small',
      revision: '36050c46d777d46dc4b5f43f6d90574fc38f8732',
    },
    webgpu: { encoder: 'fp32', decoder: 'q4', downloadMb: 352.8 + 233.1 + SMALL_FILES_MB },
    wasm: { encoder: 'q8', decoder: 'q8', downloadMb: 92.3 + 156.8 + SMALL_FILES_MB },
    needsF16: false,
  },
  best: {
    choice: 'best',
    label: 'Best',
    blurb: 'Whisper Large v3 Turbo. Needs a strong graphics chip.',
    english: {
      id: 'onnx-community/whisper-large-v3-turbo',
      revision: '360ebcde2559d60bb474678be3c1de9ef347d01a',
    },
    multilingual: {
      id: 'onnx-community/whisper-large-v3-turbo',
      revision: '360ebcde2559d60bb474678be3c1de9ef347d01a',
    },
    webgpu: { encoder: 'fp16', decoder: 'q4', downloadMb: 1274.3 + 334.1 + SMALL_FILES_MB },
    wasm: null,
    needsF16: true,
  },
};

/** Speaker turns within a stretch of audio (pyannote segmentation 3.0). Runs on the CPU. */
export const SEGMENTATION_MODEL: PinnedModel & { dtype: ModelDtype; downloadMb: number } = {
  id: 'onnx-community/pyannote-segmentation-3.0',
  revision: '733a93b6473d019a773298e08cefa686894b1854',
  dtype: 'fp32',
  downloadMb: 6.0,
};

/** One voice embedding per speaker turn (WavLM Base Plus, speaker verification). Runs on the CPU. */
export const SPEAKER_EMBEDDING_MODEL: PinnedModel & { dtype: ModelDtype; downloadMb: number } = {
  id: 'Xenova/wavlm-base-plus-sv',
  revision: 'e61029603001bd11295c36d878698708bf59190f',
  dtype: 'q8',
  downloadMb: 101.7,
};

/**
 * The model version stored with a voiceprint: the embedding model and its
 * revision. A voiceprint from another version never matches (the worker
 * skips it), so changing the model means voices are remembered again.
 */
export const VOICEPRINT_MODEL_VERSION = `wavlm-base-plus-sv@${SPEAKER_EMBEDDING_MODEL.revision.slice(0, 12)}`;

/** Only the meeting-audio and mixed tracks need to tell voices apart. */
export const SPEAKER_MODELS_MB = SEGMENTATION_MODEL.downloadMb + SPEAKER_EMBEDDING_MODEL.downloadMb;

export function isSpeechModelChoice(value: unknown): value is SpeechModelChoice {
  return typeof value === 'string' && (SPEECH_MODEL_CHOICES as readonly string[]).includes(value);
}

/** English-only weights for an English meeting, the multilingual ones otherwise. */
export function whisperModelFor(choice: SpeechModelChoice, language: string): PinnedModel {
  const spec = WHISPER_CHOICES[choice];
  return /^en(-|$)/i.test(language || 'en') ? spec.english : spec.multilingual;
}

/** Whether a choice can run on a device (Best needs WebGPU, with 16-bit floats). */
export function canRun(choice: SpeechModelChoice, device: SpeechDevice, hasF16: boolean): boolean {
  const spec = WHISPER_CHOICES[choice];
  if (device === 'wasm') return spec.wasm !== null;
  return !spec.needsF16 || hasF16;
}

/** The variant a choice runs as on a device, or null when it cannot run there. */
export function whisperVariant(
  choice: SpeechModelChoice,
  device: SpeechDevice,
  hasF16: boolean,
): WhisperVariant | null {
  if (!canRun(choice, device, hasF16)) return null;
  const spec = WHISPER_CHOICES[choice];
  return device === 'webgpu' ? spec.webgpu : spec.wasm;
}

/** The big files of a Whisper variant, as the cache stores them. */
export function whisperFiles(variant: WhisperVariant): string[] {
  return [
    `onnx/encoder_model${DTYPE_SUFFIX[variant.encoder]}.onnx`,
    `onnx/decoder_model_merged${DTYPE_SUFFIX[variant.decoder]}.onnx`,
  ];
}

export const SEGMENTATION_FILES = [`onnx/model${DTYPE_SUFFIX[SEGMENTATION_MODEL.dtype]}.onnx`];
export const SPEAKER_EMBEDDING_FILES = [
  `onnx/model${DTYPE_SUFFIX[SPEAKER_EMBEDDING_MODEL.dtype]}.onnx`,
];

/** Where a model file downloads from (and the key the browser caches it under). */
export function modelFileUrl(model: PinnedModel, file: string): string {
  return `https://huggingface.co/${model.id}/resolve/${encodeURIComponent(model.revision)}/${file}`;
}

/** "210 MB", "1.6 GB". */
export function formatMb(mb: number): string {
  if (mb >= 1000) return `${(mb / 1000).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}
