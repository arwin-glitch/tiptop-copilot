-- Harmonic over MCP: one org-wide OAuth connection to Harmonic's hosted MCP
-- server (https://mcp.api.harmonic.ai/). Whoever clicks Connect signs in with
-- their own Harmonic account; Kraken then calls Harmonic tools (entity
-- lookups for people and companies nobody has met yet) on the free OAuth
-- quota. The paid REST API key path is separate and unchanged.
--
--   - harmonic_connections: one row per organization. The dynamically
--     registered OAuth client id, and a sealed blob (AES-256-GCM, see
--     lib/security/crypto.ts) holding the client secret and the access and
--     refresh tokens. No token is ever stored in plaintext.
--
-- Additive and idempotent like every migration here: safe to run again in
-- the SQL editor. Until it is applied, Settings shows Harmonic as not
-- connected, nothing is stored, and nothing else changes.

create table if not exists harmonic_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references organizations(id) on delete cascade,
  connected_by uuid references auth.users(id) on delete set null,
  harmonic_email text,
  client_id text not null,
  sealed_ciphertext text not null,
  sealed_iv text not null,
  sealed_auth_tag text not null,
  key_version integer not null default 1,
  access_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists harmonic_connections_updated_at on harmonic_connections;
create trigger harmonic_connections_updated_at before update on harmonic_connections
  for each row execute function set_updated_at();

-- ------------------------------------------------------------------- RLS --
--
-- Service role only. RLS is on and there are deliberately NO policies, so no
-- browser role can read or write a row: the sealed tokens are read and
-- written by the server alone, under the service role.

alter table harmonic_connections enable row level security;

comment on table harmonic_connections is
  'Harmonic MCP OAuth connection, one per organization: tokens sealed, read and written by the server alone.';

-- No explicit grants: service_role inherits via the default privileges set in
-- 20260101000600, and browser roles deliberately query nothing directly.
