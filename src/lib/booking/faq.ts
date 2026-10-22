import type { FaqItem } from './chatbot-config';

/**
 * The booking assistant's answers without any AI (D-078): a visitor's
 * question is matched, here, against the questions Arwin wrote in the
 * Booking tab (and a few built from the public card), and the best one's
 * answer is given word for word. No model, no network, nothing to spend.
 *
 * How it matches: both sides are lower-cased, stripped of accents and
 * punctuation, filler words dropped, the rest cut to a rough stem and folded
 * onto a shared word for common synonyms ("check size" and "how much do you
 * invest" meet at "invest" and "size"). The score is the overlap of the two
 * word sets (weighted towards the written question, lightly towards its
 * answer) plus a bonus when two words of the visitor's appear side by side in
 * the question. A score at or over the threshold answers; the next best
 * become "Did you mean" chips.
 *
 * Pure and client-safe: the Booking tab's "Test a question" box runs the
 * same code over unsaved edits.
 */

export const MATCH_THRESHOLD = 0.5;
export const SUGGEST_THRESHOLD = 0.18;
export const MAX_SUGGESTIONS = 3;

export interface FaqEntry extends FaqItem {
  /** Stable within one list: `faq:<index>` for Arwin's, `card:<name>` for built-ins. */
  id: string;
  builtIn?: boolean;
  /** Words matched instead of `q` (a built-in's short question shows; these match). */
  match?: string;
}

export interface FaqMatch {
  entry: FaqEntry;
  score: number;
}

export interface FaqResult {
  /** The answer to give, when one scored at or over the threshold. */
  best: FaqMatch | null;
  /** Up to three other close questions, best first. */
  suggestions: FaqMatch[];
}

const STOP_WORDS = new Set(
  (
    'a an the and or but if then so to of in on at by for from with about into over as is are was ' +
    'were be been being am do does did done doing have has had having i me my mine we us our ours ' +
    'you your yours he him his she her they them their it its this that these those there here ' +
    'what which whom whose when why how can could would should shall will may might must ' +
    'please hi hello hey thanks thank just also any some all each more most very really much many ' +
    'get got go going let like want wanted wanting know tell say said need im ive id youre dont ' +
    'doesnt cant isnt arent wasnt not no yes ok okay one'
  ).split(' '),
);

/**
 * Words that mean the same thing here, folded onto one. Keys are stems (see
 * `stem`), so "investing", "investment" and "invests" all arrive as "invest".
 */
const SYNONYMS: Record<string, string> = {
  invest: 'invest',
  investor: 'invest',
  fund: 'invest',
  funding: 'invest',
  back: 'invest',
  write: 'invest',
  check: 'size',
  cheque: 'size',
  ticket: 'size',
  size: 'size',
  amount: 'size',
  allocation: 'size',
  stage: 'stage',
  round: 'stage',
  preseed: 'stage',
  seed: 'stage',
  series: 'stage',
  pitch: 'pitch',
  deck: 'pitch',
  present: 'pitch',
  presentation: 'pitch',
  apply: 'pitch',
  submit: 'pitch',
  sector: 'sector',
  industry: 'sector',
  vertical: 'sector',
  focus: 'sector',
  thesis: 'sector',
  space: 'sector',
  market: 'sector',
  meet: 'meet',
  meeting: 'meet',
  call: 'meet',
  chat: 'meet',
  zoom: 'video',
  video: 'video',
  virtual: 'video',
  online: 'video',
  remote: 'video',
  where: 'place',
  place: 'place',
  location: 'place',
  locat: 'place',
  address: 'place',
  office: 'place',
  venue: 'place',
  cafe: 'place',
  time: 'time',
  when: 'time',
  schedul: 'time',
  available: 'time',
  availability: 'time',
  slot: 'time',
  open: 'time',
  free: 'time',
  reschedul: 'reschedule',
  move: 'reschedule',
  change: 'reschedule',
  postpone: 'reschedule',
  cancel: 'cancel',
  cancell: 'cancel',
  delet: 'cancel',
  decline: 'cancel',
  guest: 'guest',
  participant: 'guest',
  attende: 'guest',
  colleague: 'guest',
  cofounder: 'guest',
  bring: 'guest',
  invite: 'guest',
  add: 'guest',
  who: 'who',
  about: 'who',
  background: 'who',
  bio: 'who',
  long: 'length',
  length: 'length',
  duration: 'length',
  minute: 'length',
  hour: 'length',
  timezone: 'zone',
  zone: 'zone',
  cost: 'cost',
  price: 'cost',
  fee: 'cost',
  charge: 'cost',
  pay: 'cost',
  portfolio: 'portfolio',
  compan: 'portfolio',
  company: 'portfolio',
  startup: 'portfolio',
  founder: 'founder',
  email: 'contact',
  contact: 'contact',
  reach: 'contact',
  message: 'contact',
  lead: 'lead',
  follow: 'follow',
  coffee: 'coffee',
  lunch: 'lunch',
  dinner: 'dinner',
};

/** Accents off, lower case, everything but letters and digits a space. */
export function normalise(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/pre[\s-]+seed/g, 'preseed')
    .replace(/co[\s-]+founder/g, 'cofounder')
    .replace(/time[\s-]+zone/g, 'timezone')
    .replace(/how much/g, 'amount')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** A rough stem: enough that "meetings", "meeting" and "meet" agree. */
export function stem(word: string): string {
  if (word.length <= 3) return word;
  let w = word;
  if (w.endsWith('ies') && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.endsWith('es') && /(ch|sh|x|ss|zz)es$/.test(w)) w = w.slice(0, -2);
  else if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) w = w.slice(0, -1);
  if (w.endsWith('ing') && w.length > 5) w = w.slice(0, -3);
  else if (w.endsWith('ed') && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith('ment') && w.length > 6) w = w.slice(0, -4);
  else if (w.endsWith('ly') && w.length > 4) w = w.slice(0, -2);
  if (w.endsWith('e') && w.length > 4) w = w.slice(0, -1);
  return w;
}

/** Strip the trailing `e` the stemmer may leave on, so a synonym key matches either way. */
function canonical(word: string): string {
  const s = stem(word);
  return SYNONYMS[s] ?? SYNONYMS[word] ?? SYNONYMS[`${s}e`] ?? s;
}

/** The words that carry meaning, in order, folded and stemmed (repeats kept). */
export function wordList(text: string): string[] {
  return normalise(text)
    .split(' ')
    .filter((w) => w && !STOP_WORDS.has(w) && (w.length > 1 || /\d/.test(w)))
    .map(canonical);
}

/** The words that carry meaning, as a set. */
export function tokens(text: string): Set<string> {
  return new Set(wordList(text));
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / Math.sqrt(a.size * b.size);
}

function bigrams(words: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 1 < words.length; i++) out.add(`${words[i]} ${words[i + 1]}`);
  return out;
}

/** How well a visitor's question fits one entry, 0 and up (1 is a strong match). */
export function scoreEntry(question: string, entry: FaqItem & { match?: string }): number {
  const qWords = wordList(question);
  const q = new Set(qWords);
  if (!q.size) return 0;
  const written = wordList(entry.match ?? entry.q);
  const asked = new Set(written);
  const answer = tokens(entry.a);
  let score = overlap(q, asked);
  // Words only in the answer count for a little: "do you lead rounds?"
  // against a question "Stage" whose answer says "we lead seed rounds".
  let answerShared = 0;
  for (const t of q) if (!asked.has(t) && answer.has(t)) answerShared++;
  score += 0.25 * (answerShared / q.size);
  // Two of the visitor's words side by side in the written question.
  const pairs = bigrams(qWords);
  const writtenPairs = bigrams(written);
  for (const pair of pairs) {
    if (writtenPairs.has(pair)) {
      score += 0.2;
      break;
    }
  }
  // Every word of a short written question asked for ("Check size").
  if (asked.size > 0 && asked.size <= 3 && [...asked].every((t) => q.has(t))) score += 0.15;
  return Math.round(score * 1000) / 1000;
}

/** The best answer for a question, and up to three others it might have meant. */
export function matchFaq(question: string, entries: readonly FaqEntry[]): FaqResult {
  const scored = entries
    .map((entry) => ({ entry, score: scoreEntry(question, entry) }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || Number(!!a.entry.builtIn) - Number(!!b.entry.builtIn));
  const top = scored[0];
  const best = top && top.score >= MATCH_THRESHOLD ? top : null;
  const suggestions = scored
    .filter((m) => m !== best && m.score >= SUGGEST_THRESHOLD)
    .slice(0, MAX_SUGGESTIONS);
  return { best, suggestions };
}

/** Arwin's written answers as entries, in his order. */
export function faqEntries(items: readonly FaqItem[]): FaqEntry[] {
  return items.map((item, i) => ({ ...item, id: `faq:${i}` }));
}

/** What the public card and the link's settings say, for answers built from them. */
export interface PublicFacts {
  hostName: string;
  hostFirst: string;
  title: string;
  bio: string;
  firmName: string;
  offersCall: boolean;
  /** In-person kinds on offer, e.g. ['Coffee', 'Lunch']. Empty: calls only. */
  inPersonKinds: string[];
  /** Listed places, "Name (Area)". */
  places: string[];
  allowCustomPlace: boolean;
  guestsAllowed: boolean;
  maxGuests: number;
}

/**
 * A few answers built from the public card and the link's settings: only
 * text Arwin entered or a fact the page already shows. Arwin's own written
 * answers win a tie (`matchFaq` sorts built-ins after them).
 */
export function builtInEntries(facts: PublicFacts): FaqEntry[] {
  const who = facts.hostName.trim();
  const first = facts.hostFirst.trim() || who || 'the host';
  const firm = facts.firmName.trim();
  const out: FaqEntry[] = [];
  const add = (name: string, q: string, match: string, a: string) =>
    out.push({ id: `card:${name}`, q, match, a: a.trim(), builtIn: true });

  if (who && (facts.title.trim() || facts.bio.trim())) {
    const line = [who, facts.title.trim()].filter(Boolean).join(', ');
    add(
      'who',
      `Who is ${who}?`,
      `Who is ${who}? Tell me about ${first}`,
      [line, facts.bio.trim()].join('. ').trim(),
    );
  }
  const kinds = facts.inPersonKinds.map((k) => k.toLowerCase());
  const meetings = [
    facts.offersCall ? 'a 30-minute video call' : null,
    kinds.length ? `a 1-hour ${joinOr(kinds)} in person` : null,
  ].filter(Boolean) as string[];
  if (meetings.length) {
    add(
      'kinds',
      'What kinds of meetings can I book?',
      'What kinds of meetings can I book? How long is a meeting? Video call or in person?',
      `You can book ${joinOr(meetings)} with ${first}. Pick a time right here and the invitation is sent straight away.`,
    );
  }
  if (kinds.length && (facts.places.length || facts.allowCustomPlace)) {
    const listed = facts.places.length ? `Places to meet: ${facts.places.join('; ')}.` : '';
    const own = facts.allowCustomPlace ? ' You can also suggest a place of your own.' : '';
    add(
      'places',
      'Where do we meet?',
      'Where do we meet in person? What location or place?',
      `${listed}${own}`,
    );
  }
  add(
    'guests',
    'Can I add guests?',
    'Can I add guests or bring a colleague or cofounder to the meeting?',
    facts.guestsAllowed
      ? `Yes. Add up to ${facts.maxGuests} guest${facts.maxGuests === 1 ? '' : 's'} by email when you book, and they get the invitation too.`
      : 'Only you can be added from this page. Forward the invitation to anyone who should join.',
  );
  add(
    'reschedule',
    'How do I reschedule or cancel?',
    'How do I reschedule or cancel a meeting? Change or move the time',
    'Your booking confirmation has a link to reschedule or cancel. Rescheduling moves the meeting for you, and you can leave a note when you cancel.',
  );
  add(
    'zone',
    'What time zone are the times in?',
    'What time zone are the times in?',
    'Times are shown in your own time zone. You can change it above the times on the page.',
  );
  if (firm) {
    add('firm', `What is ${firm}?`, `What is ${firm}?`, `${who || first} is with ${firm}.`);
  }
  return out;
}

function joinOr(words: string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`;
}

/* ---------------------------------------------------------------- intents */

export type ChatIntent =
  | { intent: 'call' }
  | { intent: 'in_person'; kind: 'coffee' | 'lunch' | 'dinner' | null }
  | { intent: 'message' };

/**
 * Whether free text is really asking to book or to leave a message, so the
 * assistant can start that flow instead of looking for an answer: "can we
 * grab coffee next week?", "I'd like to book a call", "leave a message".
 */
export function detectIntent(text: string): ChatIntent | null {
  const t = ` ${normalise(text)} `;
  const wantsTime =
    /\b(book|schedule|set up|setup|arrange|grab|get|find|have|hop on|jump on)\b/.test(t) ||
    /\b(can|could|shall) we\b/.test(t) ||
    /\b(id|i would) like\b/.test(t) ||
    /\b(meet up|meet with|meeting with)\b/.test(t);
  const kind = /\bcoffee\b/.test(t)
    ? 'coffee'
    : /\blunch\b/.test(t)
      ? 'lunch'
      : /\bdinner\b/.test(t)
        ? 'dinner'
        : null;
  if (kind && (wantsTime || t.trim().split(' ').length <= 3)) {
    return { intent: 'in_person', kind };
  }
  if (/\b(leave|send|drop|share)\b(\s+\w+){0,3}\s+(message|note|deck)\b/.test(t)) {
    return { intent: 'message' };
  }
  if (/\bin person\b/.test(t) && wantsTime) return { intent: 'in_person', kind: null };
  if (/\b(call|video|zoom|chat)\b/.test(t) && wantsTime && !/\bhow long\b/.test(t)) {
    return { intent: 'call' };
  }
  if (/\b(book|schedule)\b.*\b(time|meeting|slot)\b/.test(t)) return { intent: 'call' };
  return null;
}
