import 'server-only';
import type { DataStore } from '@/lib/db/store';
import { evidenceFor, type RelationshipIndex } from '@/lib/network/evidence';
import {
  companyDomain,
  companyLastContact,
  mailContactsAtDomain,
  mergeCompanyContacts,
  type CompanyContact,
  type MailContactInput,
} from '@/lib/portfolio/contacts';
import { log } from '@/lib/security/redact';
import type { PortfolioCompany, PortfolioContact } from '@/lib/types/domain';
import { portfolioCrmPeople } from './crm-pages';
import { getRelationshipIndex } from './relationships';
import { isPersonalDomain, TIPTOP_DOMAINS } from './warm-paths';

/**
 * Each portfolio company's people and when the fund was last in touch,
 * derived when a page is read (`lib/portfolio/contacts.ts` has the rules):
 * the contacts saved on the company, the people Affinity ties to it, and the
 * people at its domain who write to Nick, from the synced mailbox. Nothing is
 * written: a hand-entered contact stays exactly as it was typed, and the
 * derived ones follow the data as it changes.
 *
 * Never fails. Each source that cannot be read is left out (logged), so the
 * Companies tab renders with whatever the others give.
 */

export interface CompanyPeople {
  /** Strongest and most recent first; the caller caps it (3 on a card). */
  contacts: CompanyContact[];
  /** The newest of the stored date and the mail; null when there is none. */
  lastContactAt: string | null;
}

/** TipTop's domains and the domains of the fund's own addresses (personal mail aside). */
function ownDomainsOf(index: RelationshipIndex | null): string[] {
  const out = new Set<string>(TIPTOP_DOMAINS);
  for (const address of index?.own ?? []) {
    const host = address.slice(address.lastIndexOf('@') + 1);
    if (host && !isPersonalDomain(host)) out.add(host);
  }
  return [...out];
}

export async function loadPortfolioContacts(
  store: DataStore,
  organizationId: string,
  companies: readonly PortfolioCompany[],
  options: { now?: Date } = {},
): Promise<Record<string, CompanyPeople>> {
  if (companies.length === 0) return {};
  const now = options.now ?? new Date();
  const [recorded, crm, indexed] = await Promise.all([
    (store.list('portfolio_contacts', organizationId, {}) as Promise<PortfolioContact[]>).catch(
      (error: unknown) => {
        log.warn('Portfolio contacts could not be read', {
          reason: error instanceof Error ? error.message : String(error),
        });
        return [] as PortfolioContact[];
      },
    ),
    portfolioCrmPeople(
      store,
      organizationId,
      companies.map((c) => ({ id: c.id, name: c.name, domain: companyDomain(c) })),
    ),
    getRelationshipIndex(store, organizationId, { ownAddresses: [], now }).catch(() => null),
  ]);
  const index = indexed?.ok ? indexed.value : null;
  const ownDomains = ownDomainsOf(index);

  const out: Record<string, CompanyPeople> = {};
  for (const company of companies) {
    const domain = companyDomain(company);
    const saved = recorded.filter((c) => c.portfolio_company_id === company.id);
    const affinity = crm[company.id] ?? [];
    const mail: MailContactInput[] = index
      ? mailContactsAtDomain(index, domain, now, ownDomains)
      : [];
    // Someone saved or in Affinity with an address elsewhere (a personal one)
    // still has their own mail counted.
    if (index) {
      const seen = new Set(mail.map((m) => m.email));
      for (const email of [...saved.map((c) => c.email), ...affinity.map((p) => p.email)]) {
        const address = email?.trim().toLowerCase();
        if (!address?.includes('@') || seen.has(address) || index.own.has(address)) continue;
        seen.add(address);
        const { evidence } = evidenceFor(index, [address], now);
        if (!evidence.lastContactAt) continue;
        mail.push({
          email: address,
          name: null,
          emailsFromThem: evidence.emailsIn,
          lastContactAt: evidence.lastContactAt,
        });
      }
    }
    const contacts = mergeCompanyContacts(
      {
        recorded: saved.map((c) => ({
          name: c.name,
          role: c.role,
          email: c.email,
          isFounder: c.is_founder,
        })),
        affinity,
        mail,
      },
      now,
    );
    out[company.id] = {
      contacts,
      lastContactAt: companyLastContact(
        index,
        {
          stored: company.last_contact_at,
          domain,
          emails: contacts.map((c) => c.email),
          ownDomains,
        },
        now,
      ),
    };
  }
  return out;
}
