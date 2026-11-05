import type { SpaceRuleKind } from '@/lib/types/domain';

/**
 * A Space's matching rules, as plain data: what belongs in it (a company's
 * domain, people's addresses, keywords), how each is cleaned up from what a
 * person typed, the Gmail search that finds its mail, and the matchers the
 * counts, the Meetings tab and Ask use on mail and notes Kraken already has.
 *
 * Pure and client-safe: no store, no Gmail. The service adds the checks that
 * need the server (a personal domain like a free mail host is refused there).
 */

export interface RuleInput {
  kind: SpaceRuleKind;
  value: string;
}

export interface SpaceRuleSet {
  domains: string[];
  emails: string[];
  keywords: string[];
}

export const MAX_RULES = 30;
const DOMAIN = /^(?=.{3,200}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
const EMAIL = /^[^\s@<>(),;:"]{1,64}@([a-z0-9-]+\.)+[a-z]{2,24}$/;

/** A domain as typed ("https://www.Example.com/about") to its bare form, or null. */
export function cleanDomain(raw: string): string | null {
  let v = raw.trim().toLowerCase();
  if (v.startsWith('@')) v = v.slice(1);
  v = v.replace(/^[a-z]+:\/\//, '').replace(/^www\./, '');
  v = v.split(/[/?#\s]/)[0] ?? '';
  // "someone@example.com" typed in the domain box: keep the domain.
  if (v.includes('@')) v = v.slice(v.lastIndexOf('@') + 1);
  v = v.replace(/\.$/, '');
  return DOMAIN.test(v) ? v : null;
}

/** An address as typed ("Ada <ADA@example.com>") to its bare lower-case form, or null. */
export function cleanEmail(raw: string): string | null {
  const inner = /<([^>]+)>/.exec(raw)?.[1] ?? raw;
  const v = inner.trim().toLowerCase();
  return EMAIL.test(v) ? v : null;
}

/** A keyword or phrase: quotes and extra spaces dropped, 2 to 60 characters. */
export function cleanKeyword(raw: string): string | null {
  const v = raw
    .replace(/["“”{}()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (v.length < 2 || v.length > 60) return null;
  // A Gmail operator typed as a keyword would change what the search means.
  if (/^-|^(or|and)$/i.test(v) || /\b\w+:/.test(v)) return null;
  return v;
}

export function cleanRule(rule: RuleInput): RuleInput | null {
  const value =
    rule.kind === 'domain'
      ? cleanDomain(rule.value)
      : rule.kind === 'email'
        ? cleanEmail(rule.value)
        : cleanKeyword(rule.value);
  return value ? { kind: rule.kind, value } : null;
}

/**
 * A comma- or line-separated box ("example.com, other.example") to rules,
 * with what could not be read kept apart so the form can say which.
 */
export function parseRuleList(
  kind: SpaceRuleKind,
  text: string,
): { rules: RuleInput[]; invalid: string[] } {
  const rules: RuleInput[] = [];
  const invalid: string[] = [];
  const parts = text
    .split(kind === 'keyword' ? /[,\n]/ : /[,;\n\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  for (const part of parts) {
    const clean = cleanRule({ kind, value: part });
    if (clean) rules.push(clean);
    else invalid.push(part);
  }
  return { rules: dedupeRules(rules), invalid };
}

export function dedupeRules(rules: readonly RuleInput[]): RuleInput[] {
  const seen = new Set<string>();
  const out: RuleInput[] = [];
  for (const r of rules) {
    const key = `${r.kind}:${r.value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

export function ruleSet(rules: readonly RuleInput[]): SpaceRuleSet {
  return {
    domains: rules.filter((r) => r.kind === 'domain').map((r) => r.value),
    emails: rules.filter((r) => r.kind === 'email').map((r) => r.value),
    keywords: rules.filter((r) => r.kind === 'keyword').map((r) => r.value),
  };
}

export function isEmptyRuleSet(set: SpaceRuleSet): boolean {
  return !set.domains.length && !set.emails.length && !set.keywords.length;
}

/**
 * The Gmail search for a Space's mail: anything from or to its domains and
 * addresses, or mentioning a keyword. Read-only: it is only ever a search.
 * Null when there is nothing to search for (a search for nothing would be
 * the whole mailbox).
 */
export function gmailQuery(set: SpaceRuleSet): string | null {
  const parts: string[] = [];
  for (const d of set.domains) parts.push(`from:${d}`, `to:${d}`);
  for (const e of set.emails) parts.push(`from:${e}`, `to:${e}`);
  for (const k of set.keywords) parts.push(k.includes(' ') ? `"${k}"` : k);
  return parts.length ? parts.join(' OR ') : null;
}

const addressOf = (raw: string | null | undefined): string | null => {
  if (!raw) return null;
  const inner = /<([^>]+)>/.exec(raw)?.[1] ?? raw;
  const v = inner.trim().toLowerCase();
  return v.includes('@') ? v : null;
};

/** Whether one address belongs: one of the Space's addresses, or at (a subdomain of) its domain. */
export function addressMatches(raw: string | null | undefined, set: SpaceRuleSet): boolean {
  const address = addressOf(raw);
  if (!address) return false;
  if (set.emails.includes(address)) return true;
  const host = address.slice(address.lastIndexOf('@') + 1);
  return set.domains.some((d) => host === d || host.endsWith(`.${d}`));
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether a text mentions one of the keywords, as a whole word or phrase, any case. */
export function textMatches(text: string | null | undefined, set: SpaceRuleSet): boolean {
  if (!text || !set.keywords.length) return false;
  return set.keywords.some((k) =>
    new RegExp(`(^|[^\\p{L}\\p{N}])${escape(k)}($|[^\\p{L}\\p{N}])`, 'iu').test(text),
  );
}

/** A mail thread belongs when anyone on it matches, or its subject or text mentions a keyword. */
export function threadMatches(
  thread: {
    subject: string | null;
    messages: readonly {
      from_address: string;
      to_addresses: readonly string[];
      cc_addresses: readonly string[];
      snippet?: string | null;
    }[];
  },
  set: SpaceRuleSet,
): boolean {
  if (textMatches(thread.subject, set)) return true;
  return thread.messages.some(
    (m) =>
      addressMatches(m.from_address, set) ||
      m.to_addresses.some((a) => addressMatches(a, set)) ||
      m.cc_addresses.some((a) => addressMatches(a, set)) ||
      textMatches(m.snippet, set),
  );
}

/** A meeting or note belongs when an attendee matches, or its title (or text) mentions a keyword. */
export function meetingMatches(
  meeting: {
    title: string;
    attendees: readonly { email: string }[];
    text?: string | null;
  },
  set: SpaceRuleSet,
): boolean {
  if (meeting.attendees.some((a) => addressMatches(a.email, set))) return true;
  return textMatches(meeting.title, set) || textMatches(meeting.text, set);
}

/** "acme-robotics.example" -> "Acme Robotics": a starting name for a suggested Space. */
export function nameFromDomain(domain: string): string {
  const label = domain.split('.')[0] ?? domain;
  return label
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** The rules a form sends, as one list, cleaned and deduped and capped. */
export function rulesFromForm(form: { domains?: string; emails?: string; keywords?: string }): {
  rules: RuleInput[];
  invalid: string[];
} {
  const parts = [
    parseRuleList('domain', form.domains ?? ''),
    parseRuleList('email', form.emails ?? ''),
    parseRuleList('keyword', form.keywords ?? ''),
  ];
  return {
    rules: dedupeRules(parts.flatMap((p) => p.rules)).slice(0, MAX_RULES),
    invalid: parts.flatMap((p) => p.invalid),
  };
}
