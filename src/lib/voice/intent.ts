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

/** Words people put around a command that carry no meaning for it. */
const LEADING_FILLER =
  /^(?:(?:hey|hi|ok|okay|yo|so|um+|uh+|and)\b[\s,]*)*(?:arwin\b[\s,]*)?(?:(?:please|can you|could you|would you|will you|can u|i want to|i wanna|i'd like to|let's|lets)\b[\s,]*)*/;
const TRAILING_FILLER = /(?:[\s,]+(?:for me|please|thanks|thank you|now|real quick|quickly))+$/;

const STOP =
  /^(?:stop|cancel|never ?mind|forget it|shut up|be quiet|quiet|that's all|thats all|nothing)$/;

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
  if (STOP.test(said)) return { kind: 'stop' };

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

  return { kind: 'ask', question: original.replace(/^\s*(?:hey|ok|okay)?[\s,]*arwin[\s,]+/i, '') };
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
