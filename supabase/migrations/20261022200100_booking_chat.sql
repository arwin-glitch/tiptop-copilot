-- The booking page assistant's AI answers (D-078): a question a visitor asks
-- that no written answer matches can go to the booking assistant routine on
-- Arwin's own Claude plan (no API key, nothing billed). This table holds each
-- such question while it waits, and the routine's answer once the app has
-- read it back from the Slack relay and made it plain
-- (lib/booking/chat-bridge.ts).
--
--   - status: pending (waiting for the routine), answered, or expired (no
--     answer in time, or the routine could not be started).
--   - ip_hash: a keyed hash of the visitor's address, for the per-address
--     daily cap; never the address itself.
--
-- The caps are counted from these rows, so they hold across restarts: at
-- most 5 questions per address a day, and the daily total set in the
-- Booking tab (15 by default, 30 at most), for the whole link.
--
-- Additive and idempotent like every migration here: safe to run again in
-- the SQL editor. Until it is applied the assistant answers from the written
-- questions only and says nothing about AI answers: nothing else changes.

create table if not exists booking_chat_questions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  question text not null check (char_length(question) between 1 and 300),
  answer text check (answer is null or char_length(answer) <= 600),
  status text not null default 'pending',
  ip_hash text check (ip_hash is null or char_length(ip_hash) <= 64),
  created_at timestamptz not null default now(),
  answered_at timestamptz
);

-- Named so it can never collide with Postgres's own name for an inline
-- column check (booking_chat_questions_status_check): dropped first, then
-- added, so the file can be re-run.
alter table booking_chat_questions drop constraint if exists booking_chat_questions_status_allowed;
alter table booking_chat_questions add constraint booking_chat_questions_status_allowed
  check (status in ('pending', 'answered', 'expired'));

create index if not exists booking_chat_questions_created_idx
  on booking_chat_questions (organization_id, created_at desc);
create index if not exists booking_chat_questions_ip_idx
  on booking_chat_questions (organization_id, ip_hash, created_at desc);
create index if not exists booking_chat_questions_pending_idx
  on booking_chat_questions (organization_id, status, created_at);

-- ------------------------------------------------------------------- RLS --
--
-- Read for any member (the Booking tab shows when the last answer came);
-- written only by the server with the service role, which bypasses RLS, so
-- no browser role may insert, change or remove a row. Dropped first so the
-- file can be re-run.

alter table booking_chat_questions enable row level security;
drop policy if exists booking_chat_questions_select on booking_chat_questions;
drop policy if exists booking_chat_questions_insert on booking_chat_questions;
drop policy if exists booking_chat_questions_update on booking_chat_questions;
drop policy if exists booking_chat_questions_delete on booking_chat_questions;
create policy booking_chat_questions_select on booking_chat_questions
  for select using (is_org_member(organization_id));

comment on table booking_chat_questions is
  'Booking page assistant questions sent to the booking assistant routine (Arwin''s Claude plan, no API key) and their plain-text answers.';
comment on column booking_chat_questions.ip_hash is
  'A keyed hash of the visitor address, for the per-address daily cap; never the address.';

-- No explicit grants: service_role inherits via the default privileges set in
-- 20260101000600, and browser roles deliberately query nothing directly.
