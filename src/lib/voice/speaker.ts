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

/**
 * Each speak() gets a number; stopSpeaking() and the next speak() move it on.
 * A cloned-voice fetch that comes back for an old number is thrown away, so
 * nothing starts talking after the user cut Arwin off.
 */
let generation = 0;
let fetching: AbortController | null = null;
let deviceDone: (() => void) | null = null;
/** Sound is coming out right now (not while the cloned voice is still downloading). */
let audible = false;

/**
 * Whether Arwin's voice is actually coming out of the speakers now. Barge-in
 * learns how loud his echo is only while this is true: learning during the
 * silent download would take his own voice for the user talking over him.
 */
export function speechAudible(): boolean {
  return audible;
}

/**
 * Plays decoded audio through the shared context. null when the context is
 * missing or asleep (then an <audio> element is tried); 'played' otherwise,
 * including when it was stopped part way.
 */
async function playThroughContext(bytes: ArrayBuffer, gen: number): Promise<'played' | null> {
  const ctx = sharedContext();
  if (!ctx) return null;
  try {
    if (ctx.state !== 'running') await ctx.resume();
    if (ctx.state !== 'running') return null;
    const buffer = await ctx.decodeAudioData(bytes);
    if (gen !== generation) return 'played';
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    silence();
    playingSource = source;
    return await new Promise<'played'>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (playingSource === source) {
          playingSource = null;
          playingDone = null;
          audible = false;
        }
        resolve('played');
      };
      playingDone = finish;
      source.onended = finish;
      source.start();
      audible = true;
    });
  } catch {
    return gen !== generation ? 'played' : null;
  }
}

/**
 * Plays the answer in the cloned voice. 'played' when it did (or was stopped,
 * so nothing else should speak), 'fallback' when the device voice should.
 */
async function speakCloned(text: string, gen: number): Promise<'played' | 'fallback'> {
  const available = await hasClonedVoice();
  if (gen !== generation) return 'played';
  if (!available) return 'fallback';
  let blob: Blob;
  const abort = new AbortController();
  fetching = abort;
  try {
    const res = await fetch('/api/voice/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: abort.signal,
    });
    if (gen !== generation) return 'played';
    if (!res.ok) return 'fallback';
    blob = await res.blob();
  } catch {
    return gen !== generation ? 'played' : 'fallback';
  } finally {
    if (fetching === abort) fetching = null;
  }
  // Stopped while the audio was downloading: never play it.
  if (gen !== generation) return 'played';
  let bytes: ArrayBuffer | null = null;
  try {
    bytes = await blob.arrayBuffer();
  } catch {
    // Unreadable here: the <audio> element below may still play it.
  }
  const viaContext = bytes ? await playThroughContext(bytes, gen) : null;
  if (viaContext !== null) return viaContext;
  if (gen !== generation) return 'played';
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  silence();
  playing = audio;
  return new Promise<'played' | 'fallback'>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      if (playing === audio) {
        playing = null;
        playingDone = null;
        audible = false;
      }
      // Stopped mid-play counts as done: the device voice must not take over.
      resolve(ok || gen !== generation ? 'played' : 'fallback');
    };
    playingDone = () => finish(true);
    audio.onplaying = () => {
      if (playing === audio) audible = true;
    };
    audio.onended = () => finish(true);
    audio.onerror = () => finish(false);
    // Blocked autoplay (no tap on the page yet): the device voice takes over.
    audio.play().catch(() => finish(false));
  });
}

/** Speak and resolve when done (or at once when speech is off, missing or stopped). */
export async function speak(text: string): Promise<void> {
  if (!text || typeof window === 'undefined' || !speakingEnabled()) return;
  // A new answer replaces whatever was still being said or fetched.
  stopSpeaking();
  const gen = generation;
  if ((await speakCloned(text, gen)) === 'played') return;
  if (gen !== generation || !canSpeak()) return;
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
      if (deviceDone === finish) {
        deviceDone = null;
        audible = false;
      }
      resolve();
    };
    // Some engines never fire onend; never hang on it.
    const guard = setTimeout(finish, Math.max(4_000, text.length * 90));
    u.onstart = () => {
      if (deviceDone === finish) audible = true;
    };
    u.onend = finish;
    u.onerror = finish;
    deviceDone = finish;
    synth.speak(u);
  });
}

/** Quiet both voices now and let any waiting speak() finish. */
function silence(): void {
  const source = playingSource;
  if (source) {
    try {
      source.stop();
    } catch {
      // Already stopped.
    }
    playingDone?.();
  }
  const audio = playing;
  const done = playingDone;
  if (audio) {
    try {
      audio.pause();
      audio.currentTime = 0;
    } catch {
      // Already gone.
    }
    done?.();
  }
  if (canSpeak()) window.speechSynthesis.cancel();
  // Some engines skip onend/onerror after cancel(): resolve it ourselves.
  deviceDone?.();
  audible = false;
}

/** Stop talking at once: the playing voice, the device voice and any fetch still on its way. */
export function stopSpeaking(): void {
  generation += 1;
  fetching?.abort();
  fetching = null;
  silence();
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
