/**
 * Core domain types. These are shared by the data layer, the services and the
 * UI, and are deliberately free of any provider-specific shape.
 *
 * Convention: a field that is genuinely unknown is `null`, never a placeholder
 * string, `0`, or an empty array. "Unknown" is a first-class value everywhere.
 */

export type Uuid = string;
export type IsoDateTime = string;

/* ----------------------------------------------------------- organization */

export interface Organization {
  id: Uuid;
  name: string;
  slug: string;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer';

export interface OrganizationMember {
  id: Uuid;
  organization_id: Uuid;
  user_id: Uuid;
  role: OrgRole;
  created_at: IsoDateTime;
}

export interface UserProfile {
  id: Uuid;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  timezone: string;
  theme: 'system' | 'light' | 'dark';
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

/* ------------------------------------------------------------ integrations */

export type IntegrationProvider = 'google';
export type IntegrationKind = 'gmail' | 'calendar';
export type IntegrationStatus = 'connected' | 'disconnected' | 'needs_reauth' | 'error';

export interface Integration {
  id: Uuid;
  organization_id: Uuid;
  user_id: Uuid;
  provider: IntegrationProvider;
  kinds: IntegrationKind[];
  account_email: string | null;
  scopes: string[];
  status: IntegrationStatus;
  status_detail: string | null;
  last_sync_at: IsoDateTime | null;
  last_sync_error: string | null;
  /** Provider history cursor (Gmail historyId / Calendar syncToken). */
  sync_cursor: string | null;
  /**
   * When the Gmail `users.watch` registration lapses. Google caps it at seven
   * days, so it is renewed by the daily job. Null means push is not registered
   * and the mailbox is synced on the schedule and on demand instead.
   */
  watch_expires_at: IsoDateTime | null;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

/** Ciphertext envelope. The plaintext token never leaves `lib/security/crypto`. */
export interface EncryptedProviderToken {
  id: Uuid;
  integration_id: Uuid;
  organization_id: Uuid;
  token_type: 'refresh' | 'access';
  ciphertext: string;
  iv: string;
  auth_tag: string;
  key_version: number;
  expires_at: IsoDateTime | null;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

/* ------------------------------------------------------------------ email */

export const EMAIL_CATEGORIES = [
  'new_deal',
  'existing_deal',
  'portfolio_company',
  'lp_or_advisor',
  'co_investor',
  'founder_follow_up',
  'meeting_or_scheduling',
  'newsletter_or_market',
  'administrative',
  'personal_or_unrelated',
  'unknown',
] as const;
export type EmailCategory = (typeof EMAIL_CATEGORIES)[number];

export const EMAIL_CATEGORY_LABELS: Record<EmailCategory, string> = {
  new_deal: 'New deal',
  existing_deal: 'Existing deal',
  portfolio_company: 'Portfolio company',
  lp_or_advisor: 'LP or advisor',
  co_investor: 'Co-investor',
  founder_follow_up: 'Founder follow-up',
  meeting_or_scheduling: 'Meeting / scheduling',
  newsletter_or_market: 'Newsletter / market',
  administrative: 'Administrative',
  personal_or_unrelated: 'Personal / unrelated',
  unknown: 'Unclassified',
};

export interface EmailParticipant {
  name: string | null;
  address: string;
  role: 'from' | 'to' | 'cc' | 'bcc' | 'reply_to';
}

export interface EmailThread {
  id: Uuid;
  organization_id: Uuid;
  provider: IntegrationProvider;
  provider_thread_id: string;
  subject: string | null;
  last_message_at: IsoDateTime;
  message_count: number;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

export interface EmailMessage {
  id: Uuid;
  organization_id: Uuid;
  thread_id: Uuid;
  provider: IntegrationProvider;
  provider_message_id: string;
  subject: string | null;
  snippet: string;
  from_name: string | null;
  from_address: string;
  to_addresses: string[];
  cc_addresses: string[];
  labels: string[];
  is_unread: boolean;
  sent_at: IsoDateTime;
  /** Only populated after an explicit or classifier-triggered deep fetch. */
  body_text: string | null;
  body_fetched_at: IsoDateTime | null;
  body_hash: string | null;
  has_attachments: boolean;
  category: EmailCategory;
  category_confidence: number | null;
  category_source: 'model' | 'human' | 'rule' | null;
  importance: number | null;
  is_ignored: boolean;
  linked_deal_id: Uuid | null;
  linked_portfolio_company_id: Uuid | null;
  injection_flagged: boolean;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

export type ExtractionConfidence = 'high' | 'medium' | 'low';

export interface EmailAttachment {
  id: Uuid;
  organization_id: Uuid;
  message_id: Uuid;
  provider_attachment_id: string | null;
  filename: string;
  safe_filename: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string | null;
  /** Page-aware extracted text. Null until extraction runs. */
  extracted_text: string | null;
  page_count: number | null;
  extraction_confidence: ExtractionConfidence | null;
  extraction_error: string | null;
  needs_review: boolean;
  content_hash: string | null;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

/** One page (or logical section) of an extracted document. */
export interface ExtractedPage {
  page: number;
  text: string;
}

/* --------------------------------------------------------------- calendar */

export interface CalendarEvent {
  id: Uuid;
  organization_id: Uuid;
  user_id: Uuid;
  provider: IntegrationProvider;
  provider_event_id: string;
  title: string;
  description: string | null;
  location: string | null;
  starts_at: IsoDateTime;
  ends_at: IsoDateTime;
  all_day: boolean;
  attendees: { name: string | null; email: string; response: string | null }[];
  organizer_email: string | null;
  is_private: boolean;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

/* ------------------------------------------------------------------ deals */

export interface DealStage {
  key: string;
  label: string;
  order: number;
  /** Terminal stages do not appear in "awaiting decision" counts. */
  terminal: boolean;
}

export const DEFAULT_DEAL_STAGES: DealStage[] = [
  { key: 'new', label: 'New', order: 0, terminal: false },
  { key: 'reviewing', label: 'Reviewing', order: 1, terminal: false },
  { key: 'waiting_for_info', label: 'Waiting for information', order: 2, terminal: false },
  { key: 'founder_meeting', label: 'Founder meeting', order: 3, terminal: false },
  { key: 'diligence', label: 'Diligence', order: 4, terminal: false },
  { key: 'ic_review', label: 'Partner / IC review', order: 5, terminal: false },
  { key: 'passed', label: 'Passed', order: 6, terminal: true },
  { key: 'monitoring', label: 'Monitoring', order: 7, terminal: false },
  { key: 'invested', label: 'Invested', order: 8, terminal: true },
];

export interface Deal {
  id: Uuid;
  organization_id: Uuid;
  company_name: string;
  normalized_name: string;
  website: string | null;
  domain: string | null;
  stage: string;
  industry: string | null;
  vertical: string | null;
  geography: string | null;
  funding_stage: string | null;
  round_size: string | null;
  amount_raised: string | null;
  valuation_or_cap: string | null;
  existing_investors: string[];
  requested_check: string | null;
  referral_source: string | null;
  received_at: IsoDateTime;
  product_summary: string | null;
  customer: string | null;
  problem: string | null;
  solution: string | null;
  ai_usage: string | null;
  traction: string | null;
  revenue: string | null;
  growth: string | null;
  customer_count: string | null;
  pipeline: string | null;
  business_model: string | null;
  pricing: string | null;
  market: string | null;
  competition: string | null;
  team: string | null;
  founder_market_fit: string | null;
  gtm_motion: string | null;
  defensibility: string | null;
  data_advantage: string | null;
  risks: string[];
  open_questions: string[];
  outcome: string | null;
  is_archived: boolean;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

export interface DealPerson {
  id: Uuid;
  organization_id: Uuid;
  deal_id: Uuid;
  name: string;
  role: string | null;
  email: string | null;
  linkedin_url: string | null;
  background: string | null;
  created_at: IsoDateTime;
}

export type DealSourceKind =
  'email_thread' | 'email_message' | 'attachment' | 'manual' | 'knowledge_document' | 'web';

export interface DealSource {
  id: Uuid;
  organization_id: Uuid;
  deal_id: Uuid;
  kind: DealSourceKind;
  /** Points at email_messages.id / email_attachments.id / knowledge_documents.id. */
  ref_id: string | null;
  label: string;
  url: string | null;
  occurred_at: IsoDateTime | null;
  created_at: IsoDateTime;
}

/** Provenance of a fact. Drives the fact/claim/inference badge in the UI. */
export type FactSourceType =
  'founder_claim' | 'third_party_claim' | 'document' | 'model_inference' | 'human' | 'web';

export interface DealFact {
  id: Uuid;
  organization_id: Uuid;
  deal_id: Uuid;
  field: string;
  value: string | null;
  source_type: FactSourceType;
  /** Verbatim supporting text; never paraphrased by the extractor. */
  evidence_quote: string | null;
  citation_id: string | null;
  confidence: number | null;
  version: number;
  superseded_by: Uuid | null;
  created_by: Uuid | null;
  created_at: IsoDateTime;
}

export const RECOMMENDATIONS = [
  'INSUFFICIENT_DATA',
  'PASS',
  'MONITOR',
  'DIG_DEEPER',
  'ADVANCE',
] as const;
export type Recommendation = (typeof RECOMMENDATIONS)[number];

export const RECOMMENDATION_LABELS: Record<Recommendation, string> = {
  INSUFFICIENT_DATA: 'Insufficient data',
  PASS: 'Pass',
  MONITOR: 'Monitor',
  DIG_DEEPER: 'Dig deeper',
  ADVANCE: 'Advance',
};

/** A pointer from a claim back to the record it came from. */
export interface Citation {
  id: string;
  kind:
    | 'email'
    | 'email_thread'
    | 'attachment'
    | 'document'
    | 'calendar_event'
    | 'deal'
    | 'prior_decision'
    | 'portfolio_update'
    | 'note'
    | 'web';
  ref_id: string;
  label: string;
  /** 1-indexed page for paged documents. */
  page: number | null;
  section: string | null;
  url: string | null;
  /** Publication date for web sources; message date for email. */
  occurred_at: IsoDateTime | null;
  retrieved_at: IsoDateTime | null;
  publisher: string | null;
  excerpt: string | null;
}

export interface ScorecardCategoryResult {
  key: string;
  label: string;
  weight: number;
  /** Null when there is not enough evidence to score. Never coerced to 0. */
  score: number | null;
  status: 'scored' | 'unscored';
  rationale: string;
  citation_ids: string[];
}

export interface RedFlag {
  label: string;
  severity: 'hard' | 'soft';
  detail: string;
  resolved: boolean;
  citation_ids: string[];
}

export interface DealAnalysis {
  id: Uuid;
  organization_id: Uuid;
  deal_id: Uuid;
  version: number;
  recommendation: Recommendation;
  headline: string;
  rationale: string;
  /** 0–100 normalised over *attempted* weight only. */
  quality_score: number;
  attempted_weight: number;
  earned_weight: number;
  data_completeness: number;
  evidence_quality: number;
  confidence: number;
  categories: ScorecardCategoryResult[];
  strongest_evidence: string;
  biggest_concern: string;
  missing_information: string[];
  recommended_next_step: string;
  diligence_questions: string[];
  upside_case: string;
  downside_case: string;
  red_flags: RedFlag[];
  competitive_context: string | null;
  comparable_deal_ids: Uuid[];
  citations: Citation[];
  thirty_second_overview: string;
  model: string;
  prompt_version: string;
  source_hash: string;
  generated_at: IsoDateTime;
  generated_by: Uuid | null;
  human_override: {
    recommendation: Recommendation;
    note: string;
    by: Uuid;
    at: IsoDateTime;
  } | null;
  created_at: IsoDateTime;
}

export type DecisionType = 'pass' | 'monitor' | 'dig_deeper' | 'advance' | 'invest' | 'reopen';

export interface DealDecision {
  id: Uuid;
  organization_id: Uuid;
  deal_id: Uuid;
  decision: DecisionType;
  rationale: string;
  /** Always 'human'. The AI cannot write here — enforced in the service layer. */
  actor: 'human';
  decided_by: Uuid;
  decided_at: IsoDateTime;
  analysis_id: Uuid | null;
  created_at: IsoDateTime;
}

export interface DealNote {
  id: Uuid;
  organization_id: Uuid;
  deal_id: Uuid;
  body: string;
  author_id: Uuid;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

export type TaskStatus = 'open' | 'complete' | 'snoozed' | 'cancelled';

export interface Task {
  id: Uuid;
  organization_id: Uuid;
  title: string;
  detail: string | null;
  status: TaskStatus;
  due_at: IsoDateTime | null;
  snoozed_until: IsoDateTime | null;
  deal_id: Uuid | null;
  portfolio_company_id: Uuid | null;
  email_message_id: Uuid | null;
  assigned_to: Uuid | null;
  created_by: Uuid;
  source: 'human' | 'suggested';
  completed_at: IsoDateTime | null;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

/* -------------------------------------------------------------- portfolio */

export interface PortfolioCompany {
  id: Uuid;
  organization_id: Uuid;
  name: string;
  normalized_name: string;
  domain: string | null;
  website: string | null;
  current_stage: string | null;
  latest_round: string | null;
  ownership: string | null;
  key_metrics: string | null;
  current_priorities: string | null;
  upcoming_fundraise: string | null;
  hiring_needs: string | null;
  gtm_needs: string | null;
  risks: string | null;
  last_contact_at: IsoDateTime | null;
  next_follow_up_at: IsoDateTime | null;
  is_archived: boolean;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

export interface PortfolioContact {
  id: Uuid;
  organization_id: Uuid;
  portfolio_company_id: Uuid;
  name: string;
  role: string | null;
  email: string | null;
  is_founder: boolean;
  created_at: IsoDateTime;
}

export const PORTFOLIO_REQUEST_TYPES = [
  'fundraising',
  'gtm_strategy',
  'hiring',
  'candidate_request',
  'customer_introduction',
  'investor_introduction',
  'advisor_request',
  'product_feedback',
  'board_preparation',
  'urgent_problem',
  'general_update',
] as const;
export type PortfolioRequestType = (typeof PORTFOLIO_REQUEST_TYPES)[number];

export const PORTFOLIO_REQUEST_LABELS: Record<PortfolioRequestType, string> = {
  fundraising: 'Fundraising',
  gtm_strategy: 'GTM strategy',
  hiring: 'Hiring',
  candidate_request: 'Candidate request',
  customer_introduction: 'Customer introduction',
  investor_introduction: 'Investor introduction',
  advisor_request: 'Advisor request',
  product_feedback: 'Product feedback',
  board_preparation: 'Board preparation',
  urgent_problem: 'Urgent problem',
  general_update: 'General update',
};

export interface PortfolioUpdate {
  id: Uuid;
  organization_id: Uuid;
  portfolio_company_id: Uuid;
  email_message_id: Uuid | null;
  summary: string;
  request_type: PortfolioRequestType | null;
  request_detail: string | null;
  urgency: 'low' | 'medium' | 'high' | null;
  suggested_action: string | null;
  /** Only populated when a matching contact exists in network_contacts. */
  suggested_network_contact_ids: Uuid[];
  status: 'open' | 'handled' | 'ignored';
  occurred_at: IsoDateTime;
  citations: Citation[];
  model: string | null;
  prompt_version: string | null;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

/* -------------------------------------------------------------- knowledge */

export type KnowledgeDocType =
  | 'thesis'
  | 'memo'
  | 'pass_note'
  | 'ic_note'
  | 'portfolio_doc'
  | 'market_map'
  | 'playbook'
  | 'network_csv'
  | 'other';

export interface KnowledgeDocument {
  id: Uuid;
  organization_id: Uuid;
  title: string;
  doc_type: KnowledgeDocType;
  filename: string;
  safe_filename: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string | null;
  page_count: number | null;
  extraction_confidence: ExtractionConfidence | null;
  extraction_error: string | null;
  needs_review: boolean;
  content_hash: string;
  chunk_count: number;
  uploaded_by: Uuid;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

export interface KnowledgeChunk {
  id: Uuid;
  organization_id: Uuid;
  document_id: Uuid;
  chunk_index: number;
  page: number | null;
  section: string | null;
  text: string;
  created_at: IsoDateTime;
}

export interface NetworkContact {
  id: Uuid;
  organization_id: Uuid;
  full_name: string;
  email: string | null;
  company: string | null;
  title: string | null;
  relationship: string | null;
  expertise: string[];
  geography: string | null;
  notes: string | null;
  source_document_id: Uuid | null;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

/* -------------------------------------------------------------- thesis */

export interface ScoringWeight {
  key: string;
  label: string;
  weight: number;
  description: string;
  enabled: boolean;
}

export const DEFAULT_SCORING_WEIGHTS: ScoringWeight[] = [
  {
    key: 'thesis_fit',
    label: 'Vertical AI and thesis fit',
    weight: 15,
    description: 'How squarely the company sits in TipTop’s vertical-AI thesis.',
    enabled: true,
  },
  {
    key: 'team',
    label: 'Founder-market fit and team',
    weight: 15,
    description: 'Operator depth in the vertical; why this team wins here.',
    enabled: true,
  },
  {
    key: 'problem',
    label: 'Problem severity and urgency',
    weight: 10,
    description: 'How painful and how urgent the problem is for the buyer.',
    enabled: true,
  },
  {
    key: 'product',
    label: 'Product quality and AI differentiation',
    weight: 12,
    description: 'Whether AI is load-bearing or decorative.',
    enabled: true,
  },
  {
    key: 'market',
    label: 'Market size and expansion potential',
    weight: 10,
    description: 'Beachhead credibility and the path beyond it.',
    enabled: true,
  },
  {
    key: 'traction',
    label: 'Traction and GTM evidence',
    weight: 10,
    description: 'Revenue, usage, pipeline and repeatability of the motion.',
    enabled: true,
  },
  {
    key: 'defensibility',
    label: 'Defensibility, proprietary data, or workflow advantage',
    weight: 8,
    description: 'What compounds and what stops a fast follower.',
    enabled: true,
  },
  {
    key: 'timing',
    label: 'Timing and competitive position',
    weight: 7,
    description: 'Why now, and position relative to named competitors.',
    enabled: true,
  },
  {
    key: 'economics',
    label: 'Stage, round, and investment economics',
    weight: 6,
    description: 'Stage fit, round construction and entry terms.',
    enabled: true,
  },
  {
    key: 'value_add',
    label: 'TipTop value-add potential',
    weight: 7,
    description: 'Where GTM, fundraising, hiring and the operator network move the needle.',
    enabled: true,
  },
];

export interface RecommendationThresholds {
  /** Minimum completeness (0–100) below which we return INSUFFICIENT_DATA. */
  minimum_completeness: number;
  pass_below: number;
  monitor_below: number;
  dig_deeper_below: number;
  /** At or above this normalised score, ADVANCE. */
  advance_at: number;
}

export const DEFAULT_THRESHOLDS: RecommendationThresholds = {
  minimum_completeness: 35,
  pass_below: 45,
  monitor_below: 58,
  dig_deeper_below: 74,
  advance_at: 74,
};

export interface ThesisVersion {
  id: Uuid;
  organization_id: Uuid;
  version: number;
  preferred_stages: string[];
  preferred_industries: string[];
  excluded_industries: string[];
  geographic_preferences: string[];
  /** Empty means "not configured" — never invented. */
  typical_check_range: string | null;
  target_ownership: string | null;
  follow_on_strategy: string | null;
  required_traction: string | null;
  thesis_notes: string;
  hard_disqualifiers: string[];
  scoring_weights: ScoringWeight[];
  thresholds: RecommendationThresholds;
  deal_stages: DealStage[];
  is_active: boolean;
  created_by: Uuid | null;
  created_at: IsoDateTime;
}

/* --------------------------------------------------------- briefs & chat */

export interface BriefItem {
  id: string;
  kind:
    | 'priority'
    | 'meeting'
    | 'email'
    | 'new_deal'
    | 'awaiting_decision'
    | 'follow_up'
    | 'portfolio_request'
    | 'lp_item'
    | 'market_signal';
  title: string;
  detail: string;
  /** Present when the item is grounded in a record. Absent items are labelled. */
  citation_ids: string[];
  /** In-app route to open the underlying record. */
  href: string | null;
  is_suggestion: boolean;
  occurred_at: IsoDateTime | null;
}

export interface DailyBrief {
  id: Uuid;
  organization_id: Uuid;
  user_id: Uuid;
  date_key: string;
  timezone: string;
  outlook: string;
  priorities: BriefItem[];
  sections: {
    meetings: BriefItem[];
    emails: BriefItem[];
    new_deals: BriefItem[];
    awaiting_decision: BriefItem[];
    follow_ups: BriefItem[];
    portfolio_requests: BriefItem[];
    lp_items: BriefItem[];
    market_signals: BriefItem[];
  };
  recommended_actions: string[];
  citations: Citation[];
  model: string;
  prompt_version: string;
  generated_at: IsoDateTime;
  created_at: IsoDateTime;
}

export interface ChatThread {
  id: Uuid;
  organization_id: Uuid;
  user_id: Uuid;
  title: string;
  /** Scopes the assistant to one deal when set. */
  deal_id: Uuid | null;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

export interface ChatToolCall {
  name: string;
  input: Record<string, unknown>;
  ok: boolean;
  summary: string;
}

export interface ChatMessage {
  id: Uuid;
  organization_id: Uuid;
  thread_id: Uuid;
  role: 'user' | 'assistant';
  content: string;
  citations: Citation[];
  tool_calls: ChatToolCall[];
  model: string | null;
  prompt_version: string | null;
  created_at: IsoDateTime;
}

/* ------------------------------------------------------------ drafts, ops */

export type DraftKind =
  | 'missing_information'
  | 'pass'
  | 'follow_up'
  | 'meeting_request'
  | 'portfolio_reply'
  | 'generic_reply';

export interface GeneratedDraft {
  id: Uuid;
  organization_id: Uuid;
  kind: DraftKind;
  subject: string;
  body: string;
  to_addresses: string[];
  deal_id: Uuid | null;
  portfolio_company_id: Uuid | null;
  email_message_id: Uuid | null;
  /**
   * Always false. The app has no send capability and requests no send scope.
   * Present so the UI can state the fact rather than imply it.
   */
  sent: false;
  model: string | null;
  prompt_version: string | null;
  created_by: Uuid;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

export interface AiUsageRecord {
  id: Uuid;
  organization_id: Uuid;
  user_id: Uuid | null;
  operation: string;
  model: string;
  prompt_version: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  estimated_cost_usd: number;
  ok: boolean;
  error_code: string | null;
  duration_ms: number;
  created_at: IsoDateTime;
}

export interface AuditEvent {
  id: Uuid;
  organization_id: Uuid;
  user_id: Uuid | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  /** Redacted before write; see lib/security/redact.ts. */
  metadata: Record<string, unknown>;
  ip_hash: string | null;
  created_at: IsoDateTime;
}

export interface UserFeedback {
  id: Uuid;
  organization_id: Uuid;
  user_id: Uuid;
  subject_type: 'analysis' | 'brief' | 'chat_message' | 'draft' | 'classification';
  subject_id: string;
  rating: 'up' | 'down';
  comment: string | null;
  created_at: IsoDateTime;
}

export interface SyncRun {
  id: Uuid;
  organization_id: Uuid;
  integration_id: Uuid;
  kind: IntegrationKind;
  idempotency_key: string;
  status: 'running' | 'succeeded' | 'failed' | 'partial';
  items_seen: number;
  items_created: number;
  items_updated: number;
  error: string | null;
  started_at: IsoDateTime;
  finished_at: IsoDateTime | null;
}
