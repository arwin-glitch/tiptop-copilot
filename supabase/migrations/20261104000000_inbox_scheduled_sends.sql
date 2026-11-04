-- Schedule send (Gmail-style) for the Inbox tab. Gmail's API has no scheduled
-- send, so Kraken keeps the email and sends it at its time. A row exists only
-- because a person picked a time under the compose window's Send button: that
-- pick is the send decision. Nothing else writes these rows.
--
--   - inbox_scheduled_sends: one row per scheduled email: who it goes to, the
--     subject, the body (the compose window's HTML, sanitized before it is
--     stored), whose signature goes on it ('nick' reads his real Gmail
--     signature at send time; nothing is typed), and, for a reply or a
--     forward, the Gmail thread or message it belongs to.
--
-- How it is sent, at most once: a due row is claimed with one conditional
-- update (status 'scheduled' -> 'sending' with a fresh claim_token); only the
-- caller whose update matched sends it, then marks it 'sent' (or 'failed').
-- A cancel is the same conditional update ('scheduled' -> 'cancelled'), so a
-- cancel and a send can never both win. A row left in 'sending' (a process
-- that died mid-send) is marked 'failed' after 15 minutes, never sent again.
-- The phone-alert job's minute loop (GET /api/cron/push), the daily job and
-- the Inbox list as it loads all run the same claim.
--
-- Additive and idempotent like every migration here: safe to run again in
-- the SQL editor. Until it is applied the Schedule option says it needs a
-- database update, nothing is stored, and nothing else changes.
--
-- Constraint names are written out and never match the names Postgres gives
-- an inline column check (<table>_<column>_check), which is what broke the
-- first booking migration.

create table if not exists inbox_scheduled_sends (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  status text not null default 'scheduled',
  send_at timestamptz not null,
  to_addresses text not null default '',
  cc_addresses text not null default '',
  bcc_addresses text not null default '',
  subject text not null default '',
  body_html text not null default '',
  signature text not null default 'nick',
  thread_id text,
  forward_of text,
  claim_token text,
  claimed_at timestamptz,
  attempts integer not null default 0,
  sent_at timestamptz,
  sent_message_id text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table inbox_scheduled_sends drop constraint if exists inbox_scheduled_sends_status_allowed;
alter table inbox_scheduled_sends add constraint inbox_scheduled_sends_status_allowed check (
  status in ('scheduled', 'sending', 'sent', 'cancelled', 'failed')
);

alter table inbox_scheduled_sends drop constraint if exists inbox_scheduled_sends_signature_allowed;
alter table inbox_scheduled_sends add constraint inbox_scheduled_sends_signature_allowed check (
  signature in ('nick', 'arwin')
);

alter table inbox_scheduled_sends drop constraint if exists inbox_scheduled_sends_thread_shape;
alter table inbox_scheduled_sends add constraint inbox_scheduled_sends_thread_shape check (
  thread_id is null or thread_id ~ '^[0-9a-f]{10,24}$'
);

alter table inbox_scheduled_sends drop constraint if exists inbox_scheduled_sends_forward_shape;
alter table inbox_scheduled_sends add constraint inbox_scheduled_sends_forward_shape check (
  forward_of is null or forward_of ~ '^[0-9a-f]{10,24}$'
);

alter table inbox_scheduled_sends drop constraint if exists inbox_scheduled_sends_sizes;
alter table inbox_scheduled_sends add constraint inbox_scheduled_sends_sizes check (
  length(body_html) <= 200000
  and length(subject) <= 300
  and length(to_addresses) <= 4000
  and length(cc_addresses) <= 4000
  and length(bcc_addresses) <= 4000
  and attempts >= 0
);

-- The send step reads the waiting rows by time, every minute.
create index if not exists inbox_scheduled_sends_due_idx
  on inbox_scheduled_sends (organization_id, status, send_at);

drop trigger if exists inbox_scheduled_sends_updated_at on inbox_scheduled_sends;
create trigger inbox_scheduled_sends_updated_at before update on inbox_scheduled_sends
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
  foreach t in array array['inbox_scheduled_sends'] loop
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

comment on table inbox_scheduled_sends is
  'Inbox schedule send: an email a person scheduled, sent once by Kraken at send_at.';
comment on column inbox_scheduled_sends.claim_token is
  'Set by the one caller whose claim (scheduled -> sending) matched; only it sends the row.';

-- No explicit grants: service_role inherits via the default privileges set in
-- 20260101000600, and browser roles deliberately query nothing directly.
