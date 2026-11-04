/**
 * One email's original RFC 822 source, for Gmail's "Show original",
 * "Download message" and "Forward as attachment". The source is shown as
 * text only (React escapes it; nothing in it is rendered or run). Pure.
 */

/** The largest original Kraken reads (Gmail's own cap on a message is 25 MB sent, 50 MB received). */
export const MAX_RAW_BYTES = 10 * 1024 * 1024;

/** A message id a link may carry: Gmail's (hex), or the demo's fictional ones (UUIDs). */
export const MESSAGE_ID =
  /^([0-9a-f]{10,24}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export interface RawHeader {
  name: string;
  value: string;
}

/** The header block's fields, folded lines joined, in order. */
export function parseHeaders(source: string): RawHeader[] {
  const end = source.search(/\r?\n\r?\n/);
  const block = end >= 0 ? source.slice(0, end) : source;
  const out: RawHeader[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && out.length) {
      out[out.length - 1]!.value += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    out.push({ name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() });
  }
  return out;
}

/** Gmail's "Show original" summary rows: the ids, who, when, and the checks. */
export function originalSummary(headers: readonly RawHeader[]): RawHeader[] {
  const get = (n: string) => headers.find((h) => h.name.toLowerCase() === n)?.value ?? '';
  const auth = get('authentication-results');
  const check = (kind: string) => {
    const m = new RegExp(`\\b${kind}=(\\w+)`, 'i').exec(auth);
    return m ? m[1]!.toUpperCase() : '';
  };
  return [
    { name: 'Message ID', value: get('message-id') },
    { name: 'Created at', value: get('date') },
    { name: 'From', value: get('from') },
    { name: 'To', value: get('to') },
    { name: 'Subject', value: get('subject') },
    { name: 'SPF', value: check('spf') },
    { name: 'DKIM', value: check('dkim') },
    { name: 'DMARC', value: check('dmarc') },
  ].filter((r) => r.value);
}

/** A safe .eml file name from a subject. */
export function emlFileName(subject: string): string {
  const base = subject
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${base || 'message'}.eml`;
}

/**
 * The demo's stand-in original: the fictional message's own fields as an
 * RFC 822 text message. Never a real mailbox's.
 */
export function demoRawMessage(m: {
  id: string;
  from: string;
  to: string;
  cc: string;
  at: string | null;
  subject: string;
  text: string;
}): string {
  const lines = [
    `Message-ID: <${m.id}@demo.example>`,
    `Date: ${m.at ? new Date(m.at).toUTCString().replace('GMT', '+0000') : ''}`,
    `From: ${m.from}`,
    `To: ${m.to}`,
    m.cc ? `Cc: ${m.cc}` : '',
    `Subject: ${m.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Authentication-Results: mx.demo.example; spf=pass; dkim=pass; dmarc=pass',
  ].filter(Boolean);
  return `${lines.join('\r\n')}\r\n\r\n${m.text.replace(/\r?\n/g, '\r\n')}\r\n`;
}
