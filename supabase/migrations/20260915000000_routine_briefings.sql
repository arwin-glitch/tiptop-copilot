-- The Today page's briefing card, sourced from the cloud triage fleet's own
-- dashboards (Daily Overview each morning, Daily Recap each afternoon)
-- rather than generated in-app.
--
-- One row per organization: a post from a routine is an upsert keyed on
-- organization_id, so it replaces whatever was there rather than
-- accumulating a history. There is no reset at midnight — a quiet morning
-- simply leaves yesterday afternoon's card in place until the next Overview
-- replaces it. If a history of past briefings is ever wanted, that is a
-- different table; this one is deliberately a single current value.

create table if not exists routine_briefings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  kind text not null check (kind in ('morning', 'afternoon')),
  -- Local calendar date the routine ran for, in the user's timezone.
  date_key text not null check (date_key ~ '^\d{4}-\d{2}-\d{2}$'),
  title text not null,
  -- Plain text, never HTML — see the webhook route for why.
  summary text not null,
  source_url text,
  posted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id)
);

create trigger routine_briefings_updated_at before update on routine_briefings
  for each row execute function set_updated_at();

alter table routine_briefings enable row level security;

-- Read-only for members: this table's only writer is the webhook route,
-- which uses the service role and so bypasses RLS by design (see the note in
-- 20260101000600). There is deliberately no insert/update/delete policy for
-- authenticated users — the content always originates from a routine, never
-- from the app UI.
create policy routine_briefings_select on routine_briefings
  for select using (is_org_member(organization_id));
