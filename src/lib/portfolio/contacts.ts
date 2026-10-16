import {
  addressesAtDomain,
  evidenceFor,
  nameFor,
  type RelationshipIndex,
} from '@/lib/network/evidence';
import { isAutomatedAddress } from '@/lib/services/network';
import { isBulkAddress, isPersonalDomain, registrableDomain } from '@/lib/services/warm-paths';
import { normalizeDomain } from '@/lib/util/text';

/**
 * Who a portfolio company's people are, without anyone typing them in.
 *
 * Three sources, each shown with where it came from:
 *  - recorded: the contacts saved on the company here (by hand or a CSV).
 *    Never overwritten; they lead the list.
 *  - affinity: people Affinity ties to the company. A founder-list row whose
 *    work email is at the company's domain or whose company column names it,
 *    or a person record whose email is at that domain. Domain first, exact
 *    normalized name second, never a fuzzy guess (`lib/crm/founders.ts`,
 *    `services/crm-pages.ts`).
 *  - mail: the people at the company's own domain who actually write to Nick,
 *    from the synced mailbox through the relationship index, which already
 *    leaves out no-reply, notification and role inboxes (info@, hello@,
 *    support@...), mass mail and the fund's own addresses. The shared inboxes
 *    a company's updates come from (founders@, investors@, ir@, hi@...) are
 *    left out here too (`isRoleInbox`). Personal mail domains match nobody,
 *    and a company on the fund's own domain gets none.
 *
 * One person seen by several sources is one contact with each source listed:
 * the same address, or the same exact name (normalized) for someone saved or
 * in Affinity without an address.
 * Pure: the service (`services/portfolio-contacts.ts`) gathers the inputs.
 */

export type ContactSource = 'recorded' | 'affinity' | 'mail';

export interface CompanyContact {
  name: string;
  role: string | null;
  email: string | null;
  /** Where the contact comes from, in a stable order: recorded, affinity, mail. */
  sources: ContactSource[];
  founder: boolean;
  /** Their Affinity profile, when they have one. */
  recordId: string | null;
  /** Emails they sent that are in the synced mailbox. */
  emailsFromThem: number;
  /** The last email either way or past meeting with them (ISO), or null. */
  lastContactAt: string | null;
}

export interface RecordedContactInput {
  name: string;
  role: string | null;
  email: string | null;
  isFounder: boolean;
}

export interface AffinityContactInput {
  recordId: string | null;
  name: string;
  role: string | null;
  email: string | null;
  /** On a portfolio founder list (rather than a person record found at the domain). */
  founder: boolean;
}

export interface MailContactInput {
  email: string;
  name: string | null;
  emailsFromThem: number;
  lastContactAt: string | null;
}

/** How many contacts a company card shows; the profile shows more. */
export const CARD_CONTACTS = 3;
/** How many the profile shows. */
export const PROFILE_CONTACTS = 12;

const DAY_MS = 86_400_000;
const SOURCE_ORDER: readonly ContactSource[] = ['recorded', 'affinity', 'mail'];

/**
 * The shared inboxes a company writes from that are nobody in particular:
 * its investor updates (founders@, investors@, ir@, updates@), hi@, careers@,
 * press@, office@ and the like. Initials-sized locals that are as often a
 * person (pr@, hr@, ap@) are left alone.
 */
const COMPANY_ROLE_LOCAL =
  /^(?:founders?|founding-?team|the-?founders|investors?|investor-?relations|ir|shareholders?|stakeholders?|lps?|updates?|newsletter|hi|hey|howdy|careers?|jobs|hiring|recruiting|talent|people|press|media|office|admin|ops|operations|finance|accounting|accounts|billing|legal|partners?|partnerships|community|all|everyone|staff|company|general|inquiries|enquiries|service|services|security|privacy|webmaster|growth|product|engineering|marketing|sales|team|hello|info|contact|support|help)(?:[+._-].*)?$/i;

/**
 * Whether an address is a role inbox or a machine rather than a person: the
 * relationship index's own rules (no-reply, notifications, info@, hello@,
 * support@...) plus a company's shared inboxes. Never a contact, from the
 * mail or from Affinity, which makes a person record for every address that
 * writes ("Ledgerly Support").
 */
export function isRoleInbox(email: string): boolean {
  const address = email.trim().toLowerCase();
  const at = address.lastIndexOf('@');
  if (at < 1) return true;
  return (
    COMPANY_ROLE_LOCAL.test(address.slice(0, at)) ||
    isBulkAddress(address) ||
    isAutomatedAddress(address)
  );
}

/** The company's domain: its own, or its website's. */
export function companyDomain(company: {
  domain: string | null;
  website?: string | null;
}): string | null {
  return normalizeDomain(company.domain) ?? normalizeDomain(company.website ?? null);
}

/** Whether a domain is the fund's own (TipTop's, or a domain of its own addresses). */
export function isOwnDomain(domain: string, ownDomains: readonly string[]): boolean {
  const host = registrableDomain(domain.toLowerCase());
  return ownDomains.some((d) => registrableDomain(d.toLowerCase()) === host);
}

/**
 * The people at a company's domain who have written to Nick, most mail
 * first. Only real senders: someone Nick only wrote to, or only met, is left
 * to the relationship panel.
 */
export function mailContactsAtDomain(
  index: RelationshipIndex,
  domain: string | null,
  now: Date,
  ownDomains: readonly string[],
): MailContactInput[] {
  if (!domain || isPersonalDomain(domain) || isOwnDomain(domain, ownDomains)) return [];
  const out: MailContactInput[] = [];
  for (const email of addressesAtDomain(index, domain)) {
    if (isRoleInbox(email)) continue;
    const { evidence } = evidenceFor(index, [email], now);
    if (evidence.emailsIn < 1) continue;
    out.push({
      email,
      name: nameFor(index, email),
      emailsFromThem: evidence.emailsIn,
      lastContactAt: evidence.lastContactAt,
    });
  }
  return out.sort(
    (a, b) =>
      b.emailsFromThem - a.emailsFromThem ||
      (b.lastContactAt ?? '').localeCompare(a.lastContactAt ?? '') ||
      a.email.localeCompare(b.email),
  );
}

/**
 * When the fund was last in touch with anyone at the company: the date stored
 * on it, or the newest email either way or past meeting with its people (at
 * its domain, or a contact's own address), whichever is later.
 */
export function companyLastContact(
  index: RelationshipIndex | null,
  input: {
    stored: string | null;
    domain: string | null;
    emails: readonly (string | null)[];
    ownDomains: readonly string[];
  },
  now: Date,
): string | null {
  if (!index) return input.stored;
  const domain = input.domain && !isOwnDomain(input.domain, input.ownDomains) ? input.domain : null;
  const addresses = new Set(addressesAtDomain(index, domain));
  for (const e of input.emails) {
    const address = e?.trim().toLowerCase();
    if (address?.includes('@') && !index.own.has(address)) addresses.add(address);
  }
  const fromMail = addresses.size
    ? evidenceFor(index, addresses, now).evidence.lastContactAt
    : null;
  if (!fromMail) return input.stored;
  if (!input.stored) return fromMail;
  return Date.parse(fromMail) > Date.parse(input.stored) ? fromMail : input.stored;
}

/** A person's name for matching: lower case, accents and punctuation folded. */
function nameKey(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * How strong a contact is, for the order: someone saved here first, then a
 * founder Affinity names, then the most mail, most recently. Every weight is a
 * count of records, never a guess.
 */
function strength(c: CompanyContact, now: number): number {
  let score = 0;
  if (c.sources.includes('recorded')) score += 4;
  if (c.sources.includes('affinity')) score += c.founder ? 3 : 1.5;
  score += Math.min(c.emailsFromThem, 5) * 0.4;
  if (c.lastContactAt) {
    const age = now - Date.parse(c.lastContactAt);
    if (age <= 90 * DAY_MS) score += 1;
    else if (age <= 365 * DAY_MS) score += 0.5;
  }
  return score;
}

/** One list of a company's contacts from every source, strongest and most recent first. */
export function mergeCompanyContacts(
  input: {
    recorded: readonly RecordedContactInput[];
    affinity: readonly AffinityContactInput[];
    mail: readonly MailContactInput[];
  },
  now: Date = new Date(),
): CompanyContact[] {
  const all: CompanyContact[] = [];
  const byEmail = new Map<string, CompanyContact>();
  const byName = new Map<string, CompanyContact>();

  const add = (
    source: ContactSource,
    fields: Partial<CompanyContact> & { name: string; email: string | null },
  ) => {
    const email = fields.email?.trim().toLowerCase() || null;
    const key = nameKey(fields.name);
    // A saved or Affinity contact is matched by address, then by exact name,
    // so one saved without an address meets their record. A mail sender is
    // matched by name only to someone with no address yet: a contact saved
    // with another address stays a separate person.
    const byNameFound = key ? byName.get(key) : undefined;
    const found =
      (email ? byEmail.get(email) : undefined) ??
      (source !== 'mail' || (byNameFound && !byNameFound.email) ? byNameFound : undefined);
    if (found) {
      if (!found.sources.includes(source)) found.sources.push(source);
      found.email ??= email;
      found.role ??= fields.role ?? null;
      found.recordId ??= fields.recordId ?? null;
      found.founder ||= fields.founder ?? false;
      found.emailsFromThem = Math.max(found.emailsFromThem, fields.emailsFromThem ?? 0);
      if (
        fields.lastContactAt &&
        (!found.lastContactAt || fields.lastContactAt > found.lastContactAt)
      ) {
        found.lastContactAt = fields.lastContactAt;
      }
      if (email) byEmail.set(email, found);
      return;
    }
    const contact: CompanyContact = {
      name: fields.name.trim() || email || 'Unknown',
      role: fields.role ?? null,
      email,
      sources: [source],
      founder: fields.founder ?? false,
      recordId: fields.recordId ?? null,
      emailsFromThem: fields.emailsFromThem ?? 0,
      lastContactAt: fields.lastContactAt ?? null,
    };
    all.push(contact);
    if (email) byEmail.set(email, contact);
    // A name with no address is matched by name; a mail sender is matched by address only.
    if (key && source !== 'mail') byName.set(key, contact);
  };

  for (const c of input.recorded) {
    if (!c.name.trim()) continue;
    add('recorded', { name: c.name, role: c.role, email: c.email, founder: c.isFounder });
  }
  for (const c of input.affinity) {
    if (!c.name.trim()) continue;
    add('affinity', {
      name: c.name,
      role: c.role,
      email: c.email,
      founder: c.founder,
      recordId: c.recordId,
    });
  }
  // Mail evidence lands on whoever has that address (or that exact name and
  // no address), or adds the sender.
  for (const c of input.mail) {
    const existing = byEmail.get(c.email.trim().toLowerCase());
    if (existing) {
      if (!existing.sources.includes('mail')) existing.sources.push('mail');
      existing.emailsFromThem = Math.max(existing.emailsFromThem, c.emailsFromThem);
      if (
        c.lastContactAt &&
        (!existing.lastContactAt || c.lastContactAt > existing.lastContactAt)
      ) {
        existing.lastContactAt = c.lastContactAt;
      }
      continue;
    }
    add('mail', {
      name: c.name ?? c.email,
      email: c.email,
      emailsFromThem: c.emailsFromThem,
      lastContactAt: c.lastContactAt,
    });
  }

  const at = now.getTime();
  for (const c of all) c.sources.sort((a, b) => SOURCE_ORDER.indexOf(a) - SOURCE_ORDER.indexOf(b));
  return all.sort(
    (a, b) =>
      strength(b, at) - strength(a, at) ||
      (b.lastContactAt ?? '').localeCompare(a.lastContactAt ?? '') ||
      a.name.localeCompare(b.name),
  );
}

/** "from Affinity and your mail", for the sources that were not typed in here; null for none. */
export function provenanceLabel(sources: readonly ContactSource[]): string | null {
  const words = sources
    .filter((s) => s !== 'recorded')
    .map((s) => (s === 'affinity' ? 'Affinity' : 'your mail'));
  if (words.length === 0) return null;
  return `from ${words.join(' and ')}`;
}
