import type { CrmField, CrmValue } from '@/lib/types/domain';
import { corporateEmailDomain, normalizeCompanyName, normalizeDomain } from '@/lib/util/text';

/**
 * Which Affinity founders belong to which portfolio company.
 *
 * Affinity's portfolio founder lists are lists of people. A person
 * belongs to a company when their work email is at its domain, or when the
 * entry's company column names it. Nothing is guessed from a name alone, and
 * a company-type entry (a list of the portfolio itself) is never a founder.
 *
 * Pure and client-safe; `lib/services/crm-pages.ts` reads the entries.
 */

export interface FounderInput {
  entryId: string;
  recordId: string | null;
  name: string;
  kind: 'company' | 'person' | null;
  emails: readonly string[];
  /** Company names the entry's company/organization columns hold. */
  companyNames: readonly string[];
  role: string | null;
}

export interface FounderMatch {
  entryId: string;
  recordId: string | null;
  name: string;
  role: string | null;
  matchedBy: 'domain' | 'name';
}

/** The company names an entry's columns give: company-typed fields, or text fields named like one. */
export function companyNamesOf(
  fields: readonly Pick<CrmField, 'key' | 'name' | 'type'>[],
  values: Record<string, CrmValue>,
): string[] {
  const out: string[] = [];
  for (const field of fields) {
    const named = /\b(company|companies|organi[sz]ations?|startups?|portcos?|business)\b/i.test(
      field.name,
    );
    if (field.type !== 'company' && !(named && (field.type === 'text' || field.type === 'multi'))) {
      continue;
    }
    const value = values[field.key];
    if (typeof value === 'string' && value.trim()) out.push(value.trim());
    else if (Array.isArray(value)) out.push(...value.filter((v) => v.trim()));
  }
  return out;
}

/** A role or job title from an entry's columns ("Role", "Title", "Position"), if any. */
export function roleOf(
  fields: readonly Pick<CrmField, 'key' | 'name' | 'type'>[],
  values: Record<string, CrmValue>,
): string | null {
  for (const field of fields) {
    if (!/\b(role|title|position|job)\b/i.test(field.name)) continue;
    const value = values[field.key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (Array.isArray(value) && value[0]?.trim()) return value[0].trim();
  }
  return null;
}

/** Founders per company id, in the order given; companies with none are absent. */
export function foundersByCompany(
  companies: readonly { id: string; name: string; domain: string | null }[],
  people: readonly FounderInput[],
): Record<string, FounderMatch[]> {
  const byDomain = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const c of companies) {
    const domain = normalizeDomain(c.domain);
    if (domain && !byDomain.has(domain)) byDomain.set(domain, c.id);
    const name = normalizeCompanyName(c.name);
    if (name && !byName.has(name)) byName.set(name, c.id);
  }
  const out: Record<string, FounderMatch[]> = {};
  for (const person of people) {
    if (person.kind === 'company') continue;
    const seen = new Set<string>();
    const add = (companyId: string, matchedBy: FounderMatch['matchedBy']) => {
      if (seen.has(companyId)) return;
      seen.add(companyId);
      const list = (out[companyId] ??= []);
      if (list.some((f) => (f.recordId ?? f.entryId) === (person.recordId ?? person.entryId))) {
        return;
      }
      list.push({
        entryId: person.entryId,
        recordId: person.recordId,
        name: person.name,
        role: person.role,
        matchedBy,
      });
    };
    for (const email of person.emails) {
      const domain = corporateEmailDomain(email);
      const id = domain ? byDomain.get(domain) : undefined;
      if (id) add(id, 'domain');
    }
    for (const companyName of person.companyNames) {
      const id = byName.get(normalizeCompanyName(companyName));
      if (id) add(id, 'name');
    }
  }
  return out;
}
