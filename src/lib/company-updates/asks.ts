import type { PortfolioRequestType } from '@/lib/types/domain';
import { htmlToPlainText } from '@/lib/util/text';

/**
 * The explicit asks in a portfolio company's update email.
 *
 * Founders close their updates with a section of asks, under a short heading
 * whose main word is the ask or the help: "Asks", "My ask", "Top asks for
 * this month", "Key asks", "Asks & needs", "How you can help", "Ways to
 * help", "Where we need help". This reads only those sections, in the shapes
 * founders actually write them:
 *  - bullet or numbered lines, a wrapped bullet kept as one ask and nested
 *    detail kept out of the list ("Hiring" over its roles becomes one ask);
 *  - short title lines each over one sentence ("Lead investors" over
 *    "Intros to funds that back…" becomes "Lead investors: Intros to funds
 *    that back…");
 *  - a paragraph, of which only the sentences with asking words are kept
 *    ("Intros to seed funds would help", not "We have 40 paying customers",
 *    the news, a thank-you or "would love to catch up" around it), with the
 *    sentence an ask points back to ("anyone in these areas");
 *  - the heading and the ask on one line ("One ask: an intro to…",
 *    "**One ask.** Acme Corp…", "How you can help: (1) … (2) …").
 * A section ends at a sign-off, a signature, the next heading or a rule.
 * "None right now", "N/A" and "No asks this month" are no ask; a line about
 * the asks themselves ("Same asks as last month") is not one either; a
 * "Thanks for the help!" list of past helpers is never read, nor the
 * thank-yous under "Asks & thank yous". Under a bare "Requests" heading only
 * items that read as asks are kept (not feature requests or API counts).
 * HTML bodies are read as text with their lists' nesting kept. At most six
 * asks of 300 characters each come from one email.
 *
 * Deterministic: no model is involved, nothing is read outside an asks
 * section, and quoted replies are never read, so every ask is something the
 * company wrote under its own heading.
 *
 * Pure and client-safe; `lib/services/portfolio-asks.ts` reads the mail and
 * records each ask as an open portfolio request (leaving out any that reads
 * as instructions to a model).
 */

export interface ExtractedAsk {
  /** The ask as written, its bullet, markdown and links stripped. */
  text: string;
  /** The heading it sat under, as written ("Our asks"). */
  heading: string;
}

/** More than this under one update is a list of something else. */
const MAX_ASKS = 6;
const MAX_ASK_CHARS = 300;
/** A heading is a short line; a sentence that happens to say "asks" is not one. */
const MAX_HEADING_CHARS = 60;
/** Paragraphs read under one heading before giving up on finding the ask. */
const MAX_BLOCKS = 4;

const EMOJI = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}\u{20E3}]/gu;

const ASK_NOUN = String.raw`(?:asks?|requests?)`;
const ASK_PREFIX = String.raw`(?:(?:our|my|the|key|top|main|current|open|big|biggest|specific|a few|some|quick|one|two|three|four|five|\d{1,2}|this (?:month|quarter|week)'?s?|monthly|quarterly|weekly)\s+)*`;
/**
 * Any other word or two before "asks" ("Highest-impact asks", "Investor
 * asks"), except the ones that make it something else: what customers ask
 * for ("Customer asks", "Feature asks"), a list with another section
 * ("Highlights and asks"), none at all ("No asks"), or a sentence ("Everyone
 * asks").
 */
const OTHER_WORD = String.raw`(?!(?:and|or|plus|no|zero|any|anyone|everyone|nobody|someone|he|she|they|it|who|what|that|which|feature|features|customer|customers|client|clients|user|users|support|product|pull|merge|common|frequent)\b)[a-z][a-z'-]*`;
const OTHER_PREFIX = String.raw`(?:${OTHER_WORD}\s+){1,2}`;
const AUDIENCE = String.raw`(?:you|you all|y'?all|you guys|investors|our investors|the team|our network|the network|friends|everyone|our community|the community)`;
const MONTH = String.raw`(?:january|february|march|april|may|june|july|august|september|october|november|december)`;
/** "… for this month", "… this quarter", "… for Q4", "… for October". */
const WHEN = String.raw`(?:\s+(?:(?:for|in|during|of)\s+)?(?:(?:this|the|next|coming)\s+)+(?:month|quarter|week|year|round|cycle)|\s+(?:for|in)\s+(?:q[1-4](?:\s*'?\d{2,4})?|${MONTH}(?:\s+\d{4})?))?`;
const FOR_WHOM = String.raw`(?:\s+(?:for|of|from|to)\s+${AUDIENCE})?`;

/** The heading phrases, matched against the whole cleaned line. */
const HEADING_PHRASE = new RegExp(
  String.raw`^(?:` +
    [
      // "Asks", "Our asks", "Top 3 asks", "Asks for investors", "Requests",
      // "Top asks for this month", "Our asks this month"
      String.raw`${ASK_PREFIX}${ASK_NOUN}${FOR_WHOM}${WHEN}`,
      // "Highest-impact asks"
      String.raw`${OTHER_PREFIX}asks?${FOR_WHOM}${WHEN}`,
      // "How you can help", "How investors can help us"
      String.raw`how (?:${AUDIENCE}|we) (?:can|could|might) help(?: us| out)?${WHEN}`,
      String.raw`how to help(?: us| out)?`,
      // "Ways to help", "Ways you can help"
      String.raw`(?:some )?ways (?:to|you can|you could|${AUDIENCE} can) (?:help|support us)(?: us| out)?${WHEN}`,
      String.raw`help wanted`,
      String.raw`help needed`,
      // "Where we need help", "Where we could use your help", "Where you can help"
      String.raw`where (?:we|i) (?:need|could use|can use|would love|'?d love) (?:your |some |a little |a bit of )?help${WHEN}`,
      String.raw`where (?:${AUDIENCE}) (?:can|could) help`,
      String.raw`we (?:need|could use|would love) your help`,
      String.raw`what we need(?: from ${AUDIENCE})?`,
    ].join('|') +
    String.raw`)$`,
  'i',
);

/**
 * Words that may share a heading with an ask phrase ("Hiring & asks", "Asks &
 * needs", "Asks & thank yous"). A thank-you under such a heading is never
 * taken as an ask (`extractAsks`).
 */
const COMPANION =
  /^(?:hiring|intros?|introductions?|help|referrals?|asks?|needs?|requests?|thanks|thank ?you'?s?|shout-?outs?|kudos|gratitude)$/i;

/** A list marker: a dash or dot, a number or letter, a checkbox, or an emoji. */
const MARKER = String.raw`(?:[-*•·‣◦▪▸►–—]|\(?\d{1,2}[.)]|\(?[a-h][.)](?=\s)|\[[ x]?\]|[\p{Extended_Pictographic}][\u{FE0F}\u{1F3FB}-\u{1F3FF}]?)`;
const BULLET = new RegExp(String.raw`^\s*(${MARKER})\s+(\S.*)$`, 'u');
/** A dash typed hard against its text ("-Any intros to…"); three words at least, so "-Dana" signing off is not one. */
const TIGHT_BULLET = /^\s*([-•–])(?=[A-Za-z])(\S+(?:\s+\S+){2,})\s*$/u;
/** A marker on a line of its own, its text on the next: how Gmail writes a list as plain text. */
const LONE_MARKER = /^\s*([-*•◦▪]|\d{1,2}[.)])\s*$/;
/** A rule between sections: "---", "***", "_____", "———". */
const RULE = /^\s*(?:[-_=*~—–•·]\s*){3,}$/;

/**
 * The text of a bullet or numbered line ("- Intro to X", "2) Intro to X",
 * "• Intro to X", "👉 Intro to X"), or null when the line is not one.
 */
export function bulletText(line: string): string | null {
  const m = BULLET.exec(line) ?? TIGHT_BULLET.exec(line);
  return m ? (m[2] ?? '').trim() : null;
}

interface Marker {
  /** Dashes and dots are one kind ("•" from an HTML list, "-" typed); numbers, letters, checkboxes, emoji. */
  kind: 'dash' | 'number' | 'letter' | 'check' | 'emoji';
  /** The emoji itself: "👉 … 👉 …" is one list, "👉 …" then "👥 Team" is not. */
  glyph: string;
  /** 1, 2, 3 for "1." / "b)", so "4. Team" after "2." is not the third ask. */
  n: number | null;
  indent: number;
}

/** The marker a bullet line starts with, or null when the line is not a bullet. */
function markerOf(line: string): Marker | null {
  if (RULE.test(line)) return null;
  const m = BULLET.exec(line) ?? TIGHT_BULLET.exec(line);
  if (!m) return null;
  const raw = m[1] ?? '';
  const indent = /^\s*/.exec(line)?.[0].length ?? 0;
  const digits = /\d+/.exec(raw);
  if (digits) return { kind: 'number', glyph: '', n: Number(digits[0]), indent };
  if (/^\(?[a-h][.)]$/.test(raw)) {
    return { kind: 'letter', glyph: '', n: raw.replace(/[^a-h]/g, '').charCodeAt(0) - 96, indent };
  }
  if (raw.startsWith('[')) return { kind: 'check', glyph: '', n: null, indent };
  if (/^[-*•·‣◦▪▸►–—]$/.test(raw)) return { kind: 'dash', glyph: '', n: null, indent };
  return {
    kind: 'emoji',
    glyph: raw.replace(/[\u{FE0F}\u{1F3FB}-\u{1F3FF}]/gu, ''),
    n: null,
    indent,
  };
}

/**
 * The other sections of an update, by their usual names. A bullet that reads
 * as one of them ("👥 Team", "4. Highlights") is the next heading, never an
 * ask, and ends the list.
 */
const SECTION_NAMES = new Set([
  'team',
  'people',
  'culture',
  'hiring',
  'hires',
  'new hires',
  'talent',
  'highlights',
  'lowlights',
  'wins',
  'key wins',
  'losses',
  'challenges',
  'headwinds',
  'tailwinds',
  'metrics',
  'key metrics',
  'kpis',
  'numbers',
  'the numbers',
  'financials',
  'finance',
  'revenue',
  'sales',
  'marketing',
  'product',
  'product updates',
  'product update',
  'roadmap',
  'product roadmap',
  'engineering',
  'tech',
  'technology',
  'customers',
  'growth',
  'traction',
  'fundraising',
  'fundraise',
  'runway',
  'cash',
  'burn',
  'update',
  'updates',
  'company update',
  'business update',
  'team update',
  'news',
  'press',
  'in the news',
  "what's next",
  'whats next',
  'next steps',
  'looking ahead',
  'up next',
  'coming up',
  'outlook',
  'priorities',
  'goals',
  'focus',
  'okrs',
  'learnings',
  'lessons',
  'lessons learned',
  'misc',
  'miscellaneous',
  'other',
  'other news',
  'shoutouts',
  'shout-outs',
  'shout outs',
  'thanks',
  'thank you',
  'gratitude',
  'partnerships',
  'operations',
  'ops',
  'summary',
  'tl;dr',
  'tldr',
  'overview',
  'recap',
  'upcoming',
  'events',
  'milestones',
  'celebrations',
  'good news',
  'bad news',
  'the good',
  'the bad',
  'the ugly',
  'pipeline',
  'strategy',
  'go-to-market',
  'gtm',
  'pics',
  'photos',
  'recent reads',
  'reading',
]);

/** Whether a bullet's text is a heading rather than an ask: another section's name, or a short label ending in a colon. */
function looksLikeHeading(text: string): boolean {
  if (/[:：]\s*$/.test(text) && text.trim().split(/\s+/).length <= 6) return true;
  const clean = cleanHeading(text)?.toLowerCase();
  if (!clean) return false;
  const parts = clean.split(/\s*(?:&|\+|\/|,|\band\b)\s*/).filter(Boolean);
  return parts.length > 0 && parts.every((p) => SECTION_NAMES.has(p));
}

/** A thank-you is the end of the letter (or the start of a list of helpers), never an ask. */
const THANKS =
  /^(?:thanks|thank you|many thanks|appreciate (?:it|you|all)|with gratitude|gratefully)\b/i;
/** An item that thanks someone: "Thank you to the board for…", "Shout-out to Dana". */
const THANKED =
  /^(?:thanks|thank you|many thanks|big thanks|special thanks|shout-?outs?|s\/o|kudos|grateful|gratitude)\b/i;
/** A short closing line: "Best,", "Cheers", "Onwards!", "LFG." */
const CLOSING =
  /^(?:thx|ty|cheers|best|all the best|regards|kind regards|warm(?:ly| regards| wishes)?|talk soon|speak soon|more soon|until next (?:time|month)|onwards?|sincerely|love|xo+|lfg)\b[^\n]{0,24}$/i;

function isSignOff(line: string): boolean {
  const t = line
    .trim()
    .replace(/^[*_]+|[*_]+$/g, '')
    .trim();
  return THANKS.test(t) || CLOSING.test(t);
}

/** "**Our asks:** 🙏" -> "Our asks". Null when the line is too long to be a heading. */
function cleanHeading(line: string): string | null {
  let s = line.trim();
  if (!s || s.length > MAX_HEADING_CHARS) return null;
  s = s.replace(/^#{1,6}\s*/, '');
  // "4. Asks" or "IV) How you can help": a numbered section; "- Asks:" a nested one.
  s = s.replace(/^(?:\d{1,2}|[ivx]{1,4})[.)]\s+/i, '').replace(/^[-*•·‣◦▪▸►–—]\s+/, '');
  s = s
    .replace(EMOJI, ' ')
    .replace(/[*_~`]+/g, '')
    .replace(/[’]/g, "'")
    .replace(/^[\s:：\-–—|>]+/, '')
    .replace(/[\s:：\-–—|.!?]+$/, '')
    // "Asks (in priority order)", "Asks (2)"; not "Ask (our intelligence)",
    // a product's name that happens to be the word.
    .replace(
      /\s*\((?:[^()]*\b(?:order|priority|ranked|updated|new|again|still|please|if you can|for (?:you|investors|the network|friends)|q[1-4]|this (?:month|quarter))\b[^()]*|\d{1,2}|!+)\)$/i,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim();
  return s || null;
}

/** The heading as written when a line is an asks heading, else null. */
export function asksHeading(line: string): string | null {
  const clean = cleanHeading(line);
  if (!clean) return null;
  if (HEADING_PHRASE.test(clean)) return clean;
  // "Asks & how you can help", "Hiring / asks": every part ask-like, one an ask phrase.
  const parts = clean.split(/\s*(?:&|\+|\/|,|\band\b)\s*/i).filter(Boolean);
  if (parts.length < 2 || clean.split(' ').length > 8) return null;
  if (!parts.some((p) => HEADING_PHRASE.test(p))) return null;
  return parts.every((p) => HEADING_PHRASE.test(p) || COMPANION.test(p)) ? clean : null;
}

/** "On Mon, Oct 5, 2026 at 9:00 AM Jane <jane@x.com> wrote:", in the languages founders write in. */
const QUOTE_HEADER =
  /^(?:on|am|le|el|il|op)\s.{4,}\b(?:wrote|schrieb|a écrit|escribió|ha scritto|schreef)\b/i;

/** Where the company's own words stop: a quoted reply, an Outlook header, a signature. */
function ownLines(body: string): string[] {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const t = line.trim();
    const next = (lines[i + 1] ?? '').trim();
    // "On Mon, Oct 5, 2026 at 9:00 AM Jane <jane@x.com> wrote:", sometimes over two lines.
    if (/^on\s.{4,}/i.test(t) && (/wrote:\s*$/i.test(t) || /wrote:\s*$/i.test(next))) break;
    if (QUOTE_HEADER.test(t) && (/:\s*$/.test(t) || /:\s*$/.test(next))) break;
    if (/^-{2,}\s*original message\s*-{2,}$/i.test(t)) break;
    if (/^_{10,}$/.test(t)) break;
    // An Outlook reply header ("From: … / Sent: …"), unless it heads a forward.
    if (/^from:\s+\S/i.test(t) && /^(?:sent|date):\s/i.test(next)) {
      const before = lines
        .slice(Math.max(0, i - 2), i)
        .join(' ')
        .toLowerCase();
      if (!/forwarded message|begin forwarded/.test(before)) break;
    }
    // The signature delimiter ("-- ") and phone sign-offs end the letter.
    if (/^--\s?$/.test(line) || /^sent from my /i.test(t)) break;
    out.push(line);
  }
  return out;
}

/** An HTML body, or a "plain text" part that is really HTML (some update platforms send that). */
function looksLikeHtml(body: string): boolean {
  return (body.match(/<(?:p|div|br|li|ul|ol|table|td|h[1-6])\b[^>]*>/gi) ?? []).length >= 2;
}

/**
 * The body as lines of the company's own words: HTML read as text, quoted
 * replies and the signature cut, and Gmail's plain-text lists ("-" alone on a
 * line, the item's text below it) put back on one line, at the text's indent,
 * which is the one that tells an item from its sub-item.
 */
function bodyLines(body: string): string[] {
  const lines = ownLines(looksLikeHtml(body) ? htmlToPlainText(body) : body);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const lone = LONE_MARKER.exec(line);
    if (!lone) {
      out.push(line);
      continue;
    }
    let k = i + 1;
    if (!(lines[k] ?? '').trim()) k += 1;
    const text = lines[k] ?? '';
    if (!text.trim() || LONE_MARKER.test(text) || /^\s*>/.test(text)) {
      out.push('');
      continue;
    }
    const indent = /^\s*/.exec(text)?.[0] ?? '';
    out.push(`${indent}${lone[1]} ${text.trim()}`);
    i = k;
  }
  return out;
}

/* --------------------------------------------------------- the words */

/** "None right now", "N/A", "No asks this month", "Nothing new": no ask. */
const NOTHING =
  /^(?:n\/?a|none(?:\b.*)?|nothing(?:\b.*)?|tbd|tba|no(?:ne)?\s+(?:\w+\s+)?asks?\b.*|not (?:right now|at the moment|this (?:month|time|quarter))\b.*|all good\b.*|-+|\.+)$/i;
/** A line about the asks rather than an ask: "Same asks as last month". */
const META =
  /\b(?:same asks?|same as (?:last|before|always)|broken record|(?:these|our|my) asks (?:haven'?t|have not) changed|still the same)\b/i;
/**
 * Words that say what an ask is about, people to meet included. Enough for a
 * label or a title ("Lead investors", "Bridge round"); a sentence of prose
 * needs `REQUEST_CUE` as well, as the news and numbers around an ask name
 * the same things.
 */
const ASK_CUE =
  /\b(?:intros?|introductions?|introduce|connect(?:ions?)?|referrals?|refer|warm|appreciated?|would love|we'?d love|i'?d love|love (?:an?|to)|looking for|seeking|searching for|need|needs|help|helpful|if you know|do you know|know (?:anyone|someone|of)|anyone (?:who|in|at|with)|someone who|hiring|hire|candidates?|recruit\w*|feedback|advice|advisors?|mentors?|sharing|amplify\w*|spread the word|re-?share|promote|investors?|funds?|vcs?|angels?|customers?|clients?|buyers?|pilots?|design partners?|partners?|contacts?|names|beta testers?|testers?|roles?|engineers?|salespeople|salesperson|head of|vp|cto|cfo|cmo|coo|founders?|operators?|leaders?|executives?|allocation|round|bridge|invest(?:ing|ment)?|commit(?:ment)?s?)\b/i;
/**
 * Words that ask for something. A sentence of prose under an asks heading is
 * kept only with one of these: "Intros to seed funds would help", not "We
 * have 40 paying customers" or "Two new partners signed this month".
 */
const REQUEST_CUE =
  /\b(?:intros?|introductions?|introduc(?:e|ing)|referrals?|refer (?:us|them|anyone|someone|people)|connect(?:ing)? (?:us|me|with)|appreciated|appreciate (?:any|an?|your|it|intros?|introductions?)|(?:would|we'?d|i'?d|we would|i would) (?:\w+ )?(?:love|appreciate|welcome|value)|love (?:an?|to|your|any)|looking (?:for|to (?:connect|meet|hire|find|talk|speak))|seeking|searching for|(?:we|i) (?:really |still |also |urgently )?need\b|need (?:help|your|intros?|introductions?|advice|feedback)|could use|(?:your|some|any) help\b|help (?:us|me|with|finding|getting|spread(?:ing)?)|helpful|(?:would|could|can|will) (?:really |greatly |hugely |also |most )?help|if you know|do you know|who do you know|know (?:anyone|someone|of)|anyone (?:who|in|at|with|on|from)|someone who|(?:we(?:'re| are)|is|are|still|now) hiring|hiring (?:a|an|our|for|two|three|\d)|to hire|hire (?:a|an|our|two|three)|candidates?|recruit\w*|(?:any|your) (?:feedback|advice|thoughts)|feedback (?:on|from)|advice (?:on|from)|spread the word|re-?shar(?:e|ing)|repost(?:ing)?|amplify\w*|please (?:share|send|forward|intro\w*|connect|refer|consider)|names of|beta testers?|design partners?|tell (?:your|a|anyone|friends)|send (?:them|anyone|people|your)|if you(?:'d| would)? (?:like|want) to (?:be part|join|invest|participate|take part|get involved)|(?:join|participate in) (?:the|our) round)\b/i;
/** Asking words strong enough to keep a sentence that also says thank you or "reply to me". */
const STRONG_CUE =
  /\b(?:intros?|introductions?|introduce|referrals?|looking for|seeking|would (?:love|appreciate)|we'?d (?:love|appreciate)|i'?d (?:love|appreciate)|if you know|do you know|know (?:anyone|someone)|candidates?|hiring|if you(?:'d| would)? (?:like|want) to (?:be part|join|invest|participate|take part))\b/i;
/** A thank-you or a "reply to me": how to answer, not what is asked. */
const CTA =
  /\b(?:thank(?:s| you)|grateful|gratitude|reply (?:to (?:this|me)|here|directly)|hit reply|just reply|email me|text me|call me|give me a call|reach out|let me know|let'?s (?:talk|chat)|happy to (?:chat|talk|share|answer)|feel free|questions?|calendar|grab (?:some )?time|book (?:a )?(?:time|call)|schedule (?:a )?(?:call|time)|schedule time)\b/i;
/** Thanks for what is done ("grateful for the intros so far"), unlike "we'd be grateful for intros". */
const GRATITUDE = /\b(?:thank(?:s| you)|grateful|gratitude|shout-?outs?|kudos)\b/i;
const FUTURE_THANKS =
  /\b(?:(?:would|'d|will) (?:also )?(?:be )?(?:very |so |really |hugely |extremely |greatly |forever )?(?:grateful|thankful)|(?:grateful|thankful|thanks) (?:in advance )?for (?:any|an?|more)\b|thanks in advance)/i;
/** A closing pleasantry: "Would love to catch up at the conference". */
const SOCIAL =
  /\b(?:catch up|see (?:you|many of you|some of you|everyone|you all)|meet (?:you|many of you|some of you|everyone|you all|in person)|hear from you|say (?:hi|hello)|grab (?:a )?(?:coffee|drink|beer|lunch|dinner)|in person|happy holidays|have a great)\b/i;
const INTRO_WORD = /\b(?:intros?|introductions?|introduce|referrals?|candidates?)\b/i;
/** A line of numbers: "40 paying customers and $2M ARR, up 3x", "MRR $103K (+12% MoM)". */
const FIGURE = /(?:[$€£]\s?\d|\d\s?%|\b\d+(?:\.\d+)?\s?x\b|\b\d[\d,.]*\s?(?:k|m|mm|bn?)\b)/i;
const FIGURE_WORD =
  /\b(?:arr|mrr|revenue|run-?rate|gmv|nrr|grr|retention|churn|burn|runway|cash|margin|bookings|pipeline|growth|grew|up|down|mom|yoy|qoq|customers|users|accounts|logos|signed|paying|dau|wau|mau)\b/i;
/** Help already given: "…traces back to someone making a call, an intro", "you know who you are". */
const PAST_HELP =
  /\b(?:traces? back to|you know who you are|(?:made|gave|offered|sent) (?:us |me )?(?:a call|an? intros?|introductions?|the intros?)|making a call)\b/i;
/** An ask that points at the sentence before it: "anyone in these areas", "any of those". */
const REFERS_BACK =
  /\b(?:(?:these|those|such|both)\s+(?:areas?|spaces?|markets?|sectors?|industries|verticals?|roles?|companies|organizations|teams|people|folks|venues?|places|groups|categories|segments|accounts|kinds|types)|(?:in|at|into|to) (?:this|that) (?:space|area|market|sector|industry)|any of (?:these|those|them))\b/i;
/** A sentence fit to stand before such an ask: not numbers, thanks, a "reply to me", or a line about the asks. */
function setsContext(sentence: string): boolean {
  const s = plain(sentence);
  return (
    !isFigures(s) && !GRATITUDE.test(s) && !CTA.test(s) && !META.test(s) && !/[:：]\s*$/.test(s)
  );
}
/** A label's text that is news rather than the ask: "Customers: We signed three hospitals". */
const NEWS_START =
  /^(?:we|we'?ve|we'?re|our|i|i'?ve|it|this|they|the team|last (?:month|quarter|week))\b/i;
/** A line that points at the list below it: "…introductions to:", "two things", "the following". */
const LEAD_IN =
  /[:：]\s*$|\b(?:following|below|these|a few|a couple|two|three|four|things|ways|areas)\b/i;
/** "As for what would be helpful – intros to…" -> "intros to…". */
const LEAD_CLAUSE =
  /^(?:as for |in terms of )?(?:what would be (?:most |really |super )?helpful|how you can help|where you can help|the (?:big|main|biggest|one) ask(?: is)?)\s*(?:[-–—:,]|is\b)\s*/i;

/** Curly apostrophes as straight ones, for the word lists ("We’d love" is "We'd love"). */
const plain = (s: string) => s.replace(/[’‘ʼ]/g, "'");
const asksFor = (s: string) => ASK_CUE.test(plain(s));
const requests = (s: string) => REQUEST_CUE.test(plain(s));
const strong = (s: string) => STRONG_CUE.test(plain(s));
const isFigures = (s: string) => FIGURE.test(s) && FIGURE_WORD.test(s);
const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

/**
 * Whether a sentence of prose asks for something: asking words, and not a
 * thank-you for help already given, a "reply to me", a pleasantry, a line of
 * numbers, or a line about the asks themselves.
 */
function readsAsAsk(sentence: string): boolean {
  const s = plain(sentence);
  if (!REQUEST_CUE.test(s) || META.test(s) || NOTHING.test(s) || PAST_HELP.test(s)) return false;
  if (GRATITUDE.test(s) && !FUTURE_THANKS.test(s)) return false;
  if (CTA.test(s) && !STRONG_CUE.test(s)) return false;
  if (SOCIAL.test(s) && !INTRO_WORD.test(s)) return false;
  return !(isFigures(s) && !STRONG_CUE.test(s));
}
/** "Customer Stories", "What's Going Well / Next Focus": every word capitalized, small words aside. */
const titleCase = (s: string) => {
  const words = s.split(/\s+/).filter((w) => /[A-Za-z]/.test(w));
  return (
    words.length >= 2 &&
    words.every(
      (w) => /^[^A-Za-z]*[A-Z]/.test(w) || /^(?:and|or|of|to|the|a|an|for|in|on)$/.test(w),
    )
  );
};
const endsSentence = (s: string) => /[.!?]["'”’)\]*_]*$/.test(s.trim());

/** Markdown, links and stray markers out of a line of text. */
function clean(text: string): string {
  return (
    text
      // [label](url) -> label; <https://…> and bare links -> nothing.
      .replace(/\[([^\]]*)\]\([^)\s]*\)/g, '$1')
      .replace(/<(?:https?:|mailto:)[^>\s]*>/gi, ' ')
      .replace(/\bhttps?:\/\/\S+/gi, ' ')
      // "(https://…)" leaves "( )" behind.
      .replace(/\(\s*\)/g, ' ')
      .replace(/\*\*|__|`/g, '')
      .replace(/(^|[\s(“"'])[*_](?=\S)/g, '$1')
      .replace(/(?<=\S)[*_](?=$|[\s).,:;!?”"'])/g, '')
      .replace(/\s+([.,;:!?])/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** Sentences of a line of prose; a stop before a lower-case word ("U.S. big-box") is not an end. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?]["'”’)\]]?)\s+(?=["“(]?[A-Z0-9])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A trailing "Open roles:" or "see here" left behind once its link is gone. */
function dropDangling(text: string): string {
  return text
    .replace(
      /\s*\b(?:(?:see|apply|click|read|more|details|info|link)\s+(?:here|below)\s*[:.]?|(?:link|see)\s*:)\s*$/i,
      '',
    )
    .replace(/(?<=[.!?])\s+[^.!?]{1,30}:\s*$/, '')
    .replace(/[\s,;:–—-]+$/, '')
    .trim();
}

/**
 * The ask a run of text makes, at most 300 characters: whole sentences where
 * they fit, "reply to me" and thank-you sentences after the first dropped.
 */
function fitAsk(text: string): string {
  const parts = sentences(text);
  const kept = parts.filter((s, i) => i === 0 || !CTA.test(plain(s)) || strong(s));
  let out = '';
  for (const s of kept) {
    const next = out ? `${out} ${s}` : s;
    if (next.length > MAX_ASK_CHARS) break;
    out = next;
  }
  if (!out) {
    const first = kept[0] ?? text;
    out = `${first.slice(0, MAX_ASK_CHARS - 1).replace(/\s+\S*$/, '')}…`;
  }
  return out;
}

/** The asking sentences of a paragraph, or null when it asks for nothing. */
function askInProse(text: string, options: { first?: boolean } = {}): string | null {
  const parts = sentences(text.replace(LEAD_CLAUSE, ''));
  if (parts.length === 0) return null;
  // The heading's own line ("Ask: which buyers do you know…") opens with the
  // ask; when it opens with a word or two ("One ask. Acme Corp. They are…"),
  // the sentences after it say what that is.
  const opening = parts[0] ?? '';
  if (options.first && !META.test(opening) && !NOTHING.test(opening)) {
    return wordCount(opening) < 4 ? parts.join(' ') : opening;
  }
  const kept = parts.map(readsAsAsk);
  // "If you know anyone in these areas…" says what it asks with the sentence before it.
  const asking = parts.filter(
    (s, i) =>
      kept[i] ||
      (kept[i + 1] === true && REFERS_BACK.test(plain(parts[i + 1] ?? '')) && setsContext(s)),
  );
  return asking.length ? asking.join(' ') : null;
}

/** "(1) A (2) B (3) C" or "1) A 2) B" on one line: the items, or null. */
function enumerated(text: string): string[] | null {
  const re = /(?:^|\s)\(?(\d)[.)]\s+/g;
  const hits: { n: number; at: number; end: number }[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const n = Number(m[1]);
    if (n !== hits.length + 1) continue;
    hits.push({ n, at: m.index, end: m.index + m[0].length });
  }
  if (hits.length < 2 || (hits[0]?.at ?? 1) > 1) return null;
  return hits.map((h, i) => text.slice(h.end, hits[i + 1]?.at ?? text.length).trim());
}

/* ------------------------------------------------------------ sections */

const INLINE =
  /^\s*(?:[*_]{1,2})?([^:：]{2,60}?)(?:[*_]{1,2})?\s*[:：]\s*(?:[*_]{1,2}\s*)?(\S.*)$/u;

/** "**One ask.** Acme Corp…", "*How you can help* Intros to…": a heading set in bold, run into its text. */
const RUN_IN = /^\s*([*_]{1,2})(?=[^\s*_])([^*_]{2,60}?)\1\s+(\S.*)$/u;
/** "One ask. An intro to…": a heading phrase ended by a stop, its text after it. */
const STOPPED = /^\s*([^.!?:：*_]{2,40}?)[.!]\s+(\S.*)$/u;

/**
 * A heading whose only word is "requests" ("Requests", "Top requests"): in an
 * update that can as well be customers' feature requests or API calls, so its
 * items are kept only when they read as asks.
 */
function weakHeading(heading: string): boolean {
  return /\brequests?\b/i.test(heading) && !/\b(?:asks?|help)\b/i.test(heading);
}

/** "How you can help: (1) …", "One ask: an intro to…": the heading and the text after it. */
function inlineHeading(line: string): { heading: string; text: string } | null {
  if (markerOf(line)) return null;
  for (const [re, at] of [
    [INLINE, 1],
    [RUN_IN, 2],
    [STOPPED, 1],
  ] as const) {
    const m = re.exec(line);
    if (!m) continue;
    const heading = asksHeading(m[at] ?? '');
    // "Requests: 1,200 a day" is a number, not an ask.
    if (!heading || weakHeading(heading)) continue;
    const text = clean(m[at + 1] ?? '');
    if (text) return { heading, text };
  }
  return null;
}

/** A line that starts another part of the update: a heading, a rule, a sign-off. */
function isBreak(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (/^>/.test(t) || RULE.test(t) || /^#{1,6}\s/.test(t) || isSignOff(t)) return true;
  if (asksHeading(t) || looksLikeHeading(t) || inlineHeading(t)) return true;
  if (t.length > MAX_HEADING_CHARS || endsSentence(t) || markerOf(t)) return false;
  // A short line set apart: in bold or italics, led by an emoji, or in capitals.
  if (/^[*_]{1,2}[^*_].*[*_]{1,2}:?$/.test(t)) return true;
  if (/^\p{Extended_Pictographic}/u.test(t)) return true;
  const letters = t.replace(/[^A-Za-z]/g, '');
  return letters.length >= 3 && letters === letters.toUpperCase();
}

/** Whether a short line is a title over the next one ("Lead investors" over "Intros to funds…"). */
function isTitle(line: string, next: string | undefined): boolean {
  if (!next || line.length > 60 || wordCount(line) > 8) return false;
  if (/[.!?:;,]["'”’)\]]?$/.test(line) || /^[a-z]/.test(line)) return false;
  if (next.length <= line.length) return false;
  if (!endsSentence(next) && wordCount(next) < 6) return false;
  // "Looking ahead" over a sentence that mentions customers is the next section.
  return asksFor(line) || strong(next);
}

/**
 * Whether a title or label over its text is an ask: asking words in either
 * ("Series A relationships" over "Warm intros to…"), or a label naming what
 * is asked for over text that is neither news nor numbers ("Bridge round:
 * two checks are still open…", not "Customers: We signed three hospitals").
 */
function labelledAsk(label: string, text: string): boolean {
  if (requests(`${label} ${text}`) && !(isFigures(text) && !strong(text))) return true;
  return asksFor(label) && !isFigures(text) && !NEWS_START.test(plain(text.trim()));
}

/**
 * Whether the next physical line carries on this one: lower case after an
 * unfinished line, or a hard wrap (a line cut near 72-78 characters because
 * the next word did not fit). A finished sentence above a short title is not
 * a wrap.
 */
function wraps(line: string, next: string): boolean {
  const prev = line.trim();
  const t = next.trim();
  if (!prev || !t || markerOf(next)) return false;
  if (/^[a-z(]/.test(t) && !endsSentence(prev) && prev.length >= 30) return true;
  if (prev.length < 45 || prev.length > 82) return false;
  if (prev.length + 1 + (t.split(/\s+/)[0] ?? '').length < 68) return false;
  return !(endsSentence(prev) && t.length <= 40 && !endsSentence(t) && /^[A-Z]/.test(t));
}

/** A block's physical lines as its logical ones, hard wraps joined. */
function unwrap(lines: readonly string[]): string[] {
  const out: string[] = [];
  let last = '';
  for (const line of lines) {
    if (out.length > 0 && wraps(last, line)) out[out.length - 1] = `${out.at(-1)} ${line.trim()}`;
    else out.push(line.trim());
    last = line;
  }
  return out;
}

interface Section {
  /** Where reading stopped. */
  end: number;
  asks: string[];
}

/**
 * Whether the bullet at `idx` carries on the list that started with `first`
 * (its last item `last`, null right after the start): the same kind of
 * marker (the same emoji), the next number or letter, not a heading, and not
 * itself the heading of a list below it ("4. Team" over "- Hired two").
 */
function continuesList(
  lines: readonly string[],
  idx: number,
  first: Marker,
  last: Marker | null,
): boolean {
  const line = lines[idx] ?? '';
  const m = markerOf(line);
  if (!m || m.kind !== first.kind || m.glyph !== first.glyph) return false;
  if (m.indent > first.indent + 1) return false;
  if (m.n !== null && last !== null && last.n !== null && m.n !== last.n + 1) return false;
  return !isListHeading(lines, idx, m);
}

/** Whether a bullet line reads as a heading on its own words: an asks heading or another section's name. */
function headingWords(line: string): boolean {
  return asksHeading(line) !== null || looksLikeHeading(bulletText(line) ?? '');
}

/**
 * A bullet that is really a heading: by its words, or a label over a list of
 * its own ("4. Team" over "- Hired two", "- Hired two"). When the line below is
 * the heading instead ("- A VP Sales" over "👥 Team" over "- Hired two"), this
 * line is an ask and the list ends below it.
 */
function isListHeading(lines: readonly string[], idx: number, m: Marker): boolean {
  const below = markerOf(lines[idx + 1] ?? '');
  // "- Hiring" over "    - Engineers": an item with its own sub-items, not a heading.
  const hasSubItems = below !== null && below.kind === m.kind && below.indent > m.indent + 1;
  if (headingWords(lines[idx] ?? '')) return !hasSubItems || asksHeading(lines[idx] ?? '') !== null;
  if (!below || below.kind === m.kind || below.indent > m.indent) return false;
  if (headingWords(lines[idx + 1] ?? '')) return false;
  const after = markerOf(lines[idx + 2] ?? '');
  const belowHeadsAList =
    after !== null && after.kind !== below.kind && after.indent <= below.indent;
  return !belowHeadsAList;
}

/**
 * A wrapped bullet's next line: indented text, or a long line carrying on in
 * lower case. A sign-off ("thanks!") or a short line after a short one (a
 * lower-case name) is never part of the ask.
 */
function continuesAsk(line: string, previous: string): boolean {
  const t = line.trim();
  if (!t || isSignOff(t) || markerOf(line) || RULE.test(t)) return false;
  if (/^\s{2,}\S/.test(line)) return true;
  const prev = previous.trim();
  return /^[a-z(]/.test(t) && prev.length >= 40 && !/[.!?]["')\]]?$/.test(prev);
}

/** Where a list flattened onto one line goes on to its next labelled item: "….- Close the round: …". */
const RUN_ON_ITEM = /(?:(?<=[.!?)\]])\s*|\s+)[-–—]\s*(?=[A-Z0-9][^:.!?\n]{1,40}:\s)/g;

/**
 * The items of a list some mailers flatten onto one line ("Be a beta tester:
 * … .- Close the round: … - K-12 intros: …"): split only when every part
 * opens with a label of its own.
 */
function runOn(text: string): string[] {
  const parts = text
    .split(RUN_ON_ITEM)
    .map((p) => p.trim())
    .filter(Boolean);
  const labelled = (p: string) => /^[^:.!?]{1,40}:\s/.test(p);
  return parts.length > 1 && parts.every(labelled) ? parts : [text];
}

/**
 * A list's items from `start`. Detail nested under an item stays out of the
 * list; under a bare label ("Hiring", "Hiring referrals:") it is what the
 * label means, so it is added to it.
 */
function readList(lines: readonly string[], start: number): Section {
  const asks: string[] = [];
  let current: { text: string; children: string[] } | null = null;
  let first: Marker | null = null;
  let last: Marker | null = null;
  let previous = '';
  let nested = false;
  const flush = () => {
    if (!current) return;
    const label = current.text.replace(/[:：]\s*$/, '');
    const bare = /[:：]\s*$/.test(current.text) || wordCount(label) <= 3;
    if (bare && current.children.length > 0) {
      let joined = `${label}:`;
      for (const child of current.children.map((c) => clean(c).replace(/[.;,]+$/, ''))) {
        const next = joined.endsWith(':') ? `${joined} ${child}` : `${joined}; ${child}`;
        if (next.length > MAX_ASK_CHARS) break;
        joined = next;
      }
      asks.push(joined.endsWith(':') ? label : joined);
    } else {
      asks.push(...runOn(current.text));
    }
    current = null;
  };

  let j = start;
  for (; j < lines.length; j++) {
    const line = lines[j] ?? '';
    if (/^\s*>/.test(line) || RULE.test(line)) break;
    if (!line.trim()) {
      // One blank line between bullets of one list is spacing; anything else ends it.
      if (current !== null && first && continuesList(lines, j + 1, first, last)) continue;
      break;
    }
    const m = markerOf(line);
    if (m) {
      if (first === null) {
        // The first line under the heading is a heading itself: no asks here.
        if (isListHeading(lines, j, m)) break;
        first = m;
      } else if (!continuesList(lines, j, first, last)) {
        // Deeper than the list, or a list restarting at 1 under an item: detail of the item above.
        const deeper = m.indent > first.indent + 1;
        const restart = m.kind === 'number' && m.n === 1 && (last?.n ?? 0) >= 1;
        if (current !== null && (deeper || restart) && !headingWords(line)) {
          current.children.push(bulletText(line) ?? '');
          nested = true;
          previous = line;
          continue;
        }
        break;
      }
      flush();
      current = { text: bulletText(line) ?? '', children: [] };
      last = m;
      nested = false;
      previous = line;
      continue;
    }
    if (current !== null && continuesAsk(line, previous)) {
      if (nested && current.children.length > 0) {
        current.children[current.children.length - 1] += ` ${line.trim()}`;
      } else {
        current.text = `${current.text} ${line.trim()}`;
      }
      previous = line;
      continue;
    }
    break;
  }
  flush();
  return { end: j, asks };
}

/** Skip up to `max` blank lines from `j`. */
function skipBlanks(lines: readonly string[], j: number, max = 2): number {
  let k = j;
  while (k < lines.length && !(lines[k] ?? '').trim() && k - j < max) k++;
  return k;
}

/**
 * Asks written as prose from `start`: paragraphs (a title over its
 * sentence, or sentences that ask), until a heading, rule or sign-off. A
 * paragraph that asks for nothing ("My calendar is open") is
 * passed over rather than ending the section.
 */
function readProse(lines: readonly string[], start: number): Section {
  const asks: string[] = [];
  let j = start;
  for (let blocks = 0; blocks < MAX_BLOCKS && j < lines.length; blocks++) {
    const block: string[] = [];
    let stopped = false;
    let listAt = -1;
    for (; j < lines.length && (lines[j] ?? '').trim(); j++) {
      const line = lines[j] ?? '';
      if (markerOf(line)) {
        listAt = j;
        break;
      }
      if (isBreak(line)) {
        stopped = true;
        break;
      }
      block.push(line);
    }
    const logical = unwrap(block).map(clean).filter(Boolean);
    // A short line alone, asking nothing, is the next section's heading
    // ("Looking ahead"); right under the asks heading, only when it is set in
    // title case ("Customer Stories"), as a short ask may stand there unpunctuated.
    const head = logical[0];
    if (
      head !== undefined &&
      head.length <= 50 &&
      !endsSentence(head) &&
      !isTitle(head, logical[1]) &&
      (blocks > 0
        ? !asksFor(head)
        : logical.length === 1 && listAt < 0 && titleCase(head) && !strong(head))
    ) {
      break;
    }
    for (let k = 0; k < logical.length; k++) {
      const line = logical[k] ?? '';
      if (NOTHING.test(line) || META.test(line) || /[:：]$/.test(line)) continue;
      if (isTitle(line, logical[k + 1])) {
        const text = logical[k + 1] ?? '';
        if (labelledAsk(line, text)) asks.push(`${line}: ${fitAsk(text)}`);
        k += 1;
        continue;
      }
      // "Partner introductions: the intros that move us most are to…"
      const label = /^([^:：.!?]{2,40})[:：]\s+(\S.*)$/.exec(line);
      const [name, text] = [(label?.[1] ?? '').trim(), label?.[2] ?? ''];
      if (label && wordCount(name) <= 5 && labelledAsk(name, text)) {
        const said = askInProse(text, { first: true });
        if (said) asks.push(`${name}: ${fitAsk(text)}`);
        continue;
      }
      const said = askInProse(line);
      if (said) asks.push(said);
    }
    // Prose, then a list: the list is part of the asks too.
    if (listAt >= 0) {
      const list = readList(lines, listAt);
      return { end: list.end, asks: [...asks, ...list.asks] };
    }
    if (stopped) break;
    const next = skipBlanks(lines, j, 3);
    if (next === j || next >= lines.length) break;
    j = next;
  }
  return { end: j, asks };
}

/**
 * The asks under a heading that ended at `start` (with `inline` text when the
 * heading's line carried on): a list, prose, or the heading line itself.
 */
function readSection(lines: readonly string[], start: number, inline: string | null): Section {
  if (inline !== null) {
    // The rest of the heading's paragraph, when the line was wrapped.
    let paragraph = inline;
    let j = start;
    let last = inline;
    while (j < lines.length && wraps(last, lines[j] ?? '') && !isBreak(lines[j] ?? '')) {
      paragraph = `${paragraph} ${clean(lines[j] ?? '')}`;
      last = lines[j] ?? '';
      j++;
    }
    const items = enumerated(paragraph);
    const asks = items ?? [];
    const leadIn = /[:：]$/.test(paragraph) || NOTHING.test(paragraph);
    // "We need a marketing firm. Forwardable language:" still opens with its
    // ask; only a lead-in and nothing else ("a few things:") is not one.
    if (!items && !NOTHING.test(paragraph)) {
      const said = askInProse(paragraph, { first: true });
      if (said && !/[:：]$/.test(said)) asks.push(said);
    }
    // "How you can help: a few things" over a list.
    const below = skipBlanks(lines, j, 1);
    if (markerOf(lines[below] ?? '')) {
      const list = readList(lines, below);
      if (leadIn || !asksFor(paragraph)) asks.length = 0;
      return { end: list.end, asks: [...asks, ...list.asks] };
    }
    return { end: j, asks };
  }

  let j = skipBlanks(lines, start);
  // "We'd be grateful for introductions to:" (or "We'd love help with
  // two things") over the list: a lead-in, not an ask of its own.
  for (let leads = 0; leads < 2; leads++) {
    const line = (lines[j] ?? '').trim();
    if (!line || markerOf(line) || line.length > 160) break;
    // A short line ending in a colon reads as a label, which is what a lead-in is here.
    if (!/[:：]\s*$/.test(line) && isBreak(line)) break;
    // "Intros to fintech CFOs would help most." over more asks is an ask itself.
    if (!LEAD_IN.test(line) && asksFor(line)) break;
    const after = skipBlanks(lines, j + 1, 1);
    if (!markerOf(lines[after] ?? '')) break;
    j = after;
  }
  if (markerOf(lines[j] ?? '')) return readList(lines, j);
  return readProse(lines, j);
}

function tidy(text: string): string {
  let s = dropDangling(clean(text).replace(/^\*(\S.*\S|\S)\*$/, '$1'));
  s = s.replace(/^[a-z]/, (c) => c.toUpperCase());
  // "Reply to me to set it up" after the ask is how to answer, not the ask.
  return fitAsk(s);
}

/** Lowercase words only: what makes two spellings of one ask the same ask. */
export function normalizeAskText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** The asks under every asks heading in an email body, in order, each once. */
export function extractAsks(body: string): ExtractedAsk[] {
  const lines = bodyLines(body);
  const out: ExtractedAsk[] = [];
  const seen = new Set<string>();
  const add = (text: string, heading: string) => {
    const clean = tidy(text);
    const key = normalizeAskText(clean);
    if (clean.length < 3 || !key || NOTHING.test(clean) || META.test(clean) || seen.has(key)) {
      return;
    }
    // A thank-you ("Thanks to Dana for…") under "Asks & thank yous" is not an ask.
    if (THANKED.test(plain(clean))) return;
    // Under a bare "Requests" only what reads as an ask: not "Dark mode", not "1.2M API requests".
    if (weakHeading(heading) && !(requests(clean) && !isFigures(clean))) return;
    seen.add(key);
    out.push({ text: clean, heading });
  };

  for (let i = 0; i < lines.length && out.length < MAX_ASKS; i++) {
    const raw = lines[i] ?? '';
    if (/^\s*>/.test(raw)) continue;
    const heading = asksHeading(raw);
    const inline = heading ? null : inlineHeading(raw);
    if (!heading && !inline) continue;
    const section = readSection(lines, i + 1, inline?.text ?? null);
    for (const ask of section.asks) add(ask, heading ?? inline?.heading ?? '');
    i = Math.max(i, section.end - 1);
  }
  return out.slice(0, MAX_ASKS);
}

/**
 * The request type an ask reads as, from plain keywords in the ask itself.
 * Only a label for the card and for who could help: an ask that names none
 * of these stays a general ask rather than being guessed at.
 */
export function askRequestType(text: string): PortfolioRequestType {
  const s = ` ${text.toLowerCase().replace(/[^a-z0-9$&+'/-]+/g, ' ')} `;
  const has = (re: RegExp) => re.test(s);
  const intro = has(
    /\b(?:intros?|introductions?|introduce|connect(?:ions?)?|meet|warm|referrals?|refer)\b/,
  );
  const investor = has(
    /\b(?:investors?|vcs?|venture (?:capital|firms?|funds?)|angels?|lead investors?|lps?|co-?investors?|syndicates?|series [a-d](?: leads?)?|seed (?:funds?|investors?|round))\b/,
  );
  const raise = has(
    /\b(?:raise|raising|fundrais\w*|bridge|(?:seed|next|series [a-d]|bridge|extension) round|term sheets?|safes?|convertible notes?|financing)\b/,
  );
  if (investor && (intro || raise)) return 'investor_introduction';
  if (raise || (investor && !has(/\bcustomers?\b/))) return 'fundraising';

  const hiring =
    has(
      /\b(?:hire|hires|hiring|recruit\w*|candidates?|join (?:us|the team)|open roles?|roles?|talent|referrals? for (?:a|an|our)|looking for (?:a|an|our)|founding (?:engineer|designer|team|hire)s?)\b/,
    ) ||
    has(
      /\b(?:engineers?|developers?|designers?|sdrs?|account executives?|product managers?|marketers?|salespeople|recruiters?)\b/,
    ) ||
    has(/\b(?:a|an|our|first|new) (?:vp|head of|cto|cfo|coo|cmo|chief|director|gm)\b/);
  if (hiring) {
    return has(/\b(?:advice|plan|process|benchmarks?|comp(?:ensation)?|how to)\b/)
      ? 'hiring'
      : 'candidate_request';
  }
  if (
    has(
      /\b(?:customers?|clients?|buyers?|pilots?|design partners?|prospects?|distribution|channel partners?|resellers?|retailers?|enterprises?|logos?)\b/,
    ) ||
    (intro &&
      has(
        /\b(?:cfos?|ctos?|ceos?|coos?|cios?|vps?|heads?|directors?|owners?|operators?|firms?|clinics?|practices?|hospitals?|banks?|brands?)\b/,
      ))
  ) {
    return 'customer_introduction';
  }
  if (has(/\b(?:advis[oe]rs?|mentors?|board members?|experts?|expertise)\b/)) {
    return 'advisor_request';
  }
  if (has(/\b(?:feedback|beta|testers?|try (?:it|out)|user interviews?)\b/)) {
    return 'product_feedback';
  }
  if (has(/\b(?:gtm|go-to-market|pricing|positioning|marketing|messaging|sales strategy)\b/)) {
    return 'gtm_strategy';
  }
  if (has(/\bboard (?:deck|meeting|prep\w*)\b/)) return 'board_preparation';
  return 'general_update';
}
