/**
 * A Gmail signature (and the vacation responder's message), made safe to
 * show and to save. Signatures come from Gmail's settings and from the
 * Signature box, so their HTML is never trusted: this keeps the compose
 * window's few tags plus what a signature needs (an image by https URL, a
 * horizontal rule, spans and small tables for layout), a link's http(s),
 * mailto or tel href, an image's src, width, height and alt, and nothing
 * else. Scripts, styles, event handlers, data: and javascript: URLs all go.
 * Pure: no DOM.
 */

const ALLOWED = new Set([
  'b',
  'strong',
  'i',
  'em',
  'u',
  'a',
  'ul',
  'ol',
  'li',
  'br',
  'div',
  'p',
  'span',
  'blockquote',
  'small',
  'hr',
  'img',
  'table',
  'tbody',
  'tr',
  'td',
]);
const VOID = new Set(['br', 'hr', 'img']);
const DROP_WITH_CONTENT = new Set([
  'script',
  'style',
  'head',
  'title',
  'template',
  'iframe',
  'object',
  'embed',
  'svg',
  'math',
  'noscript',
]);

/** Gmail's own limit on a signature is about 10,000 characters. */
export const MAX_SIGNATURE_HTML = 10_000;

const ENTITY = /&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});/gi;

function escapeText(text: string): string {
  const parts = text.split(ENTITY);
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? '';
    if (i % 2 === 1) out += `&${part};`;
    else out += part.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  return out;
}

function attr(attrs: string, name: string): string | null {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = re.exec(attrs);
  if (!m) return null;
  return (m[2] ?? m[3] ?? m[4] ?? '').replace(/&amp;/g, '&');
}

const escapeAttr = (v: string) =>
  v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function cleanUrl(raw: string | null, allowed: RegExp): string | null {
  if (raw === null) return null;
  const url = raw.replace(/[\u0000-\u001f\u007f\s]+/g, '').trim();
  return allowed.test(url) ? escapeAttr(url) : null;
}

const size = (v: string | null) => (v && /^\d{1,4}$/.test(v.trim()) ? v.trim() : null);

/** The signature with only the allowed tags and attributes left, every tag it opened closed. */
export function sanitizeSignatureHtml(html: string): string {
  const input = html.slice(0, MAX_SIGNATURE_HTML * 2).replace(/<!--[\s\S]*?(-->|$)/g, '');
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>|([^<]+)|(<)/g;
  const open: string[] = [];
  let out = '';
  let dropping: string | null = null;
  for (const m of input.matchAll(re)) {
    const [, closing, rawName, attrs = '', text, stray] = m;
    if (text !== undefined || stray !== undefined) {
      if (!dropping) out += escapeText(text ?? '<');
      continue;
    }
    const name = (rawName ?? '').toLowerCase();
    if (dropping) {
      if (closing && name === dropping) dropping = null;
      continue;
    }
    if (DROP_WITH_CONTENT.has(name)) {
      if (!closing && !/\/\s*$/.test(attrs)) dropping = name;
      continue;
    }
    if (!ALLOWED.has(name)) continue;
    if (VOID.has(name)) {
      if (closing) continue;
      if (name === 'img') {
        const src = cleanUrl(attr(attrs, 'src'), /^https:\/\//i);
        if (!src) continue;
        const w = size(attr(attrs, 'width'));
        const h = size(attr(attrs, 'height'));
        const alt = attr(attrs, 'alt');
        out += `<img src="${src}"${w ? ` width="${w}"` : ''}${h ? ` height="${h}"` : ''}${
          alt ? ` alt="${escapeAttr(alt.slice(0, 200))}"` : ''
        }>`;
      } else out += `<${name}>`;
      continue;
    }
    if (closing) {
      const at = open.lastIndexOf(name);
      if (at < 0) continue;
      while (open.length > at) out += `</${open.pop()}>`;
      continue;
    }
    if (name === 'a') {
      const href = cleanUrl(attr(attrs, 'href'), /^(https?:\/\/|mailto:|tel:)/i);
      out += href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">` : '<a>';
    } else {
      out += `<${name}>`;
    }
    open.push(name);
  }
  while (open.length) out += `</${open.pop()}>`;
  return out;
}
