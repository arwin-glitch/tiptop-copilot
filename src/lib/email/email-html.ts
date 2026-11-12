/**
 * An email's HTML, made safe to show as the sender laid it out (logos in
 * signatures, tables, colours) in the Inbox. Belt and braces: the Inbox shows
 * it in a sandboxed frame that runs no script and has its own content policy,
 * and this strips everything active before it gets there.
 *
 * Kept: layout, inline styles, <style> blocks, links and images. Removed:
 * scripts, frames, forms, embeds, meta/base/link tags, event handlers, and
 * javascript:/vbscript:/data: links.
 */

const DROP_WITH_CONTENT =
  /<(script|noscript|iframe|frame|frameset|object|embed|applet|template|svg|math)\b[\s\S]*?<\/\1\s*>/gi;
const DROP_TAG =
  /<\/?(script|noscript|iframe|frame|frameset|object|embed|applet|form|input|button|textarea|select|option|meta|base|link|svg|math|template|portal)\b[^>]*>/gi;
const EVENT_ATTR = /\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const BAD_URL_ATTR =
  /\s+(href|src|action|formaction|background|poster|xlink:href)\s*=\s*(["']?)\s*(?:javascript|vbscript|data:(?!image\/(?:png|gif|jpe?g|webp);))[^"'\s>]*\2/gi;
const SRCDOC_ATTR = /\s+srcdoc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const CSS_DANGER = /expression\s*\(|javascript:|behavior\s*:|-moz-binding/gi;

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function sanitizeEmailHtml(html: string): string {
  if (!html) return '';
  let out = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(DROP_WITH_CONTENT, '')
    .replace(DROP_TAG, '')
    .replace(EVENT_ATTR, '')
    .replace(SRCDOC_ATTR, '')
    .replace(BAD_URL_ATTR, ' $1="#"');
  out = out.replace(CSS_DANGER, '');
  return out;
}

/** The Content-IDs an email's HTML shows in place (`src="cid:…"`). */
export function cidsIn(html: string): Set<string> {
  const out = new Set<string>();
  for (const m of html.matchAll(/\bsrc\s*=\s*["']?cid:([^"'\s>]+)/gi)) {
    out.add(safeDecode(m[1]!).trim());
  }
  return out;
}

/**
 * The HTML with each `cid:` image pointed at Kraken's attachment link, so a
 * signature logo shows in place. `urlFor` gives the link for a Content-ID, or
 * null to leave it (it then shows as a broken image, as in other clients).
 */
export function withInlineImages(html: string, urlFor: (cid: string) => string | null): string {
  return html.replace(
    /(\bsrc\s*=\s*["']?)cid:([^"'\s>]+)/gi,
    (whole, lead: string, raw: string) => {
      const url = urlFor(safeDecode(raw).trim());
      return url ? `${lead}${url}` : whole;
    },
  );
}

/** Whether a body is worth showing as HTML rather than its text: more than wrapped text. */
export function hasRichHtml(html: string): boolean {
  return /<(img|table|a|font|span|div|b|strong|i|em|br|p|ul|ol|hr|h[1-6])\b/i.test(html);
}
