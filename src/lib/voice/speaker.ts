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

/** Whether the server has a cloned ElevenLabs voice (asked once per page). */
let cloned: Promise<boolean> | null = null;
let playing: HTMLAudioElement | null = null;
let playingDone: (() => void) | null = null;

function hasClonedVoice(): Promise<boolean> {
  cloned ??= fetch('/api/voice/speak', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((b: { available?: boolean } | null) => b?.available === true)
    .catch(() => false);
  return cloned;
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
  if (playing) {
    playing.pause();
    playingDone?.();
  }
  if (canSpeak()) window.speechSynthesis.cancel();
}

let chimeContext: AudioContext | null = null;

/** A soft two-note "I'm listening" chime. */
export function chime(): void {
  try {
    chimeContext ??= new AudioContext();
    const ctx = chimeContext;
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
