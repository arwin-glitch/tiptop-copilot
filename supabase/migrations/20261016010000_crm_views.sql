-- Saved views on CRM lists.
--
-- Affinity lists carry named views — a table or a board with its own columns,
-- sort, filters and board grouping — and Copilot's lists now do too. They are
-- stored on the list itself, as a jsonb array, rather than in a table of
-- their own: a list has a handful of views, they are always read with the
-- list, and the list row already scopes them to its organization under the
-- crm_lists row-level security policies (read for members, write for member
-- and above). The shape, as lib/crm/saved-views.ts writes and re-validates it:
--
--   [{ "id": string, "name": string, "view": 'table' | 'board',
--      "columns": string[] | null, "sort": string, "dir": 'asc' | 'desc',
--      "statuses": string[], "conditions": [{ "key", "op", "value"?, "values"? }],
--      "groupBy": string, "created_at": string, "updated_at": string }]
--
-- The built-in "All" view is never stored.
--
-- Additive and idempotent like every migration here — safe to run again. The
-- app reads the column defensively: until this file has been applied a list
-- simply has no saved views, and saving one says to run this file.

alter table crm_lists add column if not exists views jsonb not null default '[]'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'crm_lists_views_is_array' and conrelid = 'crm_lists'::regclass
  ) then
    alter table crm_lists
      add constraint crm_lists_views_is_array check (jsonb_typeof(views) = 'array');
  end if;
end $$;

comment on column crm_lists.views is
  'Saved views (Affinity-style): a jsonb array validated by lib/crm/saved-views.ts. The built-in All view is not stored.';

-- Time in current status reads a list's status changes from the audit trail
-- (crm.entry_updated rows carry metadata.list_id); this keeps the whole-list
-- read an index scan for CSV exports of large lists.
create index if not exists audit_events_crm_entry_list_idx
  on audit_events (organization_id, ((metadata->>'list_id')), created_at desc)
  where action = 'crm.entry_updated';
