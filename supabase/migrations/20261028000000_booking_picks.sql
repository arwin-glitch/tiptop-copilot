-- Pick times (Vimcal-style): the host picks a few open ranges on Kraken's
-- Calendar, copies them with a link, and pastes both into an email. The
-- person he sends it to books one start inside those ranges at
-- /meet/<slug>/p/<token>, straight onto the calendar (no approve first).
--
--   - booking_picks: one row per copied set of times. Only the SHA-256 (hex)
--     of the link's token is kept for finding it; token_sealed keeps the token
--     encrypted with the app's key (AES-256-GCM, the pick id as associated
--     data) so "Copy again" can give the same link back. While a pick is open
--     and `hold` is on, its ranges are kept off the public booking link; it
--     stops at expires_at (read at the time, no job), when it is used, or when
--     the host cancels it. Holds live here only: no Google Calendar event.
--   - booking_requests.pick_id: the pick a booking was made from. Such a
--     booking is checked against busy time only (not the link's windows,
--     notice or caps), and is not moved from its own page.
--
-- Additive and idempotent like every migration here: safe to run again in
-- the SQL editor. Until it is applied the Calendar's pick panel says it needs
-- a database update, nothing is held, the public link and every booking keep
-- working exactly as before, and nothing else changes.
--
-- Constraint names are written out and never match the names Postgres gives
-- an inline column check (<table>_<column>_check), which is what broke the
-- first booking migration.

create table if not exists booking_picks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  token_hash text not null,
  token_sealed jsonb,
  meeting_type text not null,
  kind text,
  duration_minutes integer not null,
  ranges jsonb not null,
  recipient_name text,
  recipient_time_zone text not null,
  hold boolean not null default true,
  status text not null default 'open',
  booking_request_id uuid references booking_requests(id) on delete set null,
  expires_at timestamptz not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table booking_picks drop constraint if exists booking_picks_token_shape;
alter table booking_picks add constraint booking_picks_token_shape check (
  token_hash ~ '^[0-9a-f]{64}$'
);

alter table booking_picks drop constraint if exists booking_picks_type_allowed;
alter table booking_picks add constraint booking_picks_type_allowed check (
  meeting_type in ('call', 'in_person')
);

alter table booking_picks drop constraint if exists booking_picks_kind_allowed;
alter table booking_picks add constraint booking_picks_kind_allowed check (
  kind is null or kind in ('coffee', 'lunch', 'dinner')
);

alter table booking_picks drop constraint if exists booking_picks_duration_allowed;
alter table booking_picks add constraint booking_picks_duration_allowed check (
  duration_minutes between 15 and 240
);

alter table booking_picks drop constraint if exists booking_picks_ranges_shape;
alter table booking_picks add constraint booking_picks_ranges_shape check (
  jsonb_typeof(ranges) = 'array' and jsonb_array_length(ranges) between 1 and 20
);

alter table booking_picks drop constraint if exists booking_picks_name_length;
alter table booking_picks add constraint booking_picks_name_length check (
  recipient_name is null or char_length(recipient_name) <= 80
);

alter table booking_picks drop constraint if exists booking_picks_zone_length;
alter table booking_picks add constraint booking_picks_zone_length check (
  char_length(recipient_time_zone) between 1 and 64
);

alter table booking_picks drop constraint if exists booking_picks_status_allowed;
alter table booking_picks add constraint booking_picks_status_allowed check (
  status in ('open', 'used', 'revoked')
);

-- The guest page finds its pick by the hash alone.
create unique index if not exists booking_picks_token_idx on booking_picks (token_hash);
-- The public link and the Calendar read the open, unexpired picks.
create index if not exists booking_picks_open_idx
  on booking_picks (organization_id, status, expires_at);

alter table booking_requests add column if not exists pick_id uuid
  references booking_picks(id) on delete set null;
create index if not exists booking_requests_pick_idx
  on booking_requests (pick_id)
  where pick_id is not null;

drop trigger if exists booking_picks_updated_at on booking_picks;
create trigger booking_picks_updated_at before update on booking_picks
  for each row execute function set_updated_at();

-- ------------------------------------------------------------------- RLS --
--
-- The server writes with the service role; browser roles query nothing
-- directly. The policies still match the app: any member reads, member and
-- above write (picking times is the Calendar's, which any member may use).

do $$
declare
  t text;
begin
  foreach t in array array['booking_picks'] loop
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

comment on table booking_picks is
  'Pick times: ranges the host picked and sent someone, held off the public link while open.';
comment on column booking_picks.token_hash is
  'SHA-256 (hex) of the pick link token; the token is kept only sealed (token_sealed).';
comment on column booking_requests.pick_id is
  'The pick a booking was made from (Pick times): checked against busy time only.';

-- No explicit grants: service_role inherits via the default privileges set in
-- 20260101000600, and browser roles deliberately query nothing directly.
