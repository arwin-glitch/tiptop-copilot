import 'server-only';
import type { z } from 'zod';
import { scanForInjection } from '@/lib/security/injection';
import { ok, type Result } from '@/lib/util/result';
import type {
  AIProvider,
  StructuredRequest,
  StructuredResponse,
  TextRequest,
  TextResponse,
  ToolConversationRequest,
  ToolConversationResponse,
  ToolOutcome,
  UsageInfo,
} from './provider';

/**
 * Deterministic offline model.
 *
 * This is not a stub that returns canned strings. It reads the same context
 * block and the same fenced sources the real provider receives, and derives
 * its output from them — citations point at source ids that actually exist,
 * scores move when the evidence moves, and "unknown" stays unknown.
 *
 * That property is what makes the demo and the integration tests meaningful:
 * they exercise the real grounding and citation-validation paths, not a
 * pre-baked answer.
 */
export class MockAIProvider implements AIProvider {
  readonly kind = 'mock' as const;

  available(): boolean {
    return true;
  }

  async generateStructured<T extends z.ZodType>(
    request: StructuredRequest<T>,
  ): Promise<Result<StructuredResponse<z.infer<T>>>> {
    const started = Date.now();
    const prompt = request.messages.map((m) => m.content).join('\n\n');
    const context = parseContext(prompt);
    const sources = parseSources(prompt);

    const raw = buildOutput(request.operation, context, sources, prompt);
    const parsed = request.schema.safeParse(raw);
    const value = parsed.success
      ? (parsed.data as z.infer<T>)
      : (coerceToSchema(request.schema, raw) as z.infer<T>);

    return ok({
      value,
      usage: mockUsage(prompt, started),
      webSources: [],
    });
  }

  async generateText(request: TextRequest): Promise<Result<TextResponse>> {
    const started = Date.now();
    const prompt = request.messages.map((m) => m.content).join('\n\n');
    return ok({
      text: 'Offline model stub: no narrative text is generated in demo mode.',
      usage: mockUsage(prompt, started),
    });
  }

  async runToolConversation<T extends z.ZodType>(
    request: ToolConversationRequest<T>,
  ): Promise<Result<ToolConversationResponse<z.infer<T>>>> {
    const started = Date.now();
    const prompt = request.messages.map((m) => m.content).join('\n\n');
    const question = lastUserQuestion(request.messages);
    const outcomes: ToolOutcome[] = [];

    // Choose tools the way the real model would: by what the question is about.
    const plan = planTools(
      question,
      request.tools.map((t) => t.name),
    );
    for (const invocation of plan) {
      outcomes.push(await request.execute(invocation));
    }

    const evidence = outcomes
      .filter((o) => o.ok)
      .flatMap((o) => extractToolCitations(o.content))
      .slice(0, 6);

    const answer = composeChatAnswer(question, outcomes, evidence);
    const parsed = request.finalSchema.safeParse(answer);
    const value = parsed.success
      ? (parsed.data as z.infer<T>)
      : (coerceToSchema(request.finalSchema, answer) as z.infer<T>);

    return ok({
      value,
      toolOutcomes: outcomes,
      usage: mockUsage(prompt, started),
    });
  }
}

/* ---------------------------------------------------------------- helpers */

function mockUsage(prompt: string, started: number): UsageInfo {
  const inputTokens = Math.ceil(prompt.length / 4);
  return {
    model: 'demo-offline-model',
    inputTokens,
    outputTokens: 400,
    cacheReadTokens: 0,
    estimatedCostUsd: 0,
    durationMs: Math.max(1, Date.now() - started),
  };
}

export interface MockContext {
  [key: string]: unknown;
}

export interface MockSource {
  id: string;
  kind: string;
  label: string;
  page: number | null;
  date: string | null;
  text: string;
}

/** Services embed a JSON `<context>` block; both providers read the same text. */
export function parseContext(prompt: string): MockContext {
  const match = /<context>([\s\S]*?)<\/context>/.exec(prompt);
  if (!match?.[1]) return {};
  try {
    return JSON.parse(match[1]) as MockContext;
  } catch {
    return {};
  }
}

export function parseSources(prompt: string): MockSource[] {
  const out: MockSource[] = [];
  const re = /<untrusted-content ([^>]*)>([\s\S]*?)<\/untrusted-content>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt)) !== null) {
    const attrs = m[1] ?? '';
    const body = (m[2] ?? '').trim();
    out.push({
      id: attr(attrs, 'source-id') ?? '',
      kind: attr(attrs, 'kind') ?? 'unknown',
      label: attr(attrs, 'label') ?? '',
      page: attr(attrs, 'page') ? Number(attr(attrs, 'page')) : null,
      date: attr(attrs, 'date'),
      text: body,
    });
  }
  return out.filter((s) => s.id);
}

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`${name}="([^"]*)"`).exec(attrs);
  return m?.[1] ?? null;
}

/**
 * Sentences, not physical lines.
 *
 * Email bodies are hard-wrapped at around 80 characters, so quoting a line
 * yields a fragment that stops mid-clause. Paragraphs are unwrapped first and
 * then split on sentence boundaries, which is what makes a quoted claim
 * readable when it is shown back to the user.
 */
function sentencesIn(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .flatMap((paragraph) =>
      paragraph
        .replace(/\s*\n\s*/g, ' ')
        .trim()
        .split(/(?<=[.!?])\s+/),
    )
    .map((s) => s.trim())
    .filter(Boolean);
}

function findQuote(
  sources: MockSource[],
  pattern: RegExp,
): { id: string; quote: string; page: number | null } | null {
  for (const s of sources) {
    for (const candidate of sentencesIn(s.text)) {
      if (pattern.test(candidate) && candidate.length > 8) {
        return { id: s.id, quote: candidate.slice(0, 300), page: s.page };
      }
    }
  }
  return null;
}

/** One sentence, terminated exactly once — the fixture text may already end in a stop. */
function sentence(text: string): string {
  const trimmed = text.trim().replace(/[.\s]+$/, '');
  return trimmed ? `${trimmed}.` : '';
}

/**
 * A quoted fragment, cut at a word boundary rather than mid-word, and closed
 * with an ellipsis when it was cut. Stopping a truncated clause with a full
 * stop reads as a finished sentence that trails off, which is worse than
 * saying plainly that there is more.
 */
function clause(text: string, max: number): string {
  const flat = text.trim().replace(/\s+/g, ' ');
  if (flat.length <= max) return sentence(flat);
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).replace(/[,;:.\s]+$/, '')}…`;
}

function cite(hit: { id: string; quote: string; page: number | null } | null) {
  if (!hit) return null;
  return { source_id: hit.id, page: hit.page, quote: hit.quote };
}

/* ------------------------------------------------------- output builders */

function buildOutput(
  operation: string,
  context: MockContext,
  sources: MockSource[],
  prompt: string,
): unknown {
  switch (operation) {
    case 'email.classify':
      return mockClassifyEmail(context, sources, prompt);
    case 'deal.extract':
      return mockExtractDeal(context, sources);
    case 'deal.analyze':
      return mockAnalyzeDeal(context, sources);
    case 'brief.outlook':
      return mockOutlook(context);
    case 'portfolio.classify':
      return mockPortfolioUpdate(context, sources);
    case 'draft.reply':
      return mockDraft(context, sources);
    case 'deal.compare':
      return mockCompare(context, sources);
    case 'injection.detect':
      return mockInjection(sources, prompt);
    default:
      return {};
  }
}

/* ------------------------------------------------------ email classifier */

function mockClassifyEmail(context: MockContext, sources: MockSource[], prompt: string) {
  const from = String(context.from_address ?? '');
  const subject = String(context.subject ?? '');
  const snippet = String(context.snippet ?? '');
  const knownPortfolioDomains = asStringArray(context.portfolio_domains);
  const knownDealDomains = asStringArray(context.deal_domains);
  const lpDomains = asStringArray(context.lp_domains);
  const text = `${subject}\n${snippet}\n${sources.map((s) => s.text).join('\n')}`.toLowerCase();
  const domain = from.split('@')[1]?.toLowerCase() ?? '';

  const scan = scanForInjection(`${subject}\n${snippet}\n${prompt}`);

  let category = 'unknown';
  let importance = 40;
  let reason = 'Insufficient signal in the metadata and snippet to classify confidently.';

  if (knownPortfolioDomains.includes(domain)) {
    category = 'portfolio_company';
    importance = /urgent|help|intro|hiring|raise|runway/.test(text) ? 88 : 70;
    reason = 'Sender domain matches a portfolio company on file.';
  } else if (knownDealDomains.includes(domain)) {
    category = 'existing_deal';
    importance = 82;
    reason = 'Sender domain matches a company already in the pipeline.';
  } else if (
    lpDomains.includes(domain) ||
    /\blp\b|limited partner|family office|capital call/.test(text)
  ) {
    category = 'lp_or_advisor';
    importance = 90;
    reason = 'Content and sender indicate a limited partner or fund advisor.';
  } else if (/unsubscribe|newsletter|digest|this week in/.test(text)) {
    category = 'newsletter_or_market';
    importance = 22;
    reason = 'Bulk newsletter markers present.';
  } else if (/co-?invest|taking a piece|alongside you|are you looking at/.test(text)) {
    category = 'co_investor';
    importance = 84;
    reason = 'Another investor is discussing a shared opportunity.';
  } else if (/raising|seed round|pre-?seed|our deck|pitch|arr|mrr/.test(text)) {
    category = 'new_deal';
    importance = /\$\s?\d|\bmrr\b|\barr\b|paying customers/.test(text) ? 78 : 48;
    reason = 'Fundraising language with company-level detail; reads as an inbound pitch.';
  } else if (/reschedul|calendar|invite|meeting at|available on/.test(text)) {
    category = 'meeting_or_scheduling';
    importance = 35;
    reason = 'Scheduling logistics only.';
  } else if (/invoice|receipt|subscription renewal|w-?9|contract for signature/.test(text)) {
    category = 'administrative';
    importance = 30;
    reason = 'Administrative or vendor correspondence.';
  }

  const company = /([A-Z][A-Za-z0-9]+(?:\s[A-Z][A-Za-z0-9]+)?)\s+(?:—|-|is|does|builds)/.exec(
    subject,
  );

  return {
    category,
    confidence: category === 'unknown' ? 0.35 : 0.82,
    importance,
    reason,
    company_name:
      category === 'new_deal' || category === 'existing_deal'
        ? (company?.[1] ?? subject.split(/[—:-]/)[0]?.trim() ?? null)
        : null,
    warrants_deep_fetch: [
      'new_deal',
      'existing_deal',
      'portfolio_company',
      'lp_or_advisor',
      'co_investor',
    ].includes(category),
    contains_instruction_to_ai: scan.highestSeverity === 'high',
  };
}

/* ------------------------------------------------------- deal extraction */

const FIELD_PATTERNS: Record<string, RegExp> = {
  revenue: /\$\s?[\d.,]+\s?(k|m|b)?\s*(mrr|arr)/i,
  growth: /(up from|grew|growth|month over month|quarter over quarter|\d+%\s*(mom|qoq))/i,
  customer_count:
    /\b\d+\s+(paying\s+)?(clinics?|customers?|contractors?|firms?|workspaces?|accounts?)\b/i,
  traction: /(paying|pilot|customers?|clinics?|contractors?|firms?)/i,
  round_size: /raising\s+\$\s?[\d.,]+\s?(k|m|b)?/i,
  amount_raised: /(committed|raised)\s*[:\-]?\s*\$?\s?[\d.,]+\s?(k|m|b)?/i,
  valuation_or_cap: /(post-?money|pre-?money|cap)\s*(of|at)?\s*\$\s?[\d.,]+\s?(k|m|b)?/i,
  pricing: /(\$\s?[\d.,]+\s*(per|\/)\s*(user|seat|month|clinic|year))|average contract value/i,
  team: /(founder|co-?founder|ceo|cto|years at|practised|practiced|worked)/i,
  market: /(market|practices|clinics in the|tam|serviceable)/i,
  competition: /(competitor|competition|lost .* to|won .* against|category has)/i,
  business_model: /(subscription|per seat|per clinic|annual contract|self-?serve)/i,
  defensibility: /(proprietary|licensed|exclusive|corpus|integrations took|moat)/i,
  data_advantage: /(corpus|de-?identified|licensed|proprietary data|encounters)/i,
  gtm_motion: /(sales cycle|direct sales|self-?serve|bottom-?up|outbound)/i,
  ai_usage: /(model|fine-?tuned|ambient|extraction|llm|machine learning)/i,
  problem: /(problem|lose|lost|hours per week|manual|turnover|takes .* days)/i,
  solution: /(we automate|our solution|sits on top|automates|produces)/i,
  customer: /(independent|mid-?market|clinics|contractors|firms|teams)/i,
  product_summary: /(operating system|platform|copilot|assistant|we (build|are building)|does)/i,
  industry: /(veterinary|construction|logistics|freight|accounting|healthcare|legal|productivity)/i,
  vertical: /(estimating|practice|brokerage|bookkeeping|documentation|scheduling)/i,
  funding_stage: /\b(pre-?seed|seed|series [a-d])\b/i,
  geography: /\b(united states|us|uk|europe|canada|emea|apac)\b/i,
  pipeline: /(pipeline|in paid pilot|converting|lois?)/i,
  founder_market_fit: /(practised|practiced|ran a|operated|years in|worked in|estimators)/i,
  requested_check: /(check size|asking for|allocation of)\s*\$?\s?[\d.,]+/i,
  website: /https?:\/\/[^\s)]+/i,
  company_name: /^[A-Z][\w.& -]{1,40}/,
};

function mockExtractDeal(context: MockContext, sources: MockSource[]) {
  const fields: Record<string, unknown> = {};
  const fieldNames = asStringArray(context.fields);
  for (const name of fieldNames.length ? fieldNames : Object.keys(FIELD_PATTERNS)) {
    const pattern = FIELD_PATTERNS[name];
    const hit = pattern ? findQuote(sources, pattern) : null;
    fields[name] = {
      value: hit ? hit.quote : null,
      source_type: hit && hit.page != null ? 'document' : hit ? 'founder_claim' : 'model_inference',
      citation: cite(hit),
      confidence: hit ? 0.72 : 0,
    };
  }

  const founders: unknown[] = [];
  const founderRe =
    /(?:^|\n)\s*(?:Dr\.\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-zA-Z-]+){1,2})\s*[,—-]\s*(CEO|CTO|Founder[^\n,.]*|Co-?founder[^\n,.]*)/g;
  for (const s of sources) {
    let m: RegExpExecArray | null;
    while ((m = founderRe.exec(s.text)) !== null && founders.length < 5) {
      founders.push({
        name: m[1] ?? '',
        role: m[2] ?? null,
        email: null,
        background: null,
        citation: { source_id: s.id, page: s.page, quote: (m[0] ?? '').trim().slice(0, 200) },
      });
    }
  }

  const risks: unknown[] = [];
  const riskPatterns: [RegExp, string][] = [
    [/churn/i, 'Churn is mentioned in the source material and should be quantified by cohort.'],
    [
      /unproven|not yet set|no .* forecast|haven'?t set/i,
      'The founder describes part of the offering or the round as unsettled.',
    ],
    [
      /exclusive|licence|license/i,
      'Data rights depend on a licence whose terms beyond the initial period are not stated.',
    ],
    [
      /lost .* to|competitor|crowded|funded companies/i,
      'Competitive pressure is acknowledged in the sources.',
    ],
  ];
  for (const [re, text] of riskPatterns) {
    const hit = findQuote(sources, re);
    if (hit) risks.push({ risk: text, citation: cite(hit) });
  }

  const scan = scanForInjection(sources.map((s) => s.text).join('\n'));

  return {
    fields,
    founders,
    existing_investors: [],
    referral_source: null,
    risks,
    open_questions: buildOpenQuestions(fields),
    suspicious_content_notes: scan.signals
      .filter((s) => s.severity === 'high')
      .slice(0, 3)
      .map((s) => `Source text matched ${s.pattern}: ${s.excerpt.slice(0, 160)}`),
  };
}

function buildOpenQuestions(fields: Record<string, unknown>): string[] {
  const missing = Object.entries(fields)
    .filter(([, v]) => (v as { value: string | null }).value === null)
    .map(([k]) => k);
  const questions: string[] = [];
  if (missing.includes('revenue'))
    questions.push('What is current revenue, and on what basis (MRR or ARR)?');
  if (missing.includes('customer_count'))
    questions.push('How many paying customers are there today?');
  if (missing.includes('valuation_or_cap'))
    questions.push('What is the target post-money or cap for this round?');
  if (missing.includes('competition'))
    questions.push(
      'Who else is selling into this buyer, and what has been won or lost against them?',
    );
  if (missing.includes('founder_market_fit'))
    questions.push('What is each founder’s direct operating experience in this vertical?');
  if (missing.includes('defensibility'))
    questions.push('What compounds here that a fast follower could not replicate in a year?');
  return questions.slice(0, 8);
}

/* --------------------------------------------------------- deal analysis */

interface WeightSpec {
  key: string;
  label: string;
  weight: number;
}

function mockAnalyzeDeal(context: MockContext, sources: MockSource[]) {
  const weights = (
    Array.isArray(context.scoring_weights) ? context.scoring_weights : []
  ) as WeightSpec[];
  const deal = (context.deal ?? {}) as Record<string, unknown>;
  const thesisKeywords = asStringArray(context.thesis_keywords);
  const priorDecisions = (
    Array.isArray(context.prior_decisions) ? context.prior_decisions : []
  ) as {
    deal_id: string;
    company: string;
    decision: string;
    rationale: string;
  }[];

  const allText = sources
    .map((s) => s.text)
    .join('\n')
    .toLowerCase();
  const dealText = Object.values(deal)
    .filter((v) => typeof v === 'string')
    .join(' ')
    .toLowerCase();
  const corpus = `${allText}\n${dealText}`;

  const evidenceFor = (key: string): RegExp | null => {
    switch (key) {
      case 'thesis_fit':
        return /vertical|industry|clinic|contractor|firm|practice|workflow/i;
      case 'team':
        return /founder|ceo|cto|years|practised|practiced|ran a|operated|estimator/i;
      case 'problem':
        return /hours per week|manual|turnover|takes .* days|lose|pain/i;
      case 'product':
        return /model|fine-?tuned|ambient|automat|extraction|corpus/i;
      case 'market':
        return /market|practices|clinics in the|contractors|firms|tam/i;
      case 'traction':
        return /mrr|arr|paying|customers|retention|nrr|churn/i;
      case 'defensibility':
        return /proprietary|licensed|exclusive|corpus|integrations|moat/i;
      case 'timing':
        return /competitor|category|funded companies|announced|crowded/i;
      case 'economics':
        return /raising|committed|post-?money|cap|round/i;
      case 'value_add':
        return /intro|gtm|hiring|network|fundrais/i;
      default:
        return null;
    }
  };

  const horizontal = /any team, any industry|every team|works everywhere|horizontal/.test(corpus);
  const verticalSignals = thesisKeywords.filter((k) => corpus.includes(k.toLowerCase())).length;

  const categories = weights.map((w) => {
    const re = evidenceFor(w.key);
    const hit = re ? findQuote(sources, re) : null;
    if (!hit) {
      return {
        key: w.key,
        score: null,
        rationale: `No source in this deal speaks to ${w.label.toLowerCase()}. Recorded as unscored rather than zero so it lowers confidence, not quality.`,
        citations: [],
      };
    }
    let score = 62;
    if (w.key === 'thesis_fit') {
      score = horizontal ? 18 : Math.min(95, 55 + verticalSignals * 8);
    } else if (w.key === 'traction') {
      score = /nrr|net revenue retention|118|121/.test(corpus)
        ? 78
        : /mrr|arr/.test(corpus)
          ? 64
          : 45;
      if (/6% monthly|churn is 6/.test(corpus)) score = 28;
    } else if (w.key === 'team') {
      score = /practised|practiced|ran a|sold that group|estimators/.test(corpus)
        ? 86
        : /have not worked in a specific vertical|none of us have worked/.test(corpus)
          ? 24
          : 58;
    } else if (w.key === 'defensibility') {
      score = /licensed|exclusive|corpus/.test(corpus) ? 74 : 45;
    } else if (w.key === 'timing') {
      score = /crowded|nine funded|lost .* to/.test(corpus) ? 44 : 60;
    }
    return {
      key: w.key,
      score,
      rationale: `${w.label}: assessed from the source material. ${hit.quote.slice(0, 180)}`,
      citations: [cite(hit)].filter(Boolean),
    };
  });

  const scored = categories.filter((c) => c.score !== null);
  const attempted = weights
    .filter((w) => scored.some((c) => c.key === w.key))
    .reduce((sum, w) => sum + w.weight, 0);
  const earned = scored.reduce((sum, c) => {
    const w = weights.find((x) => x.key === c.key);
    return sum + ((c.score ?? 0) / 100) * (w?.weight ?? 0);
  }, 0);
  const normalized = attempted > 0 ? Math.round((earned / attempted) * 100) : 0;
  const completeness = Math.round((scored.length / Math.max(1, weights.length)) * 100);

  const redFlags: unknown[] = [];
  if (horizontal) {
    const hit = findQuote(sources, /any team, any industry|every team|works everywhere/i);
    redFlags.push({
      label: 'Horizontal product with no vertical ownership',
      severity: 'hard',
      detail:
        'The company positions itself as industry-agnostic. That is a direct mismatch with a thesis built on owning a vertical workflow.',
      citations: [cite(hit)].filter(Boolean),
    });
  }
  const churnHit = findQuote(sources, /churn is \d+% monthly|6% monthly/i);
  if (churnHit) {
    redFlags.push({
      label: 'Monthly logo churn',
      severity: 'hard',
      detail: 'Monthly logo churn at this level compounds faster than the growth described.',
      citations: [cite(churnHit)],
    });
  }
  const licenceHit = findQuote(sources, /exclusive|licence|license/i);
  if (licenceHit && !horizontal) {
    redFlags.push({
      label: 'Data rights beyond the licence term are unresolved',
      severity: 'soft',
      detail:
        'The proprietary data advantage rests on a licence whose terms after the initial period are not stated in the sources.',
      citations: [cite(licenceHit)],
    });
  }

  const hasHardFlag = redFlags.some((f) => (f as { severity: string }).severity === 'hard');

  let recommendation: string;
  if (completeness < 35) recommendation = 'INSUFFICIENT_DATA';
  else if (hasHardFlag) recommendation = horizontal ? 'PASS' : 'MONITOR';
  else if (normalized >= 74) recommendation = 'ADVANCE';
  else if (normalized >= 58) recommendation = 'DIG_DEEPER';
  else if (normalized >= 45) recommendation = 'MONITOR';
  else recommendation = 'PASS';

  const company = String(deal.company_name ?? 'This company');
  const revenueHit = findQuote(sources, /\$\s?[\d.,]+\s?(k|m)?\s*(mrr|arr)/i);
  const strongest = categories
    .filter((c) => (c.score ?? 0) >= 70)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
  const weakest = categories
    .filter((c) => c.score !== null)
    .sort((a, b) => (a.score ?? 0) - (b.score ?? 0))[0];

  const comparable = priorDecisions.slice(0, 2).map((d) => ({
    deal_id: d.deal_id,
    why_comparable: `${d.company} sat in an adjacent position on the same axis being assessed here.`,
    what_we_decided: `${d.decision.toUpperCase()} — ${d.rationale.slice(0, 200)}`,
  }));

  return {
    thirty_second_overview: `${company}: ${sentence(
      String(deal.product_summary ?? 'product description not stated in the sources'),
    )} ${
      revenueHit
        ? `Reported: ${clause(revenueHit.quote, 120)}`
        : 'No revenue figure appears in the sources.'
    } The decision turns on ${weakest ? weakest.key.replace(/_/g, ' ') : 'evidence coverage'}.`,
    recommendation,
    headline: `${recommendation.replace(/_/g, ' ')} — ${normalized}/100 on ${attempted} of ${weights.reduce((s, w) => s + w.weight, 0)} points attempted`,
    rationale: hasHardFlag
      ? `An unresolved hard red flag caps this regardless of the underlying score.`
      : `Normalised score of ${normalized} against the configured thresholds, on ${completeness}% category coverage.`,
    confidence: Math.max(10, Math.min(90, Math.round(completeness * 0.8))),
    evidence_quality: sources.length >= 2 ? 68 : 40,
    categories,
    strongest_evidence: strongest
      ? strongest.rationale
      : 'No category cleared a strong threshold on the available evidence.',
    biggest_concern:
      (redFlags[0] as { detail?: string } | undefined)?.detail ??
      weakest?.rationale ??
      'Coverage is too thin to name a single dominant concern.',
    missing_information: categories
      .filter((c) => c.score === null)
      .map((c) => `No evidence for ${c.key.replace(/_/g, ' ')}.`)
      .slice(0, 8),
    recommended_next_step:
      recommendation === 'PASS'
        ? 'Send a courteous pass note stating the specific reason.'
        : recommendation === 'INSUFFICIENT_DATA'
          ? 'Request the missing items listed below before spending more time.'
          : 'Book a working session with the founder focused on the diligence questions below.',
    diligence_questions: buildOpenQuestions(
      Object.fromEntries(categories.map((c) => [c.key, { value: c.score === null ? null : 'x' }])),
    ).slice(0, 5),
    upside_case: `If the strongest evidence holds under diligence, ${company} becomes the record of how this workflow is run, and expansion follows the same buyer.`,
    downside_case: `If the concerns above are real, ${company} is a feature inside someone else's system of record, with pricing power set by whoever owns the workflow.`,
    red_flags: redFlags,
    competitive_context:
      findQuote(sources, /competitor|lost .* to|category has|funded companies/i)?.quote ?? null,
    comparable_prior_deals: comparable,
  };
}

/* -------------------------------------------------------------- outlook */

interface OutlookContextItem {
  kind: string;
  title: string;
  detail: string;
  source_id?: string | null;
  href?: string | null;
  occurred_at?: string | null;
}

function mockOutlook(context: MockContext) {
  const items = (Array.isArray(context.items) ? context.items : []) as OutlookContextItem[];
  const byKind = (kind: string) =>
    items
      .filter((i) => i.kind === kind)
      .map((i) => ({
        kind: i.kind,
        title: i.title,
        detail: i.detail,
        citations: i.source_id ? [{ source_id: i.source_id, page: null, quote: null }] : [],
        is_suggestion: false,
      }));

  const meetings = byKind('meeting');
  const overdue = items.filter((i) => i.kind === 'follow_up' && /overdue/i.test(i.detail));
  const newDeals = byKind('new_deal');
  const portfolio = byKind('portfolio_request');
  const lp = byKind('lp_item');

  const priorities = [...lp, ...portfolio, ...newDeals]
    .slice(0, 3)
    .map((i) => ({ ...i, kind: 'priority' as const }));

  const lead =
    overdue.length > 0
      ? `${overdue.length} follow-up${overdue.length === 1 ? ' is' : 's are'} overdue.`
      : newDeals.length > 0
        ? `${newDeals.length} new deal${newDeals.length === 1 ? '' : 's'} arrived.`
        : 'Nothing is overdue.';

  const outlook = `${lead} ${meetings.length} meeting${meetings.length === 1 ? '' : 's'} today${
    meetings[0] ? `, starting with ${meetings[0].title}` : ''
  }. ${lp.length > 0 ? 'An LP is waiting on a direct answer. ' : ''}${
    portfolio.length > 0
      ? `${portfolio.length} portfolio request${portfolio.length === 1 ? '' : 's'} open. `
      : ''
  }${newDeals.length > 0 ? `Newest inbound: ${newDeals[0]?.title ?? ''}.` : ''}`.trim();

  return {
    outlook,
    priorities,
    meetings,
    emails: byKind('email'),
    new_deals: newDeals,
    awaiting_decision: byKind('awaiting_decision'),
    follow_ups: byKind('follow_up'),
    portfolio_requests: portfolio,
    lp_items: lp,
    market_signals: byKind('market_signal'),
    recommended_actions: [...priorities, ...overdue.map((o) => ({ title: o.title }))]
      .slice(0, 6)
      .map((p) => p.title),
  };
}

/* ---------------------------------------------------- portfolio + drafts */

function mockPortfolioUpdate(context: MockContext, sources: MockSource[]) {
  const text = sources.map((s) => s.text).join('\n');
  const lower = text.toLowerCase();
  const contacts = (Array.isArray(context.network_contacts) ? context.network_contacts : []) as {
    id: string;
    full_name: string;
    expertise: string[];
    relationship: string | null;
  }[];

  let requestType: string | null = 'general_update';
  let urgency: string | null = 'low';
  if (/intro.*investor|series a|investor intro/.test(lower)) {
    requestType = 'investor_introduction';
    urgency = 'high';
  } else if (/founding engineer|hiring|recruit|candidate|placement/.test(lower)) {
    requestType = 'candidate_request';
    urgency = 'medium';
  } else if (/customer intro|warm intro.*customer|pipeline help/.test(lower)) {
    requestType = 'customer_introduction';
    urgency = 'medium';
  } else if (/runway|down round|bridge|urgent|emergency/.test(lower)) {
    requestType = 'urgent_problem';
    urgency = 'high';
  } else if (/board|deck for the board/.test(lower)) {
    requestType = 'board_preparation';
    urgency = 'medium';
  } else if (/gtm|go-to-market|positioning|pricing/.test(lower)) {
    requestType = 'gtm_strategy';
    urgency = 'medium';
  }

  // Only ever suggest people who are actually in the supplied network list.
  const wanted =
    requestType === 'investor_introduction'
      ? ['seed', 'follow-on', 'investor']
      : requestType === 'candidate_request'
        ? ['recruiting', 'hiring', 'talent']
        : [];
  const matches = contacts
    .filter((c) =>
      wanted.some(
        (w) =>
          c.expertise.some((e) => e.toLowerCase().includes(w)) ||
          (c.relationship ?? '').toLowerCase().includes(w),
      ),
    )
    .slice(0, 2);

  const metrics = Array.from(
    text.matchAll(/\$[\d.,]+[KMB]?\s*(ARR|MRR)|\b\d+%\b|\b\d+\s+(firms|clinics|months)\b/gi),
  )
    .map((m) => m[0])
    .slice(0, 8);

  const firstLine =
    text
      .split('\n')
      .find((l) => l.trim().length > 30)
      ?.trim() ?? 'Update received.';

  return {
    summary: firstLine.slice(0, 600),
    request_type: requestType,
    request_detail: requestType === 'general_update' ? null : firstLine.slice(0, 400),
    urgency,
    suggested_action:
      matches.length > 0
        ? `Introduce them to ${matches.map((m) => m.full_name).join(' and ')} from the network.`
        : 'No one in the uploaded network data matches this request. Handle directly or import more contacts.',
    suggested_network_contact_ids: matches.map((m) => m.id),
    metrics_mentioned: metrics,
    citations: sources.slice(0, 2).map((s) => ({ source_id: s.id, page: s.page, quote: null })),
  };
}

function mockDraft(context: MockContext, sources: MockSource[]) {
  const kind = String(context.kind ?? 'generic_reply');
  const company = String(context.company_name ?? 'your company');
  const recipient = String(context.recipient_first_name ?? 'there');
  const missing = asStringArray(context.missing_information);
  const reason = String(context.reason ?? '');
  const facts: string[] = [];

  let subject: string;
  let body: string;

  switch (kind) {
    case 'missing_information':
      subject = `${company} — a few things before we go further`;
      body = `Hi ${recipient},

Thanks for sending this over. Before I take it further internally I need a few specifics:

${(missing.length ? missing : ['The current revenue figure and whether it is MRR or ARR.']).map((m, i) => `${i + 1}. ${m}`).join('\n')}

Each of these changes the answer rather than just filling a form, so I would rather ask than assume.

Nick`;
      break;
    case 'pass':
      subject = `${company} — passing for now`;
      body = `Hi ${recipient},

Thanks for the time and for sharing the detail — it was more useful than most.

We're going to pass. ${reason || 'The fit with what we focus on is not close enough for us to be a useful investor here.'}

That is a judgement about our own focus, not a prediction about the company. Happy to stay in touch.

Nick`;
      break;
    case 'meeting_request':
      subject = `${company} — working session?`;
      body = `Hi ${recipient},

I'd like to spend an hour on this properly rather than do another overview call.

What I'd want to get through:
${(missing.length ? missing : ['The parts of the model that are load-bearing.']).map((m) => `• ${m}`).join('\n')}

Send a couple of times that work and I'll make one of them work.

Nick`;
      break;
    case 'follow_up':
      subject = `${company} — following up`;
      body = `Hi ${recipient},

Following up on the below. ${reason || 'No rush if the timing is wrong — just let me know either way.'}

${missing.length ? `Specifically:\n${missing.map((m) => `• ${m}`).join('\n')}\n` : ''}
Nick`;
      break;
    case 'portfolio_reply':
      subject = `Re: ${String(context.subject ?? 'your update')}`;
      body = `Hi ${recipient},

Got it — thanks for the clear numbers.

${reason || 'I can help with the ask. Let me come back to you this week with names.'}

Nick`;
      break;
    default:
      subject = `Re: ${String(context.subject ?? company)}`;
      body = `Hi ${recipient},

${reason || 'Thanks — noted. I will come back to you shortly.'}

Nick`;
  }

  for (const s of sources.slice(0, 3)) {
    const line = s.text.split('\n').find((l) => /\$|\d+%|\d+\s+(clinics|firms|customers)/.test(l));
    if (line) facts.push(line.trim().slice(0, 200));
  }

  return {
    subject,
    body,
    intent:
      kind === 'pass'
        ? 'Decline clearly and courteously with the real reason.'
        : kind === 'missing_information'
          ? 'Request the specific items needed to make a decision.'
          : 'Move the conversation forward.',
    asserted_facts: facts,
  };
}

/* ------------------------------------------------------------ comparison */

function mockCompare(context: MockContext, sources: MockSource[]) {
  const deals = (Array.isArray(context.deals) ? context.deals : []) as {
    id: string;
    company_name: string;
    revenue: string | null;
    traction: string | null;
    team: string | null;
    founder_market_fit: string | null;
    competition: string | null;
    stage: string;
  }[];

  const dimensions = [
    { key: 'revenue', label: 'Revenue and traction' },
    { key: 'founder_market_fit', label: 'Founder-market fit' },
    { key: 'competition', label: 'Competitive position' },
  ].map((d) => {
    const values = deals.map((deal) => ({
      deal_id: deal.id,
      value: (deal as unknown as Record<string, string | null>)[d.key],
    }));
    const known = values.filter((v) => v.value);
    const best = known.sort((a, b) => (b.value?.length ?? 0) - (a.value?.length ?? 0))[0];
    return {
      dimension: d.label,
      assessments: values.map((v) => ({
        deal_id: v.deal_id,
        assessment: v.value ?? `Not stated in the sources for this company.`,
        stronger: v.value ? v.deal_id === best?.deal_id : null,
      })),
    };
  });

  const named = deals.map((d) => d.company_name).join(' and ');
  const withData = deals.filter((d) => d.revenue || d.traction);

  return {
    answer:
      deals.length < 2
        ? 'Fewer than two comparable deals were supplied, so there is nothing to compare.'
        : `Between ${named}, ${withData[0]?.company_name ?? deals[0]?.company_name} has the more complete evidence base and is the one worth an hour first. The comparison is limited wherever one side has data and the other does not — those rows are marked rather than guessed.`,
    dimensions,
    what_would_change_the_answer: [
      'Estimating or output accuracy measured against a held-out set of real work for both companies.',
      'Cohort retention rather than blended retention for each.',
      'Which of the two the shared buyer actually renewed.',
    ],
    citations: sources.slice(0, 4).map((s) => ({ source_id: s.id, page: s.page, quote: null })),
  };
}

/* ------------------------------------------------------------- injection */

function mockInjection(sources: MockSource[], prompt: string) {
  const scan = scanForInjection(sources.map((s) => s.text).join('\n') || prompt);
  return {
    contains_injection: scan.flagged,
    severity: scan.highestSeverity ?? 'none',
    suspicious_spans: scan.signals.slice(0, 6).map((s) => s.excerpt.slice(0, 300)),
    explanation: scan.flagged
      ? `Matched ${scan.signals.length} pattern(s), highest severity ${scan.highestSeverity}. The content was treated as data and its instructions were not followed.`
      : 'No manipulation patterns detected.',
  };
}

/* ------------------------------------------------------------- chat mock */

function lastUserQuestion(messages: { role: string; content: string }[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'user') {
      const q = /Question:\s*([\s\S]*)$/.exec(m.content);
      return (q?.[1] ?? m.content).trim();
    }
  }
  return '';
}

function planTools(
  question: string,
  available: string[],
): { name: string; input: Record<string, unknown> }[] {
  const q = question.toLowerCase();
  const plan: { name: string; input: Record<string, unknown> }[] = [];
  const has = (n: string) => available.includes(n);

  if (/today|outlook|attention|what should i do/.test(q) && has('get_daily_outlook')) {
    plan.push({ name: 'get_daily_outlook', input: {} });
  }
  if (/email|inbox|since yesterday|came in/.test(q) && has('search_recent_email')) {
    plan.push({ name: 'search_recent_email', input: { query: keywords(question), days: 3 } });
  }
  if (/overdue|follow-?up|due/.test(q) && has('list_due_tasks')) {
    plan.push({ name: 'list_due_tasks', input: { include_overdue: true } });
  }
  if (/portfolio|help|intro/.test(q) && has('search_portfolio_updates')) {
    plan.push({ name: 'search_portfolio_updates', input: { open_only: true } });
  }
  if (/compare|versus|vs\b|other construction/.test(q) && has('search_deals')) {
    plan.push({ name: 'search_deals', input: { query: keywords(question), limit: 5 } });
  }
  if (/pass|passed|before|similar|seen something/.test(q) && has('search_prior_decisions')) {
    plan.push({ name: 'search_prior_decisions', input: { query: keywords(question) } });
  }
  if (/thesis|playbook|market map|knowledge/.test(q) && has('search_knowledge')) {
    plan.push({ name: 'search_knowledge', input: { query: keywords(question) } });
  }
  if (/meeting|calendar|schedule/.test(q) && has('list_calendar_events')) {
    plan.push({ name: 'list_calendar_events', input: { days: 1 } });
  }
  if (plan.length === 0 && has('search_deals')) {
    plan.push({ name: 'search_deals', input: { query: keywords(question), limit: 5 } });
  }
  if (plan.length === 0 && has('get_daily_outlook')) {
    plan.push({ name: 'get_daily_outlook', input: {} });
  }
  return plan.slice(0, 3);
}

function keywords(question: string): string {
  const stop = new Set([
    'what',
    'which',
    'the',
    'and',
    'for',
    'are',
    'was',
    'were',
    'have',
    'has',
    'did',
    'does',
    'about',
    'from',
    'that',
    'this',
    'with',
    'into',
    'should',
    'would',
    'could',
    'any',
    'all',
    'give',
    'tell',
    'show',
    'find',
    'me',
    'my',
    'is',
    'do',
    'of',
    'in',
    'on',
    'to',
    'a',
    'an',
  ]);
  return question
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2 && !stop.has(w))
    .slice(0, 6)
    .join(' ');
}

function extractToolCitations(
  content: string,
): { source_id: string; label: string; snippet: string }[] {
  try {
    const parsed = JSON.parse(content) as {
      citations?: { id: string; label: string }[];
      results?: unknown[];
    };
    if (Array.isArray(parsed.citations)) {
      return parsed.citations.map((c) => ({ source_id: c.id, label: c.label, snippet: c.label }));
    }
  } catch {
    // Non-JSON tool output is fine; it just carries no structured citations.
  }
  return [];
}

function composeChatAnswer(
  question: string,
  outcomes: ToolOutcome[],
  evidence: { source_id: string; label: string; snippet: string }[],
) {
  const successful = outcomes.filter((o) => o.ok);
  const summaries = successful.map((o) => o.summary).filter(Boolean);

  const answer =
    summaries.length > 0
      ? `${summaries[0]}${summaries[1] ? ` ${summaries[1]}` : ''}`
      : 'Nothing in the connected records answers that. Nothing was invented to fill the gap.';

  return {
    answer,
    supporting_evidence: evidence.slice(0, 6).map((e) => ({
      point: e.label,
      citation: { source_id: e.source_id, page: null, quote: null },
      kind: 'fact' as const,
    })),
    unknowns:
      successful.length === 0
        ? ['No matching records were found for this question.']
        : summaries
            .slice(2)
            .map((s) => `Not covered here: ${s}`)
            .slice(0, 3),
    next_actions: summaries.length > 0 ? ['Open the cited record to see the full context.'] : [],
  };
}

/* ------------------------------------------------------------- coercion */

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * Last-resort shaping so demo mode never hard-fails on a schema mismatch we
 * introduced while editing the mock. Real provider output is never coerced —
 * a mismatch there is a genuine failure and is surfaced as one.
 */
function coerceToSchema(schema: z.ZodType, raw: unknown): unknown {
  const attempt = schema.safeParse(raw);
  if (attempt.success) return attempt.data;
  const fallback = schema.safeParse({});
  if (fallback.success) return fallback.data;
  return raw;
}
