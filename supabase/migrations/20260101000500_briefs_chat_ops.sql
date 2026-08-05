-- Daily briefs, chat, drafts and the operational tables (usage, audit, feedback).

create table if not exists daily_briefs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Local calendar date in the user's timezone, not the server's.
  date_key text not null check (date_key ~ '^\d{4}-\d{2}-\d{2}$'),
  timezone text not null,
  outlook text not null,
  priorities jsonb not null default '[]'::jsonb,
  sections jsonb not null default '{}'::jsonb,
  recommended_actions text[] not null default '{}',
  citations jsonb not null default '[]'::jsonb,
  model text not null,
  prompt_version text not null,
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (organization_id, user_id, date_key)
);

create table if not exists chat_threads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'New conversation',
  -- When set, every tool read in this conversation is restricted to this deal.
  deal_id uuid references deals(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists chat_threads_user_idx on chat_threads (user_id, updated_at desc);

create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  thread_id uuid not null references chat_threads(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  citations jsonb not null default '[]'::jsonb,
  tool_calls jsonb not null default '[]'::jsonb,
  model text,
  prompt_version text,
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_thread_idx on chat_messages (thread_id, created_at);

create table if not exists generated_drafts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  kind draft_kind not null,
  subject text not null,
  body text not null,
  to_addresses text[] not null default '{}',
  deal_id uuid references deals(id) on delete cascade,
  portfolio_company_id uuid references portfolio_companies(id) on delete cascade,
  email_message_id uuid references email_messages(id) on delete set null,
  -- Permanently false. The app requests no send scope and has no send path;
  -- the constraint makes that a schema-level guarantee rather than a promise.
  sent boolean not null default false check (sent = false),
  model text,
  prompt_version text,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists generated_drafts_deal_idx on generated_drafts (deal_id, created_at desc)
  where deal_id is not null;
create index if not exists generated_drafts_org_idx on generated_drafts (organization_id, created_at desc);

create table if not exists ai_usage (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  operation text not null,
  model text not null,
  prompt_version text not null,
  input_tokens integer,
  output_tokens integer,
  cache_read_tokens integer,
  estimated_cost_usd numeric(12, 6) not null default 0,
  ok boolean not null default true,
  error_code text,
  duration_ms integer not null default 0,
  created_at timestamptz not null default now()
);

-- The rate limiter and daily budget both read this index.
create index if not exists ai_usage_org_created_idx on ai_usage (organization_id, created_at desc);
create index if not exists ai_usage_user_created_idx on ai_usage (user_id, created_at desc);

create table if not exists audit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text,
  -- Redacted before write; see lib/security/redact.ts.
  metadata jsonb not null default '{}'::jsonb,
  -- One-way hash. The raw client address is never stored.
  ip_hash text,
  created_at timestamptz not null default now()
);

create index if not exists audit_events_org_created_idx on audit_events (organization_id, created_at desc);
create index if not exists audit_events_entity_idx on audit_events (organization_id, entity_type, entity_id);
create index if not exists audit_events_action_idx on audit_events (organization_id, action, created_at desc);

create table if not exists user_feedback (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  subject_type text not null check (
    subject_type in ('analysis', 'brief', 'chat_message', 'draft', 'classification')
  ),
  subject_id text not null,
  rating text not null check (rating in ('up', 'down')),
  comment text,
  created_at timestamptz not null default now(),
  unique (user_id, subject_type, subject_id)
);

create index if not exists user_feedback_subject_idx
  on user_feedback (organization_id, subject_type, subject_id);

create trigger chat_threads_updated_at before update on chat_threads
  for each row execute function set_updated_at();
create trigger generated_drafts_updated_at before update on generated_drafts
  for each row execute function set_updated_at();
