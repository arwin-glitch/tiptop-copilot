/** Text normalisation helpers used by dedupe, search and extraction. */

/** Lowercase, strip punctuation and legal suffixes, collapse whitespace. */
export function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(
      /\b(inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|gmbh|ab|oy|bv|nv|sa|sas|plc|pbc|holdings|labs|technologies|technology|tech|ai|io|hq)\b/g,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

/** Bare registrable-ish domain: strips scheme, `www.`, path, port and query. */
export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let v = input.trim().toLowerCase();
  if (!v) return null;
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  v = v.split('/')[0] ?? v;
  v = v.split('?')[0] ?? v;
  v = v.split('#')[0] ?? v;
  v = v.split(':')[0] ?? v;
  v = v.replace(/^www\./, '');
  v = v.replace(/\.$/, '');
  if (!v.includes('.')) return null;
  return v;
}

const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'fastmail.com',
  'hey.com',
  'msn.com',
  'gmx.com',
  'zoho.com',
]);

export function isFreeEmailDomain(domain: string | null | undefined): boolean {
  if (!domain) return false;
  return FREE_EMAIL_DOMAINS.has(domain.toLowerCase());
}

/** Company-ish domain from an email address, or null for free providers. */
export function emailDomain(address: string | null | undefined): string | null {
  if (!address) return null;
  const at = address.lastIndexOf('@');
  if (at < 0) return null;
  return normalizeDomain(address.slice(at + 1));
}

export function corporateEmailDomain(address: string | null | undefined): string | null {
  const d = emailDomain(address);
  if (!d || isFreeEmailDomain(d)) return null;
  return d;
}

/** Convert an HTML email body into readable plain text, server-side. */
export function htmlToPlainText(html: string): string {
  return (
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
      .replace(/<li[^>]*>/gi, '• ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
      .replace(/[ \t ]+/g, ' ')
      // An opening block tag collapses to a space, so without this every line
      // would start with one and a blank line would not read as blank.
      .replace(/[ \t]*\n[ \t]*/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

export function truncate(text: string, max: number, suffix = '…'): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - suffix.length)).trimEnd() + suffix;
}

/** Snippet used in list views; collapses newlines. */
export function snippet(text: string, max = 220): string {
  return truncate(text.replace(/\s+/g, ' ').trim(), max);
}

/** Filesystem/storage-safe filename. Preserves extension, drops everything odd. */
export function sanitizeFilename(name: string): string {
  const trimmed = name.trim().replace(/[\r\n\t]/g, '');
  const lastDot = trimmed.lastIndexOf('.');
  const base = lastDot > 0 ? trimmed.slice(0, lastDot) : trimmed;
  const ext = lastDot > 0 ? trimmed.slice(lastDot + 1) : '';
  const safeBase =
    base
      .normalize('NFKD')
      .replace(/[^a-zA-Z0-9._-]/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 80) || 'file';
  const safeExt = ext
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 10)
    .toLowerCase();
  return safeExt ? `${safeBase}.${safeExt}` : safeBase;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return (parts[0] ?? '?').slice(0, 2).toUpperCase();
  return `${parts[0]?.[0] ?? ''}${parts[parts.length - 1]?.[0] ?? ''}`.toUpperCase();
}

/** Naive token overlap score in [0,1]; used for cheap similarity ranking. */
export function tokenOverlap(a: string, b: string): number {
  const ta = new Set(
    a
      .toLowerCase()
      .split(/\W+/)
      .filter((t) => t.length > 2),
  );
  const tb = new Set(
    b
      .toLowerCase()
      .split(/\W+/)
      .filter((t) => t.length > 2),
  );
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.min(ta.size, tb.size);
}
