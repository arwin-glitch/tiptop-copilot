/**
 * A job description as the board stores and shows it: plain structured text,
 * never HTML. Job boards send their descriptions as HTML (Greenhouse even
 * entity-encodes it once more); this reads that HTML into a small text format
 * and the board renders the text as text, so nothing a board sends can ever
 * become markup, a script or a tracking pixel on TipTop's pages.
 *
 * The format, one block per paragraph, blocks apart by a blank line:
 *   - `## Heading`
 *   - `- item` lines (a list)
 *   - anything else: a paragraph (single line breaks kept)
 *
 * Pure and client-safe.
 */

export const MAX_DESCRIPTION_CHARS = 20_000;
/** A description's HTML is read up to this size; real ones are a few KB. */
export const MAX_HTML_CHARS = 100_000;

export type DescriptionBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; items: string[] };

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
  pound: '£',
  times: '×',
  laquo: '«',
  raquo: '»',
};

function codePoint(n: number): string {
  // Control characters and lone surrogates read as nothing.
  if (!Number.isFinite(n) || n < 32 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return '';
  if (n >= 0x7f && n < 0xa0) return '';
  return String.fromCodePoint(n);
}

/** Every HTML entity this knows, decoded once. Unknown ones stay as written. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const n =
        body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return codePoint(n);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** True when markup arrived entity-encoded (`&lt;p&gt;`), as Greenhouse sends it. */
function looksEncoded(html: string): boolean {
  return /&lt;\/?[a-z][a-z0-9]*[\s&]/i.test(html) && !/<\/?(p|div|ul|li|br|h[1-6])\b/i.test(html);
}

/** Elements dropped whole, with everything inside them. */
const DROPPED_OPENER =
  /<(script|style|noscript|iframe|object|embed|svg|math|template|form|select|textarea|button|head|title)\b/gi;

/**
 * Every DROPPED_OPENER element cut out, up to its closing tag; one that never
 * closes takes the rest of the input with it. One forward pass (each search
 * starts where the last ended), so a description full of unclosed
 * `<script` tags costs the same as any other: a regex with a lazy match and
 * a back-reference rescans to the end for each one.
 */
function dropElements(html: string): string {
  const opener = new RegExp(DROPPED_OPENER.source, 'gi');
  let out = '';
  let pos = 0;
  for (let m = opener.exec(html); m; m = opener.exec(html)) {
    out += `${html.slice(pos, m.index)} `;
    const closer = new RegExp(`</${m[1]}\\b[^<>]*>`, 'gi');
    closer.lastIndex = opener.lastIndex;
    const close = closer.exec(html);
    if (!close) return out;
    pos = closer.lastIndex;
    opener.lastIndex = pos;
  }
  return out + html.slice(pos);
}

/** Every `<!-- ... -->` (or `<![CDATA[ ... ]]>`) replaced by a space; an unclosed one ends the input. */
function dropSpans(html: string, open: string, close: string): string {
  let out = '';
  let pos = 0;
  for (let at = html.indexOf(open, pos); at >= 0; at = html.indexOf(open, pos)) {
    out += `${html.slice(pos, at)} `;
    const end = html.indexOf(close, at + open.length);
    if (end < 0) return out;
    pos = end + close.length;
  }
  return out + html.slice(pos);
}

/**
 * Board HTML -> the structured text above. Headings, paragraphs, line breaks
 * and list items keep their shape; links keep their words (never their
 * address); images, scripts, styles, forms and embeds are dropped whole.
 * Capped at MAX_DESCRIPTION_CHARS, cut at a block with "…".
 */
export function htmlToStructuredText(
  input: string | null | undefined,
  max = MAX_DESCRIPTION_CHARS,
): string {
  if (!input || typeof input !== 'string') return '';
  let html = input.length > MAX_HTML_CHARS ? input.slice(0, MAX_HTML_CHARS) : input;
  if (looksEncoded(html)) html = decodeEntities(html);

  // The two marker characters below are never taken from the input.
  html = html.replace(/[\u0002\u0003]/g, '');
  html = dropElements(dropSpans(dropSpans(html, '<!--', '-->'), '<![CDATA[', ']]>'))
    // Unclosed dangerous openers: drop from there to the end of the tag.
    .replace(/<(script|style|iframe|object|embed)\b[^<>]*>?/gi, ' ');

  // Every tag pattern below stops at the next "<" ([^<>] rather than [^>]),
  // so a tag that never closes costs one short scan, not one to the end of
  // the input: the descriptions are written by companies, and a quadratic
  // pattern here would stall all of Kraken.
  // A paragraph that is only bold words reads as a heading ("<p><b>About you</b></p>").
  html = html.replace(
    /<p\b[^<>]*>\s*<(strong|b)\b[^<>]*>([^<]{1,90})<\/\1>\s*:?\s*(?:<br\s*\/?>\s*)?<\/p>/gi,
    (_, _tag: string, words: string) => `\n\n\u0002${words}\n\n`,
  );

  const text = html
    .replace(/<h[1-6]\b[^<>]*>/gi, '\n\n\u0002')
    .replace(/<\/h[1-6]\s*>/gi, '\n\n')
    .replace(/<li\b[^<>]*>/gi, '\n\u0003')
    .replace(/<\/li\s*>/gi, '\n')
    .replace(/<\/?(ul|ol|dl)\b[^<>]*>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(
      /<\/?(p|div|section|article|header|footer|blockquote|table|tr|pre|dd|dt)\b[^<>]*>/gi,
      '\n\n',
    )
    .replace(/<\/?(td|th)\b[^<>]*>/gi, ' ')
    // Any other tag (it starts with a letter, "/", "!" or "?"); a bare "<"
    // in text ("5 < 6") is not a tag.
    .replace(/<\/?[a-z!?][^<>]*>/gi, '')
    // Anything left that still looks like a tag start is text, never markup.
    .replace(/</g, '‹');

  return finishText(decodeEntities(text), max);
}

/**
 * Plain text (a board's own plain version, or a person's typing) -> the same
 * structured text: bullets of any common kind become "- ", stray markup is
 * not interpreted, and the length is capped like the HTML path.
 */
export function plainToStructuredText(
  input: string | null | undefined,
  max = MAX_DESCRIPTION_CHARS,
): string {
  if (!input || typeof input !== 'string') return '';
  // The two marker characters the HTML path uses are never taken from text.
  return finishText(input.replace(/\r\n?/g, '\n').replace(/[\u0002\u0003]/g, ''), max);
}

function finishText(raw: string, max: number): string {
  const lines = raw
    // Zero-width and bidi controls never reach the page.
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, '')
    .replace(/[\u0000\u0001\u0004-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    // Tabs and non-breaking spaces are spaces.
    .replace(/[\t\u00a0\u2007\u202f]/g, ' ')
    .split('\n')
    .map((line) => line.replace(/ {2,}/g, ' ').trim())
    .map((line) => {
      if (line.startsWith('\u0002')) {
        const heading = line
          .slice(1)
          .replace(/^#+\s*/, '')
          .replace(/:$/, '')
          .trim();
        return heading ? `## ${heading}` : '';
      }
      if (line.startsWith('\u0003')) {
        const item = line
          .slice(1)
          .replace(/^[-•·*–▪◦]\s*/, '')
          .trim();
        return item ? `- ${item}` : '';
      }
      // Bullets typed as text: "• item", "* item", "– item".
      const bullet = /^[•·*–▪◦]\s+(.+)$/.exec(line);
      if (bullet) return `- ${bullet[1]}`;
      if (/^#{1,6}\s+\S/.test(line)) return `## ${line.replace(/^#+\s+/, '')}`;
      return line.replace(/[\u0002\u0003]/g, '');
    });

  // Blocks: headings and list runs stand alone; blank lines part paragraphs.
  const out: string[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (paragraph.length) out.push(paragraph.join('\n'));
    if (list.length) out.push(list.join('\n'));
    paragraph = [];
    list = [];
  };
  for (const line of lines) {
    if (!line) {
      // A blank line ends a paragraph. A list keeps going through blank
      // lines (boards close each item with its own break); the next
      // paragraph or heading ends it.
      if (paragraph.length) {
        out.push(paragraph.join('\n'));
        paragraph = [];
      }
      continue;
    }
    if (line.startsWith('## ')) {
      flush();
      out.push(line);
      continue;
    }
    if (line.startsWith('- ')) {
      if (paragraph.length) {
        out.push(paragraph.join('\n'));
        paragraph = [];
      }
      list.push(line);
      continue;
    }
    if (list.length) {
      out.push(list.join('\n'));
      list = [];
    }
    paragraph.push(line);
  }
  flush();

  // Two headings in a row: the first heads nothing.
  const blocks = out.filter(
    (block, i) =>
      !(block.startsWith('## ') && out[i + 1]?.startsWith('## ')) || i === out.length - 1,
  );
  let result = blocks.join('\n\n').trim();
  if (result.length > max) {
    const cut = result.lastIndexOf('\n\n', max - 2);
    result = `${result.slice(0, cut > max / 2 ? cut : max - 2).trimEnd()}\n\n…`;
    if (result.length > max) result = `${result.slice(0, max - 1)}…`;
  }
  return result;
}

/** The stored text -> blocks to render as text. */
export function parseStructuredText(text: string | null | undefined): DescriptionBlock[] {
  if (!text) return [];
  const blocks: DescriptionBlock[] = [];
  for (const chunk of text.split(/\n{2,}/)) {
    const lines = chunk
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) continue;
    if (lines.length === 1 && lines[0]!.startsWith('## ')) {
      blocks.push({ kind: 'heading', text: lines[0]!.slice(3).trim() });
      continue;
    }
    if (lines.every((l) => l.startsWith('- '))) {
      blocks.push({ kind: 'list', items: lines.map((l) => l.slice(2).trim()).filter(Boolean) });
      continue;
    }
    blocks.push({ kind: 'paragraph', text: lines.join('\n') });
  }
  return blocks;
}

/** The first paragraph's words, cut short: for a meta description or a card. */
export function descriptionSummary(text: string | null | undefined, max = 200): string {
  const first = parseStructuredText(text).find((b) => b.kind === 'paragraph');
  const words = first && first.kind === 'paragraph' ? first.text.replace(/\s+/g, ' ') : '';
  if (words.length <= max) return words;
  const cut = words.lastIndexOf(' ', max - 1);
  return `${words.slice(0, cut > max / 2 ? cut : max - 1)}…`;
}
