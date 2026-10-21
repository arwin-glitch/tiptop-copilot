-- Removed list rows, kept so the daily Affinity sync does not bring them back.
--
-- Copilot now writes to the CRM as Affinity did: new companies and people,
-- new lists, columns, notes, and taking a row off a list. Everything but the
-- last fits the tables of 20261015000000_crm.sql. Taking a row off a list
-- does not: until the subscription is cancelled the daily sync copies every
-- Affinity list in again each morning, and a row that is simply deleted is a
-- row it has never seen, so it would be back the next day.
--
-- So removing a row writes one of these first, then deletes the row. The
-- sync (and a CSV re-import, which goes through the same upsert) skips any
-- incoming row that matches a tombstone of its list: by the row's own key,
-- or on a company or person list by the company or person it is about. The
-- tombstone also holds the row as it was, so Undo puts it back exactly — same
-- id, so the notes linked to it are linked again — and deletes the tombstone.
-- Adding the same company or person to the list again by hand clears it too.
--
-- Additive and idempotent like every migration here; safe to run again in the
-- SQL editor. Until it is applied the app keeps working: removing a row says
-- to run this file and removes nothing, and the sync reads no tombstones (see
-- lib/services/crm.ts).

create table if not exists crm_entry_tombstones (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  -- The list the row was taken off. A deleted list takes its tombstones.
  list_id uuid not null references crm_lists(id) on delete cascade,
  -- The removed row's id, reused when Undo puts it back.
  entry_id uuid not null,
  -- What the sync matches on: the row's own key (Affinity's row id,
  -- 'entity:<id>' or 'name:<name>'; null for a row made in Copilot) and the
  -- company or person it was about. No foreign key: the record may go later
  -- and the tombstone must still hold.
  external_id text,
  record_id uuid,
  title text not null check (char_length(title) between 1 and 500),
  -- The row as it was when removed (a crm_list_entries row as JSON), for Undo.
  entry jsonb not null check (jsonb_typeof(entry) = 'object'),
  removed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (list_id, entry_id)
);

create index if not exists crm_entry_tombstones_list_idx
  on crm_entry_tombstones (organization_id, list_id);
create index if not exists crm_entry_tombstones_record_idx
  on crm_entry_tombstones (list_id, record_id) where record_id is not null;

-- ------------------------------------------------------------------- RLS --
--
-- The CRM's own shape: read for any member, write for member and above.
-- Dropped first so the file can be re-run.

alter table crm_entry_tombstones enable row level security;
drop policy if exists crm_entry_tombstones_select on crm_entry_tombstones;
drop policy if exists crm_entry_tombstones_insert on crm_entry_tombstones;
drop policy if exists crm_entry_tombstones_delete on crm_entry_tombstones;
create policy crm_entry_tombstones_select on crm_entry_tombstones
  for select using (is_org_member(organization_id));
create policy crm_entry_tombstones_insert on crm_entry_tombstones
  for insert with check (has_org_role(organization_id, 'member'));
create policy crm_entry_tombstones_delete on crm_entry_tombstones
  for delete using (has_org_role(organization_id, 'member'));

comment on table crm_entry_tombstones is
  'Rows taken off a CRM list in Copilot: the daily Affinity sync and CSV re-imports skip them; Undo restores the row from `entry`.';

-- No explicit grants: service_role inherits via the default privileges set in
-- 20260101000600.
