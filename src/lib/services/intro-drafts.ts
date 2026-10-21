import 'server-only';
import { crmNameKey } from '@/lib/crm/fields';
import type { IntroParty } from '@/lib/crm/affinity-introductions';
import { isMissingTableError } from '@/lib/db/missing-table';
import { chunk } from '@/lib/db/paging';
import type { DataStore } from '@/lib/db/store';
import { toLinkedInUrl } from '@/lib/email/name-links';
import {
  buildIntroDraft,
  cleanEmail,
  introKey,
  looksLikeCompany,
  parseIntroSide,
  type IntroDraft,
  type IntroPerson,
  type IntroSide,
} from '@/lib/intros/intro-draft';
import { companyDomain } from '@/lib/portfolio/contacts';
import { log } from '@/lib/security/redact';
import type { AuditEvent, CrmRecord, PortfolioCompany, PortfolioContact } from '@/lib/types/domain';
import { portfolioCrmPeople } from './crm-pages';
import type { IntroItem } from './follow-ups';
import { INTRODUCTION_ACTION } from './introductions';

/**
 * The people behind each owed intro, for "Write the intro" (the email itself
 * is `lib/intros/intro-draft.ts`). Read-only, and nothing is guessed: an
 * address or LinkedIn comes only from verified data, in this order —
 *
 *  1. the intro tracker's own row, when it names each side's people;
 *  2. a Copilot CRM person record with exactly that name (a name two records
 *     share matches neither);
 *  3. a portfolio company's saved contacts, and the founders the imported
 *     founder lists tie to it, when a side is a portfolio company;
 *  4. imported introductions, for a person the introduction places at that firm.
 *
 * A person none of these knows keeps their name and no address; the compose
 * window says so. A side that is only a firm ("Northwind Capital") stays a
 * firm: Copilot never picks someone there.
 *
 * Never fails: a source that cannot be read (the CRM not set up yet, a
 * fault) is left out and logged, and the intro still gets its draft.
 */

/** Records looked up by name in one query. */
const NAME_BATCH = 100;

interface Knowledge {
  /** CRM person records by name key, only names exactly one record has. */
  people: Map<string, CrmRecord>;
  /** CRM company records by name key, likewise. */
  companies: Map<string, CrmRecord>;
  /** Portfolio companies by name key, likewise. */
  portfolio: Map<string, PortfolioCompany>;
  /** Saved portfolio contacts by name key, likewise. */
  contacts: Map<string, PortfolioContact>;
  /** Founders per portfolio company id: saved ones, then the imported founder lists. */
  founders: Map<string, IntroPerson[]>;
  /** Imported introductions: `orgKey|nameKey` -> the one address seen for them. */
  introEmails: Map<string, string>;
}

type PersonInput = { name: string; email?: string | null; linkedin?: string | null };

interface SideInput {
  label: string;
  who: string;
  names: string[];
  org: string | null;
  /** The tracker's own people for this side, when it gave them. */
  given: PersonInput[] | null;
}

function sideInput(
  label: string,
  org: string | null | undefined,
  people: PersonInput[] | null | undefined,
): SideInput {
  const parsed = parseIntroSide(label);
  const given = people?.length ? people : null;
  return {
    label,
    who: parsed.who,
    names: given ? given.map((p) => p.name) : parsed.names,
    org: org?.trim() || parsed.org,
    given,
  };
}

/** One per key, dropping every key more than one row has. */
function uniqueBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T> {
  const out = new Map<string, T>();
  const twice = new Set<string>();
  for (const row of rows) {
    const k = key(row);
    if (!k) continue;
    if (out.has(k)) twice.add(k);
    else out.set(k, row);
  }
  for (const k of twice) out.delete(k);
  return out;
}

/** A read that degrades to nothing: logged unless the table simply is not there yet. */
async function quietly<T>(what: string, fallback: T, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!isMissingTableError(error)) {
      log.warn('Intro draft lookup failed', {
        what,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    return fallback;
  }
}

async function recordsByName(
  store: DataStore,
  organizationId: string,
  keys: readonly string[],
): Promise<CrmRecord[]> {
  const unique = [...new Set(keys.filter(Boolean))];
  if (unique.length === 0) return [];
  return quietly('crm records', [] as CrmRecord[], async () => {
    const rows: CrmRecord[] = [];
    for (const group of chunk(unique, NAME_BATCH)) {
      rows.push(
        ...((await store.list('crm_records', organizationId, {
          in: { name_key: group },
        })) as CrmRecord[]),
      );
    }
    return rows;
  });
}

/** A record's LinkedIn profile, from an imported column named for it. */
export function linkedInOf(record: Pick<CrmRecord, 'fields'>): string | null {
  for (const [label, value] of Object.entries(record.fields ?? {})) {
    if (!/linked\s*-?in/i.test(label)) continue;
    for (const v of Array.isArray(value) ? value : [value]) {
      const url = typeof v === 'string' ? toLinkedInUrl(v) : null;
      if (url) return url;
    }
  }
  return null;
}

const recordEmail = (r: CrmRecord) => cleanEmail(r.primary_email) ?? cleanEmail(r.emails[0]);

/** The imported introductions naming any of these firms: who was there, and their address. */
async function introductionEmails(
  store: DataStore,
  organizationId: string,
  orgs: readonly { key: string; domain: string | null }[],
): Promise<Map<string, string>> {
  const entityKeys = new Map<string, string>();
  for (const org of orgs) {
    entityKeys.set(`company:${org.key}`, org.key);
    if (org.domain) entityKeys.set(`domain:${org.domain}`, org.key);
  }
  if (entityKeys.size === 0) return new Map();
  const rows = await quietly('imported introductions', [] as AuditEvent[], async () => {
    const out: AuditEvent[] = [];
    for (const group of chunk([...entityKeys.keys()], NAME_BATCH)) {
      out.push(
        ...((await store.list(
          'audit_events',
          organizationId,
          { eq: { action: INTRODUCTION_ACTION }, in: { entity_id: group } },
          { limit: 500 },
        )) as AuditEvent[]),
      );
    }
    return out;
  });
  const seen = new Map<string, Set<string>>();
  for (const row of rows) {
    const orgKey = entityKeys.get(String(row.entity_id ?? ''));
    if (!orgKey) continue;
    const meta = (row.metadata ?? {}) as { introducer?: IntroParty; introduced?: IntroParty[] };
    const parties = [meta.introducer, ...(Array.isArray(meta.introduced) ? meta.introduced : [])];
    for (const p of parties) {
      if (!p || p.kind !== 'person' || !p.name) continue;
      const email = cleanEmail(p.email);
      if (!email) continue;
      // Only someone the introduction itself places at this firm.
      const at = p.organization;
      const domain = orgs.find((o) => o.key === orgKey)?.domain ?? null;
      const there =
        (at?.name && crmNameKey(at.name) === orgKey) ||
        (domain && (at?.domain === domain || email.endsWith(`@${domain}`)));
      if (!there) continue;
      const k = `${orgKey}|${crmNameKey(p.name)}`;
      const set = seen.get(k) ?? new Set<string>();
      set.add(email);
      seen.set(k, set);
    }
  }
  const out = new Map<string, string>();
  for (const [k, emails] of seen) if (emails.size === 1) out.set(k, [...emails][0]!);
  return out;
}

async function readKnowledge(
  store: DataStore,
  organizationId: string,
  sides: readonly SideInput[],
): Promise<Knowledge> {
  const [companies, contacts] = await Promise.all([
    quietly(
      'portfolio companies',
      [] as PortfolioCompany[],
      () => store.list('portfolio_companies', organizationId, {}) as Promise<PortfolioCompany[]>,
    ),
    quietly(
      'portfolio contacts',
      [] as PortfolioContact[],
      () => store.list('portfolio_contacts', organizationId, {}) as Promise<PortfolioContact[]>,
    ),
  ]);
  const portfolio = uniqueBy(companies, (c) => crmNameKey(c.name));

  const sideKeys = sides.flatMap((s) => [
    crmNameKey(s.who),
    ...s.names.map(crmNameKey),
    ...(s.org ? [crmNameKey(s.org)] : []),
  ]);
  const firstPass = await recordsByName(store, organizationId, sideKeys);

  // Founders of the portfolio companies a side names: saved contacts first,
  // then the people the imported founder lists tie to the company.
  const named = new Map<string, PortfolioCompany>();
  for (const key of sideKeys) {
    const company = portfolio.get(key);
    if (company) named.set(company.id, company);
  }
  const fromLists = await portfolioCrmPeople(
    store,
    organizationId,
    [...named.values()].map((c) => ({ id: c.id, name: c.name, domain: companyDomain(c) })),
  );
  const founders = new Map<string, IntroPerson[]>();
  for (const company of named.values()) {
    const list: IntroPerson[] = [];
    const add = (name: string, email: string | null) => {
      const key = crmNameKey(name);
      const clean = cleanEmail(email);
      const same = list.find(
        (p) => crmNameKey(p.name) === key || (clean && cleanEmail(p.email) === clean),
      );
      if (same) {
        same.email ??= clean;
        return;
      }
      list.push({ name: name.trim(), email: clean, linkedin: null, founder: true });
    };
    for (const c of contacts) {
      if (c.portfolio_company_id === company.id && c.is_founder) add(c.name, c.email);
    }
    for (const p of fromLists[company.id] ?? []) if (p.founder) add(p.name, p.email);
    if (list.length) founders.set(company.id, list);
  }

  // Founders found above are looked up too, for their LinkedIn.
  const seenKeys = new Set(sideKeys);
  const moreKeys = [...founders.values()]
    .flat()
    .map((p) => crmNameKey(p.name))
    .filter((k) => !seenKeys.has(k));
  const records = [...firstPass, ...(await recordsByName(store, organizationId, moreKeys))];
  const people = uniqueBy(
    records.filter((r) => r.kind === 'person'),
    (r) => r.name_key,
  );
  const crmCompanies = uniqueBy(
    records.filter((r) => r.kind === 'company'),
    (r) => r.name_key,
  );

  const orgs = new Map<string, string | null>();
  for (const s of sides) {
    if (!s.org) continue;
    const key = crmNameKey(s.org);
    orgs.set(
      key,
      crmCompanies.get(key)?.domain ??
        (portfolio.get(key) ? companyDomain(portfolio.get(key)!) : null),
    );
  }
  const introEmails = await introductionEmails(
    store,
    organizationId,
    [...orgs.entries()].map(([key, domain]) => ({ key, domain })),
  );

  return {
    people,
    companies: crmCompanies,
    portfolio,
    contacts: uniqueBy(contacts, (c) => crmNameKey(c.name)),
    founders,
    introEmails,
  };
}

function resolvePerson(
  input: PersonInput,
  org: string | null,
  k: Knowledge,
): { person: IntroPerson; companyName: string | null } {
  const key = crmNameKey(input.name);
  const record = k.people.get(key);
  const contact = k.contacts.get(key);
  const fromIntro = org ? k.introEmails.get(`${crmNameKey(org)}|${key}`) : undefined;
  const companyOfContact = contact
    ? ([...k.portfolio.values()].find((c) => c.id === contact.portfolio_company_id)?.name ?? null)
    : null;
  // A founder of this side's company, not of some other one with the same name about.
  const sameCompany =
    !org || (companyOfContact !== null && crmNameKey(companyOfContact) === crmNameKey(org));
  return {
    person: {
      name: input.name.trim(),
      email:
        cleanEmail(input.email) ??
        (record ? recordEmail(record) : null) ??
        cleanEmail(contact?.email) ??
        cleanEmail(fromIntro),
      linkedin: toLinkedInUrl(input.linkedin) ?? (record ? linkedInOf(record) : null),
      founder: Boolean(contact?.is_founder) && sameCompany,
    },
    companyName: companyOfContact,
  };
}

/** One side of an intro, with everything verified data knows about its people. */
function resolveSide(input: SideInput, k: Knowledge): IntroSide {
  let { org } = input;
  let people: PersonInput[] = input.given ?? input.names.map((name) => ({ name }));

  // "Harbor Labs" on its own: a company, not a person called that. A record
  // decides when there is one; otherwise how the name reads.
  if (!input.given && !org && input.who) {
    const whoKey = crmNameKey(input.who);
    const company = k.portfolio.get(whoKey) ?? k.companies.get(whoKey);
    const person = k.people.has(whoKey) || k.contacts.has(whoKey);
    if (company && !person) {
      org = company.name;
      people = [];
    } else if (!company && !person && looksLikeCompany(input.who)) {
      org = input.who;
      people = [];
    }
  }

  const portfolioCompany = org ? k.portfolio.get(crmNameKey(org)) : undefined;
  if (people.length === 0 && portfolioCompany) {
    people = (k.founders.get(portfolioCompany.id) ?? []).map((p) => ({
      name: p.name,
      email: p.email,
    }));
  }

  const founderNames = new Set(
    portfolioCompany
      ? (k.founders.get(portfolioCompany.id) ?? []).map((p) => crmNameKey(p.name))
      : [],
  );
  const resolved = people.map((p) => resolvePerson(p, org, k));
  if (!org) {
    // A person known only by name may be a saved portfolio contact: their company.
    const companies = new Set(resolved.map((r) => r.companyName));
    if (companies.size === 1 && !companies.has(null)) org = [...companies][0]!;
  }
  return {
    label: input.label,
    org,
    people: resolved.map(({ person }) => ({
      ...person,
      founder: person.founder || founderNames.has(crmNameKey(person.name)),
    })),
  };
}

/**
 * A ready draft for each owed intro, keyed by `introKey`. Intros that are not
 * owed get none. Never throws.
 */
export async function introDrafts(
  store: DataStore,
  organizationId: string,
  intros: readonly IntroItem[],
): Promise<Record<string, IntroDraft>> {
  const owed = intros.filter((i) => i.status === 'owed');
  if (owed.length === 0) return {};
  const inputs = owed.map((i) => ({
    intro: i,
    target: sideInput(i.to_who, i.to_org, i.to_people),
    founders: sideInput(i.for_who, i.for_org, i.for_people),
  }));
  let knowledge: Knowledge;
  try {
    knowledge = await readKnowledge(
      store,
      organizationId,
      inputs.flatMap((x) => [x.target, x.founders]),
    );
  } catch (error) {
    log.warn('Intro drafts fell back to names only', {
      reason: error instanceof Error ? error.message : String(error),
    });
    knowledge = {
      people: new Map(),
      companies: new Map(),
      portfolio: new Map(),
      contacts: new Map(),
      founders: new Map(),
      introEmails: new Map(),
    };
  }
  const out: Record<string, IntroDraft> = {};
  for (const x of inputs) {
    out[introKey(x.intro)] = buildIntroDraft(
      resolveSide(x.target, knowledge),
      resolveSide(x.founders, knowledge),
    );
  }
  return out;
}
