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
  /** One line on what the company does; optional because older rows predate it. */
  description?: string | null;
  sector?: string | null;
  geography?: string | null;
  /** How the fund came to the deal, e.g. "VC Network" or "Founder Network". */
  deal_source?: string | null;
  /** Other investors in the round, comma separated. */
  co_investors?: string | null;
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

/**
 * A meeting note ingested from an external note-taker (Granola today).
 *
 * `content` is untrusted third-party text: it is scanned on ingestion and
 * `injection_flagged` annotates anything instruction-shaped, but the text is
 * always stored verbatim and only ever rendered as text. Links to deals,
 * companies and people are derived at read time from `attendees` — never
 * persisted — so a wrong inference cannot outlive the records it was made from.
 */
export interface MeetingNote {
  id: Uuid;
  organization_id: Uuid;
  provider: 'granola';
  /** The note's identity in the source system; ingestion upserts on this. */
  external_id: string;
  title: string;
  occurred_at: IsoDateTime;
  attendees: { name: string | null; email: string }[];
  content: string;
  source_url: string | null;
  injection_flagged: boolean;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

/* ------------------------------------------------------------------ crm */
//
// Copilot's CRM, shaped like Affinity's so an Affinity export maps onto it
// one-to-one: lists of one entity type with their own custom fields, companies
// and people as records that can sit on many lists, list entries carrying that
// list's field values, and notes attached to records and entries. Service:
// lib/services/crm.ts. Field helpers (keys, coercion): lib/crm/fields.ts.

/** Where a CRM row came from: an Affinity export, or made in Copilot. */
export type CrmSource = 'affinity' | 'copilot';

/** Affinity's organization, person and opportunity lists. */
export type CrmEntityType = 'company' | 'person' | 'deal';

export type CrmRecordKind = 'company' | 'person';

export const CRM_FIELD_TYPES = [
  'text',
  'number',
  'date',
  'status',
  'multi',
  'person',
  'company',
  'url',
  'email',
  'money',
] as const;

export type CrmFieldType = (typeof CRM_FIELD_TYPES)[number];

/**
 * One column of a list. `key` is a stable slug (`[a-z0-9_]`, unique within
 * the list) that entry `values` are keyed by; `name` is the label shown.
 * `options` are the choices of a 'status' or 'multi' field, in display order —
 * for a pipeline, the stage order.
 */
export interface CrmField {
  key: string;
  name: string;
  type: CrmFieldType;
  options?: string[];
  /**
   * 'copilot' for a column someone added in Copilot. The Affinity sync and
   * CSV re-imports never take one over by its label, so its values stay the
   * team's own. Absent on imported columns.
   */
  origin?: 'copilot';
}

/**
 * A stored field value. Scalars for text/number/date/status/url/email/money
 * (dates as `YYYY-MM-DD` or an ISO date-time, money and numbers as numbers),
 * string arrays for multi/person/company. A value an import could not parse
 * as its type is kept as the original string rather than dropped. An empty
 * value is an absent key, never `''`.
 */
export type CrmValue = string | number | string[] | null;

export interface CrmList {
  id: Uuid;
  organization_id: Uuid;
  source: CrmSource;
  external_id: string | null;
  name: string;
  entity_type: CrmEntityType;
  fields: CrmField[];
  position: number;
  archived: boolean;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
  /**
   * Saved views, as stored (jsonb array; 20261016010000_crm_views.sql). Absent
   * until that migration has run, so read it only through parseSavedViews in
   * lib/crm/saved-views.ts, which also drops anything malformed.
   */
  views?: unknown;
}

/** A company or a person. */
export interface CrmRecord {
  id: Uuid;
  organization_id: Uuid;
  kind: CrmRecordKind;
  source: CrmSource;
  /** Affinity's Organization ID / Person ID; null when made in Copilot or known by name only. */
  external_id: string | null;
  name: string;
  /** `lower(trim(name))`, maintained by the service; what case-insensitive matching uses. */
  name_key: string;
  /** Bare domain, companies only. */
  domain: string | null;
  /** Lowercased; includes `primary_email`. */
  emails: string[];
  primary_email: string | null;
  /** Extra columns from the export, keyed by display label (records have no schema). */
  fields: Record<string, CrmValue>;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

/** One row of one list. */
export interface CrmListEntry {
  id: Uuid;
  organization_id: Uuid;
  list_id: Uuid;
  /** The company/person the row is about; for a deal list, the company the deal is with. */
  record_id: Uuid | null;
  /** The entity or opportunity name as the list shows it. */
  title: string;
  /**
   * What makes an imported row the same row on the next import: Affinity's
   * row id, `entity:<id>` (the organization/person/opportunity id) or
   * `name:<name>` (a deal list exported without ids). Null for rows made in
   * Copilot.
   */
  external_id: string | null;
  /** Keyed by the list's `fields[].key`. */
  values: Record<string, CrmValue>;
  /**
   * The values as the last import left them (what the file said), so the next
   * import can tell a value someone changed in Copilot since — which it keeps
   * — from one only Affinity has touched. Null for a row no import has written.
   */
  imported_values: Record<string, CrmValue> | null;
  position: number;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

/**
 * A row taken off a list in Copilot (20261021000300_crm_writes.sql). The
 * daily Affinity sync and CSV re-imports skip incoming rows that match it, so
 * the row stays off; Undo re-inserts `entry` and deletes the tombstone.
 */
export interface CrmEntryTombstone {
  id: Uuid;
  organization_id: Uuid;
  list_id: Uuid;
  entry_id: Uuid;
  external_id: string | null;
  record_id: Uuid | null;
  title: string;
  /** The row as it was when removed. */
  entry: CrmListEntry;
  removed_by: Uuid | null;
  created_at: IsoDateTime;
}

/**
 * A note on records and/or list entries. `content` is untrusted text — stored
 * verbatim, scanned on the way in (`injection_flagged` annotates, never hides)
 * and only ever rendered as text, like meeting notes.
 */
export interface CrmNote {
  id: Uuid;
  organization_id: Uuid;
  source: CrmSource;
  /** Source id, or for an id-less CSV row a stable hash of entity names + date + content. */
  external_id: string;
  title: string | null;
  content: string;
  /** Display name of the author as the source gives it. */
  author: string | null;
  occurred_at: IsoDateTime | null;
  record_ids: Uuid[];
  entry_ids: Uuid[];
  /** The names the source attached the note to, kept even when no record matched. */
  entity_names: string[];
  injection_flagged: boolean;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

/* ------------------------------------------------------------ campaigns */
//
// Tracked bulk email, replacing Affinity's: one personal email per recipient
// from the connected mailbox, with opens, clicks and replies tracked. Service:
// lib/services/campaigns.ts. Template and limits: lib/campaigns/.

export type CampaignStatus = 'draft' | 'sending' | 'paused' | 'sent' | 'cancelled';

/**
 * Why a campaign is paused, so every view can say so: a person tapped Pause,
 * the sending page was left (sending runs only while it is open), the 24-hour
 * cap was reached, sends kept failing, or Gmail refused.
 */
export type CampaignPauseReason = 'manual' | 'left' | 'capped' | 'failures' | 'refused';

/** Whose signature goes under the email; both send from the connected mailbox. */
export type CampaignFromIdentity = 'nick' | 'arwin';

/**
 * Where a campaign's Bcc goes: on every email, or on the first email it
 * actually sends, once (a sample copy for the records).
 */
export type CampaignBccMode = 'every' | 'first';

/** A file sent with every email of a campaign, kept in the private storage bucket. */
export interface CampaignAttachment {
  id: string;
  name: string;
  /** MIME type. */
  type: string;
  /** Bytes. */
  size: number;
  /** Object paths in the storage bucket, in order: a large file is uploaded in pieces. */
  parts: string[];
}

export interface Campaign {
  id: Uuid;
  organization_id: Uuid;
  /** What it is called in Copilot. Recipients never see it. */
  name: string;
  subject: string;
  /** Plain text with light Markdown and merge fields (lib/campaigns/template.ts). */
  body_template: string;
  from_identity: CampaignFromIdentity;
  status: CampaignStatus;
  attachments: CampaignAttachment[];
  /** The body's links when the campaign was confirmed; the only places a click redirects to. */
  link_allowlist: string[];
  confirmed_at: IsoDateTime | null;
  confirmed_by: Uuid | null;
  /** The last email it sent, which paces the next. */
  last_sent_at: IsoDateTime | null;
  /**
   * Open pixel and click-tracked links. Off: the email carries no Copilot
   * link at all and only replies and bounces are tracked.
   */
  track_activity: boolean;
  /**
   * The grey unsubscribe line and the List-Unsubscribe headers mail
   * providers turn into their own button. Off by default: an LP update is a
   * personal email, not a mailing.
   */
  unsubscribe_link: boolean;
  /**
   * Set on confirmation: the created_at of the last recipient the review
   * counted. A recipient added after it is never sent.
   */
  confirmed_through: IsoDateTime | null;
  /** Why it is paused; null unless paused. */
  pause_reason: CampaignPauseReason | null;
  created_by: Uuid | null;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
  /** When the last recipient was sent to. */
  sent_at: IsoDateTime | null;
  // Photos and copies (20261021001100_campaign_photos_cc.sql). Absent on a row
  // read before that file was applied: then they stay hidden, and the
  // campaign sends exactly as it did without them (services/campaigns.ts,
  // extrasAvailable). Every reader treats absent as empty.
  /** Addresses copied (Cc) on every email. Lowercased, at most ten. */
  cc?: string[];
  /** Addresses blind-copied (Bcc), on every email or the first only (bcc_mode). */
  bcc?: string[];
  bcc_mode?: CampaignBccMode;
  /**
   * When the one "first email only" Bcc copy was claimed for an email: set
   * just before it goes, cleared only if Gmail refused it outright (nothing
   * went), so the sample is never sent twice.
   */
  bcc_sample_at?: IsoDateTime | null;
}

/**
 * A photo a campaign can attach to one recipient's email (or to several,
 * picked by hand), kept in the private storage bucket in pieces like an
 * attachment.
 */
export interface CampaignPhoto {
  /** The upload id the page chose; its pieces share it. */
  id: Uuid;
  organization_id: Uuid;
  campaign_id: Uuid;
  /** The cleaned file name: the attachment's name, and what the match by name reads. */
  name: string;
  /** MIME type, read from the file's own first bytes. */
  type: string;
  /** Bytes. */
  size: number;
  /** Object paths in the storage bucket, in order. */
  parts: string[];
  created_at: IsoDateTime;
}

/**
 * `unconfirmed`: the send was interrupted after it started, so it may have
 * gone out. Never sent again automatically and never swept up by "retry
 * failed": a person checks Gmail Sent and marks it sent or sends it again.
 */
export type CampaignRecipientStatus = 'pending' | 'sent' | 'failed' | 'unconfirmed' | 'skipped';

export interface CampaignMerge {
  first_name?: string;
  name?: string;
  company?: string;
}

export interface CampaignRecipient {
  id: Uuid;
  organization_id: Uuid;
  campaign_id: Uuid;
  /** Lowercased. */
  email: string;
  name: string | null;
  merge: CampaignMerge;
  /** The CRM person the recipient came from. */
  record_id: Uuid | null;
  status: CampaignRecipientStatus;
  gmail_message_id: string | null;
  gmail_thread_id: string | null;
  /** Why it failed or was skipped. Safe to show. */
  error: string | null;
  /** Set just before the send; still pending with this set means interrupted mid-send. */
  attempted_at: IsoDateTime | null;
  sent_at: IsoDateTime | null;
  opened_at: IsoDateTime | null;
  open_count: number;
  clicked_at: IsoDateTime | null;
  click_count: number;
  replied_at: IsoDateTime | null;
  bounced_at: IsoDateTime | null;
  unsubscribed_at: IsoDateTime | null;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
  // Photos and copies (20261021001100_campaign_photos_cc.sql); absent before
  // that file is applied, and read as none.
  /**
   * The recipient's photo, a CampaignPhoto id. Not a foreign key: one that
   * no longer exists reads as "photo missing" (blocked at review, failed at
   * send), never as no photo.
   */
  photo_id?: Uuid | null;
  /** Extra addresses copied on this recipient's email only. */
  cc?: string[];
  /** CC and BCC addresses this email also went to: each counts toward the 24-hour cap. */
  copy_count?: number;
}

/** `resubscribe` undoes an earlier unsubscribe for that address: the latest of the two wins. */
export type CampaignEventKind =
  'open' | 'click' | 'reply' | 'bounce' | 'unsubscribe' | 'resubscribe';

export interface CampaignEvent {
  id: Uuid;
  organization_id: Uuid;
  campaign_id: Uuid | null;
  recipient_id: Uuid | null;
  kind: CampaignEventKind;
  /** The link, for a click. */
  url: string | null;
  /** Lowercased, for an unsubscribe: the suppression list. */
  email: string | null;
  at: IsoDateTime;
  user_agent: string | null;
  /**
   * An open or click that looked like a machine (a mail scanner checking
   * links, a prefetch): kept for the record, never counted as the person's.
   */
  automated: boolean;
}

/**
 * One row per organization: who may send campaign email right now. A batch
 * takes the lease before its first email and renews it before each one, so
 * two batches (two tabs, two server instances) never send at once, and the
 * pace and the 24-hour cap hold across them.
 */
export interface CampaignSendLock {
  organization_id: Uuid;
  /** The holder's token, swapped atomically to take the lease. */
  lease_token: string | null;
  /** Null when released; a lease past this time is free to take. */
  lease_expires_at: IsoDateTime | null;
  /** The campaign the holder is sending. */
  campaign_id: Uuid | null;
  /** The organization's last campaign email, which paces the next. */
  last_sent_at: IsoDateTime | null;
  updated_at: IsoDateTime;
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

export type RoutineBriefingKind = 'morning' | 'afternoon' | 'dossier';

/**
 * Two independent slots shown on Today, sourced from the cloud triage
 * fleet's own dashboards rather than generated in-app: a *brief* — the
 * Daily Overview's morning post, replaced by the Daily Recap's afternoon
 * post the same day — and a *dossier*, the Daily Overview's meeting prep,
 * which is untouched by the afternoon swap and only replaced by tomorrow's
 * Overview. Splitting them was deliberate: the Recap has no meeting prep of
 * its own to offer, so a design that let it wipe the dossier too would erase
 * real content for no reason.
 *
 * One row per (organization, kind) — see the migration that split the old
 * one-row-per-organization shape. `getCurrentBrief` picks whichever of
 * 'morning'/'afternoon' is current for *today*; `getCurrentDossier` reads
 * the 'dossier' row directly, since it has no sibling to compare against.
 */
export interface RoutineBriefing {
  id: Uuid;
  organization_id: Uuid;
  kind: RoutineBriefingKind;
  /** Local calendar date the routine ran for, in the user's timezone. */
  date_key: string;
  title: string;
  /** Plain text — never rendered as HTML. See the webhook route for why. */
  summary: string;
  /** Link to the routine's own dashboard artifact or Slack post, if any. */
  source_url: string | null;
  posted_at: IsoDateTime;
  updated_at: IsoDateTime;
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
  /**
   * 'pending' only ever applies to an assistant row awaiting an answer from
   * the Ask bridge (see `askBridgeToken`) — content is empty until then.
   * Every user row, and every assistant row answered in-process, is
   * 'answered' from the moment it is inserted.
   */
  status: 'pending' | 'answered';
  created_at: IsoDateTime;
}

/* ------------------------------------------------------------ drafts, ops */

export type DraftKind =
  | 'missing_information'
  | 'pass'
  | 'follow_up'
  | 'meeting_request'
  | 'portfolio_reply'
  | 'generic_reply'
  | 'scheduling';

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
   * Always false. Generated drafts never send; the only send path is the
   * email session's Send button, which does not use this table.
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

/**
 * The booking link's settings: one row per organization
 * (supabase/migrations/20261022000000_booking_link.sql). `settings` is the
 * Settings > Booking link document, read through lib/booking/config.ts.
 */
export interface BookingSettingsRow {
  id: Uuid;
  organization_id: Uuid;
  enabled: boolean;
  slug: string;
  settings: Record<string, unknown>;
  updated_by: Uuid | null;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

/**
 * pending: waiting for a person (approve first). approved: on the calendar
 * after someone approved it (or added it by hand). declined: turned down, or a
 * held time released. handled: a message, read. booked: on the calendar at
 * once from the link (D-078). held: kept until calendar editing is on.
 * cancelled: cancelled, the event deleted with Google's cancellation.
 */
export type BookingRequestStatus =
  | 'pending'
  | 'approved'
  | 'declined'
  | 'handled'
  | 'booked'
  | 'held'
  | 'cancelled';

/** A meeting request (or a message) sent from the public booking page. */
export interface BookingRequest {
  id: Uuid;
  organization_id: Uuid;
  status: BookingRequestStatus;
  meeting_type: 'call' | 'in_person' | 'message';
  kind: 'coffee' | 'lunch' | 'dinner' | null;
  starts_at: IsoDateTime | null;
  ends_at: IsoDateTime | null;
  visitor_time_zone: string | null;
  name: string;
  email: string;
  company: string | null;
  place_id: string | null;
  place_name: string | null;
  place_area: string | null;
  place_map_url: string | null;
  place_custom: boolean;
  note: string | null;
  deck_url: string | null;
  source: 'form' | 'chatbot';
  ip_hash: string | null;
  claimed_at: IsoDateTime | null;
  calendar_id: string | null;
  event_id: string | null;
  decided_by: Uuid | null;
  decided_at: IsoDateTime | null;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
  /*
   * D-078 (20261022200000_booking_v2.sql). Optional: a row read before that
   * migration has none of them, and the code treats a missing one as empty.
   */
  /** Guests the visitor added, invited with them. */
  guest_emails?: string[];
  /** SHA-256 (hex) of the booking page's token; the token is never stored. */
  manage_token_hash?: string | null;
  /** The visitor's note to the host when they cancelled. */
  cancel_note?: string | null;
  cancelled_at?: IsoDateTime | null;
  /** Who cancelled: the visitor (its page), the team (Copilot) or the calendar (deleted in Google). */
  cancelled_by?: 'visitor' | 'team' | 'calendar' | null;
  rescheduled_count?: number;
  previous_starts_at?: IsoDateTime | null;
}

/**
 * A token a Claude client (a claude.ai custom connector, a Claude Code session,
 * a cloud routine) uses to read the CRM through the MCP endpoint. Only the
 * SHA-256 of the token is stored; the token itself is shown once, at creation.
 */
export interface McpToken {
  id: Uuid;
  organization_id: Uuid;
  /** What the owner called the client, e.g. "claude.ai" or "Deal-sorter routine". */
  name: string;
  /** Hex SHA-256 of the whole token. */
  token_hash: string;
  /** The token's last four characters, so the owner can tell tokens apart. */
  hint: string;
  created_by: Uuid | null;
  created_at: IsoDateTime;
  last_used_at: IsoDateTime | null;
  revoked_at: IsoDateTime | null;
}

/**
 * A desktop app sign-in in progress (lib/auth/desktop-handoff.ts). The app
 * starts it, the system browser does Google and shows a code, and the person
 * types that code into the app, which then finishes the sign-in itself.
 */
export type DesktopHandoffStatus = 'pending' | 'code_received' | 'claimed' | 'signed_in' | 'failed';
export type DesktopHandoffFailure =
  'cancelled' | 'no_code' | 'wrong_code' | 'rejected' | 'superseded' | 'exchange' | 'domain';
export type DesktopPlatform = 'mac' | 'windows' | 'other';

export interface DesktopHandoff {
  id: Uuid;
  /** Hex SHA-256 of the hand-off id that rides in the browser's URL. */
  handoff_hash: string;
  /** Hex SHA-256 of the app's poll secret (an httpOnly cookie in the app). */
  poll_secret_hash: string;
  /** Minted when the browser receives Google's code; shown there, typed in the app. */
  match_code: string | null;
  /** Wrong codes typed so far; the third ends the hand-off. */
  attempts: number;
  /** Supabase's PKCE flow id, so the exchange finds this flow's verifier. Not a secret. */
  flow_id: string | null;
  platform: DesktopPlatform;
  status: DesktopHandoffStatus;
  failure_reason: DesktopHandoffFailure | null;
  /** sealToken output (lib/security/crypto.ts); null except between code_received and claimed. */
  auth_code_sealed: { ciphertext: string; iv: string; authTag: string; keyVersion: number } | null;
  created_at: IsoDateTime;
  expires_at: IsoDateTime;
  code_received_at: IsoDateTime | null;
  consumed_at: IsoDateTime | null;
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

/* ------------------------------------------------------- public job board */
//
// supabase/migrations/20261022100000_public_jobs.sql. The board is off until a
// person turns it on; see lib/services/jobs-board.ts for how a role becomes
// public.

export type JobPostingSource = 'ats' | 'email' | 'manual';
export type JobAts = 'greenhouse' | 'lever' | 'ashby' | 'workable' | 'recruitee';
export type JobEmploymentType = 'full_time' | 'part_time' | 'contract' | 'internship' | 'temporary';
export type JobSeniority =
  | 'intern'
  | 'entry'
  | 'mid'
  | 'senior'
  | 'staff'
  | 'lead'
  | 'manager'
  | 'director'
  | 'vp'
  | 'executive';

export interface JobBoardSettings {
  id: Uuid;
  organization_id: Uuid;
  enabled: boolean;
  title: string;
  intro: string | null;
  accent: string;
  updated_by: Uuid | null;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

export interface JobCompany {
  id: Uuid;
  organization_id: Uuid;
  portfolio_company_id: Uuid;
  slug: string;
  careers_url: string | null;
  ats: JobAts | null;
  ats_token: string | null;
  sync_enabled: boolean;
  auto_publish: boolean;
  listed: boolean;
  logo_url: string | null;
  about: string | null;
  last_sync_at: IsoDateTime | null;
  last_sync_status: 'ok' | 'failed' | 'skipped' | null;
  last_sync_message: string | null;
  last_sync_count: number | null;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

export interface JobPosting {
  id: Uuid;
  organization_id: Uuid;
  portfolio_company_id: Uuid;
  source: JobPostingSource;
  source_key: string;
  slug: string;
  title: string;
  team: string | null;
  job_function: string;
  locations: string[];
  remote: 'remote' | 'hybrid' | 'onsite' | null;
  employment_type: JobEmploymentType | null;
  seniority: JobSeniority | null;
  comp: string | null;
  description: string | null;
  apply_url: string | null;
  posted_at: IsoDateTime | null;
  source_updated_at: IsoDateTime | null;
  status: 'active' | 'closed';
  published: boolean;
  featured: boolean;
  approved_by: Uuid | null;
  approved_at: IsoDateTime | null;
  hidden_by: Uuid | null;
  hidden_at: IsoDateTime | null;
  first_seen_at: IsoDateTime;
  last_seen_at: IsoDateTime;
  closed_at: IsoDateTime | null;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}
