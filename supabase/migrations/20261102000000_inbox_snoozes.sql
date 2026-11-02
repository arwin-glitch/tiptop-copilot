-- Snooze (Gmail-style) for the Inbox tab. Gmail's API has no snooze, so
-- Kraken keeps it: snoozing a thread takes it out of the inbox in Gmail (the
-- same label change as Archive) and keeps one row here with the wake time.
-- At or after wake_at Kraken puts the thread back in the inbox, marked
-- unread, and the row becomes 'woken'. Waking happens whenever the Inbox list
-- loads and on the daily job's runs (including its frequent tasks=sync runs).
-- Unsnooze (or Undo) puts the thread back at once and marks the row
-- 'cancelled'.
--
--   - inbox_snoozes: one row per snooze. thread_id is the Gmail thread id (or
--     the demo Inbox's id for a demo thread). At most one row per thread is
--     'snoozed' at a time (inbox_snoozes_one_open_idx); snoozing again
--     replaces it.
--
-- Additive and idempotent like every migration here: safe to run again in
-- the SQL editor. Until it is applied the Snooze button says it needs a
-- database update, nothing is taken out of the inbox, and nothing else
-- changes.
--
-- Constraint names are written out and never match the names Postgres gives
-- an inline column check (<table>_<column>_check), which is what broke the
-- first booking migration.

create table if not exists inbox_snoozes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  thread_id text not null,
  wake_at timestamptz not null,
  status text not null default 'snoozed',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table inbox_snoozes drop constraint if exists inbox_snoozes_thread_shape;
alter table inbox_snoozes add constraint inbox_snoozes_thread_shape check (
  thread_id ~ '^[0-9a-f]{10,24}$'
);

alter table inbox_snoozes drop constraint if exists inbox_snoozes_status_allowed;
alter table inbox_snoozes add constraint inbox_snoozes_status_allowed check (
  status in ('snoozed', 'woken', 'cancelled')
);

-- One open snooze per thread.
create unique index if not exists inbox_snoozes_one_open_idx
  on inbox_snoozes (organization_id, thread_id)
  where status = 'snoozed';
-- The wake step and the Snoozed tab read the open snoozes by wake time.
create index if not exists inbox_snoozes_due_idx
  on inbox_snoozes (organization_id, status, wake_at);

drop trigger if exists inbox_snoozes_updated_at on inbox_snoozes;
create trigger inbox_snoozes_updated_at before update on inbox_snoozes
  for each row execute function set_updated_at();

-- ------------------------------------------------------------------- RLS --
--
-- The server writes with the service role; browser roles query nothing
-- directly. The policies still match the app: any member reads, member and
-- above write (the Inbox's actions are any member's).

do $$
declare
  t text;
begin
  foreach t in array array['inbox_snoozes'] loop
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

comment on table inbox_snoozes is
  'Inbox snooze: a thread taken out of the inbox until wake_at, when Kraken puts it back unread.';
comment on column inbox_snoozes.thread_id is
  'The Gmail thread id (the demo Inbox''s id for a demo thread).';

-- No explicit grants: service_role inherits via the default privileges set in
-- 20260101000600, and browser roles deliberately query nothing directly.
