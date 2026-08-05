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
