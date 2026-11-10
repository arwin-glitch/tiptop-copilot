import { judgeMatches, searchAppGuide, type AppGuideMatch } from '@/lib/help/app-guide';

/**
 * What a spoken sentence asks Voice Arwin to do. Pure: no React, no browser.
 *
 * Opening a page and searching happen at once on this computer; everything
 * else goes to Ask Arwin exactly as if it had been typed, so voice answers
 * come from the same place as chat answers.
 */
export type VoiceIntent =
  | { kind: 'navigate'; match: AppGuideMatch; reply: string }
  | { kind: 'search'; query: string; reply: string }
  | { kind: 'stop' }
  | { kind: 'ask'; question: string }
  | { kind: 'empty' };

/** "Arwin" as speech-to-text often writes it. */
const ARWIN_LIKE =
  '(?:arwin|arwyn|arwen|erwin|irwin|erwan|aaron|edwin|darwin|our win|are win|ar win|r win)';

/**
 * "Hey Arwin" at the start of what was heard, and what came after it. Only a
 * greeting plus the name counts, so "Arwin said…" in a conversation does not
 * wake it.
 */
const WAKE = new RegExp(
  `^[\\s"'(]*(?:hey|hay|hi|hiya|okay|ok|yo|a|hello)[\\s,]+${ARWIN_LIKE}\\b[\\s,.!?:;-]*(.*)$`,
  'is',
);

/** The rest of the sentence after "Hey Arwin", or null when it was not said. */
export function matchWake(text: string): { rest: string } | null {
  const m = WAKE.exec(text.replace(/[’]/g, "'").trim());
  return m ? { rest: (m[1] ?? '').trim() } : null;
}

/** Words people put around a command that carry no meaning for it. */
const LEADING_FILLER = new RegExp(
  `^(?:(?:hey|hi|ok|okay|yo|so|um+|uh+|and)\\b[\\s,]*)*(?:${ARWIN_LIKE}\\b[\\s,]*)?` +
    "(?:(?:please|can you|could you|would you|will you|can u|i want to|i wanna|i'd like to|let's|lets)\\b[\\s,]*)*",
);
const TRAILING_FILLER = /(?:[\s,]+(?:for me|please|thanks|thank you|now|real quick|quickly))+$/;

const STOP =
  /^(?:stop|cancel|never ?mind|forget it|shut up|be quiet|quiet|that's all|thats all|that's it|thats it|nothing|bye|bye bye|goodbye|good bye|end|end chat|end voice chat|end the chat|i'm done|im done|we're done|all done|thanks|thank you|no thanks|no thank you|nope|no)$/;

/** Clear "we're done" phrases inside a short sentence: "ok thanks, end chat". */
const END_PHRASE =
  /\b(?:end (?:the )?(?:voice )?(?:chat|call|conversation)|stop (?:the )?(?:voice )?chat|stop listening|bye(?: bye)?(?: arwin)?|goodbye|good bye|that's all|thats all|that's it for now|we're done|were done|i'm done|im done|all done|thanks arwin|thank you arwin|talk (?:to you )?later|see you)\b/;

/** A short sentence that ends the voice chat ("ok thanks, end chat", "bye Arwin"). */
export function endsChat(said: string): boolean {
  return said.split(' ').length <= 7 && END_PHRASE.test(said);
}

const NAVIGATE =
  /^(?:open(?: up)?|go to|go back to|take me to|bring me to|show(?: me)?|pull up|bring up|switch to|jump to|navigate to|launch)\s+(.+)$/;

/** "Show me what's due today": a question about data, for Ask, not a page to open. */
const ABOUT_DATA =
  /\b(what|what's|whats|who|who's|when|where|why|how|which|today|tonight|tomorrow|yesterday|this week|next week|last week|due|latest|new|unread|from|about)\b/;

const SEARCH = /^(?:search(?: kraken)?(?: for)?|find(?: me)?|look up|lookup|look for)\s+(.+)$/;

/** "the", "my", "our" and a trailing "page"/"tab" say nothing about where to go. */
function placeWords(target: string): string {
  return target
    .replace(/^(?:the|my|our|nick's|nicks)\s+/, '')
    .replace(/\s+(?:page|tab|screen|section)$/, '')
    .trim();
}

/** The sentence as typed or heard, lower-cased and without its fillers or end punctuation. */
export function normalizeUtterance(text: string): string {
  let t = text
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s.!?…,]+$/g, '');
  // Fillers can repeat ("hey arwin, can you please …"), so strip until stable.
  for (let i = 0; i < 3; i++) {
    const next = t
      .replace(LEADING_FILLER, '')
      .replace(TRAILING_FILLER, '')
      .replace(/[\s.!?…,]+$/g, '')
      .trim();
    if (next === t) break;
    t = next;
  }
  return t;
}

/** The page or tab a spoken place names, only when one place clearly wins. */
export function placeFor(target: string): AppGuideMatch | null {
  const words = placeWords(target);
  if (!words) return null;
  const matches = searchAppGuide(words);
  const verdict = judgeMatches(matches);
  if (verdict.kind === 'confident' && verdict.match.href) return verdict.match;
  // A page or tab named outright ("tasks", "inbox") is enough on its own.
  const top = matches[0];
  if (top?.strong && top.href && (!matches[1] || matches[1].score < top.score)) return top;
  return null;
}

function where(match: AppGuideMatch): string {
  return match.tabLabel ? `${match.pageName}, ${match.tabLabel}` : match.pageName;
}

export function voiceIntent(text: string): VoiceIntent {
  const original = text.trim();
  const said = normalizeUtterance(original);
  if (!said) return { kind: 'empty' };
  if (STOP.test(said) || endsChat(said)) return { kind: 'stop' };

  // Names keep the capitals they were said or typed with ("Acme", not "acme").
  const asSaid = (words: string) => {
    const at = original.toLowerCase().replace(/[’]/g, "'").indexOf(words);
    return at >= 0 ? original.slice(at, at + words.length) : words;
  };

  const search = SEARCH.exec(said);
  if (search?.[1]) {
    const query = asSaid(placeWords(search[1]));
    if (query) return { kind: 'search', query, reply: `Searching for ${query}.` };
  }

  const nav = NAVIGATE.exec(said);
  if (nav?.[1] && !ABOUT_DATA.test(nav[1])) {
    const match = placeFor(nav[1]);
    if (match) return { kind: 'navigate', match, reply: `Opening ${where(match)}.` };
    // "Pull up Acme" names a thing, not a page: look it up instead. Questions
    // about data ("show me what's due today") still go to Ask.
    const thing = asSaid(placeWords(nav[1]));
    if (thing && thing.split(' ').length <= 4) {
      return { kind: 'search', query: thing, reply: `Looking up ${thing}.` };
    }
  }

  // A bare page name ("inbox", "tasks") is a request to open it.
  if (said.split(' ').length <= 3) {
    const match = placeFor(said);
    if (match && match.strong)
      return { kind: 'navigate', match, reply: `Opening ${where(match)}.` };
  }

  const woke = matchWake(original);
  return { kind: 'ask', question: woke?.rest || original };
}

/**
 * An answer as it should be read aloud: no markdown, links or lists, and
 * short (the full answer stays in the chat).
 */
export function spokenText(text: string, maxChars = 320): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<?https?:\/\/\S+>?/g, ' ')
    .replace(/[*_`#>|~]+/g, ' ')
    .replace(/^\s*(?:[-•]|\d+[.)])\s+/gm, '')
    .replace(/([.!?:;,])\s*\n+\s*/g, '$1 ')
    .replace(/\s*\n+\s*/g, '. ')
    .replace(/\.\s*\./g, '.')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length <= maxChars) return plain;
  const sentences = plain.match(/[^.!?]+[.!?]+/g) ?? [plain];
  let out = '';
  for (const s of sentences) {
    if ((out + s).length > maxChars) break;
    out += s;
  }
  if (!out) out = `${plain.slice(0, maxChars).replace(/\s+\S*$/, '')}.`;
  return `${out.trim()} The rest is in the chat.`;
}

/* ------------------------------------------------------ "one sec" lines */

const ACKS: { when: RegExp; lines: string[] }[] = [
  {
    when: /\b(calendar|meeting|meetings|schedule|today|tomorrow|this week|free|busy|call)\b/i,
    lines: [
      'Let me check your calendar, one sec.',
      'Give me a second, pulling up your schedule.',
      'Sure, let me look at what’s on the calendar.',
    ],
  },
  {
    when: /\b(email|emails|inbox|mail|reply|replied|wrote|sent|message)\b/i,
    lines: [
      'Give me a sec, I’ll dig through the inbox.',
      'Let me check the emails on that, one moment.',
      'Sure thing, looking through the mail now.',
    ],
  },
  {
    when: /\b(draft|write|compose|intro|introduce|follow up|follow-up)\b/i,
    lines: [
      'Sure, let me put that together for you.',
      'Okay, I’ll draft that up, give me a sec.',
      'Got it, working on the wording now.',
    ],
  },
  {
    when: /\b(deal|deals|company|startup|founder|portfolio|round|raise|investor|fund)\b/i,
    lines: [
      'Good question, let me look into that.',
      'Let me pull up what we have on that, one sec.',
      'Sure, I’ll check the notes on that for you.',
    ],
  },
];

const GENERAL_ACKS = [
  'I’ll look into that, just give me a sec.',
  'Good question, let me check.',
  'Sure, one moment while I find that.',
  'Let me take a look, be right back.',
  'Okay, give me a second on that one.',
];

let lastAck = '';

/**
 * What Arwin says while the answer is on its way: short, warm and about
 * the question when it can tell ("Let me check your calendar, one sec"),
 * never the same line twice in a row.
 */
export function ackFor(question: string, random: () => number = Math.random): string {
  const pool = ACKS.find((a) => a.when.test(question))?.lines ?? GENERAL_ACKS;
  const choices = pool.filter((l) => l !== lastAck);
  const line = choices[Math.floor(random() * choices.length)] ?? pool[0]!;
  lastAck = line;
  return line;
}
