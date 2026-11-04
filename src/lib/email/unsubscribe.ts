/**
 * Gmail's "Unsubscribe" next to a sender, from the message's own
 * List-Unsubscribe header (RFC 2369) and List-Unsubscribe-Post (RFC 8058).
 * Plain data, shared by the server (which re-reads the headers before any
 * one-click POST) and the conversation view. Nothing here unsubscribes: a
 * person clicks Unsubscribe and then confirms.
 */

export interface UnsubscribeOptions {
  /** An https link; one-click when `oneClick`, else opened in a new tab. */
  http: string | null;
  /** A mailto: address with the subject and body the list asks for. */
  mailto: { to: string; subject: string; body: string } | null;
  /** RFC 8058: the sender takes a POST of `List-Unsubscribe=One-Click` to `http`. */
  oneClick: boolean;
}

/** The POST body RFC 8058 defines. */
export const ONE_CLICK_BODY = 'List-Unsubscribe=One-Click';

const MAX_URL = 2000;

function httpsLink(raw: string): string | null {
  if (raw.length > MAX_URL) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function mailtoLink(raw: string): UnsubscribeOptions['mailto'] {
  if (!/^mailto:/i.test(raw) || raw.length > MAX_URL) return null;
  const rest = raw.slice('mailto:'.length);
  const [addr = '', query = ''] = rest.split('?');
  let to: string;
  try {
    to = decodeURIComponent(addr).trim();
  } catch {
    return null;
  }
  if (!/^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/.test(to)) return null;
  const params = new URLSearchParams(query);
  const clean = (s: string | null, max: number) =>
    (s ?? '')
      .replace(/[\r\n]+/g, ' ')
      .trim()
      .slice(0, max);
  return {
    to,
    subject: clean(params.get('subject'), 200) || 'Unsubscribe',
    body: clean(params.get('body'), 1000),
  };
}

/** The ways a message offers to unsubscribe, or null when it offers none Kraken can use. */
export function parseUnsubscribe(
  listUnsubscribe: string | null | undefined,
  listUnsubscribePost: string | null | undefined,
): UnsubscribeOptions | null {
  if (!listUnsubscribe) return null;
  const entries = [...listUnsubscribe.matchAll(/<([^<>]+)>/g)].map((m) =>
    m[1]!.replace(/\s+/g, ''),
  );
  let http: string | null = null;
  let mailto: UnsubscribeOptions['mailto'] = null;
  for (const entry of entries) {
    if (!http && /^https:/i.test(entry)) http = httpsLink(entry);
    if (!mailto && /^mailto:/i.test(entry)) mailto = mailtoLink(entry);
  }
  if (!http && !mailto) return null;
  const oneClick =
    Boolean(http) &&
    (listUnsubscribePost ?? '').replace(/\s+/g, '').toLowerCase() === ONE_CLICK_BODY.toLowerCase();
  return { http, mailto, oneClick };
}

/** What Unsubscribe will do, in the confirm dialog's words. */
export function unsubscribeHow(options: UnsubscribeOptions): 'one-click' | 'email' | 'link' {
  if (options.oneClick && options.http) return 'one-click';
  if (options.mailto) return 'email';
  return 'link';
}
