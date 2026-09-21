import { z } from 'zod';
import { env } from '@/lib/config/env';
import type { DataStore } from '@/lib/db/store';
import { recordAudit } from '@/lib/security/audit';
import { log } from '@/lib/security/redact';
import type { PortfolioCompany, PortfolioContact } from '@/lib/types/domain';
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
        description: z.string().trim().max(500).nullish(),
        sector: z.string().trim().max(200).nullish(),
        website: z.string().trim().max(500).nullish(),
        latest_round: z.string().trim().max(200).nullish(),
        founder: z.string().trim().max(200).nullish(),
        founder_email: z.string().trim().email().max(320).nullish(),
        /** Every founder / co-founder; `founder` above is the single-person shorthand. */
        founders: z
          .array(
            z.object({
              name: z.string().trim().min(1).max(200),
              title: z.string().trim().max(100).nullish(),
              email: z.string().trim().email().max(320).nullish(),
            }),
          )
          .max(10)
          .nullish(),
      }),
    )
    .min(1)
    .max(50),
});

export type PortfolioIngestPayload = z.infer<typeof PORTFOLIO_INGEST_SCHEMA>;

export interface PortfolioIngestResult {
  created: string[];
  existing: string[];
  /** Existing companies that had a blank stage, website or founder filled in. */
  filled: string[];
}

/**
 * Add-only, and fill-only-blanks. A company whose normalized name is already
 * in the portfolio is never replaced: the only thing a re-post can do to it is
 * fill a field that is still empty (stage, website, a founder contact when it
 * has none). A value that is already there is never overwritten, a company
 * someone archived on purpose is left completely alone, and nothing here ever
 * removes a row. So a watcher that re-posts the whole list every day changes
 * nothing after the first run.
 */
export async function ingestPortfolioCompanies(
  store: DataStore,
  organizationId: string,
  payload: PortfolioIngestPayload,
): Promise<PortfolioIngestResult> {
  const known = (await store.list('portfolio_companies', organizationId, {})) as PortfolioCompany[];
  const byName = new Map(known.map((c) => [c.normalized_name, c]));
  const result: PortfolioIngestResult = { created: [], existing: [], filled: [] };

  for (const input of payload.companies) {
    const normalized = normalizeCompanyName(input.name);
    const current = byName.get(normalized);
    if (current) {
      result.existing.push(input.name);
      if (!current.is_archived && (await fillBlanks(store, organizationId, current, input))) {
        result.filled.push(input.name);
      }
      continue;
    }

    const now = new Date().toISOString();
    const company: PortfolioCompany = {
      id: newId(),
      organization_id: organizationId,
      name: input.name,
      normalized_name: normalized,
      domain: normalizeDomain(input.website ?? null),
      website: input.website ?? null,
      current_stage: input.stage ?? null,
      latest_round: input.latest_round ?? null,
      // Only set when given, so an insert without them never names a column
      // the database might not have yet.
      ...(input.description ? { description: input.description } : {}),
      ...(input.sector ? { sector: input.sector } : {}),
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
    byName.set(normalized, company);

    for (const founder of foundersOf(input)) {
      await store.insert('portfolio_contacts', {
        id: newId(),
        organization_id: organizationId,
        portfolio_company_id: company.id,
        name: founder.name,
        role: founder.title,
        email: founder.email,
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

type IngestCompany = PortfolioIngestPayload['companies'][number];

interface FounderInput {
  name: string;
  title: string | null;
  email: string | null;
}

/** `founder` shorthand and `founders` merged into one list, without repeats. */
function foundersOf(input: IngestCompany): FounderInput[] {
  const list: FounderInput[] = [];
  if (input.founder) {
    list.push({ name: input.founder, title: null, email: input.founder_email ?? null });
  }
  for (const f of input.founders ?? []) {
    list.push({ name: f.name, title: f.title ?? null, email: f.email ?? null });
  }
  const seen = new Set<string>();
  return list.filter((f) => {
    const key = f.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fillBlanks(
  store: DataStore,
  organizationId: string,
  company: PortfolioCompany,
  input: IngestCompany,
): Promise<boolean> {
  const patch: Partial<PortfolioCompany> = {};
  if (!company.current_stage && input.stage) patch.current_stage = input.stage;
  if (!company.latest_round && input.latest_round) patch.latest_round = input.latest_round;
  if (!company.description && input.description) patch.description = input.description;
  if (!company.sector && input.sector) patch.sector = input.sector;
  if (!company.website && input.website) {
    patch.website = input.website;
    patch.domain = normalizeDomain(input.website);
  }
  let changed = false;
  if (Object.keys(patch).length > 0) {
    await store.update('portfolio_companies', organizationId, company.id, {
      ...patch,
      updated_at: new Date().toISOString(),
    });
    changed = true;
  }
  const founders = foundersOf(input);
  if (founders.length > 0) {
    const contacts = (await store.list('portfolio_contacts', organizationId, {
      eq: { portfolio_company_id: company.id },
    })) as PortfolioContact[];
    for (const founder of founders) {
      const match = contacts.find(
        (c) =>
          c.name.toLowerCase() === founder.name.toLowerCase() ||
          (founder.email && c.email?.toLowerCase() === founder.email.toLowerCase()),
      );
      if (!match) {
        await store.insert('portfolio_contacts', {
          id: newId(),
          organization_id: organizationId,
          portfolio_company_id: company.id,
          name: founder.name,
          role: founder.title,
          email: founder.email,
          is_founder: true,
          created_at: new Date().toISOString(),
        });
        changed = true;
        continue;
      }
      // A known person: only their blank role or email is filled.
      const fill: Partial<PortfolioContact> = {};
      if (!match.role && founder.title) fill.role = founder.title;
      if (!match.email && founder.email) fill.email = founder.email;
      if (Object.keys(fill).length > 0) {
        await store.update('portfolio_contacts', organizationId, match.id, fill);
        changed = true;
      }
    }
  }
  return changed;
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
    const total: PortfolioIngestResult = { created: [], existing: [], filled: [] };
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
      total.filled.push(...result.filled);
    }
    return total;
  } catch (error) {
    log.warn('Portfolio relay ingest failed', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return null;
  }
}
