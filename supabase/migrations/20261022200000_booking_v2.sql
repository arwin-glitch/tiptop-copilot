-- The booking link, v2 (D-078): instant booking, guests, and each booking's
-- own page (/meet/<slug>/b/<token>) where the visitor can reschedule or
-- cancel.
--
--   - booking_requests.status gains three values:
--       booked     on the host's calendar, made at once from the link (the
--                  invitation went out from his calendar);
--       held       the time is kept while calendar editing is off: the event
--                  is created, re-checked, as soon as editing is on;
--       cancelled  cancelled by the visitor (or from Copilot), the event
--                  deleted with Google's own cancellation to every guest.
--     pending, approved, declined and handled keep their meaning (approve
--     first is now an option in Settings, off by default).
--   - guest_emails: the people the visitor added ("Add guests"), invited
--     with them. Never the host's or a teammate's address.
--   - manage_token_hash: the SHA-256 (hex) of the booking page's token. The
--     token itself is in the visitor's link and the event description only;
--     it is never stored.
--   - cancel_note / cancelled_at / cancelled_by: the visitor's optional note
--     to the host when they cancel (at most 500 characters), when, and who:
--     the visitor on the booking's page, the team in Copilot, or the
--     calendar (the event was deleted in Google Calendar).
--   - rescheduled_count / previous_starts_at: how often the visitor moved it
--     (at most 5), and the time before the last move.
--
-- Additive and idempotent like every migration here: safe to run again in
-- the SQL editor. Until it is applied the link keeps working the old way
-- (every booking waits as a request) and nothing else changes.
--
-- The old status check was written inline, so Postgres named it
-- booking_requests_status_check. It is dropped by that name and the wider
-- one is added under a name of its own (never an auto-name like
-- <table>_<column>_check, which is what broke the first booking migration).

alter table booking_requests add column if not exists guest_emails text[] not null default '{}';
alter table booking_requests add column if not exists manage_token_hash text;
alter table booking_requests add column if not exists cancel_note text;
alter table booking_requests add column if not exists cancelled_at timestamptz;
alter table booking_requests add column if not exists cancelled_by text;
alter table booking_requests add column if not exists rescheduled_count integer not null default 0;
alter table booking_requests add column if not exists previous_starts_at timestamptz;

alter table booking_requests drop constraint if exists booking_requests_status_check;
alter table booking_requests drop constraint if exists booking_requests_status_allowed;
alter table booking_requests add constraint booking_requests_status_allowed check (
  status in ('pending', 'approved', 'declined', 'handled', 'booked', 'held', 'cancelled')
);

alter table booking_requests drop constraint if exists booking_requests_guests_allowed;
alter table booking_requests add constraint booking_requests_guests_allowed check (
  cardinality(guest_emails) <= 10
);

alter table booking_requests drop constraint if exists booking_requests_token_shape;
alter table booking_requests add constraint booking_requests_token_shape check (
  manage_token_hash is null or manage_token_hash ~ '^[0-9a-f]{64}$'
);

alter table booking_requests drop constraint if exists booking_requests_cancel_note_length;
alter table booking_requests add constraint booking_requests_cancel_note_length check (
  cancel_note is null or char_length(cancel_note) <= 500
);

alter table booking_requests drop constraint if exists booking_requests_cancelled_by_allowed;
alter table booking_requests add constraint booking_requests_cancelled_by_allowed check (
  cancelled_by is null or cancelled_by in ('visitor', 'team', 'calendar')
);

alter table booking_requests drop constraint if exists booking_requests_reschedules_allowed;
alter table booking_requests add constraint booking_requests_reschedules_allowed check (
  rescheduled_count between 0 and 5
);

-- One booking per token: the booking page finds its row by the hash alone.
create unique index if not exists booking_requests_manage_token_idx
  on booking_requests (manage_token_hash)
  where manage_token_hash is not null;
-- The alerts and the Booking tab read what changed lately.
create index if not exists booking_requests_updated_idx
  on booking_requests (organization_id, updated_at desc);
-- The abuse brakes count an address's upcoming bookings, as booker or guest.
create index if not exists booking_requests_guests_idx
  on booking_requests using gin (guest_emails);

comment on column booking_requests.guest_emails is
  'Guests the visitor added to the booking, invited with them (D-078).';
comment on column booking_requests.manage_token_hash is
  'SHA-256 (hex) of the booking page token; the token itself is never stored (D-078).';
comment on column booking_requests.cancel_note is
  'The visitor''s optional note to the host when they cancelled (at most 500 characters).';

-- Row-level security is unchanged: booking_requests keeps the policies from
-- 20261022000000_booking_link.sql (read for any member, written by member and
-- above). The public routes use the service role; browser roles query nothing
-- directly.
