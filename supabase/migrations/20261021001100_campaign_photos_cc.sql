-- Campaign photos and copies: a photo per recipient, and CC / BCC.
--
-- Both are optional and empty by default. A campaign that uses neither sends
-- exactly the email it sent before this file existed: no Cc or Bcc header,
-- the same attachments, the same pacing.
--
--   - Photos. A campaign can carry a set of photos, kept in the private
--     storage bucket in pieces like its attachments. Each recipient may have
--     one (campaign_recipients.photo_id), matched by file name when it is
--     uploaded ("Jane Doe.jpg", "jane@acme.example.png") or picked by hand.
--     A recipient with a photo gets it as an attachment on their email only,
--     alongside the campaign's shared attachments.
--   - Copies. Addresses copied (Cc) on every email, addresses blind-copied
--     (Bcc) on every email or on the first email only (one sample copy), and
--     a few extra Cc addresses on one recipient's email. Each copy counts
--     toward the organization's 24-hour cap (copy_count), so Gmail's limits
--     hold however many people a campaign copies.
--
-- Nothing here sends, and nothing here changes what the confirmation checks:
-- every edit to photos or copies is a draft edit, which moves the campaign's
-- version on, so a review taken before it can no longer be confirmed.
--
-- Additive and idempotent like every migration here: safe to run again in
-- the SQL editor. Until it is applied, the app reads campaigns exactly as
-- before and keeps photos and CC / BCC hidden (lib/services/campaigns.ts,
-- extrasAvailable): a row read without the `cc` column means this file has
-- not run.

-- --------------------------------------------------------------- photos --

create table if not exists campaign_photos (
  -- The upload id the page chose, as for attachments: its pieces share it.
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  campaign_id uuid not null references campaigns(id) on delete cascade,
  -- The cleaned file name: what the recipient sees on the attachment, and
  -- what the match by name reads.
  name text not null check (char_length(name) between 1 and 180),
  -- Read from the file's own first bytes, never from the browser's word.
  type text not null
    check (type in ('image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic')),
  size integer not null check (size > 0),
  -- Object paths in the private storage bucket, in order.
  parts text[] not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists campaign_photos_campaign_idx
  on campaign_photos (organization_id, campaign_id, created_at);

-- -------------------------------------------------------------- copies --

-- Lowercased addresses, at most ten each. Empty: no Cc / Bcc header at all.
alter table campaigns add column if not exists cc text[] not null default '{}';
alter table campaigns add column if not exists bcc text[] not null default '{}';
-- 'every': the Bcc goes on every email. 'first': on the first email this
-- campaign actually sends, once (a sample copy for the sender's records).
alter table campaigns add column if not exists bcc_mode text not null default 'every';
-- When the one "first email only" Bcc copy was claimed for an email. Set
-- just before that email goes and cleared again only if Gmail refused it,
-- so a pause, a resume or a later batch never adds the sample a second time.
alter table campaigns add column if not exists bcc_sample_at timestamptz;

alter table campaigns drop constraint if exists campaigns_bcc_mode_check;
alter table campaigns add constraint campaigns_bcc_mode_check
  check (bcc_mode in ('every', 'first'));
alter table campaigns drop constraint if exists campaigns_copies_check;
alter table campaigns add constraint campaigns_copies_check
  check (cardinality(cc) <= 10 and cardinality(bcc) <= 10);

-- The recipient's photo, by its id in campaign_photos. Deliberately not a
-- foreign key: a photo that disappears from under a recipient must read as
-- "photo missing" (a problem the review blocks on, and a send that fails
-- rather than going out without it), never be nulled away silently.
alter table campaign_recipients add column if not exists photo_id uuid;
-- Extra addresses copied on this recipient's email only.
alter table campaign_recipients add column if not exists cc text[] not null default '{}';
-- How many CC and BCC addresses this email also went to. The 24-hour cap
-- counts each of them as one more email.
alter table campaign_recipients add column if not exists copy_count integer not null default 0;

alter table campaign_recipients drop constraint if exists campaign_recipients_copies_check;
alter table campaign_recipients add constraint campaign_recipients_copies_check
  check (cardinality(cc) <= 10 and copy_count >= 0);

create index if not exists campaign_recipients_photo_idx
  on campaign_recipients (organization_id, campaign_id, photo_id) where photo_id is not null;

-- ------------------------------------------------------------------- RLS --
--
-- The campaigns' own shape: read for any member, write for member and above.
-- Dropped first so the file can be re-run.

do $$
declare
  t text := 'campaign_photos';
begin
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
end $$;

comment on table campaign_photos is
  'Photos a campaign can attach one per recipient (campaign_recipients.photo_id), kept in the private bucket.';
comment on column campaigns.bcc_sample_at is
  'When the one "first email only" Bcc copy was claimed; never claimed again once its email went.';
comment on column campaign_recipients.copy_count is
  'CC and BCC addresses this email also went to; each counts toward the 24-hour cap.';

-- No explicit grants: service_role inherits via the default privileges set in
-- 20260101000600, and browser roles deliberately query nothing directly.
