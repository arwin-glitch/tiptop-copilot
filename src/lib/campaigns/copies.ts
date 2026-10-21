import type { CampaignBccMode } from '@/lib/types/domain';
import { isEmail, normalizeEmail } from './recipients';

/**
 * CC and BCC on a campaign. Pure, shared by the composer (which checks as you
 * type) and the server (which decides).
 *
 * Three kinds, all empty by default:
 *   - campaign CC: copied on every email;
 *   - campaign BCC: on every email, or on the first email only (one sample
 *     copy for the records);
 *   - a recipient's own CC: copied on that one person's email.
 *
 * An email's To is always exactly its one recipient; copies never change
 * that, and the recipient's own address is never copied to them as well.
 * Every copy is one more email as far as Gmail's sending limits go, so each
 * counts toward the daily cap (copyCount).
 */

/** Addresses one list (campaign CC, campaign BCC, or one person's CC) can hold. */
export const MAX_COPY_ADDRESSES = 10;

export type ParsedCopies = { ok: true; emails: string[] } | { ok: false; message: string };

/** `Jane Doe <jane@acme.example>` or `"Doe, Jane" <jane@acme.example>`: the address alone. */
const NAMED = /(?:"[^"]*"|[^,;<>"\n@]*)\s*<([^<>\s]*)>/g;

/**
 * Addresses as typed: commas, semicolons, spaces or new lines between them,
 * `Name <address>` allowed (the name is dropped). Lowercased and deduped.
 * Stricter than pasting recipients, where a stray word reads as a name: here
 * every word must be an address, and the whole list is refused, naming what
 * is wrong, if one is not or there are too many. Half a CC list silently
 * saved is worse than none.
 */
export function parseCopyAddresses(text: string): ParsedCopies {
  const tokens = text
    .slice(0, 20_000)
    .replace(NAMED, ' $1 ')
    .split(/[\s,;]+/)
    .map((t) => normalizeEmail(t.replace(/^["'([]+|["')\].]+$/g, '')))
    .filter(Boolean);
  const invalid = tokens.filter((t) => !isEmail(t));
  if (invalid.length) {
    return { ok: false, message: `Not an email address: ${invalid.slice(0, 3).join(', ')}` };
  }
  const emails = [...new Set(tokens)];
  if (emails.length > MAX_COPY_ADDRESSES) {
    return { ok: false, message: `At most ${MAX_COPY_ADDRESSES} addresses.` };
  }
  return { ok: true, emails };
}

/**
 * A stored list as addresses: lowercased, deduped, real addresses only.
 * Anything else (an absent column, a hand-edited row) reads as empty rather
 * than reaching a header.
 */
export function cleanCopyList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out = new Set<string>();
  for (const v of value) {
    if (typeof v !== 'string') continue;
    const email = normalizeEmail(v);
    if (isEmail(email)) out.add(email);
  }
  return [...out].slice(0, MAX_COPY_ADDRESSES);
}

export function cleanBccMode(value: unknown): CampaignBccMode {
  return value === 'first' ? 'first' : 'every';
}

/** The copies on one email. Both empty: no Cc or Bcc header at all. */
export interface EmailCopies {
  cc: string[];
  bcc: string[];
}

export const NO_COPIES: EmailCopies = Object.freeze({ cc: [], bcc: [] }) as EmailCopies;

/**
 * One email's Cc and Bcc: the campaign's CC then the person's own, and the
 * Bcc this email carries (the caller decides whether the first-only sample is
 * on it). The recipient's own address is never among them, an address is
 * never both Cc and Bcc (Cc wins), and an unsubscribed address is left off.
 */
export function copiesFor(
  to: string,
  input: {
    campaignCc: readonly string[];
    personalCc: readonly string[];
    bcc: readonly string[];
    suppressed?: ReadonlySet<string>;
  },
): EmailCopies {
  const self = normalizeEmail(to);
  const skip = (email: string) => email === self || Boolean(input.suppressed?.has(email));
  const cc = [...new Set([...input.campaignCc, ...input.personalCc])].filter((e) => !skip(e));
  const inCc = new Set(cc);
  const bcc = [...new Set(input.bcc)].filter((e) => !skip(e) && !inCc.has(e));
  return { cc, bcc };
}

/** How many extra addresses an email goes to: each counts toward the daily cap. */
export function copyCount(copies: EmailCopies): number {
  return copies.cc.length + copies.bcc.length;
}

/** "a@x.example, b@y.example", for a line of text; "" when empty. */
export function formatCopyList(emails: readonly string[]): string {
  return emails.join(', ');
}
