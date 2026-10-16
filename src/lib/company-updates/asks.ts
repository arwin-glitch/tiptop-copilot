import type { PortfolioRequestType } from '@/lib/types/domain';

/**
 * The explicit asks in a portfolio company's update email.
 *
 * Founders close their updates with a section of asks: "Asks", "Our asks",
 * "How you can help", "Ways to help", "Help wanted", "Where we need help",
 * "Requests". This reads only those: the bullet or numbered lines under such
 * a heading, up to the next heading, a blank gap or the signature. Nothing is
 * read from prose, no model is involved, and quoted replies are never read,
 * so every ask is a line the company wrote under its own heading. A heading
 * with no bullets under it gives nothing.
 *
 * Pure and client-safe; `lib/services/portfolio-asks.ts` reads the mail and
 * records each ask as an open portfolio request.
 */

export interface ExtractedAsk {
  /** The ask as written, its bullet and markdown stripped. */
  text: string;
  /** The heading it sat under, as written ("Our asks"). */
  heading: string;
}

/** More than this under one update is a list of something else. */
const MAX_ASKS = 10;
const MAX_ASK_CHARS = 400;
/** A heading is a short line; a sentence that happens to say "asks" is not one. */
const MAX_HEADING_CHARS = 60;

const EMOJI = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}\u{20E3}]/gu;

const ASK_NOUN = String.raw`(?:asks?|requests?)`;
const ASK_PREFIX = String.raw`(?:(?:our|my|the|key|top|main|current|open|a few|some|quick|one|two|three|four|five|\d{1,2}|this (?:month|quarter|week)'?s?|monthly|quarterly|weekly)\s+)*`;
const AUDIENCE = String.raw`(?:you|you all|y'?all|you guys|investors|our investors|the team|our network|the network|friends|everyone|our community|the community)`;

/** The heading phrases, matched against the whole cleaned line. */
const HEADING_PHRASE = new RegExp(
  String.raw`^(?:` +
    [
      // "Asks", "Our asks", "Top 3 asks", "Asks for investors", "Requests"
      String.raw`${ASK_PREFIX}${ASK_NOUN}(?:\s+(?:for|of|from|to)\s+${AUDIENCE})?`,
      // "How you can help", "How investors can help us"
      String.raw`how (?:${AUDIENCE}|we) (?:can|could|might) help(?: us| out)?`,
      String.raw`how to help(?: us| out)?`,
      // "Ways to help", "Ways you can help"
      String.raw`(?:some )?ways (?:to|you can|you could|${AUDIENCE} can) help(?: us| out)?`,
      String.raw`help wanted`,
      String.raw`help needed`,
      // "Where we need help", "Where we could use your help"
      String.raw`where (?:we|i) (?:need|could use|can use|would love|'?d love) (?:your |some |a little |a bit of )?help`,
      String.raw`what we need(?: from ${AUDIENCE})?`,
    ].join('|') +
    String.raw`)$`,
  'i',
);

/** Words that may share a heading with an ask phrase ("Hiring & asks"). */
const COMPANION = /^(?:hiring|intros?|introductions?|help|referrals?|asks?)$/i;

/** A list marker: a dash or dot, a number or letter, a checkbox, or an emoji. */
const MARKER = String.raw`(?:[-*•·‣◦▪▸►–—]|\(?\d{1,2}[.)]|\(?[a-h][.)](?=\s)|\[[ x]?\]|[\p{Extended_Pictographic}][\u{FE0F}\u{1F3FB}-\u{1F3FF}]?)`;
const BULLET = new RegExp(String.raw`^\s*(${MARKER})\s+(\S.*)$`, 'u');

/**
 * The text of a bullet or numbered line ("- Intro to X", "2) Intro to X",
 * "• Intro to X", "👉 Intro to X"), or null when the line is not one.
 */
export function bulletText(line: string): string | null {
  const m = BULLET.exec(line);
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
  const m = BULLET.exec(line);
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
]);

/** Whether a bullet's text is a heading rather than an ask: another section's name, or a short label ending in a colon. */
function looksLikeHeading(text: string): boolean {
  if (/[:：]\s*$/.test(text) && text.trim().split(/\s+/).length <= 6) return true;
  const clean = cleanHeading(text)?.toLowerCase();
  if (!clean) return false;
  const parts = clean.split(/\s*(?:&|\+|\/|,|\band\b)\s*/).filter(Boolean);
  return parts.length > 0 && parts.every((p) => SECTION_NAMES.has(p));
}

/** A sign-off is the end of the letter, never the rest of an ask. */
const SIGN_OFF =
  /^(?:thanks|thank you|many thanks|thx|ty|cheers|best|all the best|regards|kind regards|warm(?:ly| regards| wishes)?|talk soon|onwards?|appreciate(?: it| you)?|sincerely|gratefully|with gratitude|love|xo+)\b/i;

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
    // "Asks (in priority order)".
    .replace(/\s*\([^()]*\)$/, '')
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

/** Where the company's own words stop: a quoted reply, an Outlook header, a signature. */
function ownLines(body: string): string[] {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const t = line.trim();
    // "On Mon, Oct 5, 2026 at 9:00 AM Jane <jane@x.com> wrote:", sometimes over two lines.
    if (
      /^on\s.{4,}/i.test(t) &&
      (/wrote:\s*$/i.test(t) || /wrote:\s*$/i.test(lines[i + 1] ?? ''))
    ) {
      break;
    }
    if (/^-{2,}\s*original message\s*-{2,}$/i.test(t)) break;
    if (/^_{10,}$/.test(t)) break;
    // An Outlook reply header ("From: … / Sent: …"), unless it heads a forward.
    if (/^from:\s+\S/i.test(t) && /^(?:sent|date):\s/i.test((lines[i + 1] ?? '').trim())) {
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

const NOTHING = /^(?:n\/?a|none|nothing(?:\s.*)?|tbd|tba|no asks?(?:\s.*)?|-+|\.+)$/i;

function tidy(text: string): string {
  const clean = text
    .replace(/\*\*|__|`/g, '')
    .replace(/^\*(\S.*\S|\S)\*$/, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > MAX_ASK_CHARS ? `${clean.slice(0, MAX_ASK_CHARS - 1).trimEnd()}…` : clean;
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
  if (headingWords(lines[idx] ?? '')) return true;
  const below = markerOf(lines[idx + 1] ?? '');
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
  if (!t || SIGN_OFF.test(t) || markerOf(line)) return false;
  if (/^\s{2,}\S/.test(line)) return true;
  const prev = previous.trim();
  return /^[a-z(]/.test(t) && prev.length >= 40 && !/[.!?]["')\]]?$/.test(prev);
}

/** The asks under every asks heading in an email body, in order, each once. */
export function extractAsks(body: string): ExtractedAsk[] {
  const lines = ownLines(body);
  const out: ExtractedAsk[] = [];
  const seen = new Set<string>();
  const add = (text: string, heading: string) => {
    const clean = tidy(text);
    const key = normalizeAskText(clean);
    if (clean.length < 3 || !key || NOTHING.test(clean) || seen.has(key)) return;
    seen.add(key);
    out.push({ text: clean, heading });
  };

  for (let i = 0; i < lines.length && out.length < MAX_ASKS; i++) {
    const raw = lines[i] ?? '';
    if (/^\s*>/.test(raw)) continue;
    const heading = asksHeading(raw);
    if (!heading) continue;

    // Up to two blank lines may sit between the heading and its first bullet.
    let j = i + 1;
    let blanks = 0;
    while (j < lines.length && !(lines[j] ?? '').trim() && blanks < 2) {
      j++;
      blanks++;
    }
    let current: string | null = null;
    let first: Marker | null = null;
    let last: Marker | null = null;
    let previous = '';
    for (; j < lines.length; j++) {
      const line = lines[j] ?? '';
      if (/^\s*>/.test(line)) break;
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
          // A different marker nested deeper is detail of the ask above; skip it.
          if (m.kind !== first.kind && m.indent > first.indent + 1) {
            previous = '';
            continue;
          }
          break;
        }
        if (current !== null) add(current, heading);
        current = bulletText(line) ?? '';
        last = m;
        previous = line;
        continue;
      }
      if (current !== null && continuesAsk(line, previous)) {
        current = `${current} ${line.trim()}`;
        previous = line;
        continue;
      }
      break;
    }
    if (current !== null) add(current, heading);
    i = j - 1;
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
