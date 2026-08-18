-- Meeting notes, ingested from Granola via a Zapier webhook.
--
-- One table, additive and idempotent like every migration here. The note body
-- is untrusted third-party content: it is stored verbatim, scanned for
-- instruction-shaped text on the way in (annotated, never hidden), and only
-- ever rendered as text. Links to deals, companies and people are derived at
-- read time from attendee addresses — nothing is guessed at write time, so a
-- wrong inference cannot be persisted.

create table if not exists meeting_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  -- 'granola' today. A column rather than an assumption, so a second source
  -- never needs a schema change.
  provider text not null default 'granola',
  -- The note's identity in the source system. Zapier retries deliveries, so
  -- ingestion must be an upsert on this key to stay idempotent.
  external_id text not null,
  title text not null,
  -- When the meeting happened, from the calendar event Granola attaches.
  occurred_at timestamptz not null,
  -- [{ "name": string|null, "email": string }]
  attendees jsonb not null default '[]'::jsonb,
  -- Verbatim note text. Untrusted; rendered as text only.
  content text not null,
  source_url text,
  -- Set by the ingest scan when the content contains text aimed at an AI
  -- assistant. Annotates the note in the UI; never hides it.
  injection_flagged boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider, external_id)
);

create index if not exists meeting_notes_occurred_idx
  on meeting_notes (organization_id, occurred_at desc);

alter table meeting_notes enable row level security;

create policy meeting_notes_select on meeting_notes
  for select using (is_org_member(organization_id));
create policy meeting_notes_insert on meeting_notes
  for insert with check (has_org_role(organization_id, 'member'));
create policy meeting_notes_update on meeting_notes
  for update using (has_org_role(organization_id, 'member'))
  with check (has_org_role(organization_id, 'member'));
create policy meeting_notes_delete on meeting_notes
  for delete using (has_org_role(organization_id, 'member'));

-- No explicit grants: service_role inherits via the default privileges set in
-- 20260101000600, and browser roles deliberately query nothing directly.
