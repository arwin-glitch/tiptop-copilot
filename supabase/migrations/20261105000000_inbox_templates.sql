-- Templates (Gmail's "Templates") for the Inbox tab's compose window. Gmail's
-- API cannot read or write Gmail's own templates, and keeping them as Gmail
-- drafts would put them in Drafts, where a template could be sent by mistake.
-- So Kraken keeps them: one row per template, shared by the workspace (Nick
-- and his assistant use the same ones). A row exists only because a person
-- clicked Templates › Save draft as template; inserting one only fills the
-- compose box, and nothing is ever sent from here.
--
--   - inbox_templates: the template's name, subject and body (the compose
--     window's HTML, sanitized before it is stored).
--
-- Additive and idempotent like every migration here: safe to run again in
-- the SQL editor. Until it is applied the Templates menu says it needs a
-- database update, nothing is stored, and nothing else changes.
--
-- Constraint names are written out and never match the names Postgres gives
-- an inline column check (<table>_<column>_check).

create table if not exists inbox_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  name text not null,
  subject text not null default '',
  body_html text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table inbox_templates drop constraint if exists inbox_templates_sizes;
alter table inbox_templates add constraint inbox_templates_sizes check (
  length(name) between 1 and 120
  and length(subject) <= 300
  and length(body_html) <= 100000
);

create index if not exists inbox_templates_org_idx on inbox_templates (organization_id, name);

drop trigger if exists inbox_templates_updated_at on inbox_templates;
create trigger inbox_templates_updated_at before update on inbox_templates
  for each row execute function set_updated_at();

-- ------------------------------------------------------------------- RLS --
--
-- The server writes with the service role; browser roles query nothing
-- directly. The policies still match the app: any member reads, member and
-- above write.

do $$
declare
  t text;
begin
  foreach t in array array['inbox_templates'] loop
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

comment on table inbox_templates is
  'Inbox compose templates: saved from a compose window by a person; inserting one only fills the box.';

-- No explicit grants: service_role inherits via the default privileges set in
-- 20260101000600, and browser roles deliberately query nothing directly.
