import { z } from 'zod';
import { env } from '@/lib/config/env';
import type { DataStore } from '@/lib/db/store';
import { recordAudit } from '@/lib/security/audit';
import { log } from '@/lib/security/redact';
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

/* ---------------------------------------------------------- Slack relay */

const RELAY_MARKER = 'PORTFOLIO_ADD_V1';

/**
 * One relay-channel message -> a validated payload, or null.
 *
 * The convention matches the other relay messages: a marker line, then the
 * JSON body wrapped in backticks so Slack never auto-links anything inside it.
 * Anything else in the channel (Ask questions and answers, briefing payloads,
 * chatter) is skipped rather than guessed at.
 */
export function parsePortfolioRelayMessage(text: unknown): PortfolioIngestPayload | null {
  if (typeof text !== 'string') return null;
  const clean = text.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').trim();
  if (!clean.startsWith(RELAY_MARKER)) return null;
  const match = /`([^`]+)`/.exec(clean);
  if (!match?.[1]) return null;
  let json: unknown;
  try {
    json = JSON.parse(match[1]);
  } catch {
    return null;
  }
  const parsed = PORTFOLIO_INGEST_SCHEMA.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/**
 * The cloud routines' sandboxes cannot reach this app, so a routine that
 * spots a new portfolio company posts a PORTFOLIO_ADD_V1 message to the relay
 * channel instead, and the daily job reads it here. Stateless: ingest is
 * add-only, so the last 100 messages are simply re-read each pass and anything
 * already listed is a no-op.
 */
export async function ingestPortfolioFromSlack(
  store: DataStore,
  organizationId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PortfolioIngestResult | null> {
  const e = env();
  if (!e.askRelaySlackToken) return null;
  try {
    const url = `https://slack.com/api/conversations.history?channel=${encodeURIComponent(
      e.askRelayChannelId,
    )}&limit=100`;
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${e.askRelaySlackToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json()) as {
      ok?: boolean;
      error?: string;
      messages?: Array<{ text?: unknown }>;
    };
    if (!body.ok) {
      log.warn('Slack relay channel could not be read for portfolio additions', {
        error: body.error ?? 'unknown',
      });
      return null;
    }
    const total: PortfolioIngestResult = { created: [], existing: [] };
    // Oldest first, so a company posted twice keeps its first source.
    for (const message of [...(body.messages ?? [])].reverse()) {
      const payload = parsePortfolioRelayMessage(message.text);
      if (!payload) continue;
      const result = await ingestPortfolioCompanies(store, organizationId, {
        ...payload,
        source: `slack-relay:${payload.source}`,
      });
      total.created.push(...result.created);
      total.existing.push(...result.existing);
    }
    return total;
  } catch (error) {
    log.warn('Portfolio relay ingest failed', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return null;
  }
}
