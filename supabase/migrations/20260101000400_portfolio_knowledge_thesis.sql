-- Portfolio, knowledge base, network and thesis configuration.

create table if not exists portfolio_companies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null check (length(name) between 1 and 200),
  normalized_name text not null,
  domain text,
  website text,
  current_stage text,
  latest_round text,
  ownership text,
  key_metrics text,
  current_priorities text,
  upcoming_fundraise text,
  hiring_needs text,
  gtm_needs text,
  risks text,
  last_contact_at timestamptz,
  next_follow_up_at timestamptz,
  is_archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, normalized_name)
);

create index if not exists portfolio_domain_idx on portfolio_companies (organization_id, domain)
  where domain is not null;

alter table portfolio_companies
  add column if not exists search_vector tsvector
  generated always as (
    setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english',
      coalesce(key_metrics, '') || ' ' || coalesce(current_priorities, '') || ' ' ||
      coalesce(hiring_needs, '') || ' ' || coalesce(gtm_needs, '') || ' ' || coalesce(risks, '')
    ), 'C')
  ) stored;

create index if not exists portfolio_search_idx on portfolio_companies using gin (search_vector);

create table if not exists portfolio_contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  portfolio_company_id uuid not null references portfolio_companies(id) on delete cascade,
  name text not null,
  role text,
  email text,
  is_founder boolean not null default false,
  created_at timestamptz not null default now(),
  unique (portfolio_company_id, name)
);

create table if not exists portfolio_updates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  portfolio_company_id uuid not null references portfolio_companies(id) on delete cascade,
  email_message_id uuid references email_messages(id) on delete set null,
  summary text not null,
  request_type portfolio_request_type,
  request_detail text,
  urgency text check (urgency in ('low', 'medium', 'high')),
  suggested_action text,
  -- Ids from network_contacts only. The application refuses any id that is not
  -- already in the organization's own network data, so a suggestion can never
  -- name someone Nick does not actually know.
  suggested_network_contact_ids uuid[] not null default '{}',
  status text not null default 'open' check (status in ('open', 'handled', 'ignored')),
  occurred_at timestamptz not null default now(),
  citations jsonb not null default '[]'::jsonb,
  model text,
  prompt_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists portfolio_updates_company_idx
  on portfolio_updates (portfolio_company_id, occurred_at desc);
create index if not exists portfolio_updates_open_idx
  on portfolio_updates (organization_id, status, occurred_at desc);

-- Deferred foreign key: tasks is created before portfolio_companies.
alter table tasks
  drop constraint if exists tasks_portfolio_company_id_fkey;
alter table tasks
  add constraint tasks_portfolio_company_id_fkey
  foreign key (portfolio_company_id) references portfolio_companies(id) on delete cascade;

alter table email_messages
  drop constraint if exists email_messages_linked_deal_id_fkey;
alter table email_messages
  add constraint email_messages_linked_deal_id_fkey
  foreign key (linked_deal_id) references deals(id) on delete set null;

alter table email_messages
  drop constraint if exists email_messages_linked_portfolio_fkey;
alter table email_messages
  add constraint email_messages_linked_portfolio_fkey
  foreign key (linked_portfolio_company_id) references portfolio_companies(id) on delete set null;

-- ------------------------------------------------------------ knowledge --

create table if not exists knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  title text not null,
  doc_type knowledge_doc_type not null default 'other',
  filename text not null,
  safe_filename text not null,
  mime_type text not null,
  size_bytes bigint not null default 0,
  storage_path text,
  page_count integer,
  extraction_confidence extraction_confidence,
  extraction_error text,
  needs_review boolean not null default false,
  -- Uploading the same bytes twice is rejected rather than silently duplicated.
  content_hash text not null,
  chunk_count integer not null default 0,
  uploaded_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, content_hash)
);

create index if not exists knowledge_documents_type_idx
  on knowledge_documents (organization_id, doc_type, created_at desc);

-- Chunks never span a page boundary, which is what lets a citation carry a real
-- page number rather than an estimate.
create table if not exists knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  document_id uuid not null references knowledge_documents(id) on delete cascade,
  chunk_index integer not null,
  page integer,
  section text,
  text text not null,
  created_at timestamptz not null default now(),
  unique (document_id, chunk_index)
);

alter table knowledge_chunks
  add column if not exists search_vector tsvector
  generated always as (
    setweight(to_tsvector('english', coalesce(section, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(text, '')), 'C')
  ) stored;

create index if not exists knowledge_chunks_search_idx on knowledge_chunks using gin (search_vector);
create index if not exists knowledge_chunks_document_idx on knowledge_chunks (document_id, chunk_index);

create table if not exists network_contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  full_name text not null,
  email text,
  company text,
  title text,
  relationship text,
  expertise text[] not null default '{}',
  geography text,
  notes text,
  source_document_id uuid references knowledge_documents(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists network_contacts_org_idx on network_contacts (organization_id, full_name);
create unique index if not exists network_contacts_email_uniq
  on network_contacts (organization_id, lower(email)) where email is not null;

alter table network_contacts
  add column if not exists search_vector tsvector
  generated always as (
    setweight(to_tsvector('english', coalesce(full_name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(company, '') || ' ' || coalesce(title, '')), 'B') ||
    setweight(to_tsvector('english',
      coalesce(relationship, '') || ' ' || array_to_string(expertise, ' ') || ' ' || coalesce(notes, '')
    ), 'C')
  ) stored;

create index if not exists network_contacts_search_idx on network_contacts using gin (search_vector);

-- --------------------------------------------------------------- thesis --

-- Versioned and append-only. An analysis records the version it was scored
-- against, so editing weights later never rewrites the meaning of a past
-- recommendation.
create table if not exists thesis_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  version integer not null,
  preferred_stages text[] not null default '{}',
  preferred_industries text[] not null default '{}',
  excluded_industries text[] not null default '{}',
  geographic_preferences text[] not null default '{}',
  -- Null means "not configured" and is excluded from scoring. It never means
  -- zero, and the product never invents a value for it.
  typical_check_range text,
  target_ownership text,
  follow_on_strategy text,
  required_traction text,
  thesis_notes text not null default '',
  hard_disqualifiers text[] not null default '{}',
  scoring_weights jsonb not null default '[]'::jsonb,
  thresholds jsonb not null default '{}'::jsonb,
  deal_stages jsonb not null default '[]'::jsonb,
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (organization_id, version)
);

-- At most one active thesis per organization.
create unique index if not exists thesis_versions_active_idx
  on thesis_versions (organization_id) where is_active;

-- Individual criteria, split out so a single criterion can be enabled,
-- weighted and reported on without rewriting the whole thesis document.
create table if not exists thesis_criteria (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  thesis_version_id uuid not null references thesis_versions(id) on delete cascade,
  key text not null,
  label text not null,
  description text not null default '',
  weight real not null default 0 check (weight >= 0),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (thesis_version_id, key)
);

create trigger portfolio_companies_updated_at before update on portfolio_companies
  for each row execute function set_updated_at();
create trigger portfolio_updates_updated_at before update on portfolio_updates
  for each row execute function set_updated_at();
create trigger knowledge_documents_updated_at before update on knowledge_documents
  for each row execute function set_updated_at();
create trigger network_contacts_updated_at before update on network_contacts
  for each row execute function set_updated_at();
