-- Events: Luma-style event pages, guest lists and check-in, inside Copilot (D-075).
--
-- An event is one page at copilot.tiptop.vc/e/<slug> with one or more
-- sessions (the AGM: an afternoon meeting and an evening reception), a guest
-- list with per-session RSVP status, and the people allowed to edit its draft
-- from outside Copilot through a personal link.
--
-- The page itself is a JSON document (lib/events/schema.ts): `draft_doc` is
-- what Studio edits, op by op, under a compare-and-set on `draft_version`;
-- `published_doc` is the snapshot guests see, copied from the draft only when
-- an owner presses Publish. Guests never read the draft.
--
-- Nothing here sends email. Every guest email is a campaign draft a person
-- reviews and confirms (20261016000000_campaigns.sql); `notified_status`
-- only records what a person has already sent.
--
-- Public pages (/e/*) read through the server under the service role, with
-- explicit organization_id and event_id filters (lib/services/event-public.ts).
-- There is no anon policy anywhere in this file, and outsiders never get a
-- Supabase session.
--
-- Additive and idempotent like every migration here: create-if-not-exists,
-- policies dropped and recreated, safe to run again in the SQL editor. Until
-- it is applied, the Events tab shows a "run this migration" note and every
-- other Copilot page works as before (lib/services/events.ts).
--
-- The atomic registration function (event_register) lives in
-- 20261023000200_event_register_fn.sql; the media buckets in
-- 20261023000100_event_media_buckets.sql.

-- ----------------------------------------------------------------- events --

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  -- copilot.tiptop.vc/e/<slug>. Globally unique: the URL space is one
  -- namespace. Words the /e routes use themselves are reserved.
  slug text not null
    check (slug ~ '^[a-z0-9]([a-z0-9-]{0,48}[a-z0-9])?$')
    check (slug not in ('edit', 'checkin', 'api', 'new', 'i', 'c')),
  title text not null check (char_length(title) between 1 and 140),
  status text not null default 'draft'
    check (status in ('draft', 'published', 'cancelled', 'archived')),
  -- public: may be indexed once published; unlisted: link only, noindex;
  -- private: owners and viewer links only.
  visibility text not null default 'unlisted'
    check (visibility in ('public', 'unlisted', 'private')),
  -- open: anyone with the link registers; approval: requests wait for an
  -- owner; invite_only: only personal links can RSVP.
  access text not null default 'open'
    check (access in ('open', 'approval', 'invite_only')),
  -- Optional page password (v1 nice): a hash, never the password.
  password_hash text,
  time_zone text not null default 'America/Chicago' check (char_length(time_zone) between 1 and 64),
  starts_at timestamptz,
  ends_at timestamptz,
  -- { kind: in_person|online|hybrid, name, address, lat, lng, place_id,
  --   maps_url, online_url, reveal: public|registered|going, notes }.
  -- The reveal rule is enforced on the server, never with CSS.
  venue jsonb not null default '{"kind": "in_person", "reveal": "public"}'::jsonb
    check (jsonb_typeof(venue) = 'object'),
  -- Event-wide cap across sessions; null means none (sessions have their own).
  capacity integer check (capacity is null or capacity between 0 and 100000),
  -- { open, closes_at, show_remaining, response_set, plus_ones{max,
  --   per_session, collect_email, ask_questions}, waitlist, auto_promote,
  --   claim_window_hours, request_invite, guest_wall: hidden|count|going|public }
  registration jsonb not null default '{}'::jsonb check (jsonb_typeof(registration) = 'object'),
  -- Registration questions, in order:
  -- [{ id, type, label, help, required, options[], session_id, ask_plus_ones,
  --    position, removed_at }]. A removed question keeps its id (exports).
  questions jsonb not null default '[]'::jsonb check (jsonb_typeof(questions) = 'array'),
  -- { reminder_offsets_minutes: [10080, 1440, 180], sender: nick|arwin }.
  -- Reminders are DRAFTS prepared ahead; nothing is scheduled to send.
  comms jsonb not null default '{"reminder_offsets_minutes": [10080, 1440, 180], "sender": "nick"}'::jsonb
    check (jsonb_typeof(comms) = 'object'),
  -- The page document Studio edits (lib/events/schema.ts), and its version:
  -- bumped by one on every applied batch of ops (compare-and-set).
  draft_doc jsonb not null default '{}'::jsonb check (jsonb_typeof(draft_doc) = 'object'),
  draft_version integer not null default 0 check (draft_version >= 0),
  -- The snapshot guests see; null until the first Publish.
  published_doc jsonb check (published_doc is null or jsonb_typeof(published_doc) = 'object'),
  published_version integer not null default 0 check (published_version >= 0),
  -- The draft_version that publish copied: Studio's "N changes" badge and the
  -- library's "unpublished changes" dot compare draft_version against it.
  published_draft_version integer not null default 0 check (published_draft_version >= 0),
  published_at timestamptz,
  published_by uuid references auth.users(id) on delete set null,
  -- The ICS SEQUENCE: bumped on any time or venue change.
  schedule_version integer not null default 0 check (schedule_version >= 0),
  -- schedule_version at the first Publish: schedule edits before anyone could
  -- RSVP never prompt an "update" message to Going guests.
  published_schedule_version integer not null default 0
    check (published_schedule_version >= 0),
  -- event-media/og/<event>/v<n>.png, rendered at Publish.
  og_image_path text check (og_image_path is null or char_length(og_image_path) <= 300),
  -- Read-only mode for every outside editor (reversible).
  editing_paused boolean not null default false,
  cancel_message text check (cancel_message is null or char_length(cancel_message) <= 2000),
  cancelled_at timestamptz,
  -- A saved template ("Save as template"): never published, listed under
  -- Templates, copied by "New event".
  is_template boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table events add column if not exists questions jsonb not null default '[]'::jsonb;
alter table events add column if not exists is_template boolean not null default false;
alter table events add column if not exists published_draft_version integer not null default 0;

create unique index if not exists events_slug_key on events (slug);
create index if not exists events_org_starts_idx on events (organization_id, starts_at desc);
create index if not exists events_org_status_idx on events (organization_id, status);

-- ------------------------------------------------------- slug aliases --
--
-- A slug an event used to have. Old links 301 to the current slug forever,
-- and an alias can never be taken by another event.

create table if not exists event_slug_aliases (
  slug text primary key check (slug ~ '^[a-z0-9]([a-z0-9-]{0,48}[a-z0-9])?$'),
  organization_id uuid not null references organizations(id) on delete cascade,
  event_id uuid not null references events(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists event_slug_aliases_event_idx on event_slug_aliases (organization_id, event_id);

-- ----------------------------------------------------------- sessions --
--
-- Every event has at least one session. Each has its own capacity,
-- approval and waitlist overrides, tag visibility (Reception-only invitees
-- never see the Meeting) and check-in.

create table if not exists event_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  event_id uuid not null references events(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  description text check (description is null or char_length(description) <= 2000),
  starts_at timestamptz,
  ends_at timestamptz,
  -- Same shape as events.venue; null means the event's venue.
  venue jsonb check (venue is null or jsonb_typeof(venue) = 'object'),
  capacity integer check (capacity is null or capacity between 0 and 100000),
  -- null means inherit from the event's access mode / registration settings.
  requires_approval boolean,
  waitlist boolean,
  -- Empty: everyone who can see the event sees this session.
  visible_to_tags text[] not null default '{}',
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists event_sessions_event_idx on event_sessions (organization_id, event_id, position);

-- ------------------------------------------------------------- guests --
--
-- One person on one event's list. Plus-ones are guests too, with
-- parent_guest_id set. Guest-level status is derived from the per-session
-- rows in event_guest_sessions.

create table if not exists event_guests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  event_id uuid not null references events(id) on delete cascade,
  parent_guest_id uuid references event_guests(id) on delete cascade,
  -- Lowercased. Optional for plus-ones and walk-ins.
  email text check (email is null or (char_length(email) between 3 and 320 and email = lower(email))),
  first_name text check (first_name is null or char_length(first_name) <= 100),
  last_name text check (last_name is null or char_length(last_name) <= 100),
  company text check (company is null or char_length(company) <= 200),
  title text check (title is null or char_length(title) <= 200),
  phone text check (phone is null or char_length(phone) <= 40),
  -- The CRM person this guest is, when known.
  record_id uuid references crm_records(id) on delete set null,
  -- Host-only tags (LP, Co-investor, Founder, Sponsor, Speaker, VIP, Staff,
  -- Press, custom). Drive gated sections and session visibility.
  tags text[] not null default '{}',
  -- Host-only note. Never shown to the guest.
  host_note text check (host_note is null or char_length(host_note) <= 4000),
  -- { <question id>: answer }.
  answers jsonb not null default '{}'::jsonb check (jsonb_typeof(answers) = 'object'),
  source text not null default 'host'
    check (source in ('invite', 'public', 'request', 'import', 'host', 'walk_in', 'plus_one')),
  -- Bumped to kill this guest's personal and check-in links (stateless HMACs).
  token_version integer not null default 1 check (token_version >= 1),
  -- The guest ticked "Show me on the guest list".
  show_on_wall boolean not null default false,
  referral_code text check (referral_code is null or char_length(referral_code) <= 64),
  utm jsonb check (utm is null or jsonb_typeof(utm) = 'object'),
  -- hashIp() of the registering address; never the address.
  ip_hash text,
  -- { <session id>: status } the guest was last told about by a SENT
  -- campaign. A status that differs is in the "Needs notifying" queue.
  notified_status jsonb not null default '{}'::jsonb check (jsonb_typeof(notified_status) = 'object'),
  registered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists event_guests_event_email_key
  on event_guests (event_id, email) where email is not null;
create index if not exists event_guests_event_idx on event_guests (organization_id, event_id, created_at);
create index if not exists event_guests_parent_idx on event_guests (parent_guest_id) where parent_guest_id is not null;
create index if not exists event_guests_record_idx on event_guests (organization_id, record_id) where record_id is not null;

-- ---------------------------------------------------- guest sessions --
--
-- A guest's status for one session. Luma's statuses map 1:1
-- (approved = going, pending_approval = pending).

create table if not exists event_guest_sessions (
  guest_id uuid not null references event_guests(id) on delete cascade,
  session_id uuid not null references event_sessions(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  event_id uuid not null references events(id) on delete cascade,
  status text not null default 'invited'
    check (status in ('invited', 'pending', 'going', 'maybe', 'waitlist', 'declined', 'not_going')),
  -- When they asked (registration or request): waitlist order is FIFO by it.
  requested_at timestamptz,
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  decision_note text check (decision_note is null or char_length(decision_note) <= 1000),
  -- A promoted waitlister's deadline to confirm (v1 nice).
  claim_expires_at timestamptz,
  checked_in_at timestamptz,
  -- Actor key of whoever checked them in: 'u:<user id>' or 'g:<grant id>'.
  checked_in_by text check (checked_in_by is null or char_length(checked_in_by) <= 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (guest_id, session_id)
);

create index if not exists event_guest_sessions_session_idx
  on event_guest_sessions (organization_id, event_id, session_id, status);

-- ------------------------------------------------------------ editors --
--
-- Personal links into an event from outside Copilot: outside editors,
-- viewers (draft preview) and check-in staff. Like mcp_tokens, only the
-- SHA-256 of the secret is stored, plus a 4-character hint; the link is
-- shown once. Every request re-checks revoked_at, expires_at,
-- token_version, editing_paused, the event and the scope
-- (lib/events/editor-auth.ts). Owners only can read this table.

create table if not exists event_editors (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  event_id uuid not null references events(id) on delete cascade,
  -- "Morgan – Capital Factory". Required.
  label text not null check (char_length(label) between 1 and 80),
  -- Kept as a record only; nothing is sent to it automatically.
  email text check (email is null or char_length(email) <= 320),
  role text not null check (role in ('editor', 'viewer', 'checkin')),
  -- { design: bool, content: bool, sections: 'all' | uuid[], brand_locked: bool }
  scope jsonb not null default '{"design": false, "content": true, "sections": "all", "brand_locked": true}'::jsonb
    check (jsonb_typeof(scope) = 'object'),
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  token_hint text not null check (char_length(token_hint) between 1 and 8),
  -- Bumped by Regenerate: ends every session claimed with the old link.
  token_version integer not null default 1 check (token_version >= 1),
  password_hash text,
  -- Default 14 days, at most 90.
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  first_claimed_at timestamptz,
  last_used_at timestamptz,
  last_ip_hash text,
  last_ua_hash text,
  use_count integer not null default 0 check (use_count >= 0),
  unique (token_hash)
);

create index if not exists event_editors_event_idx on event_editors (organization_id, event_id, created_at desc);

-- ----------------------------------------------------------- presence --
--
-- Who is in Studio right now: one row per person per event, upserted by
-- the sync poll. Rows older than 60 s are ignored, so a crashed tab
-- disappears on its own.

create table if not exists event_presence (
  event_id uuid not null references events(id) on delete cascade,
  -- 'u:<user id>' for owners, 'g:<grant id>' for outside editors.
  actor_key text not null check (char_length(actor_key) between 3 and 80),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  color text not null check (color ~ '^#[0-9a-fA-F]{6}$'),
  focused_section_id uuid,
  typing boolean not null default false,
  last_seen_at timestamptz not null default now(),
  primary key (event_id, actor_key)
);

create index if not exists event_presence_org_idx on event_presence (organization_id, event_id, last_seen_at desc);

-- ----------------------------------------------------------- versions --
--
-- Checkpoints of the draft: autosave (after 5+ minutes of activity, or when
-- an editor's session ends), published (every Publish), pre_restore (before
-- every restore), restore, and named ("Before Morgan's pass"). Restoring
-- never overwrites: it saves a pre_restore first and still needs a Publish.
-- Named and published versions are kept forever; autosaves 30 days or the
-- last 100.

create table if not exists event_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  event_id uuid not null references events(id) on delete cascade,
  -- 1, 2, 3 … per event.
  version integer not null check (version >= 1),
  kind text not null check (kind in ('autosave', 'named', 'published', 'pre_restore', 'restore')),
  name text check (name is null or char_length(name) <= 120),
  doc jsonb not null check (jsonb_typeof(doc) = 'object'),
  -- The draft_version this snapshot was taken at.
  draft_version integer not null default 0,
  author_user_id uuid references auth.users(id) on delete set null,
  author_editor_id uuid references event_editors(id) on delete set null,
  -- Stored at the time, so attribution survives a revoked link.
  author_name text check (author_name is null or char_length(author_name) <= 120),
  created_at timestamptz not null default now(),
  unique (event_id, version)
);

create index if not exists event_versions_event_idx on event_versions (organization_id, event_id, created_at desc);

-- -------------------------------------------------------------- edits --
--
-- The per-section activity log ("who changed which keys, when"), one row
-- per applied op. Feeds the Activity panel, conflict attribution ("Morgan
-- changed Headline") and sync tombstones. Pruned at 90 days.

create table if not exists event_edits (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  event_id uuid not null references events(id) on delete cascade,
  -- Null for theme and page edits.
  section_id uuid,
  op text not null check (op in ('insert', 'update', 'move', 'delete', 'theme', 'page')),
  keys text[] not null default '{}',
  before jsonb,
  after jsonb,
  draft_version integer not null,
  actor_key text not null check (char_length(actor_key) between 3 and 80),
  author_name text not null check (char_length(author_name) between 1 and 120),
  ip_hash text,
  created_at timestamptz not null default now()
);

create index if not exists event_edits_event_version_idx on event_edits (organization_id, event_id, draft_version);
create index if not exists event_edits_section_idx
  on event_edits (organization_id, event_id, section_id, created_at desc);

-- -------------------------------------------------------------- media --
--
-- Images, videos, logos and gated files placed on an event page. Pages
-- reference media by this id, never by URL. Originals are private
-- (event-originals); processed derivatives (AVIF/WebP at 640/1080/1920,
-- EXIF stripped, content-hashed paths) are public (event-media) unless the
-- item is gated, when everything stays private and is served as 15-minute
-- signed URLs to viewers who qualify.

create table if not exists event_media (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  event_id uuid not null references events(id) on delete cascade,
  -- 'file': a gated Materials download (PDF, deck), always private.
  kind text not null check (kind in ('image', 'video', 'logo', 'file')),
  status text not null default 'uploaded' check (status in ('uploaded', 'ready', 'failed')),
  -- In the private event-originals bucket.
  original_path text not null check (char_length(original_path) <= 400),
  original_name text check (original_name is null or char_length(original_name) <= 255),
  content_type text check (content_type is null or char_length(content_type) <= 120),
  bytes bigint check (bytes is null or bytes >= 0),
  -- [{ w, format, path, bytes }]
  variants jsonb not null default '[]'::jsonb check (jsonb_typeof(variants) = 'array'),
  poster_path text check (poster_path is null or char_length(poster_path) <= 400),
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  thumbhash text check (thumbhash is null or char_length(thumbhash) <= 200),
  -- The top 5 colours, as hex.
  colors jsonb not null default '[]'::jsonb check (jsonb_typeof(colors) = 'array'),
  alt text check (alt is null or char_length(alt) <= 500),
  decorative boolean not null default false,
  gated boolean not null default false,
  -- Why processing failed, safe to show.
  error text check (error is null or char_length(error) <= 500),
  -- Actor key: 'u:<user id>' or 'g:<grant id>'.
  created_by_actor text not null check (char_length(created_by_actor) between 3 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists event_media_event_idx on event_media (organization_id, event_id, created_at desc);

-- --------------------------------------------- page views (v1 nice) --
--
-- One row per visitor per day per event, from the JS view beacon (a GET
-- never records anything). visitor_hash is a daily-salted hash of address
-- and user agent, so a visitor cannot be followed across days.

create table if not exists event_page_views (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  event_id uuid not null references events(id) on delete cascade,
  day date not null,
  visitor_hash text not null check (char_length(visitor_hash) <= 64),
  guest_id uuid references event_guests(id) on delete set null,
  -- 'direct', a referrer host, a UTM source or a share-link code.
  source text check (source is null or char_length(source) <= 120),
  created_at timestamptz not null default now(),
  unique (event_id, day, visitor_hash)
);

create index if not exists event_page_views_event_idx on event_page_views (organization_id, event_id, day);

-- ---------------------------------------- partner share links (v1 nice) --

create table if not exists event_share_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  event_id uuid not null references events(id) on delete cascade,
  code text not null check (code ~ '^[a-z0-9-]{2,32}$'),
  label text not null check (char_length(label) between 1 and 80),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (event_id, code)
);

-- -------------------------------------------------------------- triggers --

drop trigger if exists events_updated_at on events;
create trigger events_updated_at before update on events
  for each row execute function set_updated_at();
drop trigger if exists event_sessions_updated_at on event_sessions;
create trigger event_sessions_updated_at before update on event_sessions
  for each row execute function set_updated_at();
drop trigger if exists event_guests_updated_at on event_guests;
create trigger event_guests_updated_at before update on event_guests
  for each row execute function set_updated_at();
drop trigger if exists event_guest_sessions_updated_at on event_guest_sessions;
create trigger event_guest_sessions_updated_at before update on event_guest_sessions
  for each row execute function set_updated_at();
drop trigger if exists event_media_updated_at on event_media;
create trigger event_media_updated_at before update on event_media
  for each row execute function set_updated_at();

-- ------------------------------------------------------------------- RLS --
--
-- The standard org-scoped shape, as for campaigns and the CRM: read for any
-- member, write for member and above. Dropped first so the file can be
-- re-run. No anon policies and no `using (true)`: public pages, guest links
-- and outside editors all go through the server under the service role,
-- which filters by organization_id and event_id explicitly.

do $$
declare
  t text;
  event_tables text[] := array[
    'events', 'event_slug_aliases', 'event_sessions', 'event_guests',
    'event_guest_sessions', 'event_presence', 'event_versions', 'event_edits',
    'event_media', 'event_page_views', 'event_share_links'
  ];
begin
  foreach t in array event_tables loop
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

-- Edit and staff links: owners may read (labels, hints, dates; the hash is
-- useless without the secret). Nothing is writable from a browser role:
-- creating, regenerating and revoking go through the server.
alter table event_editors enable row level security;
drop policy if exists event_editors_select on event_editors;
drop policy if exists event_editors_insert on event_editors;
drop policy if exists event_editors_update on event_editors;
drop policy if exists event_editors_delete on event_editors;
create policy event_editors_select on event_editors
  for select using (has_org_role(organization_id, 'owner'));

comment on table events is
  'Event pages (D-075): settings plus the draft and published page documents. Public at /e/<slug> only once published.';
comment on table event_slug_aliases is
  'Slugs an event used to have: 301 to the current slug forever, never reusable.';
comment on table event_sessions is
  'Sessions of an event (at least one each): own capacity, approval, waitlist, tag visibility, check-in.';
comment on table event_guests is
  'Guests of an event, plus-ones included (parent_guest_id). Emails never appear on public pages.';
comment on table event_guest_sessions is
  'A guest''s RSVP status per session; guest-level status is derived from these rows.';
comment on table event_editors is
  'Personal outside-editor, viewer and check-in links: SHA-256 hash only, shown once. Owners read; the server writes.';
comment on table event_presence is
  'Who is in Studio now (sync-poll upserts); rows older than 60 s are ignored.';
comment on table event_versions is
  'Draft checkpoints: autosave, named, published, pre_restore, restore. Restore never overwrites.';
comment on table event_edits is
  'One row per applied draft op: per-section activity, conflict attribution, sync tombstones. Pruned at 90 days.';
comment on table event_media is
  'Media placed on event pages, referenced by id. Originals private; derivatives public unless gated.';
comment on table event_page_views is
  'Daily unique views per event from the JS beacon (v1 nice).';
comment on table event_share_links is
  'Partner-tracked share links (v1 nice).';

-- No explicit grants: service_role inherits via the default privileges set in
-- 20260101000600, and browser roles deliberately query nothing directly.
