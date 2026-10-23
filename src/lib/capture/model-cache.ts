import {
  SEGMENTATION_FILES,
  SEGMENTATION_MODEL,
  SPEAKER_EMBEDDING_FILES,
  SPEAKER_EMBEDDING_MODEL,
  modelFileUrl,
  whisperFiles,
  whisperModelFor,
  whisperVariant,
  type SpeechDevice,
  type SpeechModelChoice,
} from '@/lib/transcribe/models';

/**
 * What this browser has downloaded, and what it can run (D-076). Client
 * only. The speech worker caches every model file in the Cache API under
 * 'transformers-cache', keyed by the file's huggingface.co address; this
 * reads the same keys, so Settings can say "Downloaded" without loading a
 * model, and can delete them all on request.
 */

export const MODEL_CACHE_NAME = 'transformers-cache';

export interface SpeechHardware {
  /** WebGPU works here (a graphics chip the browser may use). */
  webgpu: boolean;
  /** That chip does 16-bit floats (Best needs it). */
  f16: boolean;
  /** Web Workers and WebAssembly: everything Whisper on the processor needs. */
  wasm: boolean;
}

interface GpuLike {
  requestAdapter(options?: { powerPreference?: string }): Promise<{ features: Set<string> } | null>;
}

export async function detectSpeechHardware(): Promise<SpeechHardware> {
  const wasm = typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined';
  const gpu =
    typeof navigator !== 'undefined' ? (navigator as Navigator & { gpu?: GpuLike }).gpu : undefined;
  if (!gpu) return { webgpu: false, f16: false, wasm };
  try {
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    return { webgpu: Boolean(adapter), f16: Boolean(adapter?.features.has('shader-f16')), wasm };
  } catch {
    return { webgpu: false, f16: false, wasm };
  }
}

/** The device a preference runs on here. */
export function deviceFor(
  preference: 'auto' | SpeechDevice,
  hardware: SpeechHardware,
): SpeechDevice {
  if (preference === 'wasm' || !hardware.webgpu) return 'wasm';
  return 'webgpu';
}

async function openCache(): Promise<Cache | null> {
  try {
    if (typeof caches === 'undefined') return null;
    return await caches.open(MODEL_CACHE_NAME);
  } catch {
    return null;
  }
}

async function allCached(urls: string[]): Promise<boolean> {
  const cache = await openCache();
  if (!cache) return false;
  try {
    for (const url of urls) if (!(await cache.match(url))) return false;
    return true;
  } catch {
    return false;
  }
}

/** Whether a Whisper size is already downloaded for this device. */
export async function whisperCached(
  choice: SpeechModelChoice,
  device: SpeechDevice,
  hasF16: boolean,
  language = 'en',
): Promise<boolean> {
  const variant = whisperVariant(choice, device, hasF16);
  if (!variant) return false;
  const model = whisperModelFor(choice, language);
  return allCached(whisperFiles(variant).map((f) => modelFileUrl(model, f)));
}

/** Whether the voice models (who's talking) are downloaded. */
export async function speakerModelsCached(): Promise<boolean> {
  return allCached([
    ...SEGMENTATION_FILES.map((f) => modelFileUrl(SEGMENTATION_MODEL, f)),
    ...SPEAKER_EMBEDDING_FILES.map((f) => modelFileUrl(SPEAKER_EMBEDDING_MODEL, f)),
  ]);
}

/** Delete every downloaded model from this browser. The next recording downloads again. */
export async function removeDownloadedModels(): Promise<boolean> {
  try {
    if (typeof caches === 'undefined') return false;
    return await caches.delete(MODEL_CACHE_NAME);
  } catch {
    return false;
  }
}
