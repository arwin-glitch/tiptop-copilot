import 'server-only';
import { PROMPTS } from '@/lib/ai/prompts';
import { portfolioUpdateSchema } from '@/lib/ai/schemas';
import { CitationRegistry } from '@/lib/ai/citations';
import type { AuthContext } from '@/lib/auth/session';
import { getAI, getStore } from '@/lib/runtime';
import { recordAudit } from '@/lib/security/audit';
import {
  fenceUntrusted,
  UNTRUSTED_CONTENT_RULE,
  type UntrustedBlock,
} from '@/lib/security/injection';
import { checkAiBudget, recordAiUsage } from '@/lib/security/limits';
import type {
  EmailMessage,
  NetworkContact,
  PortfolioCompany,
  PortfolioContact,
  PortfolioUpdate,
  Task,
} from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';
import { normalizeCompanyName, normalizeDomain, truncate } from '@/lib/util/text';
import { err, ok, type Result } from '@/lib/util/result';

/**
 * Portfolio support.
 *
 * The rule that shapes this module: a suggested introduction may only name
 * someone who exists in the uploaded network data. The model is given the
 * candidate list and its output ids are checked against it — so the product
 * cannot imply Nick knows someone he does not.
 */

export async function listPortfolio(
  organizationId: string,
  includeArchived = false,
): Promise<PortfolioCompany[]> {
  const store = getStore();
  return (await store.list(
    'portfolio_companies',
    organizationId,
    includeArchived ? {} : { eq: { is_archived: false } },
    { orderBy: [{ field: 'name', direction: 'asc' }] },
  )) as PortfolioCompany[];
}

export interface PortfolioDetail {
  company: PortfolioCompany;
  contacts: PortfolioContact[];
  updates: PortfolioUpdate[];
  tasks: Task[];
  emails: EmailMessage[];
}

export async function getPortfolioDetail(
  organizationId: string,
  companyId: string,
): Promise<PortfolioDetail | null> {
  const store = getStore();
  const company = (await store.get(
    'portfolio_companies',
    organizationId,
    companyId,
  )) as PortfolioCompany | null;
  if (!company) return null;

  const [contacts, updates, tasks, emails] = await Promise.all([
    store.list('portfolio_contacts', organizationId, {
      eq: { portfolio_company_id: companyId },
    }) as Promise<PortfolioContact[]>,
    store.list(
      'portfolio_updates',
      organizationId,
      { eq: { portfolio_company_id: companyId } },
      { orderBy: [{ field: 'occurred_at', direction: 'desc' }] },
    ) as Promise<PortfolioUpdate[]>,
    store.list(
      'tasks',
      organizationId,
      { eq: { portfolio_company_id: companyId } },
      { orderBy: [{ field: 'due_at', direction: 'asc' }] },
    ) as Promise<Task[]>,
    store.list(
      'email_messages',
      organizationId,
      { eq: { linked_portfolio_company_id: companyId } },
      { orderBy: [{ field: 'sent_at', direction: 'desc' }], limit: 20 },
    ) as Promise<EmailMessage[]>,
  ]);

  return { company, contacts, updates, tasks, emails };
}

export interface CreatePortfolioInput {
  name: string;
  website?: string | null;
  currentStage?: string | null;
  latestRound?: string | null;
  ownership?: string | null;
  keyMetrics?: string | null;
  currentPriorities?: string | null;
  contacts?: { name: string; role?: string | null; email?: string | null; isFounder?: boolean }[];
}

export async function createPortfolioCompany(
  auth: AuthContext,
  input: CreatePortfolioInput,
): Promise<Result<PortfolioCompany>> {
  if (!input.name.trim()) return err('invalid_input', 'A portfolio company needs a name.');
  const store = getStore();
  const now = new Date().toISOString();

  const company: PortfolioCompany = {
    id: newId(),
    organization_id: auth.organizationId,
    name: input.name.trim(),
    normalized_name: normalizeCompanyName(input.name),
    domain: normalizeDomain(input.website ?? null),
    website: input.website ?? null,
    current_stage: input.currentStage ?? null,
    latest_round: input.latestRound ?? null,
    ownership: input.ownership ?? null,
    key_metrics: input.keyMetrics ?? null,
    current_priorities: input.currentPriorities ?? null,
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

  for (const contact of input.contacts ?? []) {
    if (!contact.name.trim()) continue;
    await store.insert('portfolio_contacts', {
      id: newId(),
      organization_id: auth.organizationId,
      portfolio_company_id: company.id,
      name: contact.name.trim(),
      role: contact.role ?? null,
      email: contact.email ?? null,
      is_founder: contact.isFounder ?? false,
      created_at: now,
    });
  }

  await recordAudit(store, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    action: 'portfolio.created',
    entityType: 'portfolio_company',
    entityId: company.id,
    metadata: { name: company.name },
  });

  return ok(company);
}

/* ------------------------------------------------------------- CSV import */

export interface ImportResult {
  created: number;
  skipped: number;
  errors: string[];
}

/**
 * CSV import. Header-driven rather than positional so a column order change in
 * the source spreadsheet does not silently shift every value one field left.
 */
export async function importPortfolioCsv(
  auth: AuthContext,
  csvText: string,
): Promise<Result<ImportResult>> {
  const Papa = (await import('papaparse')).default;
  const parsed = Papa.parse<Record<string, string>>(csvText.trim(), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toLowerCase().replace(/\s+/g, '_'),
  });

  if (parsed.errors.length > 0 && parsed.data.length === 0) {
    return err('invalid_input', `Could not parse the CSV: ${parsed.errors[0]?.message}`);
  }

  const store = getStore();
  const existing = await listPortfolio(auth.organizationId, true);
  const result: ImportResult = { created: 0, skipped: 0, errors: [] };

  for (const [index, row] of parsed.data.entries()) {
    const name = (row.name ?? row.company ?? row.company_name ?? '').trim();
    if (!name) {
      result.errors.push(`Row ${index + 2}: no company name column found.`);
      continue;
    }
    const normalized = normalizeCompanyName(name);
    if (existing.some((c) => c.normalized_name === normalized)) {
      result.skipped++;
      continue;
    }

    const created = await createPortfolioCompany(auth, {
      name,
      website: row.website ?? row.url ?? null,
      currentStage: row.stage ?? row.current_stage ?? null,
      latestRound: row.latest_round ?? row.round ?? null,
      ownership: row.ownership ?? null,
      keyMetrics: row.metrics ?? row.key_metrics ?? null,
      currentPriorities: row.priorities ?? row.current_priorities ?? null,
      contacts:
        row.founder || row.contact
          ? [
              {
                name: (row.founder ?? row.contact ?? '').trim(),
                email: row.email ?? null,
                isFounder: Boolean(row.founder),
              },
            ]
          : [],
    });
    if (created.ok) result.created++;
    else result.errors.push(`Row ${index + 2}: ${created.error.message}`);
  }

  await recordAudit(store, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    action: 'portfolio.imported',
    entityType: 'portfolio_company',
    entityId: null,
    metadata: { created: result.created, skipped: result.skipped, errors: result.errors.length },
  });

  return ok(result);
}

/* ------------------------------------------------------ update classification */

export async function classifyPortfolioEmail(
  auth: AuthContext,
  messageId: string,
): Promise<Result<PortfolioUpdate>> {
  const store = getStore();
  const message = (await store.get(
    'email_messages',
    auth.organizationId,
    messageId,
  )) as EmailMessage | null;
  if (!message) return err('not_found', 'That email does not exist.');

  const companies = await listPortfolio(auth.organizationId);
  const senderDomain = normalizeDomain(message.from_address.split('@')[1] ?? null);
  const company =
    (message.linked_portfolio_company_id
      ? companies.find((c) => c.id === message.linked_portfolio_company_id)
      : undefined) ?? companies.find((c) => c.domain && c.domain === senderDomain);

  if (!company) {
    return err(
      'not_found',
      'This message is not from a known portfolio company. Link it to one first.',
    );
  }

  const budget = await checkAiBudget(store, auth.organizationId, auth.userId);
  if (!budget.ok) return budget;

  const networkContacts = (await store.list(
    'network_contacts',
    auth.organizationId,
    {},
    { limit: 200 },
  )) as NetworkContact[];

  const registry = new CitationRegistry();
  const citationId = `email:${message.id}`;
  registry.add({
    id: citationId,
    kind: 'email',
    ref_id: message.id,
    label: message.subject ?? '(no subject)',
    page: null,
    section: null,
    url: null,
    occurred_at: message.sent_at,
    retrieved_at: message.body_fetched_at,
    publisher: message.from_address,
    excerpt: truncate(message.body_text ?? message.snippet, 240),
  });

  const blocks: UntrustedBlock[] = [
    {
      sourceId: citationId,
      sourceKind: 'email',
      label: `Update from ${company.name}`,
      text: truncate(message.body_text ?? message.snippet, 16_000),
      occurredAt: message.sent_at,
    },
  ];

  const context = {
    company: { id: company.id, name: company.name, current_priorities: company.current_priorities },
    network_contacts: networkContacts.map((c) => ({
      id: c.id,
      full_name: c.full_name,
      company: c.company,
      title: c.title,
      relationship: c.relationship,
      expertise: c.expertise,
    })),
    available_source_ids: registry.ids(),
  };

  const ai = getAI();
  const response = await ai.generateStructured({
    tier: 'fast',
    operation: 'portfolio.classify',
    promptVersion: PROMPTS.portfolioUpdate.version,
    system: PROMPTS.portfolioUpdate.system,
    messages: [
      {
        role: 'user',
        content: `<context>${JSON.stringify(context)}</context>

${UNTRUSTED_CONTENT_RULE}

<sources>
${fenceUntrusted(blocks)}
</sources>

Classify this portfolio update. Only suggest network contact ids that appear in context.network_contacts.`,
      },
    ],
    schema: portfolioUpdateSchema,
    maxTokens: 4_000,
  });

  await recordAiUsage(store, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    operation: 'portfolio.classify',
    promptVersion: PROMPTS.portfolioUpdate.version,
    usage: response.ok ? response.value.usage : null,
    ok: response.ok,
    errorCode: response.ok ? null : response.error.code,
  });

  if (!response.ok) return response;
  const output = response.value.value;

  // Hard gate: only ids that exist in the org's own network data survive.
  const knownIds = new Set(networkContacts.map((c) => c.id));
  const suggestedContacts = output.suggested_network_contact_ids.filter((id) => knownIds.has(id));
  const inventedContacts = output.suggested_network_contact_ids.length - suggestedContacts.length;
  if (inventedContacts > 0) {
    await recordAudit(store, {
      organizationId: auth.organizationId,
      userId: auth.userId,
      action: 'security.citation_rejected',
      entityType: 'portfolio_update',
      entityId: null,
      metadata: { invented_contact_ids: inventedContacts, operation: 'portfolio.classify' },
    });
  }

  const { citations } = registry.resolve(output.citations);

  const now = new Date().toISOString();
  const update: PortfolioUpdate = {
    id: newId(),
    organization_id: auth.organizationId,
    portfolio_company_id: company.id,
    email_message_id: message.id,
    summary: output.summary,
    request_type: output.request_type,
    request_detail: output.request_detail,
    urgency: output.urgency,
    suggested_action:
      suggestedContacts.length === 0 && output.suggested_action?.includes('Introduce')
        ? 'No one in the uploaded network data matches this request. Import more contacts or handle it directly.'
        : output.suggested_action,
    suggested_network_contact_ids: suggestedContacts,
    status: 'open',
    occurred_at: message.sent_at,
    citations,
    model: response.value.usage.model,
    prompt_version: PROMPTS.portfolioUpdate.version,
    created_at: now,
    updated_at: now,
  };
  await store.insert('portfolio_updates', update);

  await store.update('portfolio_companies', auth.organizationId, company.id, {
    last_contact_at: message.sent_at,
  });
  await store.update('email_messages', auth.organizationId, message.id, {
    linked_portfolio_company_id: company.id,
  });

  return ok(update);
}

export async function setUpdateStatus(
  auth: AuthContext,
  updateId: string,
  status: PortfolioUpdate['status'],
): Promise<Result<PortfolioUpdate>> {
  const store = getStore();
  const update = await store.get('portfolio_updates', auth.organizationId, updateId);
  if (!update) return err('not_found', 'That portfolio update does not exist.');
  const updated = (await store.update('portfolio_updates', auth.organizationId, updateId, {
    status,
  })) as PortfolioUpdate;
  await recordAudit(store, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    action: 'portfolio.request_handled',
    entityType: 'portfolio_update',
    entityId: updateId,
    metadata: { status },
  });
  return ok(updated);
}

export async function openRequests(organizationId: string): Promise<PortfolioUpdate[]> {
  const store = getStore();
  return (await store.list(
    'portfolio_updates',
    organizationId,
    { eq: { status: 'open' }, notNull: ['request_type'] },
    { orderBy: [{ field: 'occurred_at', direction: 'desc' }] },
  )) as PortfolioUpdate[];
}
