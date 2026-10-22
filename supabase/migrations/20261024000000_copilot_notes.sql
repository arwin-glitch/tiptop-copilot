-- Copilot Notes: meetings recorded and transcribed by Copilot itself (D-076).
--
-- Copilot takes meeting notes without a bot and without a paid speech
-- service: the browser (and later the desktop app) transcribes the microphone
-- and the meeting audio itself, with Whisper running on that computer, and
-- only finished text lines come back here. No audio is ever stored or sent:
-- there is no audio column, and `meetings.audio_retained` is pinned to false
-- by a check.
--
-- What lives here:
--   meetings               one recorded (or about to be recorded) conversation
--   meeting_participants   who was invited or present, from the calendar or by hand
--   meeting_speakers       one row per voice ("cluster"), and the name it carries
--   transcript_segments    the lines, keyed by voice cluster, never by name, so
--                          renaming a voice is a single row update
--   meeting_folders        folders; a private one (e.g. "Coaching") stays private
--   note_templates         custom note templates (built-in ones live in code)
--   note_recipes           saved prompts for chat
--   note_share_links       expiring, revocable share links; only a hash is kept
--   meeting_consent_log    append-only log of the consent step and recording state
--   voice_profiles         opt-in voice enrolment consent (Texas Bus. & Com. 503.001)
--   voice_identifiers      the encrypted voiceprints themselves, server only
--   recording_rules        never-record rules (title, attendee domain or address,
--                          calendar)
--   notes_requests         jobs for Arwin's Claude routine: write a meeting's
--                          notes, or answer a question about meetings
-- and Copilot's own notes go into the existing meeting_notes table with
-- provider 'copilot', so the deal, company and network pages that already read
-- meeting_notes pick them up.
--
-- Visibility: a meeting is private to the person who recorded it (plus anyone
-- listed in shared_with) unless it is marked 'team'. The app reads through the
-- service role and applies the same rule in lib/services/notes.ts; the
-- policies below are the second lock, as everywhere else.
--
-- Additive and idempotent like every migration here; safe to run again in the
-- SQL editor. The feature is behind NOTES_ENABLED (off by default), and every
-- read of these tables degrades to "not set up yet" until this file has been
-- applied, so it must be applied before the flag is turned on, never after.

-- --------------------------------------------------------------- folders --

create table if not exists meeting_folders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  -- A private folder keeps every meeting in it private to its recorder, and
  -- routines and MCP clients leave it out unless their scope allows it.
  is_private boolean not null default false,
  -- Optional: post a meeting's notes to this Slack channel when they are ready.
  slack_channel_id text check (slack_channel_id is null or slack_channel_id ~ '^[A-Z0-9]{8,12}$'),
  position integer not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, name)
);

-- ------------------------------------------------------------- templates --
--
-- Custom templates only. The built-in VC templates (founder pitch, LP call,
-- portfolio check-in, intro call, internal 1:1) are constants in the app, with
-- ids like 'builtin:founder_pitch', so no seeding is needed per organization.

create table if not exists note_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  -- What kind of meeting it is for, used when a template is picked
  -- automatically: pitch | lp | portfolio | intro | internal | other.
  meeting_type text not null default 'other'
    check (meeting_type in ('pitch', 'lp', 'portfolio', 'intro', 'internal', 'other')),
  purpose text not null default '' check (char_length(purpose) <= 2000),
  length text not null default 'standard' check (length in ('brief', 'standard', 'detailed')),
  -- [{ "heading": string, "prompt": string }]
  sections jsonb not null default '[]'::jsonb check (jsonb_typeof(sections) = 'array'),
  prompt text not null default '' check (char_length(prompt) <= 8000),
  -- When to apply it automatically: { "meetingTypes"?: string[],
  -- "domains"?: string[], "titleIncludes"?: string[] }. Null: never.
  auto_rule jsonb check (auto_rule is null or jsonb_typeof(auto_rule) = 'object'),
  archived boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists note_templates_org_idx on note_templates (organization_id, name);

-- --------------------------------------------------------------- recipes --

create table if not exists note_recipes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  prompt text not null check (char_length(prompt) between 1 and 8000),
  -- 'meeting': runs on one meeting; 'many': across a person's, a company's or
  -- all meetings.
  scope text not null default 'meeting' check (scope in ('meeting', 'many')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists note_recipes_org_idx on note_recipes (organization_id, name);

-- -------------------------------------------------------------- meetings --

create table if not exists meetings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  -- The Google Calendar event this meeting belongs to, when it has one.
  -- Recurring meetings also carry the series id, so past notes of the same
  -- series can be found.
  provider_event_id text check (provider_event_id is null or char_length(provider_event_id) <= 1024),
  recurring_event_id text check (recurring_event_id is null or char_length(recurring_event_id) <= 1024),
  calendar_id text check (calendar_id is null or char_length(calendar_id) <= 320),
  title text not null check (char_length(title) between 1 and 500),
  kind text not null default 'video' check (kind in ('video', 'in_person', 'phone', 'adhoc')),
  platform text check (platform is null or platform in ('meet', 'zoom', 'teams', 'other')),
  capture_source text not null default 'web'
    check (capture_source in ('web', 'desktop', 'iphone', 'upload')),
  status text not null default 'scheduled'
    check (status in ('scheduled', 'recording', 'paused', 'processing', 'ready', 'failed', 'discarded')),
  -- Who recorded it: the only person who may upload lines or mint speech keys.
  recorded_by uuid references auth.users(id) on delete set null,
  scheduled_start timestamptz,
  scheduled_end timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  -- Recorded time, pauses excluded.
  recorded_ms integer not null default 0 check (recorded_ms >= 0),
  visibility text not null default 'private' check (visibility in ('private', 'team')),
  -- Explicit grants on a private meeting: these team members can read it too.
  shared_with uuid[] not null default '{}',
  folder_id uuid references meeting_folders(id) on delete set null,
  -- 'builtin:<key>' for a built-in template, else a note_templates id.
  template_id text check (template_id is null or char_length(template_id) <= 64),
  language text not null default 'en' check (language ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  -- The consent step: recording cannot start until it is 'confirmed', and a
  -- meeting matching a never-record rule is 'blocked'.
  consent_state text not null default 'pending'
    check (consent_state in ('pending', 'confirmed', 'blocked')),
  consent_method text check (consent_method is null or consent_method in
    ('verbal', 'chat_notice', 'invite_notice', 'in_person_notice', 'other')),
  consent_at timestamptz,
  consent_by uuid references auth.users(id) on delete set null,
  consent_notice_text text check (consent_notice_text is null or char_length(consent_notice_text) <= 2000),
  -- The never-record rule this meeting matched: { "ruleId", "label", "reason" }.
  never_record_match jsonb check (never_record_match is null or jsonb_typeof(never_record_match) = 'object'),
  -- No audio is kept in v1. The check makes that a property of the schema,
  -- not a promise in the code.
  audio_retained boolean not null default false check (audio_retained = false),
  -- Pairs this meeting with the Granola note of the same conversation while
  -- both tools run, so lists show it once.
  granola_external_id text,
  -- The highest line number stored, so a reconnecting recorder resumes after it.
  last_seq integer check (last_seq is null or last_seq >= 0),
  -- Set when a line or the notes contain text aimed at an AI assistant.
  -- Annotates the meeting; never hides anything.
  injection_flagged boolean not null default false,
  -- In the trash: purged with everything under it after 7 days.
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists meetings_org_started_idx
  on meetings (organization_id, coalesce(started_at, scheduled_start, created_at) desc);
create index if not exists meetings_event_idx
  on meetings (organization_id, provider_event_id) where provider_event_id is not null;
create index if not exists meetings_series_idx
  on meetings (organization_id, recurring_event_id) where recurring_event_id is not null;
create index if not exists meetings_granola_idx
  on meetings (organization_id, granola_external_id) where granola_external_id is not null;
-- One live meeting per calendar event per recorder, so "Take notes" twice
-- opens the same meeting.
create unique index if not exists meetings_event_recorder_uidx
  on meetings (organization_id, provider_event_id, recorded_by)
  where provider_event_id is not null and deleted_at is null;

-- Whether the signed-in user may read a meeting: a member of its
-- organization, and the meeting is the team's, theirs, or shared with them.
-- Security definer so the child tables' policies can call it without a policy
-- of their own on meetings getting in the way; it reads one row by id.
create or replace function can_read_meeting(target uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from meetings m
    where m.id = target
      and is_org_member(m.organization_id)
      and (
        m.visibility = 'team'
        or m.recorded_by = auth.uid()
        or auth.uid() = any (m.shared_with)
      )
  );
$$;

comment on function can_read_meeting(uuid) is
  'True when the current auth.uid() may read the meeting: an org member, and the meeting is team-visible, theirs or shared with them.';

-- ---------------------------------------------------------- participants --

create table if not exists meeting_participants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  meeting_id uuid not null references meetings(id) on delete cascade,
  -- Lowercased. Null for someone added by name only.
  email text check (email is null or (char_length(email) <= 320 and email = lower(email))),
  name text check (name is null or char_length(name) <= 300),
  role text not null default 'guest' check (role in ('organizer', 'guest', 'self')),
  source text not null default 'calendar' check (source in ('calendar', 'roster', 'manual')),
  crm_person_id uuid references crm_records(id) on delete set null,
  -- A team member, when the participant is one.
  user_id uuid references auth.users(id) on delete set null,
  is_external boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists meeting_participants_email_uidx
  on meeting_participants (meeting_id, email) where email is not null;
create index if not exists meeting_participants_meeting_idx
  on meeting_participants (meeting_id);
create index if not exists meeting_participants_email_idx
  on meeting_participants (organization_id, email) where email is not null;

-- -------------------------------------------------------------- speakers --
--
-- One row per voice. cluster_key is how the lines point at a voice:
--   'mic'          the microphone: the person at this computer
--   'sys:A'        a voice in the meeting audio, by the on-device clustering's label
--   'sys:<uuid>'   a voice the browser matched to an enrolled voice profile
--   'mix:B'        a voice in a single mixed track (in person, phone)
-- and '<key>#2' when a voice was split ("from here it's someone else").
-- The name lives here only, so relabelling a voice is one update.

create table if not exists meeting_speakers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  meeting_id uuid not null references meetings(id) on delete cascade,
  cluster_key text not null
    check (cluster_key ~ '^(mic|(sys|mix):[A-Za-z0-9_-]{1,64})(#[0-9]{1,3})?$'),
  track text not null check (track in ('mic', 'system', 'mixed')),
  person_email text check (person_email is null or (char_length(person_email) <= 320 and person_email = lower(person_email))),
  display_name text check (display_name is null or char_length(display_name) <= 300),
  crm_person_id uuid references crm_records(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  -- "Guest 1", "Guest 2": the number an unresolved voice shows.
  guest_number smallint check (guest_number is null or guest_number between 1 and 99),
  -- The strongest evidence behind the name, best first:
  -- channel > manual > voiceprint > roster > calendar > llm_cue.
  source text check (source is null or source in
    ('channel', 'manual', 'voiceprint', 'roster', 'calendar', 'llm_cue')),
  confidence real check (confidence is null or (confidence >= 0 and confidence <= 1)),
  -- Set when a person picked the name. Automation never overrides a locked name.
  locked boolean not null default false,
  -- Ranked guesses shown as chips: [{ "email", "name", "crmPersonId",
  -- "source", "confidence", "reason" }]. Never applied on their own.
  suggestions jsonb not null default '[]'::jsonb check (jsonb_typeof(suggestions) = 'array'),
  -- Merge keeps the row and points it at the voice it was merged into.
  merged_into text,
  -- Split: the voice this one was split from, and the first line moved.
  split_from text,
  split_at_seq integer,
  confirmed_by uuid references auth.users(id) on delete set null,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (meeting_id, cluster_key)
);

-- ------------------------------------------------------------ transcript --

create table if not exists transcript_segments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  meeting_id uuid not null references meetings(id) on delete cascade,
  -- Assigned by the recorder, monotonic per meeting; uploads upsert on it, so
  -- a retried batch is a no-op rather than a duplicate.
  seq integer not null check (seq >= 0),
  track text not null check (track in ('mic', 'system', 'mixed')),
  cluster_key text not null,
  -- The speech engine's own speaker label, kept for audit.
  vendor_label text check (vendor_label is null or char_length(vendor_label) <= 80),
  start_ms integer not null check (start_ms >= 0),
  end_ms integer not null,
  -- What the speech model heard. Untrusted: rendered as text only.
  text text not null check (char_length(text) between 1 and 4000),
  -- A person's correction (a number, a name). The original stays in `text`.
  edited_text text check (edited_text is null or char_length(edited_text) between 1 and 4000),
  edited_by uuid references auth.users(id) on delete set null,
  edited_at timestamptz,
  confidence real check (confidence is null or (confidence >= 0 and confidence <= 1)),
  is_final boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_ms >= start_ms),
  unique (meeting_id, seq),
  foreign key (meeting_id, cluster_key) references meeting_speakers (meeting_id, cluster_key)
    on update cascade
);

alter table transcript_segments
  add column if not exists search_vector tsvector
  generated always as (
    to_tsvector('english', coalesce(edited_text, text))
  ) stored;

create index if not exists transcript_segments_search_idx
  on transcript_segments using gin (search_vector);
create index if not exists transcript_segments_meeting_time_idx
  on transcript_segments (meeting_id, start_ms);
create index if not exists transcript_segments_cluster_idx
  on transcript_segments (meeting_id, cluster_key);

-- ----------------------------------------------- meeting_notes, extended --
--
-- Copilot's notes are meeting_notes rows with provider 'copilot' and
-- external_id = the meeting's id, so every existing reader keeps working.
-- `content` holds a plain-text rendering of the notes for those readers.
-- Granola rows keep every new column null (or its default).

alter table meeting_notes add column if not exists meeting_id uuid references meetings(id) on delete cascade;
-- The notes typed during the meeting, as markdown, word for word.
alter table meeting_notes add column if not exists user_notes text
  check (user_notes is null or char_length(user_notes) <= 200000);
-- [{ "id", "kind", "text", "depth", "source": 'typed' | 'ai',
--    "sources": [{ "fromSeq", "toSeq" }] }]
alter table meeting_notes add column if not exists enhanced_blocks jsonb
  check (enhanced_blocks is null or jsonb_typeof(enhanced_blocks) = 'array');
-- [{ "id", "text", "ownerEmail", "ownerName", "ownerClusterKey", "due",
--    "isPrincipalPromise", "taskId", "sources" }]
alter table meeting_notes add column if not exists action_items jsonb not null default '[]'::jsonb
  check (jsonb_typeof(action_items) = 'array');
alter table meeting_notes add column if not exists template_id text;
alter table meeting_notes add column if not exists prompt_version text;
alter table meeting_notes add column if not exists model text;
alter table meeting_notes add column if not exists generated_at timestamptz;
alter table meeting_notes add column if not exists edited_at timestamptz;
-- 'team' for every Granola row (as before); a Copilot row copies its
-- meeting's visibility, and `owner_id` is the recorder.
alter table meeting_notes add column if not exists visibility text not null default 'team'
  check (visibility in ('private', 'team'));
alter table meeting_notes add column if not exists owner_id uuid references auth.users(id) on delete set null;

alter table meeting_notes
  add column if not exists search_vector tsvector
  generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(user_notes, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(content, '')), 'C')
  ) stored;

create index if not exists meeting_notes_search_idx on meeting_notes using gin (search_vector);
create index if not exists meeting_notes_meeting_idx
  on meeting_notes (meeting_id) where meeting_id is not null;

-- The read policy gains the visibility rule; Granola rows are all 'team', so
-- nothing changes for them.
drop policy if exists meeting_notes_select on meeting_notes;
create policy meeting_notes_select on meeting_notes
  for select using (
    is_org_member(organization_id)
    and (
      visibility = 'team'
      or owner_id = auth.uid()
      or (meeting_id is not null and can_read_meeting(meeting_id))
    )
  );

-- ----------------------------------------------------------- share links --

create table if not exists note_share_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  meeting_id uuid not null references meetings(id) on delete cascade,
  -- Hex SHA-256 of the token and NOTES_SHARE_PEPPER. The token itself is
  -- shown once, in the link, and cannot be recovered from this table.
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  -- The summary only, unless this is switched on.
  include_transcript boolean not null default false,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  view_count integer not null default 0 check (view_count >= 0),
  last_viewed_at timestamptz,
  created_at timestamptz not null default now(),
  -- 90 days at most (a minute's grace for clock skew between app and database).
  check (expires_at > created_at and expires_at <= created_at + interval '90 days 1 minute'),
  unique (token_hash)
);

create index if not exists note_share_links_meeting_idx on note_share_links (meeting_id);

-- ----------------------------------------------------------- consent log --
--
-- Append-only: the consent step (shown, copied, confirmed, blocked) and the
-- recording state around it (started, paused, resumed, stopped), with who and
-- when. Never updated; deleted only with its meeting.

create table if not exists meeting_consent_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  meeting_id uuid not null references meetings(id) on delete cascade,
  event text not null check (event in (
    'notice_copied', 'confirmed', 'blocked', 'recording_started', 'paused', 'resumed', 'stopped'
  )),
  method text check (method is null or method in
    ('verbal', 'chat_notice', 'invite_notice', 'in_person_notice', 'other')),
  notice_text text check (notice_text is null or char_length(notice_text) <= 2000),
  actor_id uuid references auth.users(id) on delete set null,
  -- Non-sensitive context: the matched rule's label, a stop reason.
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object'),
  created_at timestamptz not null default now()
);

create index if not exists meeting_consent_log_meeting_idx
  on meeting_consent_log (meeting_id, created_at);

-- --------------------------------------------------------- voice profiles --
--
-- Voiceprints are biometric identifiers (Texas Bus. & Com. Code 503.001,
-- Illinois BIPA): notice and consent before capture, destroyed within a year
-- of last use, deleted at once on revoke, never exported. This table holds
-- the consent and its evidence only; the identifier is in voice_identifiers,
-- which no browser role can read at all.

create table if not exists voice_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  person_email text not null check (char_length(person_email) <= 320 and person_email = lower(person_email)),
  display_name text check (display_name is null or char_length(display_name) <= 300),
  crm_person_id uuid references crm_records(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  -- Voiceprints are made on the recorder's own device by the speech worker.
  provider text not null default 'on_device' check (provider in ('on_device')),
  consent_status text not null default 'not_asked'
    check (consent_status in ('not_asked', 'granted', 'revoked')),
  consent_at timestamptz,
  -- How the consent was recorded: the person's own checkbox, a signed form, a
  -- recorded verbal yes.
  consent_evidence text check (consent_evidence is null or consent_evidence in
    ('self_checkbox', 'written', 'verbal_recorded')),
  consent_text_version text check (consent_text_version is null or char_length(consent_text_version) <= 40),
  consent_recorded_by uuid references auth.users(id) on delete set null,
  enrolled_at timestamptz,
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, person_email, provider)
);

create table if not exists voice_identifiers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  voice_profile_id uuid not null references voice_profiles(id) on delete cascade,
  -- AES-256-GCM output, sealed in the app with VOICEPRINT_ENC_KEY and bound
  -- to the profile id: { "ciphertext", "iv", "authTag", "keyVersion" }.
  identifier_enc jsonb not null check (jsonb_typeof(identifier_enc) = 'object'),
  -- A voiceprint (a speaker embedding) only matches one from the same model.
  model_version text not null check (char_length(model_version) between 1 and 80),
  created_at timestamptz not null default now(),
  -- At most a year after it was last used; the purge job deletes it then.
  expires_at timestamptz not null,
  unique (voice_profile_id)
);

create index if not exists voice_identifiers_expires_idx on voice_identifiers (expires_at);

-- --------------------------------------------------------- recording rules --

create table if not exists recording_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  kind text not null check (kind in ('title', 'attendee_domain', 'attendee_email', 'calendar_id')),
  -- A word or phrase for 'title' (matched as whole words, any case); a bare
  -- domain, an address or a calendar id otherwise.
  pattern text not null check (char_length(pattern) between 1 and 320),
  -- What the rule protects, shown in the blocked message: 'legal', 'family'
  -- or the organization's own word.
  label text not null check (char_length(label) between 1 and 60),
  enabled boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, kind, pattern)
);

-- -------------------------------------------------------------- triggers --

drop trigger if exists meeting_folders_updated_at on meeting_folders;
create trigger meeting_folders_updated_at before update on meeting_folders
  for each row execute function set_updated_at();
drop trigger if exists note_templates_updated_at on note_templates;
create trigger note_templates_updated_at before update on note_templates
  for each row execute function set_updated_at();
drop trigger if exists note_recipes_updated_at on note_recipes;
create trigger note_recipes_updated_at before update on note_recipes
  for each row execute function set_updated_at();
drop trigger if exists meetings_updated_at on meetings;
create trigger meetings_updated_at before update on meetings
  for each row execute function set_updated_at();
drop trigger if exists meeting_participants_updated_at on meeting_participants;
create trigger meeting_participants_updated_at before update on meeting_participants
  for each row execute function set_updated_at();
drop trigger if exists meeting_speakers_updated_at on meeting_speakers;
create trigger meeting_speakers_updated_at before update on meeting_speakers
  for each row execute function set_updated_at();
drop trigger if exists transcript_segments_updated_at on transcript_segments;
create trigger transcript_segments_updated_at before update on transcript_segments
  for each row execute function set_updated_at();
drop trigger if exists voice_profiles_updated_at on voice_profiles;
create trigger voice_profiles_updated_at before update on voice_profiles
  for each row execute function set_updated_at();
drop trigger if exists recording_rules_updated_at on recording_rules;
create trigger recording_rules_updated_at before update on recording_rules
  for each row execute function set_updated_at();

-- ------------------------------------------------------------------- RLS --
--
-- Organization-wide tables take the standard shape: read for any member,
-- write for member and above. A meeting and everything under it is read only
-- where the visibility rule allows. The consent log is append-only from a
-- browser role. voice_identifiers has RLS on and no policy at all: only the
-- server, under the service role, ever touches it. Dropped first so the file
-- can be re-run.

do $$
declare
  t text;
  org_tables text[] := array['meeting_folders', 'note_templates', 'note_recipes',
    'recording_rules', 'voice_profiles'];
  meeting_tables text[] := array['meeting_participants', 'meeting_speakers',
    'transcript_segments', 'note_share_links'];
begin
  foreach t in array org_tables loop
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

  foreach t in array meeting_tables loop
    execute format('alter table %I enable row level security;', t);
    execute format('drop policy if exists %I on %I;', t || '_select', t);
    execute format('drop policy if exists %I on %I;', t || '_insert', t);
    execute format('drop policy if exists %I on %I;', t || '_update', t);
    execute format('drop policy if exists %I on %I;', t || '_delete', t);
    execute format(
      'create policy %I on %I for select using (is_org_member(organization_id) and can_read_meeting(meeting_id));',
      t || '_select', t
    );
    execute format(
      'create policy %I on %I for insert with check (has_org_role(organization_id, ''member'') and can_read_meeting(meeting_id));',
      t || '_insert', t
    );
    execute format(
      'create policy %I on %I for update using (has_org_role(organization_id, ''member'') and can_read_meeting(meeting_id)) with check (has_org_role(organization_id, ''member''));',
      t || '_update', t
    );
    execute format(
      'create policy %I on %I for delete using (has_org_role(organization_id, ''member'') and can_read_meeting(meeting_id));',
      t || '_delete', t
    );
  end loop;
end $$;

alter table meetings enable row level security;
drop policy if exists meetings_select on meetings;
drop policy if exists meetings_insert on meetings;
drop policy if exists meetings_update on meetings;
drop policy if exists meetings_delete on meetings;
create policy meetings_select on meetings
  for select using (
    is_org_member(organization_id)
    and (visibility = 'team' or recorded_by = auth.uid() or auth.uid() = any (shared_with))
  );
create policy meetings_insert on meetings
  for insert with check (has_org_role(organization_id, 'member'));
create policy meetings_update on meetings
  for update using (has_org_role(organization_id, 'member') and can_read_meeting(id))
  with check (has_org_role(organization_id, 'member'));
create policy meetings_delete on meetings
  for delete using (has_org_role(organization_id, 'member') and can_read_meeting(id));

alter table meeting_consent_log enable row level security;
drop policy if exists meeting_consent_log_select on meeting_consent_log;
drop policy if exists meeting_consent_log_insert on meeting_consent_log;
create policy meeting_consent_log_select on meeting_consent_log
  for select using (is_org_member(organization_id) and can_read_meeting(meeting_id));
create policy meeting_consent_log_insert on meeting_consent_log
  for insert with check (has_org_role(organization_id, 'member') and can_read_meeting(meeting_id));

alter table voice_identifiers enable row level security;

comment on table meetings is
  'Copilot Notes meetings. Private to the recorder unless visibility = team or shared_with lists the reader. No audio is stored (audio_retained is pinned false).';
comment on table meeting_speakers is
  'One row per voice in a meeting; the only place a voice''s name lives, so relabelling is one update.';
comment on table transcript_segments is
  'Transcript lines keyed by voice cluster. Untrusted text, rendered as text only; edited_text keeps the original in text.';
comment on table note_share_links is
  'Expiring, revocable share links for a meeting''s notes: SHA-256 hash of token + pepper only.';
comment on table meeting_consent_log is
  'Append-only log of the consent step and recording state per meeting.';
comment on table voice_profiles is
  'Opt-in voice enrolment consent and its evidence. The identifiers themselves are in voice_identifiers.';
comment on table voice_identifiers is
  'Encrypted voice identifiers (biometric). Server only: RLS on with no policy; never selected by default, never exported.';
comment on table recording_rules is
  'Never-record rules: a matching meeting cannot be recorded.';

-- --------------------------------------------------------- notes requests --
--
-- Zero spend: a meeting's notes and the meeting chat are written by Arwin's
-- Claude routine (the Ask bridge's ask-bridge-answerer, on Arwin's plan), never
-- by a paid API. The app fires the routine with everything it needs in the
-- request (the routine cannot reach the app) and reads the answer back from
-- the Slack relay. One row per job.
--
-- line_map holds line ids only (a cited id -> the seq range it stands for; for
-- chat also the meeting, the moment and the speaker's name). `parts` holds a
-- result's NOTES_RESULT_V1 parts while they arrive and is emptied once the
-- notes are stored. No audio, ever.

create table if not exists notes_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  meeting_id uuid not null references meetings(id) on delete cascade,
  kind text not null default 'notes' check (kind in ('notes', 'chat')),
  status text not null default 'pending'
    check (status in ('pending', 'ready', 'failed', 'expired')),
  reason text check (reason is null or reason in ('stop', 'regenerate', 'template')),
  -- Chat only: the pending Ask message the answer lands on, and its thread.
  message_id uuid references chat_messages(id) on delete cascade,
  thread_id uuid references chat_threads(id) on delete cascade,
  template_id text check (template_id is null or char_length(template_id) <= 80),
  meeting_day date,
  requested_by uuid references auth.users(id) on delete set null,
  fired_at timestamptz,
  fire_attempts integer not null default 0 check (fire_attempts >= 0),
  last_fire_at timestamptz,
  line_map jsonb not null default '{}'::jsonb check (jsonb_typeof(line_map) = 'object'),
  parts jsonb not null default '{}'::jsonb check (jsonb_typeof(parts) = 'object'),
  payload_chars integer check (payload_chars is null or payload_chars >= 0),
  omitted_lines integer not null default 0 check (omitted_lines >= 0),
  -- Plain words for the page ("no answer came within a day"); never transcript text.
  error text check (error is null or char_length(error) <= 300),
  completed_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists notes_requests_pending_idx
  on notes_requests (organization_id, status, created_at);
create index if not exists notes_requests_meeting_idx
  on notes_requests (meeting_id, created_at desc);

-- The request behind a Copilot note's current text ("Arwin is writing…").
alter table meeting_notes add column if not exists notes_request_id uuid
  references notes_requests(id) on delete set null;

drop trigger if exists notes_requests_updated_at on notes_requests;
create trigger notes_requests_updated_at before update on notes_requests
  for each row execute function set_updated_at();

alter table notes_requests enable row level security;
drop policy if exists notes_requests_select on notes_requests;
drop policy if exists notes_requests_insert on notes_requests;
drop policy if exists notes_requests_update on notes_requests;
drop policy if exists notes_requests_delete on notes_requests;
create policy notes_requests_select on notes_requests
  for select using (is_org_member(organization_id) and can_read_meeting(meeting_id));
create policy notes_requests_insert on notes_requests
  for insert with check (has_org_role(organization_id, 'member') and can_read_meeting(meeting_id));
create policy notes_requests_update on notes_requests
  for update using (has_org_role(organization_id, 'member') and can_read_meeting(meeting_id))
  with check (has_org_role(organization_id, 'member'));
create policy notes_requests_delete on notes_requests
  for delete using (has_org_role(organization_id, 'member') and can_read_meeting(meeting_id));

comment on table notes_requests is
  'Jobs for Arwin''s Claude routine (zero spend): a meeting''s notes or a meeting chat question. Line ids only in line_map; result parts are cleared once stored. No audio.';

-- No explicit grants: service_role inherits via the default privileges set in
-- 20260101000600, and browser roles deliberately query nothing directly.
