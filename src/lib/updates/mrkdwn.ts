import type { Block, Seg } from '@/lib/updates/types';

/**
 * Slack mrkdwn -> segments and blocks, through a whitelist.
 *
 * Nothing here produces markup. Text stays text, and `href` is set in exactly
 * one place — `safeHref` — so a link whose scheme is not https, http or mailto
 * can only ever reach the page as its label.
 */

const FOOTER_RE = /^[_*]?Sent using[_*]? ?Claude[_*]?$/;

/** Drop trailing "Sent using Claude" footers (any emphasis, stacked) and blank lines. */
export function stripFooters(text: string): { text: string; hadFooter: boolean } {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let hadFooter = false;
  while (lines.length > 0) {
    const last = (lines[lines.length - 1] ?? '').trim();
    if (last === '') {
      lines.pop();
    } else if (FOOTER_RE.test(last)) {
      lines.pop();
      hadFooter = true;
    } else {
      break;
    }
  }
  return { text: lines.join('\n'), hadFooter };
}

/**
 * A link token whose URL part contains whitespace is a routine's line break
 * swallowed into the link: `Link: <https://…#all/ID\nLedger|junk>: ID`. Cut the
 * URL at the whitespace and put the rest back as text, dropping the label.
 */
export function repairBrokenLinks(raw: string): string {
  return raw.replace(/<((?:https?|mailto):[^|>\s]+)(\s+)([^|>]*)\|[^>]*>/g, '<$1>$2$3');
}

/** Slack escapes & < >; routine output is sometimes escaped twice. */
export function decodeEntities(s: string): string {
  return s
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
    .replaceAll('&amp;', '&');
}

/** The only way an `href` is ever produced. */
export function safeHref(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || /[\u0000-\u001F\u007F\s]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const protocol = url.protocol.toLowerCase();
  if (protocol === 'https:' || protocol === 'http:') {
    if (!url.hostname || url.username || url.password) return null;
    return url.href;
  }
  if (protocol === 'mailto:') {
    return url.pathname.includes('@') ? url.href : null;
  }
  return null;
}

const EMOJI: Record<string, string> = {
  mailbox_with_mail: '📬',
  clipboard: '📋',
  warning: '⚠️',
  lock: '🔒',
  white_check_mark: '✅',
  thread: '🧵',
  fire: '🔥',
  rocket: '🚀',
  boom: '💥',
  wave: '👋',
  tada: '🎉',
  eyes: '👀',
  star: '⭐',
};
const EMOJI_RE = new RegExp(`:(${Object.keys(EMOJI).join('|')}):`, 'g');

function emojify(s: string): string {
  return s
    .replace(/:skin-tone-[1-6]:/g, '')
    .replace(EMOJI_RE, (m, name: string) => EMOJI[name] ?? m);
}

function displayUrl(href: string): string {
  if (href.toLowerCase().startsWith('mailto:')) {
    const address = href.slice('mailto:'.length).split('?')[0] ?? '';
    try {
      return decodeURIComponent(address);
    } catch {
      return address;
    }
  }
  const url = new URL(href);
  const shown = `${url.host}${url.pathname}`.replace(/\/$/, '');
  return shown.length > 48 ? `${shown.slice(0, 47)}…` : shown;
}

/** One `<…>` token -> one segment. Unknown and unsafe targets become plain text. */
function angleToken(inner: string): Seg {
  const bar = inner.indexOf('|');
  const target = bar >= 0 ? inner.slice(0, bar) : inner;
  const label = bar >= 0 ? decodeEntities(inner.slice(bar + 1)) : null;
  if (/^@[UW][A-Z0-9]+$/.test(target)) return { text: label ? `@${label}` : '@member' };
  if (/^#C[A-Z0-9]+$/.test(target)) return { text: label ? `#${label}` : '#channel' };
  if (/^!(here|channel|everyone)$/.test(target)) return { text: `@${target.slice(1)}` };
  if (target.startsWith('!date^')) return { text: label ?? '' };
  const href = safeHref(decodeEntities(target));
  if (href) return { text: label || displayUrl(href), href };
  return { text: label ?? decodeEntities(inner) };
}

type Flags = Omit<Seg, 'text' | 'href'>;

// Placeholders stand in for already-parsed `<…>` tokens while emphasis is
// matched, so a link can sit inside bold text without being re-read as text.
const PLACEHOLDER = 0xe000;
const PLACEHOLDER_RE = /[\uE000-\uF8FF]/g;

// `~` too: routines write `~_$1M_` for "about $1M", emphasised.
const OPEN_PREV = /[\s([{"'“‘—–~-]/;
const CLOSE_NEXT = /[\s.,;:!?)\]}"'”’—–-]/;

// Real text nests at most bold, italic and strike. The caps stop hostile input
// from recursing past the stack or scanning quadratically.
const MAX_EMPHASIS_DEPTH = 3;
const MAX_EMPHASIS_LINE = 3_000;

function withFlag(flags: Flags, mark: string): Flags {
  if (mark === '*') return { ...flags, bold: true };
  if (mark === '_') return { ...flags, italic: true };
  return { ...flags, strike: true };
}

/** Text with placeholders -> segments, decoding entities in the text parts. */
function expand(s: string, flags: Flags, atoms: Seg[]): Seg[] {
  const out: Seg[] = [];
  let buf = '';
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code >= PLACEHOLDER && code <= 0xf8ff) {
      if (buf) out.push({ text: decodeEntities(buf), ...flags });
      buf = '';
      const atom = atoms[code - PLACEHOLDER];
      if (atom) out.push({ ...atom, ...flags });
    } else {
      buf += ch;
    }
  }
  if (buf) out.push({ text: decodeEntities(buf), ...flags });
  return out;
}

function findCloser(s: string, open: number, mark: string): number {
  for (let j = open + 2; j < s.length; j++) {
    if (s[j] !== mark) continue;
    if (/\s/.test(s[j - 1] ?? ' ')) continue;
    const next = s[j + 1];
    if (next !== undefined && !CLOSE_NEXT.test(next)) continue;
    return j;
  }
  return -1;
}

function emphasis(s: string, flags: Flags, atoms: Seg[], depth = 0): Seg[] {
  if (depth >= MAX_EMPHASIS_DEPTH || s.length > MAX_EMPHASIS_LINE) return expand(s, flags, atoms);
  const out: Seg[] = [];
  let buf = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i] ?? '';
    const isMark = ch === '*' || ch === '_' || ch === '~';
    const next = s[i + 1];
    if (
      isMark &&
      (i === 0 || OPEN_PREV.test(s[i - 1] ?? '')) &&
      next !== undefined &&
      !/\s/.test(next)
    ) {
      const close = findCloser(s, i, ch);
      if (close > i + 1) {
        if (buf) out.push(...expand(buf, flags, atoms));
        buf = '';
        out.push(...emphasis(s.slice(i + 1, close), withFlag(flags, ch), atoms, depth + 1));
        i = close + 1;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  if (buf) out.push(...expand(buf, flags, atoms));
  return out;
}

function sameStyle(a: Seg, b: Seg): boolean {
  return (
    !a.href &&
    !b.href &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.code === b.code &&
    a.strike === b.strike
  );
}

/** One line of Slack mrkdwn -> segments. */
export function inline(line: string): Seg[] {
  const atoms: Seg[] = [];
  const s = line.replace(PLACEHOLDER_RE, '').replace(/<([^<>\n]*)>/g, (_m, inner: string) => {
    atoms.push(angleToken(inner));
    return String.fromCharCode(PLACEHOLDER + atoms.length - 1);
  });

  const raw: Seg[] = [];
  const codeRe = /`([^`]+)`/g;
  let last = 0;
  for (let m = codeRe.exec(s); m; m = codeRe.exec(s)) {
    if (m.index > last) raw.push(...emphasis(emojify(s.slice(last, m.index)), {}, atoms));
    raw.push(...expand(m[1] ?? '', { code: true }, atoms));
    last = m.index + m[0].length;
  }
  if (last < s.length) raw.push(...emphasis(emojify(s.slice(last)), {}, atoms));

  const out: Seg[] = [];
  for (const seg of raw) {
    if (!seg.text) continue;
    const prev = out[out.length - 1];
    if (prev && sameStyle(prev, seg)) prev.text += seg.text;
    else out.push({ ...seg });
  }
  return out;
}

/** Segments -> the text a reader sees. */
export function segText(segs: Seg[]): string {
  return segs.map((s) => s.text).join('');
}

/** One line of mrkdwn -> its visible plain text (links show their label). */
export function plainText(line: string): string {
  return segText(inline(line)).trim();
}

/** Remove whole-line `_…_` / `*…*` wrapping, any depth. */
export function unwrapEmphasis(line: string): string {
  let out = line.trim();
  for (;;) {
    const m = /^([_*])(.+)\1$/.exec(out);
    if (!m?.[1] || !m[2] || m[2].trim() !== m[2] || m[2].includes(m[1])) return out;
    out = m[2];
  }
}

const RULER_RE = /^\s*(?:={6,}|─{6,}|━{6,})\s*$/;

/** A multi-line mrkdwn body -> blocks. */
export function toBlocks(raw: string): Block[] {
  const text = repairBrokenLinks(raw.replace(/\r\n?/g, '\n'));
  const blocks: Block[] = [];
  let para: Seg[][] | null = null;
  const flush = () => {
    if (para && para.length > 0) blocks.push({ type: 'para', lines: para });
    para = null;
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd();
    const t = line.trim();
    if (!t || RULER_RE.test(line)) {
      flush();
      continue;
    }
    let m: RegExpExecArray | null;

    if ((m = /^\s{2,}[•-]\s+(.*)$/.exec(line)) || (m = /^\s*◦\s+(.*)$/.exec(line))) {
      flush();
      blocks.push({ type: 'bullet', depth: 1, segs: inline(m[1] ?? '') });
      continue;
    }
    if ((m = /^\s*•\s+(.*)$/.exec(line))) {
      flush();
      blocks.push({ type: 'bullet', depth: 0, segs: inline(m[1] ?? '') });
      continue;
    }
    if ((m = /^-\s+(.*)$/.exec(line))) {
      const prev = para ? undefined : blocks[blocks.length - 1];
      const nested = prev?.type === 'bullet' || prev?.type === 'numbered';
      flush();
      blocks.push({ type: 'bullet', depth: nested ? 1 : 0, segs: inline(m[1] ?? '') });
      continue;
    }
    if (/^\s*→/.test(line)) {
      flush();
      blocks.push({ type: 'bullet', depth: 1, segs: inline(t) });
      continue;
    }
    if ((m = /^_(\d+)\.\s+(.+)_$/.exec(t)) || (m = /^(\d+)\.\s+(.*)$/.exec(t))) {
      flush();
      blocks.push({ type: 'numbered', n: Number(m[1]), segs: inline(m[2] ?? '') });
      continue;
    }
    // `_3. Name_ — Direct SAFE`: the number sits inside the name's emphasis.
    if ((m = /^([_*])(\d+)\.\s+(\S.*)$/.exec(t))) {
      flush();
      blocks.push({ type: 'numbered', n: Number(m[2]), segs: inline(`${m[1]}${m[3]}`) });
      continue;
    }
    const wrapped = /^([*_])(\S(?:.*\S)?)\1(:?)$/.exec(t);
    if (wrapped?.[2] && !wrapped[2].includes(wrapped[1] ?? '') && t.length <= 80) {
      flush();
      blocks.push({ type: 'label', segs: inline(wrapped[2].replace(/:$/, '')) });
      continue;
    }
    if (t.endsWith(':') && t.length <= 60) {
      flush();
      blocks.push({ type: 'label', segs: inline(t.slice(0, -1)) });
      continue;
    }
    para ??= [];
    para.push(inline(t));
  }
  flush();
  return blocks;
}

/** Every segment in a block list, for walking. */
export function blockSegs(blocks: Block[]): Seg[] {
  return blocks.flatMap((b) => (b.type === 'para' ? b.lines.flat() : b.segs));
}

/** A block's visible text, one line. */
export function blockText(block: Block): string {
  return block.type === 'para' ? block.lines.map(segText).join(' ') : segText(block.segs);
}
