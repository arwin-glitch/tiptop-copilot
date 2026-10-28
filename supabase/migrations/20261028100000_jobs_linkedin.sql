-- The public job board: a LinkedIn jobs link per portfolio company.
--
-- One nullable column on job_companies. When a person gives a company's
-- LinkedIn address in Portfolio > Jobs, Kraken stores the company's jobs tab
-- (https://www.linkedin.com/company/<slug>/jobs/) and the public company
-- page and card show "See roles on LinkedIn". Kraken never fetches LinkedIn;
-- this is only a link.
--
-- Additive and idempotent: safe to run again. Until it runs, the board works
-- as before and saving a LinkedIn link says this file is needed
-- (lib/services/jobs-board.ts). Row-level security is the table's own
-- (20261022100000_public_jobs.sql); a new column needs no new policy.

alter table job_companies add column if not exists linkedin_url text;

alter table job_companies drop constraint if exists job_companies_linkedin_jobs_link;
alter table job_companies add constraint job_companies_linkedin_jobs_link
  check (
    linkedin_url is null
    or linkedin_url ~ '^https://www\.linkedin\.com/company/[a-z0-9][a-z0-9_.-]{0,99}/jobs/$'
  );

comment on column job_companies.linkedin_url is
  'The company''s LinkedIn jobs tab, shown as a link on the public board. Never fetched.';
