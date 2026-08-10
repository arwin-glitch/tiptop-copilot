-- Row-level security.
--
-- Every table is deny-by-default and readable only by members of the owning
-- organization. The application *also* passes organization_id explicitly on
-- every query: the policy is the security boundary, the parameter is the
-- correctness boundary, and a bug in either is caught by the other.
--
-- Note on the service role: server-side code uses the service key, which
-- bypasses RLS by design. These policies protect the anon/authenticated paths
-- (a leaked anon key, a direct PostgREST call, a future client-side query) and
-- are the reason such a leak is not a data breach.

-- Membership predicates used by every policy below.
--
-- These are defined here rather than alongside the other helpers in
-- `20260101000000` because they are `language sql`, which Postgres validates
-- when the function is created — and they read `organization_members`, which
-- does not exist until `20260101000100`. Declaring them any earlier makes the
-- schema impossible to apply in order.
--
-- SECURITY DEFINER with a pinned search_path: the policy needs to read
-- organization_members, but organization_members is itself protected by RLS,
-- which would recurse. Defining the check here breaks the cycle without
-- widening what a caller can read.

create or replace function is_org_member(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from organization_members m
    where m.organization_id = target_org
      and m.user_id = auth.uid()
  );
$$;

create or replace function has_org_role(target_org uuid, minimum org_role)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from organization_members m
    where m.organization_id = target_org
      and m.user_id = auth.uid()
      and case m.role
            when 'owner'  then 4
            when 'admin'  then 3
            when 'member' then 2
            when 'viewer' then 1
          end
          >=
          case minimum
            when 'owner'  then 4
            when 'admin'  then 3
            when 'member' then 2
            when 'viewer' then 1
          end
  );
$$;

comment on function is_org_member(uuid) is
  'True when the current auth.uid() belongs to the organization. Used by every RLS policy.';
comment on function has_org_role(uuid, org_role) is
  'True when the current user holds at least the given role in the organization.';

alter table organizations enable row level security;
alter table organization_members enable row level security;
alter table user_profiles enable row level security;
alter table integrations enable row level security;
alter table encrypted_provider_tokens enable row level security;
alter table sync_runs enable row level security;
alter table email_threads enable row level security;
alter table email_messages enable row level security;
alter table email_participants enable row level security;
alter table email_attachments enable row level security;
alter table calendar_events enable row level security;
alter table deals enable row level security;
alter table deal_people enable row level security;
alter table deal_sources enable row level security;
alter table deal_facts enable row level security;
alter table deal_analyses enable row level security;
alter table deal_decisions enable row level security;
alter table deal_notes enable row level security;
alter table tasks enable row level security;
alter table portfolio_companies enable row level security;
alter table portfolio_contacts enable row level security;
alter table portfolio_updates enable row level security;
alter table knowledge_documents enable row level security;
alter table knowledge_chunks enable row level security;
alter table network_contacts enable row level security;
alter table thesis_versions enable row level security;
alter table thesis_criteria enable row level security;
alter table daily_briefs enable row level security;
alter table chat_threads enable row level security;
alter table chat_messages enable row level security;
alter table generated_drafts enable row level security;
alter table ai_usage enable row level security;
alter table audit_events enable row level security;
alter table user_feedback enable row level security;

-- --------------------------------------------------- identity & membership --

create policy organizations_select on organizations
  for select using (is_org_member(id));

create policy organizations_update on organizations
  for update using (has_org_role(id, 'admin')) with check (has_org_role(id, 'admin'));

create policy organization_members_select on organization_members
  for select using (user_id = auth.uid() or is_org_member(organization_id));

create policy organization_members_write on organization_members
  for all using (has_org_role(organization_id, 'admin'))
  with check (has_org_role(organization_id, 'admin'));

-- A profile is visible to its owner and to co-members, so the UI can attribute
-- a note or a decision to a name.
create policy user_profiles_select on user_profiles
  for select using (
    id = auth.uid()
    or exists (
      select 1
      from organization_members mine
      join organization_members theirs on theirs.organization_id = mine.organization_id
      where mine.user_id = auth.uid() and theirs.user_id = user_profiles.id
    )
  );

create policy user_profiles_write on user_profiles
  for all using (id = auth.uid()) with check (id = auth.uid());

-- ------------------------------------------------------------ integrations --

create policy integrations_select on integrations
  for select using (is_org_member(organization_id));

create policy integrations_write on integrations
  for all using (has_org_role(organization_id, 'member'))
  with check (has_org_role(organization_id, 'member'));

-- Encrypted tokens are never readable through the anon or authenticated role,
-- under any policy. Only the service role (server-side) can touch them, and
-- even then the plaintext requires the encryption key, which is not in the
-- database. There is deliberately no SELECT policy here.
create policy encrypted_tokens_no_client_access on encrypted_provider_tokens
  for select using (false);

create policy sync_runs_select on sync_runs
  for select using (is_org_member(organization_id));

-- --------------------------------------------------------------- org-scoped --
--
-- The remaining tables share one shape: read for any member, write for member
-- and above. Generated so the rule is impossible to apply inconsistently.

do $$
declare
  t text;
  org_scoped text[] := array[
    'email_threads', 'email_messages', 'email_participants', 'email_attachments',
    'calendar_events', 'deals', 'deal_people', 'deal_sources', 'deal_facts',
    'deal_analyses', 'deal_decisions', 'deal_notes', 'tasks',
    'portfolio_companies', 'portfolio_contacts', 'portfolio_updates',
    'knowledge_documents', 'knowledge_chunks', 'network_contacts',
    'thesis_versions', 'thesis_criteria', 'generated_drafts', 'user_feedback'
  ];
begin
  foreach t in array org_scoped loop
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

-- ------------------------------------------------------------ user-private --
--
-- Briefs and conversations belong to one person within the organization.
-- A co-member cannot read another member's chat history.

create policy daily_briefs_own on daily_briefs
  for all using (user_id = auth.uid() and is_org_member(organization_id))
  with check (user_id = auth.uid() and is_org_member(organization_id));

create policy chat_threads_own on chat_threads
  for all using (user_id = auth.uid() and is_org_member(organization_id))
  with check (user_id = auth.uid() and is_org_member(organization_id));

create policy chat_messages_own on chat_messages
  for all using (
    is_org_member(organization_id)
    and exists (
      select 1 from chat_threads t
      where t.id = chat_messages.thread_id and t.user_id = auth.uid()
    )
  )
  with check (
    is_org_member(organization_id)
    and exists (
      select 1 from chat_threads t
      where t.id = chat_messages.thread_id and t.user_id = auth.uid()
    )
  );

-- ------------------------------------------------------------- append-only --
--
-- Usage and audit are readable by admins and never mutable from a client.
-- Writes happen server-side under the service role.

create policy ai_usage_select on ai_usage
  for select using (has_org_role(organization_id, 'admin'));

create policy audit_events_select on audit_events
  for select using (has_org_role(organization_id, 'admin'));

comment on policy encrypted_tokens_no_client_access on encrypted_provider_tokens is
  'Deliberately denies all client reads. Provider tokens are server-only and additionally require an encryption key held outside the database.';

-- ----------------------------------------------------------------- grants --
--
-- Without these the schema is unusable, and the failure is opaque: the server
-- authenticates a user successfully and then the first query raises
--
--   permission denied for table organization_members
--
-- Supabase grants the API roles privileges on new tables only when the
-- project's "Automatically expose new tables" setting is on. That setting is
-- off by default and Supabase itself recommends leaving it off — so a schema
-- that relies on it works or fails depending on a checkbox in a dashboard, set
-- once, months earlier, by someone who has forgotten. Granting explicitly here
-- makes the migrations self-sufficient either way.
--
-- Only `service_role` gets table access. Every read and write in this
-- application happens server-side under that role; `anon` and `authenticated`
-- never query a table directly, so they get schema usage and nothing more.
-- The RLS policies above remain the boundary if that ever changes.

grant usage on schema public to anon, authenticated, service_role;

grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;
grant all privileges on all functions in schema public to service_role;

-- Anything created later, by a future migration, inherits the same.
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public grant all on functions to service_role;
