import { normalizeDomain } from '@/lib/util/text';

/**
 * Links built at render time from stored identifiers, never stored URLs.
 * Everything the deal-sorter posts is rendered as plain text; these are the
 * only places a stored value becomes an href, and each one is rebuilt from a
 * validated identifier rather than trusted as given.
 */

const THREAD_ID = /^[0-9a-f]{10,24}$/i;

/**
 * A Gmail thread in the mailbox it came from. `authuser=<email>` opens the
 * right account whatever order the browser signed in; `/u/0/` is the fallback
 * when no connected account is known, and may open another account's inbox.
 */
export function gmailThreadUrl(
  threadId: string,
  accountEmail: string | null | undefined,
): string | null {
  if (!THREAD_ID.test(threadId)) return null;
  return accountEmail
    ? `https://mail.google.com/mail/?authuser=${encodeURIComponent(accountEmail)}#all/${threadId}`
    : `https://mail.google.com/mail/u/0/#all/${threadId}`;
}

/** A DNS hostname: dot-separated LDH labels and an alphabetic top-level label. */
const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])$/;

/**
 * The normalized domain of a website, only if it is a plain hostname.
 * `normalizeDomain` keeps whatever precedes the host, so `jane@zz.example` or
 * `good.example@evil.example` would otherwise pass as a "domain" — and the
 * second, used as an href, sends the reader to `evil.example`.
 */
export function strictDomain(website: string | null | undefined): string | null {
  const domain = normalizeDomain(website);
  return domain && domain.length <= 253 && HOSTNAME.test(domain) ? domain : null;
}

/** A company website as `https://<domain>`, or null if it is not a plain hostname. */
export function websiteHref(website: string | null | undefined): string | null {
  const domain = strictDomain(website);
  return domain ? `https://${domain}` : null;
}

/** A stored source URL, only if it is plain http(s). */
export function httpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}
