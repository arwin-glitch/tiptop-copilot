-- The public job board: open roles at portfolio companies, for anyone to see.
--
-- Three tables, all empty by default. Until a person turns the board on in
-- Copilot (Portfolio > Jobs), the public pages show a "coming soon" page with
-- no data at all, and nothing here is public.
--
--   - job_board_settings: one row per organization. The board's on/off
--     switch (off unless this row says on), its title, intro and accent.
--   - job_companies: per portfolio company, how its roles reach the board.
--     A careers page address, the job board (ATS) read from it with the
--     board's own token, whether its public roles are read every day, and
--     whether they appear on the board on their own ("auto-publish"). Plus the
--     public face: a logo address, a short public "about", and whether the
--     company is listed with no open roles.
--   - job_postings: one row per role. Where it came from (`ats`: the
--     company's own public job board; `email`: a role founders sent Nick, from
--     the weekly jobs scan; `manual`: added by a person), the public fields
--     (title, team, places, remote, type, level, pay when public, the
--     description as plain structured text, never HTML, and the apply link),
--     and who decided it may be public.
--
-- How a role becomes public, enforced here as well as in the app:
--   - An emailed or hand-added role is public only once a person approved
--     it (approved_at set). The check constraint below refuses a published
--     row without an approval, whatever the code does.
--   - A role read from a company's own public job board appears on its own
--     only when a person turned auto-publish on for that company; otherwise
--     it waits for a person too.
--   - A role a person hid stays hidden, whatever later syncs read.
--   - The public pages show only active, published roles while the board is
--     on, and only these columns: never an email address, a note, a source
--     email or anything else in Copilot.
--
-- Additive and idempotent like every migration here: safe to run again in
-- the SQL editor. Until it is applied the app treats the board as off: the
-- public pages say "coming soon", and Portfolio > Jobs keeps its roles from
-- email and says the board needs this file (lib/services/jobs-board.ts).

-- -------------------------------------------------------------- settings --

create table if not exists job_board_settings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references organizations(id) on delete cascade,
  enabled boolean not null default false,
  title text not null default 'Jobs at TipTop portfolio companies'
    check (char_length(title) between 1 and 120),
  intro text check (intro is null or char_length(intro) <= 600),
  -- A plain hex colour, used for the board's accent; nothing else is accepted.
  accent text not null default '#0FC382' check (accent ~ '^#[0-9A-Fa-f]{6}$'),
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------- companies --

create table if not exists job_companies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  portfolio_company_id uuid not null references portfolio_companies(id) on delete cascade,
  -- The company's address on the board: /jobs/<slug>.
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  careers_url text
    check (careers_url is null or (careers_url ~* '^https?://' and char_length(careers_url) <= 500)),
  -- The job board read from the careers address, and the board's own name on it.
  ats text check (ats is null or ats in ('greenhouse', 'lever', 'ashby', 'workable', 'recruitee')),
  ats_token text check (ats_token is null or ats_token ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$'),
  sync_enabled boolean not null default false,
  auto_publish boolean not null default false,
  -- Shown on the board's company list even with no open roles.
  listed boolean not null default false,
  logo_url text
    check (logo_url is null or (logo_url ~* '^https://' and char_length(logo_url) <= 500)),
  about text check (about is null or char_length(about) <= 600),
  last_sync_at timestamptz,
  last_sync_status text check (last_sync_status is null or last_sync_status in ('ok', 'failed', 'skipped')),
  last_sync_message text check (last_sync_message is null or char_length(last_sync_message) <= 300),
  last_sync_count integer check (last_sync_count is null or last_sync_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, portfolio_company_id),
  unique (organization_id, slug)
);

-- -------------------------------------------------------------- postings --

create table if not exists job_postings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  portfolio_company_id uuid not null references portfolio_companies(id) on delete cascade,
  source text not null check (source in ('ats', 'email', 'manual')),
  -- The role's identity at its source: the board's posting id, the jobs
  -- scan's role id, or a fresh id for a hand-added role.
  source_key text not null check (char_length(source_key) between 1 and 200),
  -- The role's address under its company: /jobs/<company>/<slug>.
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,100}$'),
  title text not null check (char_length(title) between 1 and 200),
  team text check (team is null or char_length(team) <= 120),
  job_function text not null default 'other' check (job_function in (
    'engineering', 'product', 'design', 'data', 'sales', 'marketing', 'customer_success',
    'operations', 'finance', 'people', 'legal', 'leadership', 'other'
  )),
  locations text[] not null default '{}' check (cardinality(locations) <= 20),
  remote text check (remote is null or remote in ('remote', 'hybrid', 'onsite')),
  employment_type text check (employment_type is null or employment_type in (
    'full_time', 'part_time', 'contract', 'internship', 'temporary'
  )),
  seniority text check (seniority is null or seniority in (
    'intern', 'entry', 'mid', 'senior', 'staff', 'lead', 'manager', 'director', 'vp', 'executive'
  )),
  comp text check (comp is null or char_length(comp) <= 160),
  -- Plain structured text ("## " headings, "- " bullets, paragraphs), never HTML.
  description text check (description is null or char_length(description) <= 20000),
  apply_url text
    check (apply_url is null or (apply_url ~* '^https?://' and char_length(apply_url) <= 800)),
  posted_at timestamptz,
  source_updated_at timestamptz,
  status text not null default 'active' check (status in ('active', 'closed')),
  published boolean not null default false,
  featured boolean not null default false,
  approved_by uuid,
  approved_at timestamptz,
  hidden_by uuid,
  hidden_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, source, source_key),
  unique (organization_id, portfolio_company_id, slug)
);

-- The gate, in the database: an emailed or hand-added role is public only
-- once a person approved it, and a hidden role is never public.
alter table job_postings drop constraint if exists job_postings_approval_check;
alter table job_postings add constraint job_postings_approval_check
  check (not published or source = 'ats' or approved_at is not null);
alter table job_postings drop constraint if exists job_postings_hidden_check;
alter table job_postings add constraint job_postings_hidden_check
  check (not (published and hidden_at is not null));

create index if not exists job_postings_public_idx
  on job_postings (organization_id, status, published);
create index if not exists job_postings_company_idx
  on job_postings (organization_id, portfolio_company_id, status);

-- -------------------------------------------------------------- triggers --

drop trigger if exists job_board_settings_updated_at on job_board_settings;
create trigger job_board_settings_updated_at before update on job_board_settings
  for each row execute function set_updated_at();
drop trigger if exists job_companies_updated_at on job_companies;
create trigger job_companies_updated_at before update on job_companies
  for each row execute function set_updated_at();
drop trigger if exists job_postings_updated_at on job_postings;
create trigger job_postings_updated_at before update on job_postings
  for each row execute function set_updated_at();

-- ------------------------------------------------------------------- RLS --
--
-- Read for any member, write for member and above, like the campaigns.
-- Dropped first so the file can be re-run. The public pages read through the
-- server's service role, never from the browser.

do $$
declare
  t text;
begin
  foreach t in array array['job_board_settings', 'job_companies', 'job_postings'] loop
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

comment on table job_board_settings is
  'The public job board''s switch (off by default), title, intro and accent; one row per organization.';
comment on table job_companies is
  'Per portfolio company: careers page, its job board (ATS) and token, daily sync, auto-publish, public logo and about.';
comment on table job_postings is
  'Roles for the public job board. Emailed and hand-added roles are public only once a person approved them.';

-- No explicit grants: service_role inherits via the default privileges set in
-- 20260101000600, and browser roles deliberately query nothing directly.
