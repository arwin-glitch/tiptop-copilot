import 'server-only';
import { getAI, getStore } from '@/lib/runtime';
import { PROMPTS } from '@/lib/ai/prompts';
import {
  dealComparisonSchema,
  dealExtractionSchema,
  DEAL_EXTRACTION_FIELDS,
} from '@/lib/ai/schemas';
import type { AuthContext } from '@/lib/auth/session';
import {
  fenceUntrusted,
  UNTRUSTED_CONTENT_RULE,
  type UntrustedBlock,
} from '@/lib/security/injection';
import { recordAudit } from '@/lib/security/audit';
import { checkAiBudget, recordAiUsage } from '@/lib/security/limits';
import { CitationRegistry } from '@/lib/ai/citations';
import { splitPages } from '@/lib/documents/pages';
import { findDuplicateCandidates, type DuplicateMatch } from '@/lib/deals/dedupe';
import type {
  Citation,
  Deal,
  DealAnalysis,
  DealDecision,
  DealFact,
  DealNote,
  DealPerson,
  DealSource,
  DealStage,
  DecisionType,
  EmailAttachment,
  EmailMessage,
  FactSourceType,
  GeneratedDraft,
  Task,
} from '@/lib/types/domain';
import { newId, sha256 } from '@/lib/util/hash';
import { normalizeCompanyName, normalizeDomain, truncate } from '@/lib/util/text';
import { err, ok, type Result } from '@/lib/util/result';
import { getActiveThesis } from './thesis';
import { latestAnalysis } from './deal-analysis';

/**
 * Deal pipeline operations.
 *
 * Two invariants worth stating because everything else follows from them:
 *
 * 1. An unknown field stays null. Extraction writes what a source said or it
 *    writes nothing; there is no default, no inference-as-value, no "N/A".
 * 2. A correction never destroys the original. `deal_facts` is append-only
 *    with a `superseded_by` link, so the extracted value and Nick's correction
 *    are both visible forever.
 */

export interface DealListFilters {
  stage?: string;
  search?: string;
  industry?: string;
  includeArchived?: boolean;
}

export async function listDeals(
  organizationId: string,
  filters: DealListFilters = {},
): Promise<Deal[]> {
  const store = getStore();
  const filter: Parameters<typeof store.list>[2] = {};
  if (filters.stage) filter.eq = { ...(filter.eq ?? {}), stage: filters.stage };
  if (filters.industry) filter.eq = { ...(filter.eq ?? {}), industry: filters.industry };
  if (!filters.includeArchived) filter.eq = { ...(filter.eq ?? {}), is_archived: false };
  if (filters.search) {
    filter.textSearch = {
      columns: ['company_name', 'product_summary', 'industry', 'vertical', 'team'],
      query: filters.search,
    };
  }
  return (await store.list('deals', organizationId, filter, {
    orderBy: [{ field: 'received_at', direction: 'desc' }],
  })) as Deal[];
}

export interface DealDetail {
  deal: Deal;
  people: DealPerson[];
  sources: DealSource[];
  facts: DealFact[];
  analysis: DealAnalysis | null;
  analyses: DealAnalysis[];
  decisions: DealDecision[];
  notes: DealNote[];
  tasks: Task[];
  drafts: GeneratedDraft[];
  messages: EmailMessage[];
  attachments: EmailAttachment[];
  stages: DealStage[];
}

export async function getDealDetail(
  organizationId: string,
  dealId: string,
): Promise<DealDetail | null> {
  const store = getStore();
  const deal = (await store.get('deals', organizationId, dealId)) as Deal | null;
  if (!deal) return null;

  const [people, sources, facts, analyses, decisions, notes, tasks, drafts, thesis] =
    await Promise.all([
      store.list('deal_people', organizationId, { eq: { deal_id: dealId } }) as Promise<
        DealPerson[]
      >,
      store.list(
        'deal_sources',
        organizationId,
        { eq: { deal_id: dealId } },
        { orderBy: [{ field: 'occurred_at', direction: 'desc' }] },
      ) as Promise<DealSource[]>,
      store.list(
        'deal_facts',
        organizationId,
        { eq: { deal_id: dealId } },
        { orderBy: [{ field: 'created_at', direction: 'desc' }] },
      ) as Promise<DealFact[]>,
      store.list(
        'deal_analyses',
        organizationId,
        { eq: { deal_id: dealId } },
        { orderBy: [{ field: 'version', direction: 'desc' }] },
      ) as Promise<DealAnalysis[]>,
      store.list(
        'deal_decisions',
        organizationId,
        { eq: { deal_id: dealId } },
        { orderBy: [{ field: 'decided_at', direction: 'desc' }] },
      ) as Promise<DealDecision[]>,
      store.list(
        'deal_notes',
        organizationId,
        { eq: { deal_id: dealId } },
        { orderBy: [{ field: 'created_at', direction: 'desc' }] },
      ) as Promise<DealNote[]>,
      store.list(
        'tasks',
        organizationId,
        { eq: { deal_id: dealId } },
        { orderBy: [{ field: 'due_at', direction: 'asc' }] },
      ) as Promise<Task[]>,
      store.list(
        'generated_drafts',
        organizationId,
        { eq: { deal_id: dealId } },
        { orderBy: [{ field: 'created_at', direction: 'desc' }] },
      ) as Promise<GeneratedDraft[]>,
      getActiveThesis(store, organizationId),
    ]);

  const messages: EmailMessage[] = [];
  const attachments: EmailAttachment[] = [];
  for (const source of sources) {
    if (!source.ref_id) continue;
    if (source.kind === 'email_message') {
      const m = (await store.get(
        'email_messages',
        organizationId,
        source.ref_id,
      )) as EmailMessage | null;
      if (m) messages.push(m);
    } else if (source.kind === 'attachment') {
      const a = (await store.get(
        'email_attachments',
        organizationId,
        source.ref_id,
      )) as EmailAttachment | null;
      if (a) attachments.push(a);
    }
  }

  return {
    deal,
    people,
    sources,
    facts,
    analysis: analyses[0] ?? null,
    analyses,
    decisions,
    notes,
    tasks,
    drafts,
    messages,
    attachments,
    stages: thesis.deal_stages,
  };
}

/* ------------------------------------------------------- create from email */

export interface CreateFromEmailResult {
  deal: Deal;
  created: boolean;
  duplicates: DuplicateMatch[];
  extractionRan: boolean;
}

/**
 * Turn an email into a structured deal record.
 *
 * Duplicate handling is the interesting part: a certain match (same domain)
 * attaches the email to the existing deal; anything less certain creates the
 * deal and returns the candidates so the UI can offer a merge. We never
 * silently fold two companies together on a name similarity.
 */
export async function createDealFromEmail(
  auth: AuthContext,
  messageId: string,
  options: { force?: boolean } = {},
): Promise<Result<CreateFromEmailResult>> {
  const store = getStore();
  const message = (await store.get(
    'email_messages',
    auth.organizationId,
    messageId,
  )) as EmailMessage | null;
  if (!message) return err('not_found', 'That email does not exist in this organization.');

  const attachments = (await store.list('email_attachments', auth.organizationId, {
    eq: { message_id: message.id },
  })) as EmailAttachment[];

  const senderDomain = normalizeDomain(message.from_address.split('@')[1] ?? null);
  const guessedName = guessCompanyName(message);

  const existingDeals = await listDeals(auth.organizationId, { includeArchived: false });
  const threadsByDeal = new Map<string, string[]>();
  for (const deal of existingDeals) {
    const sources = (await store.list('deal_sources', auth.organizationId, {
      eq: { deal_id: deal.id },
    })) as DealSource[];
    threadsByDeal.set(
      deal.id,
      sources.filter((s) => s.kind === 'email_message').map((s) => s.ref_id ?? ''),
    );
  }

  const duplicates = findDuplicateCandidates(
    {
      companyName: guessedName,
      domain: senderDomain,
      founderEmails: [message.from_address],
      sourceThreadIds: [message.id],
    },
    existingDeals,
    threadsByDeal,
  );

  const certain = duplicates.find((d) => d.isCertain);
  if (certain && !options.force) {
    await attachEmailToDeal(auth, certain.deal.id, message.id);
    return ok({ deal: certain.deal, created: false, duplicates, extractionRan: false });
  }

  const now = new Date().toISOString();
  const deal: Deal = {
    id: newId(),
    organization_id: auth.organizationId,
    company_name: guessedName,
    normalized_name: normalizeCompanyName(guessedName),
    website: null,
    domain: senderDomain,
    stage: 'new',
    industry: null,
    vertical: null,
    geography: null,
    funding_stage: null,
    round_size: null,
    amount_raised: null,
    valuation_or_cap: null,
    existing_investors: [],
    requested_check: null,
    referral_source: null,
    received_at: message.sent_at,
    product_summary: null,
    customer: null,
    problem: null,
    solution: null,
    ai_usage: null,
    traction: null,
    revenue: null,
    growth: null,
    customer_count: null,
    pipeline: null,
    business_model: null,
    pricing: null,
    market: null,
    competition: null,
    team: null,
    founder_market_fit: null,
    gtm_motion: null,
    defensibility: null,
    data_advantage: null,
    risks: [],
    open_questions: [],
    outcome: null,
    is_archived: false,
    created_at: now,
    updated_at: now,
  };
  await store.insert('deals', deal);

  await addSource(
    auth,
    deal.id,
    'email_message',
    message.id,
    message.subject ?? '(no subject)',
    message.sent_at,
  );
  for (const attachment of attachments) {
    await addSource(
      auth,
      deal.id,
      'attachment',
      attachment.id,
      attachment.filename,
      attachment.created_at,
    );
  }
  await store.update('email_messages', auth.organizationId, message.id, {
    linked_deal_id: deal.id,
  });

  await recordAudit(store, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    action: 'deal.created',
    entityType: 'deal',
    entityId: deal.id,
    metadata: { from_message: message.id, duplicate_candidates: duplicates.length },
  });

  const extraction = await extractDealFacts(auth, deal.id);

  const refreshed = (await store.get('deals', auth.organizationId, deal.id)) as Deal;
  return ok({
    deal: refreshed,
    created: true,
    duplicates: duplicates.filter((d) => !d.isCertain),
    extractionRan: extraction.ok,
  });
}

function guessCompanyName(message: EmailMessage): string {
  const subject = message.subject ?? '';
  // Common inbound-pitch subject shapes: "Acme — thing", "Intro: Acme (thing)".
  const patterns = [
    /^intro(?:duction)?\s*[:—-]\s*([A-Z][\w.& '-]{1,40}?)\s*[(—-]/i,
    /^([A-Z][\w.& '-]{1,40}?)\s*[—-]\s*/,
    /^re:\s*([A-Z][\w.& '-]{1,40}?)\s*[—-]\s*/i,
  ];
  for (const re of patterns) {
    const m = re.exec(subject.trim());
    if (m?.[1]) return m[1].trim();
  }
  const domain = normalizeDomain(message.from_address.split('@')[1] ?? null);
  if (domain) {
    const base = domain.split('.')[0] ?? domain;
    return base.charAt(0).toUpperCase() + base.slice(1);
  }
  return subject.slice(0, 60) || 'Unnamed company';
}

export async function addSource(
  auth: AuthContext,
  dealId: string,
  kind: DealSource['kind'],
  refId: string | null,
  label: string,
  occurredAt: string | null,
): Promise<DealSource> {
  const store = getStore();
  const row: DealSource = {
    id: sha256(`${dealId}:${kind}:${refId}`).slice(0, 32),
    organization_id: auth.organizationId,
    deal_id: dealId,
    kind,
    ref_id: refId,
    label,
    url: null,
    occurred_at: occurredAt,
    created_at: new Date().toISOString(),
  };
  const result = await store.upsert('deal_sources', row, ['deal_id', 'kind', 'ref_id']);
  return result.row;
}

export async function attachEmailToDeal(
  auth: AuthContext,
  dealId: string,
  messageId: string,
): Promise<Result<true>> {
  const store = getStore();
  const [deal, message] = await Promise.all([
    store.get('deals', auth.organizationId, dealId) as Promise<Deal | null>,
    store.get('email_messages', auth.organizationId, messageId) as Promise<EmailMessage | null>,
  ]);
  if (!deal) return err('not_found', 'That deal does not exist.');
  if (!message) return err('not_found', 'That email does not exist.');

  await addSource(
    auth,
    dealId,
    'email_message',
    messageId,
    message.subject ?? '(no subject)',
    message.sent_at,
  );
  const attachments = (await store.list('email_attachments', auth.organizationId, {
    eq: { message_id: messageId },
  })) as EmailAttachment[];
  for (const a of attachments) {
    await addSource(auth, dealId, 'attachment', a.id, a.filename, a.created_at);
  }
  await store.update('email_messages', auth.organizationId, messageId, { linked_deal_id: dealId });

  await recordAudit(store, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    action: 'email.attached_to_deal',
    entityType: 'deal',
    entityId: dealId,
    metadata: { message_id: messageId, attachments: attachments.length },
  });
  return ok(true);
}

/* -------------------------------------------------------------- extraction */

/**
 * Extract structured facts from a deal's sources.
 *
 * Writes two things per field: the deal column (for querying and display) and
 * an append-only `deal_facts` row carrying provenance, the verbatim quote and
 * the citation. The second is what makes "where did that number come from?"
 * answerable.
 */
export async function extractDealFacts(
  auth: AuthContext,
  dealId: string,
): Promise<Result<{ fieldsWritten: number; unknownFields: number }>> {
  const store = getStore();
  const deal = (await store.get('deals', auth.organizationId, dealId)) as Deal | null;
  if (!deal) return err('not_found', 'That deal does not exist.');

  const budget = await checkAiBudget(store, auth.organizationId, auth.userId);
  if (!budget.ok) return budget;

  const sources = (await store.list('deal_sources', auth.organizationId, {
    eq: { deal_id: dealId },
  })) as DealSource[];

  const registry = new CitationRegistry();
  const blocks: UntrustedBlock[] = [];

  for (const source of sources) {
    if (!source.ref_id) continue;
    if (source.kind === 'email_message') {
      const m = (await store.get(
        'email_messages',
        auth.organizationId,
        source.ref_id,
      )) as EmailMessage | null;
      if (!m) continue;
      const id = `email:${m.id}`;
      registry.add({
        id,
        kind: 'email',
        ref_id: m.id,
        label: m.subject ?? '(no subject)',
        page: null,
        section: null,
        url: null,
        occurred_at: m.sent_at,
        retrieved_at: m.body_fetched_at,
        publisher: m.from_address,
        excerpt: truncate(m.body_text ?? m.snippet, 240),
      });
      blocks.push({
        sourceId: id,
        sourceKind: 'email',
        label: `Email from ${m.from_name ?? m.from_address}`,
        text: truncate(m.body_text ?? m.snippet, 24_000),
        occurredAt: m.sent_at,
      });
    } else if (source.kind === 'attachment') {
      const a = (await store.get(
        'email_attachments',
        auth.organizationId,
        source.ref_id,
      )) as EmailAttachment | null;
      if (!a?.extracted_text) continue;
      for (const page of splitPages(a.extracted_text)) {
        const id = `attachment:${a.id}:p${page.page}`;
        registry.add({
          id,
          kind: 'attachment',
          ref_id: a.id,
          label: a.filename,
          page: page.page,
          section: null,
          url: null,
          occurred_at: a.created_at,
          retrieved_at: a.updated_at,
          publisher: null,
          excerpt: truncate(page.text, 240),
        });
        blocks.push({
          sourceId: id,
          sourceKind: 'attachment',
          label: `${a.filename}, page ${page.page}`,
          text: truncate(page.text, 24_000),
          page: page.page,
          occurredAt: a.created_at,
        });
      }
    }
  }

  if (blocks.length === 0) {
    return err('invalid_input', 'This deal has no readable sources to extract from.');
  }

  const context = {
    fields: [...DEAL_EXTRACTION_FIELDS],
    available_source_ids: registry.ids(),
    known_company_name: deal.company_name,
  };

  const ai = getAI();
  const response = await ai.generateStructured({
    tier: 'fast',
    operation: 'deal.extract',
    promptVersion: PROMPTS.dealExtraction.version,
    system: PROMPTS.dealExtraction.system,
    messages: [
      {
        role: 'user',
        content: `<context>${JSON.stringify(context)}</context>

${UNTRUSTED_CONTENT_RULE}

<sources>
${fenceUntrusted(blocks)}
</sources>

Extract the fields listed in context.fields. Return null for anything the sources do not state.`,
      },
    ],
    schema: dealExtractionSchema,
    maxTokens: 8_000,
  });

  await recordAiUsage(store, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    operation: 'deal.extract',
    promptVersion: PROMPTS.dealExtraction.version,
    usage: response.ok ? response.value.usage : null,
    ok: response.ok,
    errorCode: response.ok ? null : response.error.code,
  });

  if (!response.ok) return response;
  const output = response.value.value;

  const dealPatch: Partial<Deal> = {};
  const factRows: DealFact[] = [];
  let fieldsWritten = 0;
  let unknownFields = 0;

  for (const field of DEAL_EXTRACTION_FIELDS) {
    const extracted = output.fields[field];
    if (!extracted || extracted.value === null || extracted.value === '') {
      unknownFields++;
      continue;
    }
    const resolved = extracted.citation
      ? registry.resolve([extracted.citation]).citations[0]
      : undefined;
    // A field we cannot attribute to a real source is not written at all.
    if (!resolved) {
      unknownFields++;
      continue;
    }

    if (field !== 'company_name' && field in deal) {
      (dealPatch as Record<string, unknown>)[field] = extracted.value;
    }
    fieldsWritten++;

    factRows.push({
      id: newId(),
      organization_id: auth.organizationId,
      deal_id: dealId,
      field,
      value: extracted.value,
      source_type: extracted.source_type as FactSourceType,
      evidence_quote: extracted.citation?.quote ?? resolved.excerpt,
      citation_id: resolved.id,
      confidence: extracted.confidence,
      version: 1,
      superseded_by: null,
      created_by: null,
      created_at: new Date().toISOString(),
    });
  }

  if (output.risks.length > 0) {
    dealPatch.risks = output.risks.map((r) => r.risk);
  }
  if (output.open_questions.length > 0) {
    dealPatch.open_questions = output.open_questions;
  }
  if (output.existing_investors.length > 0) {
    dealPatch.existing_investors = output.existing_investors;
  }
  if (output.referral_source) dealPatch.referral_source = output.referral_source;

  if (Object.keys(dealPatch).length > 0) {
    await store.update('deals', auth.organizationId, dealId, dealPatch);
  }
  if (factRows.length > 0) {
    await store.insertMany('deal_facts', factRows);
  }

  for (const founder of output.founders) {
    const person: DealPerson = {
      id: sha256(`${dealId}:${founder.name}`).slice(0, 32),
      organization_id: auth.organizationId,
      deal_id: dealId,
      name: founder.name,
      role: founder.role,
      email: founder.email,
      linkedin_url: null,
      background: founder.background,
      created_at: new Date().toISOString(),
    };
    await store.upsert('deal_people', person, ['deal_id', 'name']);
  }

  if (output.suspicious_content_notes.length > 0) {
    await recordAudit(store, {
      organizationId: auth.organizationId,
      userId: auth.userId,
      action: 'security.injection_flagged',
      entityType: 'deal',
      entityId: dealId,
      metadata: { notes: output.suspicious_content_notes.length, phase: 'extraction' },
    });
  }

  return ok({ fieldsWritten, unknownFields });
}

/* ------------------------------------------------------------ corrections */

/**
 * Correct an extracted fact.
 *
 * Appends a new version rather than overwriting: the original extraction and
 * Nick's correction are both permanently visible in the audit drawer.
 */
export async function correctFact(
  auth: AuthContext,
  dealId: string,
  field: string,
  newValue: string | null,
  note?: string,
): Promise<Result<DealFact>> {
  const store = getStore();
  const deal = (await store.get('deals', auth.organizationId, dealId)) as Deal | null;
  if (!deal) return err('not_found', 'That deal does not exist.');

  const existing = (await store.list(
    'deal_facts',
    auth.organizationId,
    { eq: { deal_id: dealId, field }, isNull: ['superseded_by'] },
    { orderBy: [{ field: 'version', direction: 'desc' }], limit: 1 },
  )) as DealFact[];
  const previous = existing[0];

  const correction: DealFact = {
    id: newId(),
    organization_id: auth.organizationId,
    deal_id: dealId,
    field,
    value: newValue,
    source_type: 'human',
    evidence_quote: note ?? null,
    citation_id: null,
    confidence: 1,
    version: (previous?.version ?? 0) + 1,
    superseded_by: null,
    created_by: auth.userId,
    created_at: new Date().toISOString(),
  };
  await store.insert('deal_facts', correction);

  if (previous) {
    await store.update('deal_facts', auth.organizationId, previous.id, {
      superseded_by: correction.id,
    });
  }

  if (field in deal) {
    await store.update('deals', auth.organizationId, dealId, {
      [field]: newValue,
    } as Partial<Deal>);
  }

  await recordAudit(store, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    action: 'deal.fact_corrected',
    entityType: 'deal',
    entityId: dealId,
    metadata: {
      field,
      previous_value: previous?.value ?? null,
      new_value: newValue,
      previous_source: previous?.source_type ?? null,
    },
  });

  return ok(correction);
}

/** Current value plus its full correction history, for the audit drawer. */
export function factHistory(facts: readonly DealFact[], field: string): DealFact[] {
  return facts.filter((f) => f.field === field).sort((a, b) => b.version - a.version);
}

/* --------------------------------------------------------------- mutations */

export async function updateDealStage(
  auth: AuthContext,
  dealId: string,
  stage: string,
): Promise<Result<Deal>> {
  const store = getStore();
  const deal = (await store.get('deals', auth.organizationId, dealId)) as Deal | null;
  if (!deal) return err('not_found', 'That deal does not exist.');

  const thesis = await getActiveThesis(store, auth.organizationId, auth.userId);
  if (!thesis.deal_stages.some((s) => s.key === stage)) {
    return err('invalid_input', `"${stage}" is not one of the configured pipeline stages.`);
  }

  const updated = (await store.update('deals', auth.organizationId, dealId, { stage })) as Deal;
  await recordAudit(store, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    action: 'deal.stage_changed',
    entityType: 'deal',
    entityId: dealId,
    metadata: { from: deal.stage, to: stage },
  });
  return ok(updated);
}

/**
 * Record a human decision.
 *
 * `actor` is hard-coded to 'human' and there is no code path that writes a
 * decision on the model's behalf. Advancing to `invested` is reachable only
 * from here.
 */
export async function recordDecision(
  auth: AuthContext,
  dealId: string,
  decision: DecisionType,
  rationale: string,
): Promise<Result<DealDecision>> {
  const store = getStore();
  const deal = (await store.get('deals', auth.organizationId, dealId)) as Deal | null;
  if (!deal) return err('not_found', 'That deal does not exist.');
  if (!rationale.trim()) {
    return err('invalid_input', 'A decision needs a rationale — that is the part worth keeping.');
  }

  const analysis = await latestAnalysis(auth.organizationId, dealId);

  const row: DealDecision = {
    id: newId(),
    organization_id: auth.organizationId,
    deal_id: dealId,
    decision,
    rationale: rationale.trim(),
    actor: 'human',
    decided_by: auth.userId,
    decided_at: new Date().toISOString(),
    analysis_id: analysis?.id ?? null,
    created_at: new Date().toISOString(),
  };
  await store.insert('deal_decisions', row);

  const stageForDecision: Record<DecisionType, string | null> = {
    pass: 'passed',
    monitor: 'monitoring',
    dig_deeper: 'diligence',
    advance: 'ic_review',
    invest: 'invested',
    reopen: 'reviewing',
  };
  const nextStage = stageForDecision[decision];
  if (nextStage) {
    await store.update('deals', auth.organizationId, dealId, {
      stage: nextStage,
      outcome: decision === 'pass' ? `Passed — ${truncate(rationale, 120)}` : deal.outcome,
    });
  }

  await recordAudit(store, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    action: 'deal.decision_recorded',
    entityType: 'deal',
    entityId: dealId,
    metadata: { decision, analysis_id: analysis?.id ?? null },
  });

  return ok(row);
}

export async function addNote(
  auth: AuthContext,
  dealId: string,
  body: string,
): Promise<Result<DealNote>> {
  const store = getStore();
  const deal = (await store.get('deals', auth.organizationId, dealId)) as Deal | null;
  if (!deal) return err('not_found', 'That deal does not exist.');
  if (!body.trim()) return err('invalid_input', 'A note needs some content.');

  const now = new Date().toISOString();
  const note: DealNote = {
    id: newId(),
    organization_id: auth.organizationId,
    deal_id: dealId,
    body: body.trim(),
    author_id: auth.userId,
    created_at: now,
    updated_at: now,
  };
  await store.insert('deal_notes', note);
  return ok(note);
}

/* -------------------------------------------------------------- comparison */

export async function compareDeals(
  auth: AuthContext,
  dealIds: string[],
): Promise<
  Result<{
    answer: string;
    dimensions: unknown[];
    whatWouldChange: string[];
    citations: Citation[];
  }>
> {
  const store = getStore();
  if (dealIds.length < 2) {
    return err('invalid_input', 'Pick at least two deals to compare.');
  }
  if (dealIds.length > 4) {
    return err('invalid_input', 'Compare at most four deals at once.');
  }

  const budget = await checkAiBudget(store, auth.organizationId, auth.userId);
  if (!budget.ok) return budget;

  const registry = new CitationRegistry();
  const blocks: UntrustedBlock[] = [];
  const deals: Deal[] = [];

  for (const id of dealIds) {
    const deal = (await store.get('deals', auth.organizationId, id)) as Deal | null;
    if (!deal) return err('not_found', `Deal ${id} does not exist in this organization.`);
    deals.push(deal);
    const evidence = await buildComparisonBlocks(auth.organizationId, deal, registry);
    blocks.push(...evidence);
  }

  const context = {
    deals: deals.map((d) => ({
      id: d.id,
      company_name: d.company_name,
      stage: d.stage,
      industry: d.industry,
      vertical: d.vertical,
      revenue: d.revenue,
      traction: d.traction,
      growth: d.growth,
      team: d.team,
      founder_market_fit: d.founder_market_fit,
      competition: d.competition,
      defensibility: d.defensibility,
      round_size: d.round_size,
    })),
    available_source_ids: registry.ids(),
  };

  const ai = getAI();
  const response = await ai.generateStructured({
    tier: 'deep',
    operation: 'deal.compare',
    promptVersion: PROMPTS.dealComparison.version,
    system: PROMPTS.dealComparison.system,
    messages: [
      {
        role: 'user',
        content: `<context>${JSON.stringify(context)}</context>

${UNTRUSTED_CONTENT_RULE}

<sources>
${fenceUntrusted(blocks)}
</sources>

Compare these deals.`,
      },
    ],
    schema: dealComparisonSchema,
    maxTokens: 10_000,
  });

  await recordAiUsage(store, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    operation: 'deal.compare',
    promptVersion: PROMPTS.dealComparison.version,
    usage: response.ok ? response.value.usage : null,
    ok: response.ok,
    errorCode: response.ok ? null : response.error.code,
  });

  if (!response.ok) return response;
  const { citations } = registry.resolve(response.value.value.citations);

  return ok({
    answer: response.value.value.answer,
    dimensions: response.value.value.dimensions,
    whatWouldChange: response.value.value.what_would_change_the_answer,
    citations,
  });
}

async function buildComparisonBlocks(
  organizationId: string,
  deal: Deal,
  registry: CitationRegistry,
): Promise<UntrustedBlock[]> {
  const store = getStore();
  const blocks: UntrustedBlock[] = [];

  const dealCitationId = `deal:${deal.id}`;
  registry.add({
    id: dealCitationId,
    kind: 'deal',
    ref_id: deal.id,
    label: deal.company_name,
    page: null,
    section: null,
    url: null,
    occurred_at: deal.received_at,
    retrieved_at: null,
    publisher: null,
    excerpt: deal.product_summary,
  });

  const sources = (await store.list(
    'deal_sources',
    organizationId,
    { eq: { deal_id: deal.id } },
    { limit: 4 },
  )) as DealSource[];

  for (const source of sources) {
    if (source.kind !== 'email_message' || !source.ref_id) continue;
    const m = (await store.get(
      'email_messages',
      organizationId,
      source.ref_id,
    )) as EmailMessage | null;
    if (!m) continue;
    const id = `email:${m.id}`;
    registry.add({
      id,
      kind: 'email',
      ref_id: m.id,
      label: `${deal.company_name}: ${m.subject ?? '(no subject)'}`,
      page: null,
      section: null,
      url: null,
      occurred_at: m.sent_at,
      retrieved_at: m.body_fetched_at,
      publisher: m.from_address,
      excerpt: truncate(m.body_text ?? m.snippet, 240),
    });
    blocks.push({
      sourceId: id,
      sourceKind: 'email',
      label: `${deal.company_name} — email`,
      text: truncate(m.body_text ?? m.snippet, 12_000),
      occurredAt: m.sent_at,
    });
  }

  return blocks;
}

/* ------------------------------------------------------------ memo export */

/** Markdown memo. Plain text by design so it pastes into anything. */
export function renderMemoMarkdown(detail: DealDetail): string {
  const { deal, analysis, people, decisions, notes } = detail;
  const lines: string[] = [];

  lines.push(`# ${deal.company_name}`);
  lines.push('');
  lines.push(
    `*Investment memo generated by TipTop Copilot on ${new Date().toISOString().slice(0, 10)}.*`,
  );
  lines.push('');

  if (analysis) {
    const rec = analysis.human_override?.recommendation ?? analysis.recommendation;
    lines.push(`**Recommendation: ${rec.replace(/_/g, ' ')}**`);
    if (analysis.human_override) {
      lines.push('');
      lines.push(
        `> Overridden by a human from ${analysis.recommendation.replace(/_/g, ' ')}. Reason: ${analysis.human_override.note}`,
      );
    }
    lines.push('');
    lines.push(
      `Quality ${analysis.quality_score}/100 · Data completeness ${analysis.data_completeness}% · Evidence quality ${analysis.evidence_quality}% · Confidence ${analysis.confidence}%`,
    );
    lines.push('');
    lines.push('## Thirty-second overview');
    lines.push(analysis.thirty_second_overview);
    lines.push('');
    lines.push('## Rationale');
    lines.push(analysis.rationale);
    lines.push('');
  } else {
    lines.push('_No analysis has been generated for this deal yet._');
    lines.push('');
  }

  lines.push('## Company');
  const fields: [string, string | null][] = [
    ['Website', deal.website],
    ['Industry', deal.industry],
    ['Vertical', deal.vertical],
    ['Geography', deal.geography],
    ['Stage', deal.funding_stage],
    ['Round size', deal.round_size],
    ['Committed', deal.amount_raised],
    ['Valuation / cap', deal.valuation_or_cap],
    ['Revenue', deal.revenue],
    ['Growth', deal.growth],
    ['Customers', deal.customer_count],
    ['Business model', deal.business_model],
    ['Pricing', deal.pricing],
  ];
  for (const [label, value] of fields) {
    lines.push(`- **${label}:** ${value ?? '_Not stated_'}`);
  }
  lines.push('');

  if (people.length > 0) {
    lines.push('## Team');
    for (const p of people) {
      lines.push(
        `- **${p.name}**${p.role ? ` — ${p.role}` : ''}${p.background ? `. ${p.background}` : ''}`,
      );
    }
    lines.push('');
  }

  if (analysis) {
    lines.push('## Scorecard');
    lines.push('');
    lines.push('| Category | Weight | Score | Basis |');
    lines.push('| --- | ---: | ---: | --- |');
    for (const c of analysis.categories) {
      lines.push(
        `| ${c.label} | ${c.weight} | ${c.score === null ? '_unscored_' : c.score} | ${c.rationale.replace(/\|/g, '/')} |`,
      );
    }
    lines.push('');
    lines.push(
      `Scored on ${analysis.attempted_weight} of ${analysis.categories.reduce((s, c) => s + c.weight, 0)} available points. Unscored categories reduce confidence; they are not counted as zero.`,
    );
    lines.push('');

    if (analysis.red_flags.length > 0) {
      lines.push('## Red flags');
      for (const f of analysis.red_flags) {
        lines.push(
          `- **${f.severity === 'hard' ? 'HARD' : 'Soft'} — ${f.label}${f.resolved ? ' (resolved)' : ''}:** ${f.detail}`,
        );
      }
      lines.push('');
    }

    lines.push('## Upside case');
    lines.push(analysis.upside_case);
    lines.push('');
    lines.push('## Downside case');
    lines.push(analysis.downside_case);
    lines.push('');

    if (analysis.missing_information.length > 0) {
      lines.push('## Missing information');
      for (const m of analysis.missing_information) lines.push(`- ${m}`);
      lines.push('');
    }

    if (analysis.diligence_questions.length > 0) {
      lines.push('## Priority diligence questions');
      analysis.diligence_questions.forEach((q, i) => lines.push(`${i + 1}. ${q}`));
      lines.push('');
    }

    if (analysis.citations.length > 0) {
      lines.push('## Sources');
      for (const c of analysis.citations) {
        const page = c.page ? `, page ${c.page}` : '';
        const date = c.occurred_at ? ` (${c.occurred_at.slice(0, 10)})` : '';
        lines.push(`- ${c.label}${page}${date}`);
      }
      lines.push('');
    }
  }

  if (decisions.length > 0) {
    lines.push('## Decision history');
    for (const d of decisions) {
      lines.push(
        `- **${d.decision.toUpperCase()}** on ${d.decided_at.slice(0, 10)} — ${d.rationale}`,
      );
    }
    lines.push('');
  }

  if (notes.length > 0) {
    lines.push('## Notes');
    for (const n of notes) {
      lines.push(`- ${n.created_at.slice(0, 10)}: ${n.body}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(
    'Generated by TipTop Copilot. Scores and recommendations are decision support, not a decision. No investment action has been taken and no message has been sent.',
  );

  return lines.join('\n');
}
