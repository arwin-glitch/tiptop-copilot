/**
 * The compose window's formatted body, made safe to send. The window is a
 * contenteditable box with Gmail's basic toolbar (bold, italic, underline,
 * link, bulleted and numbered lists), so its HTML comes from the browser and
 * is never trusted: this keeps only those few tags, a link's http(s) or
 * mailto href and nothing else, drops scripts, styles, comments and every
 * other attribute, and escapes the text between. Runs on the server before
 * anything is sent or saved, and in tests. Pure: no DOM.
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
  'blockquote',
]);
const VOID = new Set(['br']);
/** Their content goes too: never text a person meant to send. */
const DROP_WITH_CONTENT = new Set(['script', 'style', 'head', 'title', 'template', 'iframe']);

/** The longest body kept, in characters of HTML. */
export const MAX_COMPOSE_HTML = 200_000;

const ENTITY = /&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});/gi;

function escapeText(text: string): string {
  // Keep entities the browser wrote (&nbsp; &amp;), escape a bare & and the brackets.
  const parts = text.split(ENTITY);
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? '';
    if (i % 2 === 1) out += `&${part};`;
    else out += part.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  return out;
}

function safeHref(attrs: string): string | null {
  const m = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
  const raw = (m?.[2] ?? m?.[3] ?? m?.[4] ?? '')
    .replace(/&amp;/g, '&')
    .replace(/[\u0000-\u001f\u007f\s]+/g, '')
    .trim();
  if (!/^(https?:\/\/|mailto:)/i.test(raw)) return null;
  return raw.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** The body with only the allowed tags left, every tag it opened closed again. */
export function sanitizeComposeHtml(html: string): string {
  const input = html.slice(0, MAX_COMPOSE_HTML).replace(/<!--[\s\S]*?(-->|$)/g, '');
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
      if (!closing) out += '<br>';
      continue;
    }
    if (closing) {
      const at = open.lastIndexOf(name);
      if (at < 0) continue;
      // Close what was opened inside it first, so the nesting stays sound.
      while (open.length > at) out += `</${open.pop()}>`;
      continue;
    }
    if (name === 'a') {
      const href = safeHref(attrs);
      out += href ? `<a href="${href}">` : '<a>';
    } else {
      out += `<${name}>`;
    }
    open.push(name);
  }
  while (open.length) out += `</${open.pop()}>`;
  return out;
}

/** True when the body has no words in it (only tags, spaces or line breaks). */
export function isBlankHtml(html: string): boolean {
  return (
    html
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .trim() === ''
  );
}

/** Plain text typed in, as the compose window's HTML: one div per line, escaped. */
export function textToComposeHtml(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.trim() ? `<div>${escapeText(line)}</div>` : '<div><br></div>'))
    .join('');
}
