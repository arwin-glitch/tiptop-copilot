-- Campaigns: tracked bulk email, Copilot's replacement for Affinity's.
--
-- TipTop sends LP updates and SPV offerings as one personal email per
-- recipient from Nick's mailbox, and wants to know who opened, clicked and
-- replied. A campaign is one such send: a subject and a body template with
-- merge fields, a from identity, attachments, and its recipients. Each
-- recipient row carries its own send status, Gmail ids and tracking counters;
-- every open, click, reply, bounce and unsubscribe is also kept as an event.
--
-- Nothing here sends. A campaign moves from 'draft' to 'sending' only when a
-- person confirms it on the review screen (which shows the recipient count,
-- the from-address, the subject and a sample), and the batches go out through
-- lib/google/gmail-send.ts while that person's page drives them. There is no
-- schedule column on purpose.
--
-- Additive and idempotent like every migration here — safe to run again in
-- the SQL editor. The app reads these tables defensively: until this file has
-- been applied, every campaign read degrades to a "not set up yet" state and
-- every write returns a clear error (see lib/services/campaigns.ts).

-- ------------------------------------------------------------- campaigns --

create table if not exists campaigns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  -- What the campaign is called in Copilot. Recipients never see it.
  name text not null check (char_length(name) between 1 and 300),
  subject text not null default '' check (char_length(subject) <= 300),
  -- Plain text with light Markdown (paragraphs, **bold**, *italic*, lists,
  -- [links](https://...)) and merge fields: {{first_name}}, {{name}},
  -- {{company}}, each with an optional fallback, {{first_name|there}}.
  body_template text not null default '' check (char_length(body_template) <= 50000),
  -- Whose signature goes under the email. Both send from the connected
  -- mailbox (Nick's), exactly as the inbox composer does.
  from_identity text not null default 'nick' check (from_identity in ('nick', 'arwin')),
  status text not null default 'draft'
    check (status in ('draft', 'sending', 'paused', 'sent', 'cancelled')),
  -- [{ "id": string, "name": string, "type": string, "size": number,
  --    "parts": string[] }] — `parts` are object paths in the private
  -- storage bucket, in order (large files are uploaded in pieces).
  attachments jsonb not null default '[]'::jsonb check (jsonb_typeof(attachments) = 'array'),
  -- The links in the body when the campaign was confirmed. The click
  -- redirect only ever sends someone to one of these, so it cannot be used
  -- as an open redirect.
  link_allowlist text[] not null default '{}',
  -- Who confirmed the send, and when: the one tap that starts it.
  confirmed_at timestamptz,
  confirmed_by uuid references auth.users(id) on delete set null,
  -- The last email this campaign sent, which paces the next one.
  last_sent_at timestamptz,
  -- The open pixel and click-tracked links. Off: the email carries no
  -- Copilot link at all; replies and bounces are still read from the mailbox.
  track_activity boolean not null default true,
  -- The grey unsubscribe line and the List-Unsubscribe headers. Off by
  -- default: an LP update is a personal email, not a mailing.
  unsubscribe_link boolean not null default false,
  -- Set on confirmation: the created_at of the last recipient the review
  -- counted. A recipient added after it (a second tab racing the tap) is
  -- never sent.
  confirmed_through timestamptz,
  -- Why it is paused, so the list and the page can say so.
  pause_reason text check (
    pause_reason is null or pause_reason in ('manual', 'left', 'capped', 'failures', 'refused')
  ),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- When the last recipient was sent to.
  sent_at timestamptz
);

-- For a copy of this file applied before these columns were added to it.
alter table campaigns add column if not exists track_activity boolean not null default true;
alter table campaigns add column if not exists unsubscribe_link boolean not null default false;
alter table campaigns add column if not exists confirmed_through timestamptz;
alter table campaigns add column if not exists pause_reason text;
alter table campaigns drop constraint if exists campaigns_pause_reason_check;
alter table campaigns add constraint campaigns_pause_reason_check check (
  pause_reason is null or pause_reason in ('manual', 'left', 'capped', 'failures', 'refused')
);

create index if not exists campaigns_org_created_idx
  on campaigns (organization_id, created_at desc);

-- --------------------------------------------------------- recipients --

create table if not exists campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  campaign_id uuid not null references campaigns(id) on delete cascade,
  -- Lowercased.
  email text not null check (char_length(email) between 3 and 320),
  name text,
  -- Merge values: { "first_name"?: string, "name"?: string, "company"?: string }.
  merge jsonb not null default '{}'::jsonb check (jsonb_typeof(merge) = 'object'),
  -- The CRM person the recipient came from, when there is one.
  record_id uuid references crm_records(id) on delete set null,
  -- 'unconfirmed': the send was interrupted after it started, so it may have
  -- gone out. Never sent again automatically, and not part of "retry failed":
  -- a person checks Gmail Sent and marks it sent or sends it again.
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'failed', 'unconfirmed', 'skipped')),
  gmail_message_id text,
  gmail_thread_id text,
  -- Why a send failed or was skipped. Safe to show; never a provider payload.
  error text,
  -- Set just before the send is attempted. A row still 'pending' with this
  -- set was interrupted mid-send and is never sent again automatically.
  attempted_at timestamptz,
  sent_at timestamptz,
  opened_at timestamptz,
  open_count integer not null default 0,
  clicked_at timestamptz,
  click_count integer not null default 0,
  replied_at timestamptz,
  bounced_at timestamptz,
  unsubscribed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_id, email)
);

-- For a copy of this file applied before these columns were added to it.
alter table campaign_recipients add column if not exists attempted_at timestamptz;
alter table campaign_recipients add column if not exists bounced_at timestamptz;
alter table campaign_recipients add column if not exists unsubscribed_at timestamptz;
alter table campaign_recipients drop constraint if exists campaign_recipients_status_check;
alter table campaign_recipients add constraint campaign_recipients_status_check
  check (status in ('pending', 'sent', 'failed', 'unconfirmed', 'skipped'));

create index if not exists campaign_recipients_campaign_idx
  on campaign_recipients (organization_id, campaign_id, status);
-- The daily cap counts what the organization sent in the last 24 hours.
create index if not exists campaign_recipients_sent_idx
  on campaign_recipients (organization_id, sent_at) where sent_at is not null;
create index if not exists campaign_recipients_thread_idx
  on campaign_recipients (gmail_thread_id) where gmail_thread_id is not null;

-- ------------------------------------------------------------- events --

create table if not exists campaign_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  -- Set null rather than cascaded: an unsubscribe outlives the campaign it
  -- came from, and only a draft (which has no events) can be deleted.
  campaign_id uuid references campaigns(id) on delete set null,
  recipient_id uuid references campaign_recipients(id) on delete set null,
  -- 'resubscribe' undoes an earlier unsubscribe for the address (a person
  -- in Copilot did it, on that address's request): the latest of the two wins.
  kind text not null
    check (kind in ('open', 'click', 'reply', 'bounce', 'unsubscribe', 'resubscribe')),
  -- The link, for a click.
  url text check (url is null or char_length(url) <= 2000),
  -- Lowercased, for an unsubscribe or resubscribe: what the suppression check reads.
  email text,
  at timestamptz not null default now(),
  user_agent text check (user_agent is null or char_length(user_agent) <= 500),
  -- An open or click that looked like a machine (a mail scanner checking the
  -- links on delivery, a prefetch). Kept, never counted as the person's.
  automated boolean not null default false
);

alter table campaign_events add column if not exists automated boolean not null default false;
alter table campaign_events drop constraint if exists campaign_events_kind_check;
alter table campaign_events add constraint campaign_events_kind_check
  check (kind in ('open', 'click', 'reply', 'bounce', 'unsubscribe', 'resubscribe'));

create index if not exists campaign_events_campaign_idx
  on campaign_events (organization_id, campaign_id, at desc);
drop index if exists campaign_events_unsubscribe_idx;
create index if not exists campaign_events_suppression_idx
  on campaign_events (organization_id, email) where kind in ('unsubscribe', 'resubscribe');
create index if not exists campaign_events_recipient_idx
  on campaign_events (organization_id, recipient_id, kind, at desc);

-- ------------------------------------------------------------ send lock --
--
-- One row per organization: who may send campaign email right now. A batch
-- takes the lease (a compare-and-set on lease_token) before its first email
-- and renews it before each one, so two batches (two tabs, or two server
-- instances during a deploy) never send at once, and the pace and the
-- 24-hour cap hold across them. A crashed holder's lease simply expires.

create table if not exists campaign_send_locks (
  organization_id uuid primary key references organizations(id) on delete cascade,
  lease_token text,
  lease_expires_at timestamptz,
  campaign_id uuid references campaigns(id) on delete set null,
  -- The organization's last campaign email, which paces the next.
  last_sent_at timestamptz,
  updated_at timestamptz not null default now()
);

-- -------------------------------------------------------------- triggers --

drop trigger if exists campaigns_updated_at on campaigns;
create trigger campaigns_updated_at before update on campaigns
  for each row execute function set_updated_at();
drop trigger if exists campaign_recipients_updated_at on campaign_recipients;
create trigger campaign_recipients_updated_at before update on campaign_recipients
  for each row execute function set_updated_at();
drop trigger if exists campaign_send_locks_updated_at on campaign_send_locks;
create trigger campaign_send_locks_updated_at before update on campaign_send_locks
  for each row execute function set_updated_at();

-- ------------------------------------------------------------------- RLS --
--
-- The standard org-scoped shape, as for the CRM: read for any member, write
-- for member and above. Dropped first so the file can be re-run. The tracking
-- endpoints run server-side under the service role and find a recipient by a
-- signed token, never through these policies.

do $$
declare
  t text;
  campaign_tables text[] := array[
    'campaigns', 'campaign_recipients', 'campaign_events', 'campaign_send_locks'
  ];
begin
  foreach t in array campaign_tables loop
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

comment on table campaigns is
  'Tracked bulk email (Affinity-style). Moves from draft to sending only on a person''s confirmation; never scheduled.';
comment on table campaign_recipients is
  'One recipient of one campaign: send status, Gmail ids and open/click/reply tracking.';
comment on table campaign_events is
  'Opens, clicks, replies, bounces, unsubscribes and resubscribes. The latest unsubscribe/resubscribe per email is the suppression list.';
comment on table campaign_send_locks is
  'One per organization: the lease a campaign batch holds while it sends, so only one sends at a time.';

-- No explicit grants: service_role inherits via the default privileges set in
-- 20260101000600, and browser roles deliberately query nothing directly.
