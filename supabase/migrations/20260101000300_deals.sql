-- Deal pipeline.
--
-- Two design points worth stating:
--   * Every extracted field is nullable and stays null when unknown. There is
--     no default, no sentinel and no NOT NULL that would force a guess.
--   * deal_facts is append-only with a superseded_by link, so an extraction and
--     a human correction both survive forever.

create table if not exists deals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  company_name text not null check (length(company_name) between 1 and 200),
  -- Punctuation- and suffix-stripped name used for duplicate detection.
  normalized_name text not null,
  website text,
  domain text,
  stage text not null default 'new',
  industry text,
  vertical text,
  geography text,
  funding_stage text,
  round_size text,
  amount_raised text,
  valuation_or_cap text,
  existing_investors text[] not null default '{}',
  requested_check text,
  referral_source text,
  received_at timestamptz not null default now(),
  product_summary text,
  customer text,
  problem text,
  solution text,
  ai_usage text,
  traction text,
  revenue text,
  growth text,
  customer_count text,
  pipeline text,
  business_model text,
  pricing text,
  market text,
  competition text,
  team text,
  founder_market_fit text,
  gtm_motion text,
  defensibility text,
  data_advantage text,
  risks text[] not null default '{}',
  open_questions text[] not null default '{}',
  outcome text,
  -- Soft delete: archiving hides a deal without losing its decision history.
  is_archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists deals_org_received_idx on deals (organization_id, received_at desc);
create index if not exists deals_org_stage_idx on deals (organization_id, stage) where not is_archived;
create index if not exists deals_normalized_name_idx on deals (organization_id, normalized_name);
create index if not exists deals_domain_idx on deals (organization_id, domain) where domain is not null;
create index if not exists deals_name_trgm_idx on deals using gin (normalized_name gin_trgm_ops);

alter table deals
  add column if not exists search_vector tsvector
  generated always as (
    setweight(to_tsvector('english', coalesce(company_name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(industry, '') || ' ' || coalesce(vertical, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(product_summary, '')), 'B') ||
    setweight(to_tsvector('english',
      coalesce(problem, '') || ' ' || coalesce(solution, '') || ' ' ||
      coalesce(team, '') || ' ' || coalesce(competition, '') || ' ' ||
      coalesce(traction, '') || ' ' || coalesce(market, '')
    ), 'D')
  ) stored;

create index if not exists deals_search_idx on deals using gin (search_vector);

create table if not exists deal_people (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  deal_id uuid not null references deals(id) on delete cascade,
  name text not null,
  role text,
  email text,
  linkedin_url text,
  background text,
  created_at timestamptz not null default now(),
  unique (deal_id, name)
);

create index if not exists deal_people_email_idx on deal_people (organization_id, email)
  where email is not null;

create table if not exists deal_sources (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  deal_id uuid not null references deals(id) on delete cascade,
  kind text not null check (
    kind in ('email_thread', 'email_message', 'attachment', 'manual', 'knowledge_document', 'web')
  ),
  ref_id text,
  label text not null,
  url text,
  occurred_at timestamptz,
  created_at timestamptz not null default now(),
  -- Attaching the same source twice is a no-op rather than a duplicate row.
  unique (deal_id, kind, ref_id)
);

create index if not exists deal_sources_deal_idx on deal_sources (deal_id, occurred_at desc);
create index if not exists deal_sources_ref_idx on deal_sources (organization_id, ref_id)
  where ref_id is not null;

-- Append-only fact versions. `superseded_by` links an older value to the one
-- that replaced it, so "what did the founder originally claim, and what did
-- Nick correct it to" is always answerable.
create table if not exists deal_facts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  deal_id uuid not null references deals(id) on delete cascade,
  field text not null,
  value text,
  source_type fact_source_type not null,
  evidence_quote text,
  citation_id text,
  confidence real check (confidence between 0 and 1),
  version integer not null default 1,
  superseded_by uuid references deal_facts(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists deal_facts_deal_field_idx on deal_facts (deal_id, field, version desc);
create index if not exists deal_facts_current_idx on deal_facts (deal_id, field)
  where superseded_by is null;

create table if not exists deal_analyses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  deal_id uuid not null references deals(id) on delete cascade,
  version integer not null,
  recommendation recommendation not null,
  headline text not null,
  rationale text not null,
  -- Normalised over attempted weight only; see lib/deals/scoring.ts.
  quality_score smallint not null check (quality_score between 0 and 100),
  attempted_weight real not null default 0,
  earned_weight real not null default 0,
  data_completeness smallint not null check (data_completeness between 0 and 100),
  evidence_quality smallint not null check (evidence_quality between 0 and 100),
  confidence smallint not null check (confidence between 0 and 100),
  categories jsonb not null default '[]'::jsonb,
  strongest_evidence text not null default '',
  biggest_concern text not null default '',
  missing_information text[] not null default '{}',
  recommended_next_step text not null default '',
  diligence_questions text[] not null default '{}',
  upside_case text not null default '',
  downside_case text not null default '',
  red_flags jsonb not null default '[]'::jsonb,
  competitive_context text,
  comparable_deal_ids uuid[] not null default '{}',
  citations jsonb not null default '[]'::jsonb,
  thirty_second_overview text not null default '',
  model text not null,
  prompt_version text not null,
  -- Hash of the source content set. An unchanged deal reuses this row instead
  -- of spending another request.
  source_hash text not null,
  generated_at timestamptz not null default now(),
  generated_by uuid references auth.users(id) on delete set null,
  human_override jsonb,
  created_at timestamptz not null default now(),
  unique (deal_id, version)
);

create index if not exists deal_analyses_deal_version_idx on deal_analyses (deal_id, version desc);
create index if not exists deal_analyses_source_hash_idx on deal_analyses (deal_id, source_hash);

create table if not exists deal_decisions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  deal_id uuid not null references deals(id) on delete cascade,
  decision decision_type not null,
  rationale text not null check (length(rationale) > 0),
  -- Enforced at the database level: a decision is always a human act. There is
  -- no code path and no schema value that lets a model write here.
  actor text not null default 'human' check (actor = 'human'),
  decided_by uuid not null references auth.users(id) on delete restrict,
  decided_at timestamptz not null default now(),
  analysis_id uuid references deal_analyses(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists deal_decisions_deal_idx on deal_decisions (deal_id, decided_at desc);
create index if not exists deal_decisions_org_idx on deal_decisions (organization_id, decided_at desc);

create table if not exists deal_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  deal_id uuid not null references deals(id) on delete cascade,
  body text not null check (length(body) > 0),
  author_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists deal_notes_deal_idx on deal_notes (deal_id, created_at desc);

-- Tasks cover deals, portfolio companies and standalone follow-ups. One table
-- rather than three: they are the same object with a different parent.
create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  title text not null check (length(title) between 1 and 300),
  detail text,
  status task_status not null default 'open',
  due_at timestamptz,
  snoozed_until timestamptz,
  deal_id uuid references deals(id) on delete cascade,
  portfolio_company_id uuid,
  email_message_id uuid references email_messages(id) on delete set null,
  assigned_to uuid references auth.users(id) on delete set null,
  created_by uuid not null references auth.users(id) on delete cascade,
  source text not null default 'human' check (source in ('human', 'suggested')),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tasks_org_due_idx on tasks (organization_id, status, due_at);
create index if not exists tasks_deal_idx on tasks (deal_id) where deal_id is not null;
create index if not exists tasks_portfolio_idx on tasks (portfolio_company_id)
  where portfolio_company_id is not null;

create trigger deals_updated_at before update on deals
  for each row execute function set_updated_at();
create trigger deal_notes_updated_at before update on deal_notes
  for each row execute function set_updated_at();
create trigger tasks_updated_at before update on tasks
  for each row execute function set_updated_at();
