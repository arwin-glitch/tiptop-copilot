import { z } from 'zod';
import type { DataStore } from '@/lib/db/store';
import { recordAudit } from '@/lib/security/audit';
import type { PortfolioCompany } from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';
import { normalizeCompanyName, normalizeDomain } from '@/lib/util/text';

/**
 * Payload for the portfolio webhook: companies that have become part of the
 * fund's portfolio, posted by a watcher (the Schedule of Investments sheet
 * check, the closed-deal mailbox routine).
 *
 * Deliberately narrow. A company is a name plus, optionally, a stage, a
 * website and a founder contact. Valuations, cost, ownership and MOIC are
 * fund-level figures that stay out of the app, so the schema has no slot for
 * them — an unknown field is stripped, not stored.
 */
export const PORTFOLIO_INGEST_SCHEMA = z.object({
  source: z.string().trim().min(1).max(100),
  companies: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(200),
        stage: z.string().trim().max(100).nullish(),
        website: z.string().trim().max(500).nullish(),
        founder: z.string().trim().max(200).nullish(),
        founder_email: z.string().trim().email().max(320).nullish(),
      }),
    )
    .min(1)
    .max(50),
});

export type PortfolioIngestPayload = z.infer<typeof PORTFOLIO_INGEST_SCHEMA>;

export interface PortfolioIngestResult {
  created: string[];
  existing: string[];
}

/**
 * Add-only. A company whose normalized name is already in the portfolio —
 * archived or not — is left exactly as it is, so a watcher that re-posts the
 * whole list every day changes nothing after the first run, and a company
 * someone archived on purpose is not resurrected. Nothing here edits or
 * removes a row.
 */
export async function ingestPortfolioCompanies(
  store: DataStore,
  organizationId: string,
  payload: PortfolioIngestPayload,
): Promise<PortfolioIngestResult> {
  const known = (await store.list('portfolio_companies', organizationId, {})) as PortfolioCompany[];
  const seen = new Set(known.map((c) => c.normalized_name));
  const result: PortfolioIngestResult = { created: [], existing: [] };

  for (const input of payload.companies) {
    const normalized = normalizeCompanyName(input.name);
    if (seen.has(normalized)) {
      result.existing.push(input.name);
      continue;
    }
    seen.add(normalized);

    const now = new Date().toISOString();
    const company: PortfolioCompany = {
      id: newId(),
      organization_id: organizationId,
      name: input.name,
      normalized_name: normalized,
      domain: normalizeDomain(input.website ?? null),
      website: input.website ?? null,
      current_stage: input.stage ?? null,
      latest_round: null,
      ownership: null,
      key_metrics: null,
      current_priorities: null,
      upcoming_fundraise: null,
      hiring_needs: null,
      gtm_needs: null,
      risks: null,
      last_contact_at: null,
      next_follow_up_at: null,
      is_archived: false,
      created_at: now,
      updated_at: now,
    };
    await store.insert('portfolio_companies', company);

    if (input.founder) {
      await store.insert('portfolio_contacts', {
        id: newId(),
        organization_id: organizationId,
        portfolio_company_id: company.id,
        name: input.founder,
        role: null,
        email: input.founder_email ?? null,
        is_founder: true,
        created_at: now,
      });
    }

    await recordAudit(store, {
      organizationId,
      userId: null,
      action: 'portfolio.created',
      entityType: 'portfolio_company',
      entityId: company.id,
      metadata: { name: company.name, source: payload.source },
    });
    result.created.push(input.name);
  }

  return result;
}
