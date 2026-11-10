/**
 * Arwin's voice: the browser's own text-to-speech, free and on the device.
 * Works in Chrome, Edge, Safari and both Kraken apps.
 */

const VOICE_KEY = 'tiptop.voice.speak';

export function canSpeak(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

/** Whether Arwin reads answers aloud on this computer (on unless turned off). */
export function speakingEnabled(): boolean {
  try {
    return window.localStorage.getItem(VOICE_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setSpeakingEnabled(on: boolean): void {
  try {
    window.localStorage.setItem(VOICE_KEY, on ? 'on' : 'off');
  } catch {
    // Private window: it just won't be remembered.
  }
  if (!on) stopSpeaking();
}

/** A natural English voice when the computer has one. */
function pickVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis
    .getVoices()
    .filter((v) => v.lang.toLowerCase().startsWith('en'));
  const prefer = [
    /natural/i,
    /google us english/i,
    /samantha/i,
    /aria/i,
    /jenny/i,
    /guy/i,
    /daniel/i,
    /zira/i,
  ];
  for (const p of prefer) {
    const v = voices.find((x) => p.test(x.name));
    if (v) return v;
  }
  return voices.find((v) => v.lang === 'en-US') ?? voices[0] ?? null;
}

/* ------------------------------------------------- the cloned voice */

/**
 * Whether the server has a cloned ElevenLabs voice. A yes is kept for the
 * page; a no is asked again after a minute, so a voice set up while the page
 * was open (or a blip) does not leave the device voice for good.
 */
let cloned: Promise<boolean> | null = null;
let clonedNoAt = 0;
let playing: HTMLAudioElement | null = null;
let playingSource: AudioBufferSourceNode | null = null;
let playingDone: (() => void) | null = null;

function hasClonedVoice(): Promise<boolean> {
  if (cloned && clonedNoAt && Date.now() - clonedNoAt > 60_000) cloned = null;
  cloned ??= fetch('/api/voice/speak', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((b: { available?: boolean } | null) => b?.available === true)
    .catch(() => false)
    .then((yes) => {
      clonedNoAt = yes ? 0 : Date.now();
      return yes;
    });
  return cloned;
}

/**
 * The page's one audio context, woken by a tap or the mic (chime). Audio
 * played through it is not stopped by the autoplay rule the way a fresh
 * <audio> element can be after a slow fetch, so the cloned voice keeps
 * speaking on wake-word and follow-up answers too.
 */
let audioContext: AudioContext | null = null;
function sharedContext(): AudioContext | null {
  try {
    audioContext ??= new AudioContext();
    return audioContext;
  } catch {
    return null;
  }
}

/** Wake the audio on the first tap or key anywhere, so later answers may play. */
export function unlockAudio(): void {
  const ctx = sharedContext();
  if (ctx && ctx.state !== 'running') void ctx.resume().catch(() => undefined);
}

async function playThroughContext(bytes: ArrayBuffer): Promise<boolean | null> {
  const ctx = sharedContext();
  if (!ctx) return null;
  try {
    if (ctx.state !== 'running') await ctx.resume();
    if (ctx.state !== 'running') return null;
    const buffer = await ctx.decodeAudioData(bytes);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    stopSpeaking();
    playingSource = source;
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (playingSource === source) {
          playingSource = null;
          playingDone = null;
        }
        resolve(true);
      };
      playingDone = finish;
      source.onended = finish;
      source.start();
    });
  } catch {
    return null;
  }
}

/** Plays the answer in the cloned voice; false when it could not (then the device voice speaks). */
async function speakCloned(text: string): Promise<boolean> {
  if (!(await hasClonedVoice())) return false;
  let blob: Blob;
  try {
    const res = await fetch('/api/voice/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return false;
    blob = await res.blob();
  } catch {
    return false;
  }
  const viaContext = await playThroughContext(await blob.arrayBuffer());
  if (viaContext !== null) return viaContext;
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  stopSpeaking();
  playing = audio;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      if (playing === audio) {
        playing = null;
        playingDone = null;
      }
      resolve(ok);
    };
    playingDone = () => finish(true);
    audio.onended = () => finish(true);
    audio.onerror = () => finish(false);
    // Blocked autoplay (no tap on the page yet): the device voice takes over.
    audio.play().catch(() => finish(false));
  });
}

/** Speak and resolve when done (or at once when speech is off or missing). */
export async function speak(text: string): Promise<void> {
  if (!text || typeof window === 'undefined' || !speakingEnabled()) return;
  if (await speakCloned(text)) return;
  if (!canSpeak()) return;
  return speakWithDevice(text);
}

function speakWithDevice(text: string): Promise<void> {
  const synth = window.speechSynthesis;
  synth.cancel();
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    const voice = pickVoice();
    if (voice) u.voice = voice;
    u.lang = voice?.lang ?? 'en-US';
    u.rate = 1.05;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(guard);
      resolve();
    };
    // Some engines never fire onend; never hang on it.
    const guard = setTimeout(finish, Math.max(4_000, text.length * 90));
    u.onend = finish;
    u.onerror = finish;
    synth.speak(u);
  });
}

export function stopSpeaking(): void {
  if (playingSource) {
    try {
      playingSource.stop();
    } catch {
      // Already stopped.
    }
    playingDone?.();
  }
  if (playing) {
    playing.pause();
    playingDone?.();
  }
  if (canSpeak()) window.speechSynthesis.cancel();
}

/** A soft two-note "I'm listening" chime (it also wakes the shared audio). */
export function chime(): void {
  try {
    const ctx = sharedContext();
    if (!ctx) return;
    void ctx.resume().catch(() => undefined);
    const now = ctx.currentTime;
    [660, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.type = 'sine';
      const t = now + i * 0.09;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.08, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.2);
    });
  } catch {
    // No audio here: the card still shows it is listening.
  }
}

/** Chrome loads its voice list late; ask early so the first answer has a good voice. */
export function warmVoices(): void {
  if (canSpeak()) window.speechSynthesis.getVoices();
}
