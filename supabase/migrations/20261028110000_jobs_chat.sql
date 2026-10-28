-- "Ask Arwin" on the public job board: an assistant that answers visitors
-- from the published roles and the team's written answers, with no AI at all
-- (lib/jobs-board/assistant.ts). Optionally, a question neither can answer
-- goes to the jobs assistant routine on Arwin's own Claude plan (no API key,
-- nothing billed), like the booking page assistant (lib/jobs-board/chat-bridge.ts,
-- docs/JOBS_CHAT_ROUTINE.md).
--
--   - job_board_settings.assistant: the assistant's settings, edited in
--     Portfolio > Jobs: on or off, the written answers, AI answers on or off
--     and their daily cap. Read leniently (lib/jobs-board/assistant-config.ts):
--     an empty or bad value takes the defaults.
--   - jobs_chat_questions: each question sent to the routine while it waits,
--     and the routine's answer once the app has read it back from the Slack
--     relay and made it plain.
--       - status: pending (waiting), answered, or expired (no answer in time,
--         or the routine could not be started).
--       - ip_hash: a keyed hash of the visitor's address, for the per-address
--         daily cap; never the address itself.
--     The caps are counted from these rows, so they hold across restarts: at
--     most 5 questions per address a day, and the daily total set in
--     Portfolio > Jobs (15 by default, 30 at most). Rows are deleted after 30
--     days.
--
-- Additive and idempotent like every migration here: safe to run again in
-- the SQL editor. Until it is applied the assistant still answers from the
-- board and its default written answers; it cannot be edited, and AI answers
-- stay off. Nothing else changes.

-- -------------------------------------------------------------- settings --

alter table job_board_settings add column if not exists assistant jsonb not null default '{}'::jsonb;

-- Named so it can never collide with Postgres's own name for an inline
-- column check: dropped first, then added, so the file can be re-run.
alter table job_board_settings drop constraint if exists job_board_settings_assistant_shape;
alter table job_board_settings add constraint job_board_settings_assistant_shape
  check (jsonb_typeof(assistant) = 'object' and pg_column_size(assistant) <= 65536);

comment on column job_board_settings.assistant is
  'The job board assistant''s settings (enabled, faqItems, aiAnswers, dailyAiCap); read leniently by the app.';

-- ------------------------------------------------------------- questions --

create table if not exists jobs_chat_questions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  question text not null,
  answer text,
  status text not null default 'pending',
  ip_hash text,
  created_at timestamptz not null default now(),
  answered_at timestamptz
);

alter table jobs_chat_questions drop constraint if exists jobs_chat_questions_question_length;
alter table jobs_chat_questions add constraint jobs_chat_questions_question_length
  check (char_length(question) between 1 and 300);
alter table jobs_chat_questions drop constraint if exists jobs_chat_questions_answer_length;
alter table jobs_chat_questions add constraint jobs_chat_questions_answer_length
  check (answer is null or char_length(answer) <= 600);
alter table jobs_chat_questions drop constraint if exists jobs_chat_questions_status_allowed;
alter table jobs_chat_questions add constraint jobs_chat_questions_status_allowed
  check (status in ('pending', 'answered', 'expired'));
alter table jobs_chat_questions drop constraint if exists jobs_chat_questions_ip_hash_length;
alter table jobs_chat_questions add constraint jobs_chat_questions_ip_hash_length
  check (ip_hash is null or char_length(ip_hash) <= 64);

create index if not exists jobs_chat_questions_created_idx
  on jobs_chat_questions (organization_id, created_at desc);
create index if not exists jobs_chat_questions_ip_idx
  on jobs_chat_questions (organization_id, ip_hash, created_at desc);
create index if not exists jobs_chat_questions_pending_idx
  on jobs_chat_questions (organization_id, status, created_at);

-- ------------------------------------------------------------------- RLS --
--
-- Read for any member (Portfolio > Jobs shows when the last answer came);
-- written only by the server with the service role, which bypasses RLS, so
-- no browser role may insert, change or remove a row. Dropped first so the
-- file can be re-run.

alter table jobs_chat_questions enable row level security;
drop policy if exists jobs_chat_questions_select on jobs_chat_questions;
drop policy if exists jobs_chat_questions_insert on jobs_chat_questions;
drop policy if exists jobs_chat_questions_update on jobs_chat_questions;
drop policy if exists jobs_chat_questions_delete on jobs_chat_questions;
create policy jobs_chat_questions_select on jobs_chat_questions
  for select using (is_org_member(organization_id));

comment on table jobs_chat_questions is
  'Job board assistant questions sent to the jobs assistant routine (Arwin''s Claude plan, no API key) and their plain-text answers.';
comment on column jobs_chat_questions.ip_hash is
  'A keyed hash of the visitor address, for the per-address daily cap; never the address.';

-- No explicit grants: service_role inherits via the default privileges set in
-- 20260101000600, and browser roles deliberately query nothing directly.
