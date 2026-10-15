-- Tokens for the MCP endpoint (/api/mcp): how Claude reads the CRM.
--
-- Claude sessions and the cloud routines used Affinity's MCP server to look up
-- LP stages, deal history and notes. Copilot's own MCP endpoint replaces it,
-- and each client gets its own named token, created by an owner in Settings ->
-- Integrations -> Connect Claude (MCP).
--
-- Only the SHA-256 of a token is stored. The token itself is shown once, when
-- it is created, and cannot be recovered from this table: a lost token is
-- revoked and replaced, never looked up. `hint` is its last four characters,
-- so the owner can tell two tokens apart.
--
-- A table of its own rather than rows in audit_events, because a token has
-- state that changes (last used, revoked) and audit_events is append-only.
-- Every call made with a token is still audited there as `mcp.tool_called`
-- (tool and client name only, never arguments or results).
--
-- Additive and idempotent like every migration here; safe to run again in the
-- SQL editor. Until it is applied the app keeps working: Settings shows a
-- "run this migration" note instead of the token list, and /api/mcp answers
-- every request with a "not set up" error (see lib/services/mcp-tokens.ts).

create table if not exists mcp_tokens (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  -- Hex SHA-256 of the whole token string.
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  hint text not null check (char_length(hint) between 1 and 8),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  -- Written at most once a minute per token, so a busy client is not a write
  -- per call.
  last_used_at timestamptz,
  -- Set once; a revoked token never authenticates again.
  revoked_at timestamptz,
  unique (token_hash)
);

create index if not exists mcp_tokens_org_created_idx
  on mcp_tokens (organization_id, created_at desc);

-- ------------------------------------------------------------------- RLS --
--
-- Owners may read their organization's tokens (names, hints, dates; the hash
-- is useless without the token). Nothing is writable from a browser role:
-- creating and revoking go through the server, under the service role.

alter table mcp_tokens enable row level security;
drop policy if exists mcp_tokens_select on mcp_tokens;
create policy mcp_tokens_select on mcp_tokens
  for select using (has_org_role(organization_id, 'owner'));

comment on table mcp_tokens is
  'MCP connector tokens: SHA-256 hash only, shown once at creation. Read and written by the server alone.';

-- No explicit grants: service_role inherits via the default privileges set in
-- 20260101000600, and browser roles deliberately query nothing directly.
