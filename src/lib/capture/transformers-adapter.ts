import {
  AutoModelForAudioFrameClassification,
  AutoModelForXVector,
  AutoProcessor,
  env,
  pipeline,
  type AutomaticSpeechRecognitionPipeline,
  type PreTrainedModel,
  type Processor,
  type ProgressInfo,
  type Tensor,
} from '@huggingface/transformers';
import {
  SEGMENTATION_MODEL,
  SPEAKER_EMBEDDING_MODEL,
  VOICEPRINT_MODEL_VERSION,
  WHISPER_CHOICES,
  canRun,
  whisperModelFor,
  whisperVariant,
  type SpeechDevice,
  type SpeechModelChoice,
} from '@/lib/transcribe/models';
import type { WorkerConfig } from './speech-protocol';
import {
  ModelLoadError,
  type AsrResult,
  type LoadProgress,
  type LoadedAsr,
  type ModelAdapter,
  type SpeakerTurn,
} from './speech-pipeline';

/**
 * The real models, through transformers.js and ONNX Runtime Web (D-076).
 * Loaded only inside the speech worker (src/workers/speech.worker.ts).
 *
 * Free and on the device: models download once from huggingface.co at a
 * pinned revision and are cached by the browser. ONNX Runtime's WebAssembly
 * binary comes from Copilot itself: the bundler copies the installed
 * onnxruntime-web's file into /_next/static/media/ with a content hash (so it
 * is cached for good and can never drift from the code that loads it), and
 * nothing is fetched from a third-party CDN. No audio and no text leave this
 * worker except as messages to the page.
 *
 * Whisper runs on the graphics chip (WebGPU) when there is one, and falls
 * back to WebAssembly on the CPU: first the chosen size, then Fast, which
 * keeps up on any recent computer. The speaker models are small and always
 * run on the CPU, beside Whisper rather than in its way.
 */

/** pyannote's powerset classes: which local speakers each one means (0 is nobody). */
const POWERSET: Record<number, number[]> = {
  1: [0],
  2: [1],
  3: [2],
  4: [0, 1],
  5: [0, 2],
  6: [1, 2],
};

interface GpuInfo {
  available: boolean;
  f16: boolean;
}

async function detectGpu(): Promise<GpuInfo> {
  const gpu = (globalThis.navigator as (Navigator & { gpu?: GPULike }) | undefined)?.gpu;
  if (!gpu) return { available: false, f16: false };
  try {
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return { available: false, f16: false };
    return { available: true, f16: adapter.features.has('shader-f16') };
  } catch {
    return { available: false, f16: false };
  }
}

interface GPULike {
  requestAdapter(options?: { powerPreference?: string }): Promise<{ features: Set<string> } | null>;
}

/** Sums each file's bytes into one figure per load. */
function progressTracker(onProgress: (p: LoadProgress) => void): (info: ProgressInfo) => void {
  const files = new Map<string, { loaded: number; total: number }>();
  return (info) => {
    if (info.status !== 'progress') return;
    files.set(info.file, { loaded: info.loaded, total: info.total });
    let loadedBytes = 0;
    let totalBytes = 0;
    for (const f of files.values()) {
      loadedBytes += f.loaded;
      totalBytes += f.total;
    }
    onProgress({ loadedBytes, totalBytes });
  };
}

function looksOffline(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /fetch|network|Failed to load|ERR_|offline|status 5\d\d/i.test(text);
}

export class TransformersAdapter implements ModelAdapter {
  readonly voiceprintModel = VOICEPRINT_MODEL_VERSION;
  private asr: AutomaticSpeechRecognitionPipeline | null = null;
  private multilingual = false;
  private segProcessor: Processor | null = null;
  private segModel: PreTrainedModel | null = null;
  private embProcessor: Processor | null = null;
  private embModel: PreTrainedModel | null = null;

  constructor() {
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    env.useBrowserCache = true;
    // ONNX Runtime's loader is bundled in and its binary is the bundler's
    // copy: no blob-URL script and no CDN, so the page's policies stay as
    // they are.
    env.useWasmCache = false;
    const onnx = env.backends.onnx;
    if (onnx.wasm) {
      // transformers.js points ONNX Runtime at a CDN by default; an empty
      // setting sends it back to its own file, which the bundler ships.
      onnx.wasm.wasmPaths = {};
      // No cross-origin isolation on Copilot's pages, so one thread.
      onnx.wasm.numThreads = 1;
    }
  }

  async loadAsr(config: WorkerConfig, onProgress: (p: LoadProgress) => void): Promise<LoadedAsr> {
    const gpu = config.device === 'wasm' ? { available: false, f16: false } : await detectGpu();
    const attempts: { choice: SpeechModelChoice; device: SpeechDevice }[] = [];
    const add = (choice: SpeechModelChoice, device: SpeechDevice) => {
      if (!canRun(choice, device, gpu.f16)) return;
      if (device === 'webgpu' && !gpu.available) return;
      if (!attempts.some((a) => a.choice === choice && a.device === device)) {
        attempts.push({ choice, device });
      }
    };
    if (config.device !== 'wasm') add(config.choice, 'webgpu');
    if (config.device !== 'webgpu') add(config.choice, 'wasm');
    // Best needs a graphics chip; Fast keeps up anywhere.
    add('fast', gpu.available && config.device !== 'wasm' ? 'webgpu' : 'wasm');
    add('fast', 'wasm');

    let lastError: unknown = null;
    for (const attempt of attempts) {
      const variant = whisperVariant(attempt.choice, attempt.device, gpu.f16);
      if (!variant) continue;
      const model = whisperModelFor(attempt.choice, config.language);
      try {
        this.asr = (await pipeline('automatic-speech-recognition', model.id, {
          revision: model.revision,
          device: attempt.device,
          dtype: { encoder_model: variant.encoder, decoder_model_merged: variant.decoder },
          progress_callback: progressTracker(onProgress),
        })) as AutomaticSpeechRecognitionPipeline;
        // English-only weights refuse a language or task; the others want one.
        this.multilingual = !/\.en$/.test(model.id);
        const fellBack =
          attempt.choice !== config.choice ||
          (config.device !== 'auto' && attempt.device !== config.device);
        return {
          device: attempt.device,
          model: attempt.choice,
          message: fellBack
            ? `${WHISPER_CHOICES[config.choice].label} could not run here, so Copilot uses ${WHISPER_CHOICES[attempt.choice].label} on ${attempt.device === 'webgpu' ? 'the graphics chip' : 'the processor'}.`
            : null,
        };
      } catch (error) {
        lastError = error;
      }
    }
    if (looksOffline(lastError)) {
      throw new ModelLoadError(
        'The speech model could not download. Check the connection; Copilot tries again.',
        true,
      );
    }
    throw new ModelLoadError(
      'This browser could not run the speech model. Use Chrome or Edge on a computer.',
      false,
    );
  }

  async loadSpeakers(onProgress: (p: LoadProgress) => void): Promise<void> {
    const track = progressTracker(onProgress);
    try {
      const [segProcessor, segModel, embProcessor, embModel] = await Promise.all([
        AutoProcessor.from_pretrained(SEGMENTATION_MODEL.id, {
          revision: SEGMENTATION_MODEL.revision,
          progress_callback: track,
        }),
        AutoModelForAudioFrameClassification.from_pretrained(SEGMENTATION_MODEL.id, {
          revision: SEGMENTATION_MODEL.revision,
          dtype: SEGMENTATION_MODEL.dtype,
          device: 'wasm',
          progress_callback: track,
        }),
        AutoProcessor.from_pretrained(SPEAKER_EMBEDDING_MODEL.id, {
          revision: SPEAKER_EMBEDDING_MODEL.revision,
          progress_callback: track,
        }),
        AutoModelForXVector.from_pretrained(SPEAKER_EMBEDDING_MODEL.id, {
          revision: SPEAKER_EMBEDDING_MODEL.revision,
          dtype: SPEAKER_EMBEDDING_MODEL.dtype,
          device: 'wasm',
          progress_callback: track,
        }),
      ]);
      this.segProcessor = segProcessor;
      this.segModel = segModel;
      this.embProcessor = embProcessor;
      this.embModel = embModel;
    } catch (error) {
      throw new ModelLoadError(
        looksOffline(error)
          ? 'The voice models could not download. Check the connection; Copilot tries again.'
          : 'This browser could not run the voice models.',
        looksOffline(error),
      );
    }
  }

  async transcribe(audio: Float32Array, language: string): Promise<AsrResult> {
    if (!this.asr) throw new Error('The speech model is not loaded.');
    const lang = (language || 'en').slice(0, 2).toLowerCase();
    const output = (await this.asr(audio, {
      return_timestamps: true,
      ...(this.multilingual ? { language: lang, task: 'transcribe' } : {}),
    })) as { text: string; chunks?: { timestamp: [number, number | null]; text: string }[] };
    const duration = audio.length / 16000;
    const segments = (output.chunks ?? []).map((c) => ({
      startS: Math.max(0, c.timestamp[0] ?? 0),
      endS: Math.min(duration, c.timestamp[1] ?? duration),
      text: c.text.trim(),
    }));
    return { text: output.text.trim(), segments };
  }

  async segment(audio: Float32Array): Promise<SpeakerTurn[]> {
    if (!this.segProcessor || !this.segModel) return [];
    const inputs = await this.segProcessor(audio);
    const { logits } = (await this.segModel(inputs)) as { logits: Tensor };
    const processor = this.segProcessor as Processor & {
      post_process_speaker_diarization(
        logits: Tensor,
        samples: number,
      ): { id: number; start: number; end: number; confidence: number }[][];
    };
    const [result] = processor.post_process_speaker_diarization(logits, audio.length);
    const turns: SpeakerTurn[] = [];
    for (const seg of result ?? []) {
      const speakers = POWERSET[seg.id];
      // Two people at once: no clean voice to learn from, so no turn.
      if (!speakers || speakers.length !== 1) continue;
      turns.push({ startS: seg.start, endS: seg.end, speaker: speakers[0] ?? 0 });
    }
    return turns;
  }

  async embed(audio: Float32Array): Promise<Float32Array> {
    if (!this.embProcessor || !this.embModel) throw new Error('The voice model is not loaded.');
    const inputs = await this.embProcessor(audio);
    const { embeddings } = (await this.embModel(inputs)) as { embeddings: Tensor };
    return Float32Array.from(embeddings.data as Float32Array);
  }
}
