-- Mailbox and calendar mirrors.
--
-- Every table carries the natural provider key as a unique constraint. That is
-- what makes synchronisation idempotent: a re-run upserts by construction and
-- cannot create a duplicate, regardless of retries or overlapping windows.

create table if not exists email_threads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  provider integration_provider not null,
  provider_thread_id text not null,
  subject text,
  last_message_at timestamptz not null,
  message_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider, provider_thread_id)
);

create index if not exists email_threads_org_recent_idx
  on email_threads (organization_id, last_message_at desc);

create table if not exists email_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  thread_id uuid not null references email_threads(id) on delete cascade,
  provider integration_provider not null,
  provider_message_id text not null,
  subject text,
  snippet text not null default '',
  from_name text,
  from_address text not null,
  to_addresses text[] not null default '{}',
  cc_addresses text[] not null default '{}',
  labels text[] not null default '{}',
  is_unread boolean not null default false,
  sent_at timestamptz not null,
  -- Null until a deep fetch is authorised: the user opened the message, the
  -- classifier flagged it, or automatic deep analysis is enabled.
  body_text text,
  body_fetched_at timestamptz,
  body_hash text,
  has_attachments boolean not null default false,
  category email_category not null default 'unknown',
  category_confidence real check (category_confidence between 0 and 1),
  category_source text check (category_source in ('model', 'human', 'rule')),
  importance smallint check (importance between 0 and 100),
  is_ignored boolean not null default false,
  linked_deal_id uuid,
  linked_portfolio_company_id uuid,
  injection_flagged boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider, provider_message_id)
);

create index if not exists email_messages_org_sent_idx
  on email_messages (organization_id, sent_at desc);
create index if not exists email_messages_thread_idx on email_messages (thread_id, sent_at);
create index if not exists email_messages_category_idx
  on email_messages (organization_id, category, sent_at desc);
create index if not exists email_messages_deal_idx on email_messages (linked_deal_id)
  where linked_deal_id is not null;

-- Generated tsvector + GIN index: this is the default retrieval implementation
-- and the reason the product needs no embedding provider.
alter table email_messages
  add column if not exists search_vector tsvector
  generated always as (
    setweight(to_tsvector('english', coalesce(subject, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(from_name, '') || ' ' || from_address), 'B') ||
    setweight(to_tsvector('english', coalesce(snippet, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(body_text, '')), 'D')
  ) stored;

create index if not exists email_messages_search_idx on email_messages using gin (search_vector);

-- Normalised participants, so "every message involving this address" is an
-- index scan rather than an array containment check across three columns.
create table if not exists email_participants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  message_id uuid not null references email_messages(id) on delete cascade,
  role text not null check (role in ('from', 'to', 'cc', 'bcc', 'reply_to')),
  name text,
  address text not null,
  domain text,
  created_at timestamptz not null default now(),
  unique (message_id, role, address)
);

create index if not exists email_participants_address_idx
  on email_participants (organization_id, address);
create index if not exists email_participants_domain_idx
  on email_participants (organization_id, domain) where domain is not null;

create table if not exists email_attachments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  message_id uuid not null references email_messages(id) on delete cascade,
  provider_attachment_id text,
  filename text not null,
  safe_filename text not null,
  mime_type text not null,
  size_bytes bigint not null default 0,
  -- Path inside the private bucket. Never a public URL.
  storage_path text,
  -- Page-marked text (see lib/documents/pages.ts) so a claim can cite a page.
  extracted_text text,
  page_count integer,
  extraction_confidence extraction_confidence,
  extraction_error text,
  needs_review boolean not null default false,
  content_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (message_id, provider_attachment_id)
);

create index if not exists email_attachments_message_idx on email_attachments (message_id);
create index if not exists email_attachments_hash_idx on email_attachments (organization_id, content_hash)
  where content_hash is not null;

alter table email_attachments
  add column if not exists search_vector tsvector
  generated always as (
    setweight(to_tsvector('english', coalesce(filename, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(extracted_text, '')), 'D')
  ) stored;

create index if not exists email_attachments_search_idx
  on email_attachments using gin (search_vector);

create table if not exists calendar_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider integration_provider not null,
  provider_event_id text not null,
  title text not null,
  description text,
  location text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  all_day boolean not null default false,
  attendees jsonb not null default '[]'::jsonb,
  organizer_email text,
  is_private boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider, provider_event_id)
);

create index if not exists calendar_events_org_start_idx
  on calendar_events (organization_id, starts_at);

create trigger email_threads_updated_at before update on email_threads
  for each row execute function set_updated_at();
create trigger email_messages_updated_at before update on email_messages
  for each row execute function set_updated_at();
create trigger email_attachments_updated_at before update on email_attachments
  for each row execute function set_updated_at();
create trigger calendar_events_updated_at before update on calendar_events
  for each row execute function set_updated_at();
