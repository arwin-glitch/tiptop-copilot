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

/** Speak and resolve when done (or at once when speech is off or missing). */
export function speak(text: string): Promise<void> {
  if (!text || !canSpeak() || !speakingEnabled()) return Promise.resolve();
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
  if (canSpeak()) window.speechSynthesis.cancel();
}

/** Chrome loads its voice list late; ask early so the first answer has a good voice. */
export function warmVoices(): void {
  if (canSpeak()) window.speechSynthesis.getVoices();
}
