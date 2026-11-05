-- Spaces: a member's own Google, connected read-only to contribute (D-081).
--
-- Until now a workspace had ONE Google connection (provider 'google', the
-- primary: Nick's mailbox, the Inbox, sending, filters, sync). Every reader
-- of it picks "the newest google row", so a second 'google' row for a member
-- would have taken over the Inbox. A member's connection is therefore its
-- own provider value, 'google_space': nothing that reads provider 'google'
-- ever sees it, and lib/services/space-member-mail.ts is the one module that
-- reads it (a test scans the source for any other).
--
--   - integrations.provider gains 'google_space'. One per member per
--     organization: the existing unique (organization_id, provider, user_id)
--     already allows exactly that, beside the primary 'google' row.
--   - integrations_member_read_only: a 'google_space' row may only ever list
--     read-only scopes (openid, userinfo.email, gmail.readonly,
--     calendar.readonly). The app refuses any other grant before storing it;
--     this is the second lock.
--   - RLS: a member's connection row is seen and written only by that member
--     (user_id = auth.uid()). The primary stays visible to every member of the
--     organization, as before. The server reads with the service role and
--     checks Space membership itself; browser roles query nothing directly.
--   - Tokens: stored exactly as the primary's, in encrypted_provider_tokens
--     (AES-GCM, AAD bound to the integration id, key outside the database),
--     whose policy denies every client read. Nothing new is needed there.
--
-- What a member's mail and calendar are used for: the Spaces they accepted,
-- only the items matching each Space's rules, minus what they hid, shown to
-- that Space's members. Never synced into email_threads or calendar_events,
-- never in the Inbox, Today, Follow-ups, Tasks, Ask Arwin, digests or search.
--
-- Additive and idempotent like every migration here: safe to run again in
-- the SQL editor. Until it is applied, "Connect your Google to contribute"
-- says it needs a database update and nothing else changes.
--
-- The new enum value is never used as an enum literal in this file (Postgres
-- refuses a value added in the same transaction); the checks below compare
-- provider::text instead.

alter type integration_provider add value if not exists 'google_space';

alter table integrations drop constraint if exists integrations_member_read_only;
alter table integrations add constraint integrations_member_read_only check (
  provider::text <> 'google_space'
  or scopes <@ array[
    'openid',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/calendar.readonly'
  ]::text[]
);

-- ------------------------------------------------------------------- RLS --
--
-- Replaces the two integrations policies from 20260101000600 with the same
-- rule for the primary and an own-row-only rule for member connections.

drop policy if exists integrations_select on integrations;
create policy integrations_select on integrations for select using (
  is_org_member(organization_id)
  and (provider::text <> 'google_space' or user_id = auth.uid())
);

drop policy if exists integrations_write on integrations;
create policy integrations_write on integrations for all
  using (
    has_org_role(organization_id, 'member')
    and (provider::text <> 'google_space' or user_id = auth.uid())
  )
  with check (
    has_org_role(organization_id, 'member')
    and (provider::text <> 'google_space' or user_id = auth.uid())
  );

comment on constraint integrations_member_read_only on integrations is
  'A member''s Spaces connection (google_space) holds read-only scopes only.';
comment on policy integrations_select on integrations is
  'The primary Google connection is visible to the organization; a member''s own Spaces connection only to that member.';

-- No explicit grants: service_role inherits via the default privileges set in
-- 20260101000600, and browser roles deliberately query nothing directly.
