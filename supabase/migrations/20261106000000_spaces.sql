-- Spaces: a shared home for one client or project (Fyxer's "Spaces"). A
-- Space gathers the emails and meeting notes that match its rules (a
-- company's domain, people's addresses, keywords), the action items linked to
-- it, and answers questions about any of it. Spaces only read mail and
-- calendars: nothing here sends, labels, archives or changes a message.
--
--   - spaces: one row per Space. created_by is its owner. source_kind and
--     source_ref say where it was started from (a suggestion, a company or
--     person profile, a deal, or by hand).
--   - space_rules: what belongs in the Space. kind is 'domain' (a
--     company domain, lower case), 'email' (one address, lower case) or
--     'keyword' (a word or phrase matched in subjects, titles and notes).
--   - space_members: who is in it. The owner has a row with role 'owner' and
--     status 'accepted'. An invited colleague is 'invited' until they accept;
--     nothing of theirs comes in before that. 'declined' and 'left' keep the
--     row so an invite is not sent twice by mistake. Removing a member
--     deletes the row, and with it everything they contributed.
--   - space_hidden_items: an email thread, meeting or note a member hid from
--     the Space (item_kind + item_id: the Gmail thread id, the calendar event
--     id or the note id), or an action-item suggestion someone dismissed
--     ('suggestion'). Honoured on every tab, the counts and Ask.
--   - tasks.space_id: an action item linked to a Space.
--
-- Visibility is members only: a Space, its rules, members and hidden items
-- are read by the people in it (invited or accepted), never by the rest of
-- the organization. The owner (and an organization admin who is in the Space)
-- manages it; each member manages their own membership and hidden items.
--
-- Additive and idempotent like every migration here: safe to run again in
-- the SQL editor. Until it is applied the Spaces tab says it needs a database
-- update and shows nothing else, and nothing else changes.
--
-- Constraint names are written out and never match the names Postgres gives
-- an inline column check (<table>_<column>_check), which is what broke the
-- first booking migration.

create table if not exists spaces (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  description text,
  source_kind text not null default 'manual',
  source_ref text,
  created_by uuid not null references auth.users(id) on delete cascade,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table spaces drop constraint if exists spaces_name_length;
alter table spaces add constraint spaces_name_length check (
  char_length(name) between 1 and 120
);

alter table spaces drop constraint if exists spaces_source_allowed;
alter table spaces add constraint spaces_source_allowed check (
  source_kind in ('manual', 'suggested', 'company', 'person', 'deal')
);

create index if not exists spaces_org_idx on spaces (organization_id, created_at desc);

drop trigger if exists spaces_updated_at on spaces;
create trigger spaces_updated_at before update on spaces
  for each row execute function set_updated_at();

create table if not exists space_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  space_id uuid not null references spaces(id) on delete cascade,
  kind text not null,
  value text not null,
  created_at timestamptz not null default now()
);

alter table space_rules drop constraint if exists space_rules_kind_allowed;
alter table space_rules add constraint space_rules_kind_allowed check (
  kind in ('domain', 'email', 'keyword')
);

alter table space_rules drop constraint if exists space_rules_value_shape;
alter table space_rules add constraint space_rules_value_shape check (
  char_length(value) between 1 and 200
);

create unique index if not exists space_rules_unique_idx
  on space_rules (space_id, kind, value);

create table if not exists space_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  space_id uuid not null references spaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member',
  status text not null default 'invited',
  invited_by uuid references auth.users(id) on delete set null,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table space_members drop constraint if exists space_members_role_allowed;
alter table space_members add constraint space_members_role_allowed check (
  role in ('owner', 'member')
);

alter table space_members drop constraint if exists space_members_status_allowed;
alter table space_members add constraint space_members_status_allowed check (
  status in ('invited', 'accepted', 'declined', 'left')
);

create unique index if not exists space_members_one_per_user_idx
  on space_members (space_id, user_id);
create index if not exists space_members_user_idx
  on space_members (organization_id, user_id);

drop trigger if exists space_members_updated_at on space_members;
create trigger space_members_updated_at before update on space_members
  for each row execute function set_updated_at();

create table if not exists space_hidden_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  space_id uuid not null references spaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  item_kind text not null,
  item_id text not null,
  created_at timestamptz not null default now()
);

alter table space_hidden_items drop constraint if exists space_hidden_items_kind_allowed;
alter table space_hidden_items add constraint space_hidden_items_kind_allowed check (
  item_kind in ('email', 'meeting', 'note', 'suggestion')
);

alter table space_hidden_items drop constraint if exists space_hidden_items_id_shape;
alter table space_hidden_items add constraint space_hidden_items_id_shape check (
  char_length(item_id) between 1 and 200
);

create unique index if not exists space_hidden_items_unique_idx
  on space_hidden_items (space_id, item_kind, item_id);

-- An action item linked to a Space. A Space deleted leaves its tasks in place.
alter table tasks add column if not exists space_id uuid references spaces(id) on delete set null;
create index if not exists tasks_space_idx on tasks (space_id) where space_id is not null;

-- --------------------------------------------------------------- helpers --
--
-- Declared after the tables they read (a `language sql` body is checked when
-- the function is created). Security definer with a pinned search_path, as
-- is_org_member is, so the policies below do not recurse through
-- space_members' own policy.

create or replace function is_space_member(target uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from space_members m
    where m.space_id = target
      and m.user_id = auth.uid()
      and m.status in ('invited', 'accepted')
  );
$$;

create or replace function can_manage_space(target uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from spaces s
    where s.id = target
      and is_org_member(s.organization_id)
      and (
        s.created_by = auth.uid()
        or (has_org_role(s.organization_id, 'admin') and is_space_member(s.id))
      )
  );
$$;

comment on function is_space_member(uuid) is
  'True when the current auth.uid() is invited to or in the Space.';
comment on function can_manage_space(uuid) is
  'True when the current auth.uid() owns the Space, or is an org admin who is in it.';

-- ------------------------------------------------------------------- RLS --
--
-- The server writes with the service role and checks membership itself;
-- browser roles query nothing directly. The policies still match the app:
-- members only.

alter table spaces enable row level security;
drop policy if exists spaces_select on spaces;
drop policy if exists spaces_insert on spaces;
drop policy if exists spaces_update on spaces;
drop policy if exists spaces_delete on spaces;
create policy spaces_select on spaces for select using (
  is_org_member(organization_id) and (created_by = auth.uid() or is_space_member(id))
);
create policy spaces_insert on spaces for insert with check (
  has_org_role(organization_id, 'member') and created_by = auth.uid()
);
create policy spaces_update on spaces for update
  using (can_manage_space(id)) with check (can_manage_space(id));
create policy spaces_delete on spaces for delete using (can_manage_space(id));

do $$
declare
  t text;
begin
  foreach t in array array['space_rules', 'space_members', 'space_hidden_items'] loop
    execute format('alter table %I enable row level security;', t);
    execute format('drop policy if exists %I on %I;', t || '_select', t);
    execute format('drop policy if exists %I on %I;', t || '_insert', t);
    execute format('drop policy if exists %I on %I;', t || '_update', t);
    execute format('drop policy if exists %I on %I;', t || '_delete', t);
    execute format(
      'create policy %I on %I for select using (is_org_member(organization_id) and (is_space_member(space_id) or can_manage_space(space_id)));',
      t || '_select', t
    );
  end loop;
end $$;

-- Rules: the owner manages them.
create policy space_rules_insert on space_rules for insert
  with check (can_manage_space(space_id));
create policy space_rules_update on space_rules for update
  using (can_manage_space(space_id)) with check (can_manage_space(space_id));
create policy space_rules_delete on space_rules for delete using (can_manage_space(space_id));

-- Members: the owner invites and removes; each person answers their own
-- invite (accept, decline) and can leave.
create policy space_members_insert on space_members for insert
  with check (can_manage_space(space_id));
create policy space_members_update on space_members for update
  using (can_manage_space(space_id) or user_id = auth.uid())
  with check (can_manage_space(space_id) or user_id = auth.uid());
create policy space_members_delete on space_members for delete
  using (can_manage_space(space_id) or user_id = auth.uid());

-- Hidden items: each member hides and un-hides their own.
create policy space_hidden_items_insert on space_hidden_items for insert
  with check (is_space_member(space_id) and user_id = auth.uid());
create policy space_hidden_items_update on space_hidden_items for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy space_hidden_items_delete on space_hidden_items for delete
  using (user_id = auth.uid() or can_manage_space(space_id));

comment on table spaces is
  'Spaces: a shared home for one client or project, gathering the emails and meeting notes that match its rules. Members only.';
comment on table space_rules is
  'What belongs in a Space: a company domain, a person''s address, or a keyword.';
comment on table space_members is
  'Who is in a Space. Invited people accept before anything of theirs comes in.';
comment on table space_hidden_items is
  'Emails, meetings and notes a member hid from a Space, and dismissed suggestions.';
comment on column tasks.space_id is
  'The Space this action item belongs to, if any.';

-- No explicit grants: service_role inherits via the default privileges set in
-- 20260101000600, and browser roles deliberately query nothing directly.
