import type {
  AiUsageRecord,
  AuditEvent,
  CalendarEvent,
  ChatMessage,
  ChatThread,
  DailyBrief,
  Deal,
  DealAnalysis,
  DealDecision,
  DealFact,
  DealNote,
  DealPerson,
  DealSource,
  EmailAttachment,
  EmailMessage,
  EmailThread,
  EncryptedProviderToken,
  GeneratedDraft,
  Integration,
  KnowledgeChunk,
  KnowledgeDocument,
  MeetingNote,
  NetworkContact,
  Organization,
  OrganizationMember,
  PortfolioCompany,
  PortfolioContact,
  PortfolioUpdate,
  SyncRun,
  Task,
  ThesisVersion,
  UserFeedback,
  UserProfile,
} from '@/lib/types/domain';

/**
 * The persistence seam. Two implementations exist:
 *   - SupabaseStore: Postgres with row-level security, used in real deployments
 *   - DemoStore:     file-backed JSON seeded from fixtures, used without creds
 *
 * The interface is intentionally narrow and table-shaped rather than an ORM.
 * Business logic lives in services; this layer only fetches and writes rows.
 *
 * Organization scoping is a *parameter*, not a convention: every read and write
 * takes an organizationId and both implementations enforce it. In Supabase this
 * is belt-and-braces with RLS.
 */

export interface TableMap {
  organizations: Organization;
  organization_members: OrganizationMember;
  user_profiles: UserProfile;
  integrations: Integration;
  encrypted_provider_tokens: EncryptedProviderToken;
  email_threads: EmailThread;
  email_messages: EmailMessage;
  email_attachments: EmailAttachment;
  calendar_events: CalendarEvent;
  deals: Deal;
  deal_people: DealPerson;
  deal_sources: DealSource;
  deal_facts: DealFact;
  deal_analyses: DealAnalysis;
  deal_decisions: DealDecision;
  deal_notes: DealNote;
  tasks: Task;
  portfolio_companies: PortfolioCompany;
  portfolio_contacts: PortfolioContact;
  portfolio_updates: PortfolioUpdate;
  knowledge_documents: KnowledgeDocument;
  knowledge_chunks: KnowledgeChunk;
  network_contacts: NetworkContact;
  meeting_notes: MeetingNote;
  thesis_versions: ThesisVersion;
  daily_briefs: DailyBrief;
  chat_threads: ChatThread;
  chat_messages: ChatMessage;
  generated_drafts: GeneratedDraft;
  ai_usage: AiUsageRecord;
  audit_events: AuditEvent;
  user_feedback: UserFeedback;
  sync_runs: SyncRun;
}

export type TableName = keyof TableMap;
export type Row<T extends TableName> = TableMap[T];

/**
 * Tables that carry no `organization_id`, so every query on them is global.
 *
 * Defined once here rather than in each store: the two implementations had
 * their own identical copies, and a table added to one and not the other would
 * be silently scoped in Supabase and unscoped in demo, or the reverse.
 */
export function scopeless(table: TableName): boolean {
  return table === 'organizations' || table === 'organization_members' || table === 'user_profiles';
}

/**
 * Refuse a scoped query with no organization.
 *
 * An empty organization id is always a programming error — a caller wanting
 * every row across every tenant, which this interface deliberately cannot
 * express. It stayed invisible for months because the two stores disagreed
 * about what it meant: the demo store compared `organization_id === ''`,
 * matched nothing, and returned an empty array; Supabase sent
 * `organization_id = ''` to Postgres, which rejects an empty string as a uuid
 * and throws. So the Gmail push handler failed on every single notification in
 * production while every test passed, because the tests run on the demo store.
 *
 * Throwing in both makes that class of mistake fail the same way everywhere,
 * and fail where someone will see it.
 */
export function assertScoped(table: TableName, organizationId: string): void {
  if (scopeless(table) || organizationId) return;
  throw new Error(
    `[${table}] query has no organization id. Scoped tables cannot be queried across tenants; ` +
      `resolve the organization first (see soleOrganizationId for single-tenant deployments).`,
  );
}

export type Scalar = string | number | boolean | null;

export interface Filter {
  eq?: Record<string, Scalar>;
  neq?: Record<string, Scalar>;
  in?: Record<string, Scalar[]>;
  gte?: Record<string, string | number>;
  lte?: Record<string, string | number>;
  gt?: Record<string, string | number>;
  lt?: Record<string, string | number>;
  isNull?: string[];
  notNull?: string[];
  /** Array column contains the given value. */
  arrayContains?: Record<string, string>;
  /** Case-insensitive substring match across the listed columns (OR). */
  textSearch?: { columns: string[]; query: string };
}

export interface QueryOptions {
  orderBy?: { field: string; direction: 'asc' | 'desc' }[];
  limit?: number;
  offset?: number;
}

export interface UpsertResult<T> {
  row: T;
  created: boolean;
}

/** Full-text search hit with a relevance rank in [0,1]. */
export interface SearchHit<T> {
  row: T;
  rank: number;
}

export interface DataStore {
  readonly kind: 'supabase' | 'demo';

  list<T extends TableName>(
    table: T,
    organizationId: string,
    filter?: Filter,
    options?: QueryOptions,
  ): Promise<Row<T>[]>;

  get<T extends TableName>(table: T, organizationId: string, id: string): Promise<Row<T> | null>;

  /** First row matching the filter, or null. */
  findOne<T extends TableName>(
    table: T,
    organizationId: string,
    filter: Filter,
  ): Promise<Row<T> | null>;

  count<T extends TableName>(table: T, organizationId: string, filter?: Filter): Promise<number>;

  insert<T extends TableName>(table: T, row: Row<T>): Promise<Row<T>>;

  insertMany<T extends TableName>(table: T, rows: Row<T>[]): Promise<Row<T>[]>;

  update<T extends TableName>(
    table: T,
    organizationId: string,
    id: string,
    patch: Partial<Row<T>>,
  ): Promise<Row<T>>;

  /**
   * Insert or update keyed on `conflictColumns`. Used by every sync path, which
   * is what makes re-running a sync a no-op instead of a duplicate.
   */
  upsert<T extends TableName>(
    table: T,
    row: Row<T>,
    conflictColumns: (keyof Row<T> & string)[],
  ): Promise<UpsertResult<Row<T>>>;

  remove<T extends TableName>(table: T, organizationId: string, id: string): Promise<void>;

  removeWhere<T extends TableName>(
    table: T,
    organizationId: string,
    filter: Filter,
  ): Promise<number>;

  /** Full-text search. Postgres FTS in Supabase; ranked substring in demo. */
  search<T extends TableName>(
    table: T,
    organizationId: string,
    query: string,
    columns: string[],
    filter?: Filter,
    limit?: number,
  ): Promise<SearchHit<Row<T>>[]>;

  /* -------- identity lookups that intentionally cross the org boundary ---- */

  /** Membership rows for a user across all organizations. */
  membershipsForUser(userId: string): Promise<OrganizationMember[]>;
  organizationById(id: string): Promise<Organization | null>;
  userProfileById(userId: string): Promise<UserProfile | null>;
  upsertUserProfile(profile: UserProfile): Promise<UserProfile>;
}
