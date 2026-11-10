import { appGuideIndex } from '@/lib/help/app-guide';

/**
 * Cleans up what speech-to-text heard before Arwin acts on it. Pure, free and
 * on the device: no model, no key.
 *
 * 1. Known mishearings of the wake words and commands ("Hang on, I hope my
 *    inbox" → "Hey Arwin, open my inbox").
 * 2. Words that sound like something Kraken knows (its pages and tabs, and
 *    the team's companies and people from /api/voice/vocabulary) are spelled
 *    the way Kraken spells them ("ledger lee" → "Ledgerly", "in box" →
 *    "Inbox"). Only close sound-alikes, never common words, so it does not
 *    put words in anyone's mouth.
 */

export interface FixResult {
  text: string;
  /** True when anything was changed (the card then shows what was heard). */
  changed: boolean;
}

const ARWIN_WORDS =
  'arwin|arwyn|arwen|erwin|irwin|erwan|aaron|edwin|darwin|our win|are win|ar win|r win|irvin|alvin';

/** "Hey Arwin" heard as something else, at the very start. */
const GREETING = new RegExp(
  `^(?:(?:hey|hay|hi|a|okay|ok)[\\s,]+(?:${ARWIN_WORDS})|hang on|hey on|hey and|hey own|hey win|a win|hey when|hey ruin|hey or when|hey are win)\\b[\\s,.!?]*`,
  'i',
);

/** "Open" heard as something else. */
const OPEN_MISHEARD = /^(?:i hope|hope|i open|oh pen|a pen|i'll pen|opened|oh, pen|i pen)\b\s*/i;

/** Two-word mishearings of Kraken words, anywhere. */
const PHRASES: [RegExp, string][] = [
  [/\bin box\b/gi, 'inbox'],
  [/\bfollow ups?\b/gi, 'follow-ups'],
  [/\bfund (?:to|too|two|2)\b/gi, 'Fund II'],
  [/\bcracking\b|\bcraken\b|\bkracken\b/gi, 'Kraken'],
];

/** Everyday words never swapped for a name, however close they sound. */
const COMMON = new Set(
  (
    'a an the and or but if then so to of in on at by for from with about as into onto over under up down out off ' +
    'i me my mine we us our you your he him his she her it its they them their this that these those there here ' +
    'is am are was were be been being do does did done have has had will would can could should may might must ' +
    'what who when where why how which not no yes yeah okay ok please thanks thank hey hi hello open show find ' +
    'search look pull bring take go get make tell give send reply draft write read call email mail meeting meetings ' +
    'today tomorrow yesterday week month year time now later new last next first all any some more most ' +
    'one two three four five lot little big good great bad deal deals task tasks note notes page tab ' +
    'just like know think want need see let put set keep stop start end done said says say'
  ).split(' '),
);

/** A rough sound key: same key, similar sound ("ledgerly" / "ledger lee"). */
export function soundKey(word: string): string {
  let w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return '';
  w = w
    .replace(/^kn|^gn|^pn|^wr/, (m) => m[1]!)
    .replace(/ph/g, 'f')
    .replace(/ck/g, 'k')
    .replace(/q/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/c(?=[eiy])/g, 's')
    .replace(/c/g, 'k')
    .replace(/dg/g, 'j')
    .replace(/gh/g, '')
    .replace(/z/g, 's')
    .replace(/v/g, 'f')
    .replace(/y$/g, 'i');
  const first = w[0]!;
  const rest = w.slice(1).replace(/[aeiouyhw]/g, '');
  return (/[aeiou]/.test(first) ? 'a' : first) + rest.replace(/(.)\1+/g, '$1');
}

export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

interface Term {
  text: string;
  letters: string;
  key: string;
  words: number;
}

function toTerm(text: string): Term | null {
  const clean = text.replace(/\s+/g, ' ').trim();
  const letters = clean.toLowerCase().replace(/[^a-z]/g, '');
  if (letters.length < 4) return null;
  return { text: clean, letters, key: soundKey(letters), words: clean.split(' ').length };
}

let appTerms: Term[] | null = null;

/** Kraken's own page and tab names. */
function kraken(): Term[] {
  if (!appTerms) {
    const names = new Set<string>(['Kraken', 'Arwin']);
    for (const e of appGuideIndex()) {
      names.add(e.pageName);
      if (e.tabLabel) names.add(e.tabLabel);
    }
    appTerms = [...names].map(toTerm).filter((t): t is Term => t !== null);
  }
  return appTerms;
}

/** Prepare the team's names once (companies, people), longest first. */
export function prepareNames(names: readonly string[]): Term[] {
  const seen = new Set<string>();
  const out: Term[] = [];
  for (const n of names) {
    const t = toTerm(n);
    if (!t || seen.has(t.letters)) continue;
    seen.add(t.letters);
    out.push(t);
  }
  return out;
}

/** The known term this run of words sounds like, if it is close enough. */
function closest(window: string, terms: readonly Term[]): Term | null {
  const letters = window.toLowerCase().replace(/[^a-z]/g, '');
  if (letters.length < 4) return null;
  const key = soundKey(letters);
  let best: { term: Term; score: number } | null = null;
  for (const t of terms) {
    if (Math.abs(t.letters.length - letters.length) > Math.max(2, t.letters.length * 0.3)) continue;
    const exact = t.letters === letters;
    const sameSound = t.key === key || editDistance(t.key, key) <= (key.length >= 5 ? 1 : 0);
    if (!exact && !sameSound) continue;
    const spelling = editDistance(t.letters, letters);
    const allowed = Math.max(1, Math.floor(t.letters.length * 0.34));
    if (!exact && spelling > allowed) continue;
    const score = exact ? -1 : spelling;
    if (!best || score < best.score) best = { term: t, score };
  }
  return best?.term ?? null;
}

/** Spell runs of words that sound like a known name the way Kraken spells them. */
function snapNames(text: string, terms: readonly Term[]): string {
  if (terms.length === 0) return text;
  const tokens = text.split(/(\s+)/); // words and the spaces between them
  const words: { word: string; at: number }[] = [];
  tokens.forEach((t, i) => {
    if (t.trim()) words.push({ word: t, at: i });
  });
  const out = [...tokens];
  let i = 0;
  while (i < words.length) {
    let done = false;
    for (let size = Math.min(3, words.length - i); size >= 1; size--) {
      const run = words.slice(i, i + size);
      const plain = run.map((w) => w.word.replace(/[^\p{L}\p{N}'-]/gu, ''));
      if (size === 1 && plain[0]!.length < 4) continue;
      // Never swallow an everyday word at either end ("my", "the", "show").
      if (COMMON.has(plain[0]!.toLowerCase()) || COMMON.has(plain[size - 1]!.toLowerCase()))
        continue;
      const term = closest(plain.join(' '), terms);
      if (!term) continue;
      const already = plain.join(' ') === term.text;
      if (!already) {
        const trailing = run[run.length - 1]!.word.match(/[^\p{L}\p{N}]+$/u)?.[0] ?? '';
        out[run[0]!.at] = term.text + trailing;
        for (let k = run[0]!.at + 1; k <= run[run.length - 1]!.at; k++) out[k] = '';
      }
      i += size;
      done = true;
      break;
    }
    if (!done) i += 1;
  }
  return out.join('').replace(/\s+/g, ' ').trim();
}

export function fixTranscript(heard: string, names: readonly Term[] = []): FixResult {
  let text = heard.replace(/\s+/g, ' ').trim();
  const before = text;

  // "Hang on, I hope my inbox" → "Hey Arwin, open my inbox".
  let greeted = false;
  const g = GREETING.exec(text);
  if (g) {
    text = text.slice(g[0].length);
    greeted = true;
  }
  for (const [pattern, word] of PHRASES) text = text.replace(pattern, word);
  text = snapNames(text, [...kraken(), ...names]);

  // "I hope my inbox": "open", trusted only when a known page or name follows.
  const o = OPEN_MISHEARD.exec(text);
  if (o) {
    const rest = text.slice(o[0].length).replace(/^(?:my|the|our)\s+/i, '');
    const firstWords = rest.split(' ').slice(0, 3).join(' ');
    const known = [...kraken(), ...names].some((t) =>
      firstWords.toLowerCase().startsWith(t.text.toLowerCase()),
    );
    if (known) text = `open ${text.slice(o[0].length)}`;
  }

  if (greeted) text = `Hey Arwin, ${text}`;
  text = text.replace(/^./, (c) => c.toUpperCase());
  return { text, changed: text.toLowerCase() !== before.toLowerCase() };
}
