/**
 * Split answer text into plain runs and links to a short list of trusted
 * places (Nick's Google workspace, Slack, claude.ai, this app).
 *
 * Ask answers quote third-party email, so any URL could be a sender's. Only
 * links into tools TipTop itself uses become clickable; everything else stays
 * visible as plain text, where it can be read before anyone opens it.
 */

export type TextPart =
  { type: 'text'; text: string } | { type: 'link'; href: string; label: string };

const URL_RE = /https:\/\/[^\s<>"'`]+/g;
const TRAILING = /[.,;:!?)\]]+$/;

const TRUSTED: { host: RegExp; label: string }[] = [
  { host: /^mail\.google\.com$/, label: 'Open in Gmail' },
  { host: /^calendar\.google\.com$/, label: 'Open in Calendar' },
  { host: /^(docs|drive|sheets)\.google\.com$/, label: 'Open in Google Drive' },
  { host: /^([a-z0-9-]+\.)?slack\.com$/, label: 'Open in Slack' },
  { host: /^claude\.ai$/, label: 'Open on claude.ai' },
  { host: /^tiptop-copilot\.onrender\.com$/, label: 'Open in Copilot' },
];

export function trustedLinkLabel(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  return TRUSTED.find((t) => t.host.test(url.hostname))?.label ?? null;
}

export function linkifyTrusted(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    const raw = match[0];
    const href = raw.replace(TRAILING, '');
    const label = trustedLinkLabel(href);
    if (!label) continue;
    const start = match.index;
    if (start > last) parts.push({ type: 'text', text: text.slice(last, start) });
    parts.push({ type: 'link', href, label });
    last = start + href.length;
  }
  if (last < text.length) parts.push({ type: 'text', text: text.slice(last) });
  return parts;
}
