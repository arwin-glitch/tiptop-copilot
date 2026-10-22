-- The booking link: a public page where people ask for time with the host
-- (/meet/<slug>), and the requests it collects for someone to approve.
--
--   - booking_settings: one row per organization. On or off (off by
--     default: no row, or enabled = false, and the page says it is not taking
--     bookings), the link's slug, and everything Settings > Booking link
--     edits (the public card, places, windows, buffers, caps, the chatbot)
--     as one jsonb document the app reads field by field with defaults
--     (lib/booking/config.ts), so a setting added later needs no migration.
--   - booking_requests: what visitors sent. Nothing here reaches a calendar
--     on its own: a request waits until a person presses Approve in Copilot,
--     which re-checks the time and only then creates the event
--     (lib/services/booking.ts, through lib/calendar/write.ts).
--
-- Additive and idempotent like every migration here: safe to run again in
-- the SQL editor. Until it is applied the public page says it is not taking
-- bookings, Settings says to run this file, and the Calendar tab shows no
-- booking requests: nothing else changes.

-- ------------------------------------------------------------ settings --

create table if not exists booking_settings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  enabled boolean not null default false,
  slug text not null check (slug ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'),
  settings jsonb not null default '{}'::jsonb,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists booking_settings_org_idx on booking_settings (organization_id);
-- One link per slug, across every organization: the public page finds its
-- settings by the slug alone.
create unique index if not exists booking_settings_slug_idx on booking_settings (slug);

-- ------------------------------------------------------------ requests --

create table if not exists booking_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  -- pending: waiting for a person. approved: on the calendar (or added there
  -- by hand). declined: turned down. handled: a message, read.
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'declined', 'handled')),
  meeting_type text not null check (meeting_type in ('call', 'in_person', 'message')),
  kind text check (kind in ('coffee', 'lunch', 'dinner')),
  -- The slot asked for. A message asks for none.
  starts_at timestamptz,
  ends_at timestamptz,
  visitor_time_zone text check (visitor_time_zone is null or char_length(visitor_time_zone) <= 64),
  name text not null check (char_length(name) between 1 and 120),
  email text not null check (char_length(email) between 3 and 254),
  company text check (company is null or char_length(company) <= 120),
  place_id text check (place_id is null or char_length(place_id) <= 40),
  place_name text check (place_name is null or char_length(place_name) <= 160),
  place_area text check (place_area is null or char_length(place_area) <= 80),
  place_map_url text check (place_map_url is null or char_length(place_map_url) <= 500),
  place_custom boolean not null default false,
  note text check (note is null or char_length(note) <= 2000),
  deck_url text check (deck_url is null or deck_url ~* '^https?://'),
  -- 'chatbot' when the public chatbot filled the form; the visitor still pressed Send.
  source text not null default 'form' check (source in ('form', 'chatbot')),
  -- A keyed hash of the sender's address, for the abuse brakes; never the address.
  ip_hash text,
  -- Set while someone is approving it, so two clicks cannot make two events.
  claimed_at timestamptz,
  calendar_id text,
  event_id text,
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint booking_requests_slot_check check (
    (meeting_type = 'message' and starts_at is null and ends_at is null)
    or (meeting_type <> 'message' and starts_at is not null and ends_at > starts_at)
  ),
  constraint booking_requests_kind_check check (
    (meeting_type = 'in_person') = (kind is not null)
  )
);

create index if not exists booking_requests_status_idx
  on booking_requests (organization_id, status, starts_at);
create index if not exists booking_requests_email_idx
  on booking_requests (organization_id, email, status);
create index if not exists booking_requests_created_idx
  on booking_requests (organization_id, created_at desc);

drop trigger if exists booking_settings_updated_at on booking_settings;
create trigger booking_settings_updated_at before update on booking_settings
  for each row execute function set_updated_at();
drop trigger if exists booking_requests_updated_at on booking_requests;
create trigger booking_requests_updated_at before update on booking_requests
  for each row execute function set_updated_at();

-- ------------------------------------------------------------------- RLS --
--
-- Read for any member, write for member and above, as the other tables. The
-- public page never queries these from a browser: its server routes use the
-- service role, and browser roles query nothing directly. Dropped first so
-- the file can be re-run.

do $$
declare
  t text;
begin
  foreach t in array array['booking_settings', 'booking_requests'] loop
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

comment on table booking_settings is
  'The public booking link: on/off, slug, and the Settings > Booking link document (lib/booking/config.ts).';
comment on table booking_requests is
  'Meeting requests from the public booking page; nothing reaches a calendar until a person approves one.';
comment on column booking_requests.claimed_at is
  'Set while an approval is in progress, so a second click cannot create a second event.';

-- No explicit grants: service_role inherits via the default privileges set in
-- 20260101000600, and browser roles deliberately query nothing directly.
