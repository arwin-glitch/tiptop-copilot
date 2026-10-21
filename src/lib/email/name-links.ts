/**
 * LinkedIn links on names, for intro emails written in the plain-text
 * compose window: a name written `[Full Name](https://www.linkedin.com/in/…)`
 * goes out as that name linked to that profile, and nothing else becomes a
 * link. The intro format links every person's full name to their LinkedIn and
 * allows no other kind of link, so this is all the compose window needs.
 *
 * Safe by construction: only https URLs on linkedin.com (or a subdomain of
 * it) are accepted, the label and URL are HTML-escaped, and anything that
 * does not match stays exactly as typed. Sending turns links on only when the
 * window asked for them (the intro draft), so a reply that happens to contain
 * brackets is never rewritten.
 *
 * No server imports: the compose window uses the same parser to copy the
 * email for Gmail.
 */

const LINK = /\[([^[\]\n]{1,200})\]\((https:\/\/[^\s()<>"']{1,500})\)/g;

/** A LinkedIn profile URL as https, or null when the text is not one. */
export function toLinkedInUrl(raw: string | null | undefined): string | null {
  const text = (raw ?? '').trim();
  if (!text || /\s/.test(text)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) return null;
  if (url.pathname === '/' || !url.pathname) return null;
  url.protocol = 'https:';
  // Parentheses would end the `[name](url)` form early.
  return url.toString().replace(/\(/g, '%28').replace(/\)/g, '%29');
}

/** `[Full Name](url)`, or the plain name when there is no usable LinkedIn URL. */
export function linkName(name: string, url: string | null | undefined): string {
  const clean = name.replace(/[[\]\n]/g, ' ').trim();
  const href = toLinkedInUrl(url);
  return href ? `[${clean}](${href})` : clean;
}

type Segment = { text: string } | { label: string; href: string };

function segments(line: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of line.matchAll(LINK)) {
    const [whole, label, raw] = m;
    const href = toLinkedInUrl(raw);
    if (!href) continue;
    if (m.index! > last) out.push({ text: line.slice(last, m.index) });
    out.push({ label: label!, href });
    last = m.index! + whole.length;
  }
  if (last < line.length) out.push({ text: line.slice(last) });
  return out;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** One line of the body as escaped HTML, its LinkedIn names as links. */
export function lineWithLinksToHtml(line: string): string {
  return segments(line)
    .map((s) =>
      'href' in s
        ? `<a href="${escapeHtml(s.href)}">${escapeHtml(s.label)}</a>`
        : escapeHtml(s.text),
    )
    .join('');
}

/** The body as plain text: each linked name followed by its URL in brackets. */
export function textWithLinks(body: string): string {
  return body
    .split('\n')
    .map((line) =>
      segments(line)
        .map((s) => ('href' in s ? `${s.label} (${s.href})` : s.text))
        .join(''),
    )
    .join('\n');
}

/** Whether the body holds at least one name the send would link. */
export function hasNameLinks(body: string): boolean {
  return body.split('\n').some((line) => segments(line).some((s) => 'href' in s));
}
