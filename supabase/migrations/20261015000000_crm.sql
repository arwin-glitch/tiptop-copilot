-- The CRM: lists, companies and people, list entries, and notes.
--
-- Copilot replaces Affinity, so this mirrors Affinity's model rather than
-- inventing one: a list holds one entity type and carries its own custom
-- fields; companies and people are records that can sit on many lists; a list
-- entry is one row of one list, with that list's field values; notes attach to
-- records and entries. Data arrives from Affinity's own CSV exports and every
-- import is an upsert on a natural key, so importing the same file twice is a
-- no-op rather than a duplicate.
--
-- Additive and idempotent like every migration here — safe to run again in
-- the SQL editor. The app reads these tables defensively: until this file has
-- been applied, every CRM read degrades to a "not set up yet" state and every
-- write returns a clear error, never a crashed page (see lib/services/crm.ts).

-- ---------------------------------------------------------------- lists --

create table if not exists crm_lists (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  -- Where the list came from: an Affinity export, or made in Copilot.
  source text not null default 'copilot' check (source in ('affinity', 'copilot')),
  -- The list's identity in the source system, when the source has one.
  external_id text,
  name text not null check (char_length(name) between 1 and 300),
  -- One entity type per list, as in Affinity: organization, person and
  -- opportunity lists become 'company', 'person' and 'deal'.
  entity_type text not null check (entity_type in ('company', 'person', 'deal')),
  -- The list's own columns, in display order:
  -- [{ "key": string, "name": string, "type": 'text' | 'number' | 'date' |
  --    'status' | 'multi' | 'person' | 'company' | 'url' | 'email' | 'money',
  --    "options"?: string[] }]
  fields jsonb not null default '[]'::jsonb check (jsonb_typeof(fields) = 'array'),
  position integer not null default 0,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, source, external_id)
);

create index if not exists crm_lists_org_position_idx
  on crm_lists (organization_id, position);

-- ------------------------------------------------- companies and people --

create table if not exists crm_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  kind text not null check (kind in ('company', 'person')),
  source text not null default 'copilot' check (source in ('affinity', 'copilot')),
  -- Affinity's Organization ID / Person ID. Null for records made in Copilot
  -- or imported from a column that carries only a name.
  external_id text,
  name text not null check (char_length(name) between 1 and 500),
  -- The name trimmed, inner whitespace collapsed and lowercased (crmNameKey
  -- in lib/crm/fields.ts), written by the service on every insert and update.
  -- A plain column rather than an expression index because the import matches
  -- names case-insensitively in batches through PostgREST, which can filter
  -- on a column but not on an expression.
  name_key text not null,
  -- Bare domain (no scheme, no www), companies only.
  domain text,
  -- Lowercased. primary_email is also in emails.
  emails text[] not null default '{}',
  primary_email text,
  -- Free-form extra columns from the export, keyed by their display label.
  -- Records have no schema of their own; list fields live on the list.
  fields jsonb not null default '{}'::jsonb check (jsonb_typeof(fields) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, kind, source, external_id)
);

create index if not exists crm_records_name_idx
  on crm_records (organization_id, kind, name_key);
create index if not exists crm_records_domain_idx
  on crm_records (organization_id, domain) where domain is not null;
create index if not exists crm_records_primary_email_idx
  on crm_records (organization_id, primary_email) where primary_email is not null;
create index if not exists crm_records_emails_idx
  on crm_records using gin (emails);
-- Substring search on names (ILIKE '%…%'), which is what the search box does.
create index if not exists crm_records_name_trgm_idx
  on crm_records using gin (name gin_trgm_ops);

-- ---------------------------------------------------------- list entries --

create table if not exists crm_list_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  list_id uuid not null references crm_lists(id) on delete cascade,
  -- The company or person the row is about. For a deal list, the company the
  -- opportunity is with, when there is exactly one. Deleting a record keeps
  -- the row (with its title) rather than silently shrinking the list.
  record_id uuid references crm_records(id) on delete set null,
  -- The entity or opportunity name as the list shows it.
  title text not null check (char_length(title) between 1 and 500),
  -- What makes an imported row the same row next time: Affinity's list-entry
  -- (row) id, 'entity:<id>' when the export has only the organization, person
  -- or opportunity id, or 'name:<name>' for a deal list exported without ids.
  -- Null for rows made in Copilot.
  external_id text,
  -- Field key -> value, keyed by the list's `fields[].key`. Strings, numbers
  -- and string arrays; an empty value is an absent key, never ''.
  "values" jsonb not null default '{}'::jsonb check (jsonb_typeof("values") = 'object'),
  -- The values as the last import left them, so a re-import can tell a value
  -- changed in Copilot since (kept) from one only Affinity changed (updated).
  -- Null for a row no import has written.
  imported_values jsonb check (imported_values is null or jsonb_typeof(imported_values) = 'object'),
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (list_id, external_id)
);

-- For a copy of this file applied before the column was added to it.
alter table crm_list_entries add column if not exists imported_values jsonb
  check (imported_values is null or jsonb_typeof(imported_values) = 'object');

-- Every company and person an entry links to. A deal (Affinity opportunity)
-- can sit with several organizations and people; record_id stays the single
-- "about" record, these are all of them. Filled by the import as names are
-- matched to records; empty until then.
alter table crm_list_entries add column if not exists linked_record_ids uuid[] not null default '{}';

create index if not exists crm_list_entries_list_idx
  on crm_list_entries (organization_id, list_id, position);
create index if not exists crm_list_entries_record_idx
  on crm_list_entries (record_id) where record_id is not null;
create index if not exists crm_list_entries_linked_idx
  on crm_list_entries using gin (linked_record_ids);

-- ----------------------------------------------------------------- notes --

create table if not exists crm_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  source text not null default 'copilot' check (source in ('affinity', 'copilot')),
  -- The note's identity in the source. Affinity's notes export has no id
  -- column, so an imported row is keyed by a stable hash of its date, author
  -- and content (not the entity it was exported under, so the same note from
  -- two lists' exports is one note; its names count only when it has neither
  -- date nor author), which is what makes re-importing a no-op.
  external_id text not null,
  title text,
  -- Verbatim note text. Untrusted; rendered as text only.
  content text not null check (char_length(content) <= 500000),
  -- The author as the source names them (a display name, not a user id).
  author text,
  occurred_at timestamptz,
  -- What the note is attached to. Arrays rather than join tables: a note has
  -- a handful of links, and the profile page asks "notes for this record",
  -- which the GIN indexes answer directly.
  record_ids uuid[] not null default '{}',
  entry_ids uuid[] not null default '{}',
  -- The names the source attached it to, kept even when no record matched.
  entity_names text[] not null default '{}',
  -- Set when the content contains text aimed at an AI assistant. Annotates
  -- the note in the UI; never hides it.
  injection_flagged boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, source, external_id)
);

create index if not exists crm_notes_record_ids_idx on crm_notes using gin (record_ids);
create index if not exists crm_notes_entry_ids_idx on crm_notes using gin (entry_ids);
create index if not exists crm_notes_occurred_idx
  on crm_notes (organization_id, occurred_at desc);

-- -------------------------------------------------------------- triggers --

drop trigger if exists crm_lists_updated_at on crm_lists;
create trigger crm_lists_updated_at before update on crm_lists
  for each row execute function set_updated_at();
drop trigger if exists crm_records_updated_at on crm_records;
create trigger crm_records_updated_at before update on crm_records
  for each row execute function set_updated_at();
drop trigger if exists crm_list_entries_updated_at on crm_list_entries;
create trigger crm_list_entries_updated_at before update on crm_list_entries
  for each row execute function set_updated_at();
drop trigger if exists crm_notes_updated_at on crm_notes;
create trigger crm_notes_updated_at before update on crm_notes
  for each row execute function set_updated_at();

-- ------------------------------------------------------------------- RLS --
--
-- The standard org-scoped shape: read for any member, write for member and
-- above. Dropped first so the file can be re-run.

do $$
declare
  t text;
  crm_tables text[] := array['crm_lists', 'crm_records', 'crm_list_entries', 'crm_notes'];
begin
  foreach t in array crm_tables loop
    execute format('alter table %I enable row level security;', t);
    execute format('drop policy if exists %I on %I;', t || '_select', t);
    execute format('drop policy if exists %I on %I;', t || '_insert', t);
    execute format('drop policy if exists %I on %I;', t || '_update', t);
    execute format('drop policy if exists %I on %I;', t || '_delete', t);
    execute format(
      'create policy %I on %I for select using (is_org_member(organization_id));',
      t || '_select', t
    );
    execute format(
      'create policy %I on %I for insert with check (has_org_role(organization_id, ''member''));',
      t || '_insert', t
    );
    execute format(
      'create policy %I on %I for update using (has_org_role(organization_id, ''member'')) with check (has_org_role(organization_id, ''member''));',
      t || '_update', t
    );
    execute format(
      'create policy %I on %I for delete using (has_org_role(organization_id, ''member''));',
      t || '_delete', t
    );
  end loop;
end $$;

comment on table crm_lists is
  'CRM lists (Affinity lists): one entity type each, with their own custom fields in `fields`.';
comment on table crm_records is
  'CRM companies and people. Imports upsert on (organization_id, kind, source, external_id), else match by domain/email/name_key.';
comment on table crm_list_entries is
  'One row of one CRM list. `values` is keyed by the list''s field keys.';
comment on table crm_notes is
  'CRM notes. Content is untrusted, stored verbatim and rendered as text only.';

-- No explicit grants: service_role inherits via the default privileges set in
-- 20260101000600, and browser roles deliberately query nothing directly.
