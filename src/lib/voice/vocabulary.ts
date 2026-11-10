import { appGuideIndex } from '@/lib/help/app-guide';
import type { DataStore } from '@/lib/db/store';
import type { Deal, NetworkContact, PortfolioCompany } from '@/lib/types/domain';

/**
 * The words Voice Arwin should hear right: Kraken's own pages and tabs, then
 * portfolio companies, open deals, and the team's network contacts and their
 * companies. In that order, so the most useful ones survive any cap. Names
 * only, the caller's organization only.
 */
export async function voiceTerms(store: DataStore, org: string): Promise<string[]> {
  const [portfolio, deals, contacts] = await Promise.all([
    (store.list('portfolio_companies', org, {}) as Promise<PortfolioCompany[]>).catch(() => []),
    (store.list('deals', org, { eq: { is_archived: false } }) as Promise<Deal[]>).catch(() => []),
    (store.list('network_contacts', org, {}) as Promise<NetworkContact[]>).catch(() => []),
  ]);
  const terms = new Set<string>(['Kraken', 'Arwin']);
  for (const e of appGuideIndex()) {
    terms.add(e.pageName);
    if (e.tabLabel) terms.add(e.tabLabel);
  }
  for (const p of portfolio) if (p.name?.trim()) terms.add(p.name.trim());
  for (const d of deals) if (d.company_name?.trim()) terms.add(d.company_name.trim());
  for (const c of contacts) {
    if (c.full_name?.trim()) terms.add(c.full_name.trim());
    if (c.company?.trim()) terms.add(c.company.trim());
  }
  return [...terms];
}

/**
 * Terms ElevenLabs accepts as key terms: at most 1000, each at most 50
 * characters and 5 words, without < > { } [ ] or backslash.
 */
export function keyterms(terms: readonly string[], max = 1000): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of terms) {
    const t = raw
      .replace(/[<>{}[\]\\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (t.length < 2 || t.length > 50 || t.split(' ').length > 5) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}
