-- Organizations, membership, profiles and integrations.

create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 200),
  slug text not null unique check (slug ~ '^[a-z0-9-]{1,60}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists user_profiles (
  -- Mirrors auth.users.id so a profile cannot outlive its account.
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  avatar_url text,
  timezone text not null default 'America/Chicago',
  theme text not null default 'system' check (theme in ('system', 'light', 'dark')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists organization_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role org_role not null default 'member',
  created_at timestamptz not null default now(),
  -- One membership row per user per organization.
  unique (organization_id, user_id)
);

create index if not exists organization_members_user_idx on organization_members (user_id);

create table if not exists integrations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider integration_provider not null,
  kinds integration_kind[] not null default '{}',
  account_email text,
  scopes text[] not null default '{}',
  status integration_status not null default 'disconnected',
  status_detail text,
  last_sync_at timestamptz,
  last_sync_error text,
  sync_cursor text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One integration per provider per user per organization; reconnecting
  -- updates in place rather than accumulating rows.
  unique (organization_id, provider, user_id)
);

create index if not exists integrations_org_idx on integrations (organization_id);

-- Ciphertext only. The plaintext refresh token exists in process memory during
-- a request and nowhere else. AAD binds each row to its integration, so a
-- ciphertext cannot be moved between integrations even with database access.
create table if not exists encrypted_provider_tokens (
  id uuid primary key default gen_random_uuid(),
  integration_id uuid not null references integrations(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  token_type text not null check (token_type in ('refresh', 'access')),
  ciphertext text not null,
  iv text not null,
  auth_tag text not null,
  key_version integer not null default 1,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (integration_id, token_type)
);

create table if not exists sync_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  integration_id uuid not null references integrations(id) on delete cascade,
  kind integration_kind not null,
  -- The idempotency key is what makes a retried sync a no-op rather than
  -- duplicate work. Derived deterministically from org, integration, cursor
  -- and window.
  idempotency_key text not null,
  status sync_status not null default 'running',
  items_seen integer not null default 0,
  items_created integer not null default 0,
  items_updated integer not null default 0,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (organization_id, integration_id, idempotency_key)
);

create index if not exists sync_runs_org_started_idx on sync_runs (organization_id, started_at desc);

create trigger organizations_updated_at before update on organizations
  for each row execute function set_updated_at();
create trigger user_profiles_updated_at before update on user_profiles
  for each row execute function set_updated_at();
create trigger integrations_updated_at before update on integrations
  for each row execute function set_updated_at();
create trigger encrypted_provider_tokens_updated_at before update on encrypted_provider_tokens
  for each row execute function set_updated_at();
