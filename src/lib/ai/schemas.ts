import { z } from 'zod';
import { EMAIL_CATEGORIES, PORTFOLIO_REQUEST_TYPES, RECOMMENDATIONS } from '@/lib/types/domain';

/**
 * Runtime schemas for every structured model output.
 *
 * These are the contract, not the prompt. A response that does not validate is
 * a typed failure (`invalid_model_output`) and never reaches business logic.
 * The same schema is converted to JSON Schema and sent as
 * `output_config.format`, so the model is constrained on the way out and
 * checked again on the way in.
 *
 * Design rule visible throughout: every "I don't know" is representable.
 * `.nullable()` on a fact field is deliberate — it is how the model says
 * "not stated" without inventing a value.
 */

/* ------------------------------------------------------------- citations */

export const citationRefSchema = z.object({
  /** Must match a source-id supplied in the prompt. Validated post-hoc. */
  source_id: z.string().min(1),
  page: z.number().int().positive().nullable(),
  quote: z.string().max(500).nullable(),
});
export type CitationRef = z.infer<typeof citationRefSchema>;

/* ---------------------------------------------------- email classification */

export const emailClassificationSchema = z.object({
  category: z.enum(EMAIL_CATEGORIES),
  confidence: z.number().min(0).max(1),
  /** 0–100. Drives Today's "important email" section. */
  importance: z.number().int().min(0).max(100),
  reason: z.string().min(1).max(400),
  /** Company name if this looks like a deal; null otherwise. */
  company_name: z.string().max(200).nullable(),
  /** True when the message warrants fetching the full body and attachments. */
  warrants_deep_fetch: z.boolean(),
  /** True when the message contains text aimed at manipulating an AI assistant. */
  contains_instruction_to_ai: z.boolean(),
});
export type EmailClassification = z.infer<typeof emailClassificationSchema>;

/* ------------------------------------------------------- deal extraction */

const extractedFieldSchema = z.object({
  value: z.string().max(2000).nullable(),
  source_type: z.enum(['founder_claim', 'third_party_claim', 'document', 'model_inference', 'web']),
  citation: citationRefSchema.nullable(),
  confidence: z.number().min(0).max(1),
});
export type ExtractedField = z.infer<typeof extractedFieldSchema>;

export const DEAL_EXTRACTION_FIELDS = [
  'company_name',
  'website',
  'industry',
  'vertical',
  'geography',
  'funding_stage',
  'round_size',
  'amount_raised',
  'valuation_or_cap',
  'requested_check',
  'product_summary',
  'customer',
  'problem',
  'solution',
  'ai_usage',
  'traction',
  'revenue',
  'growth',
  'customer_count',
  'pipeline',
  'business_model',
  'pricing',
  'market',
  'competition',
  'team',
  'founder_market_fit',
  'gtm_motion',
  'defensibility',
  'data_advantage',
] as const;

export const dealExtractionSchema = z.object({
  fields: z.object(
    Object.fromEntries(DEAL_EXTRACTION_FIELDS.map((f) => [f, extractedFieldSchema])) as Record<
      (typeof DEAL_EXTRACTION_FIELDS)[number],
      typeof extractedFieldSchema
    >,
  ),
  founders: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        role: z.string().max(200).nullable(),
        email: z.string().max(320).nullable(),
        background: z.string().max(1000).nullable(),
        citation: citationRefSchema.nullable(),
      }),
    )
    .max(10),
  existing_investors: z.array(z.string().max(200)).max(20),
  referral_source: z.string().max(300).nullable(),
  risks: z
    .array(
      z.object({
        risk: z.string().min(1).max(500),
        citation: citationRefSchema.nullable(),
      }),
    )
    .max(12),
  open_questions: z.array(z.string().min(1).max(400)).max(12),
  /** Anything in the sources that looked like an instruction aimed at the model. */
  suspicious_content_notes: z.array(z.string().max(400)).max(5),
});
export type DealExtraction = z.infer<typeof dealExtractionSchema>;

/* --------------------------------------------------------- deal analysis */

export const scorecardCategorySchema = z.object({
  key: z.string().min(1).max(64),
  /**
   * 0–100 within the category, or null when there is not enough evidence.
   * Null is scored as "unattempted", never as zero.
   */
  score: z.number().int().min(0).max(100).nullable(),
  rationale: z.string().min(1).max(800),
  citations: z.array(citationRefSchema).max(6),
});

export const redFlagSchema = z.object({
  label: z.string().min(1).max(160),
  severity: z.enum(['hard', 'soft']),
  detail: z.string().min(1).max(800),
  citations: z.array(citationRefSchema).max(4),
});

export const dealAnalysisSchema = z.object({
  thirty_second_overview: z.string().min(1).max(900),
  recommendation: z.enum(RECOMMENDATIONS),
  headline: z.string().min(1).max(220),
  rationale: z.string().min(1).max(500),
  confidence: z.number().int().min(0).max(100),
  evidence_quality: z.number().int().min(0).max(100),
  categories: z.array(scorecardCategorySchema).min(1).max(20),
  strongest_evidence: z.string().min(1).max(800),
  biggest_concern: z.string().min(1).max(800),
  missing_information: z.array(z.string().min(1).max(300)).max(12),
  recommended_next_step: z.string().min(1).max(400),
  diligence_questions: z.array(z.string().min(1).max(400)).max(5),
  upside_case: z.string().min(1).max(1200),
  downside_case: z.string().min(1).max(1200),
  red_flags: z.array(redFlagSchema).max(10),
  competitive_context: z.string().max(1500).nullable(),
  comparable_prior_deals: z
    .array(
      z.object({
        deal_id: z.string().min(1),
        why_comparable: z.string().min(1).max(400),
        what_we_decided: z.string().max(400).nullable(),
      }),
    )
    .max(5),
});
export type DealAnalysisOutput = z.infer<typeof dealAnalysisSchema>;

/* ---------------------------------------------------------- daily outlook */

const briefItemSchema = z.object({
  kind: z.enum([
    'priority',
    'meeting',
    'email',
    'new_deal',
    'awaiting_decision',
    'follow_up',
    'portfolio_request',
    'lp_item',
    'market_signal',
  ]),
  title: z.string().min(1).max(200),
  detail: z.string().min(1).max(600),
  citations: z.array(citationRefSchema).max(4),
  /** True when this is the model's suggestion rather than a stored record. */
  is_suggestion: z.boolean(),
});

export const dailyOutlookSchema = z.object({
  outlook: z.string().min(1).max(1200),
  priorities: z.array(briefItemSchema).max(3),
  meetings: z.array(briefItemSchema).max(12),
  emails: z.array(briefItemSchema).max(10),
  new_deals: z.array(briefItemSchema).max(10),
  awaiting_decision: z.array(briefItemSchema).max(10),
  follow_ups: z.array(briefItemSchema).max(12),
  portfolio_requests: z.array(briefItemSchema).max(10),
  lp_items: z.array(briefItemSchema).max(8),
  market_signals: z.array(briefItemSchema).max(6),
  recommended_actions: z.array(z.string().min(1).max(300)).max(8),
});
export type DailyOutlookOutput = z.infer<typeof dailyOutlookSchema>;

/* ---------------------------------------------- portfolio classification */

export const portfolioUpdateSchema = z.object({
  summary: z.string().min(1).max(900),
  request_type: z.enum(PORTFOLIO_REQUEST_TYPES).nullable(),
  request_detail: z.string().max(800).nullable(),
  urgency: z.enum(['low', 'medium', 'high']).nullable(),
  suggested_action: z.string().max(800).nullable(),
  /**
   * Ids of network contacts supplied in the prompt. The model may only choose
   * from that list — it is never allowed to name someone who is not in it.
   */
  suggested_network_contact_ids: z.array(z.string()).max(3),
  metrics_mentioned: z.array(z.string().max(200)).max(10),
  citations: z.array(citationRefSchema).max(6),
});
export type PortfolioUpdateOutput = z.infer<typeof portfolioUpdateSchema>;

/* ----------------------------------------------------------- draft reply */

export const draftReplySchema = z.object({
  subject: z.string().min(1).max(250),
  body: z.string().min(1).max(6000),
  /** What the draft is asking for or communicating, in one line. */
  intent: z.string().min(1).max(300),
  /** Facts the draft asserts, so Nick can check them before sending. */
  asserted_facts: z.array(z.string().max(300)).max(8),
});
export type DraftReplyOutput = z.infer<typeof draftReplySchema>;

/* ------------------------------------------------------- deal comparison */

export const dealComparisonSchema = z.object({
  answer: z.string().min(1).max(1500),
  dimensions: z
    .array(
      z.object({
        dimension: z.string().min(1).max(120),
        assessments: z
          .array(
            z.object({
              deal_id: z.string().min(1),
              assessment: z.string().min(1).max(500),
              /** null when the dimension is unknown for that deal. */
              stronger: z.boolean().nullable(),
            }),
          )
          .min(1)
          .max(4),
      }),
    )
    .max(10),
  what_would_change_the_answer: z.array(z.string().max(300)).max(5),
  citations: z.array(citationRefSchema).max(12),
});
export type DealComparisonOutput = z.infer<typeof dealComparisonSchema>;

/* ------------------------------------------------------------ chat answer */

export const chatAnswerSchema = z.object({
  /** One or two sentences answering the question directly. Rendered first. */
  answer: z.string().min(1).max(1200),
  supporting_evidence: z
    .array(
      z.object({
        point: z.string().min(1).max(500),
        citation: citationRefSchema.nullable(),
        kind: z.enum(['fact', 'founder_claim', 'third_party_claim', 'inference', 'nick_note']),
      }),
    )
    .max(10),
  unknowns: z.array(z.string().max(300)).max(6),
  next_actions: z.array(z.string().max(300)).max(5),
});
export type ChatAnswerOutput = z.infer<typeof chatAnswerSchema>;

/* -------------------------------------------------- injection detection */

export const injectionDetectionSchema = z.object({
  contains_injection: z.boolean(),
  severity: z.enum(['none', 'low', 'medium', 'high']),
  /** Verbatim spans that look like instructions to a model. */
  suspicious_spans: z.array(z.string().max(400)).max(6),
  explanation: z.string().max(600),
});
export type InjectionDetectionOutput = z.infer<typeof injectionDetectionSchema>;

/* ------------------------------------------------------------ conversion */

/**
 * Anthropic structured outputs require `additionalProperties: false` and a
 * `required` array on every object. `z.toJSONSchema` emits draft 2020-12 with
 * `$ref`/`$defs`; we inline those and strip unsupported keywords so the schema
 * is accepted as-is.
 */
export function toModelJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'output' }) as Record<
    string,
    unknown
  >;
  const defs = (raw.$defs ?? {}) as Record<string, unknown>;
  const inlined = inlineRefs(raw, defs, 0);
  return tighten(inlined) as Record<string, unknown>;
}

function inlineRefs(node: unknown, defs: Record<string, unknown>, depth: number): unknown {
  if (depth > 30 || node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((n) => inlineRefs(n, defs, depth + 1));
  const obj = node as Record<string, unknown>;
  if (typeof obj.$ref === 'string') {
    const key = obj.$ref.replace('#/$defs/', '');
    const target = defs[key];
    if (target) return inlineRefs(structuredClone(target), defs, depth + 1);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === '$defs' || k === '$schema') continue;
    out[k] = inlineRefs(v, defs, depth + 1);
  }
  return out;
}

const UNSUPPORTED_KEYWORDS = new Set([
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'pattern',
  'format',
  'default',
]);

function tighten(node: unknown): unknown {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(tighten);
  const obj = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (UNSUPPORTED_KEYWORDS.has(k)) continue;
    out[k] = tighten(v);
  }
  if (out.type === 'object' && out.properties && typeof out.properties === 'object') {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties as Record<string, unknown>);
  }
  return out;
}
