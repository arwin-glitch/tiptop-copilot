-- TipTop Copilot — extensions, enums and shared helpers.
--
-- Ordering note: this file must run first. Everything after it assumes the
-- enums, the `updated_at` trigger function and the membership helpers exist.

create extension if not exists "pgcrypto";
create extension if not exists "pg_trgm";
create extension if not exists "unaccent";

-- ---------------------------------------------------------------- enums --

do $$ begin
  create type org_role as enum ('owner', 'admin', 'member', 'viewer');
exception when duplicate_object then null; end $$;

do $$ begin
  create type integration_provider as enum ('google');
exception when duplicate_object then null; end $$;

do $$ begin
  create type integration_kind as enum ('gmail', 'calendar');
exception when duplicate_object then null; end $$;

do $$ begin
  create type integration_status as enum ('connected', 'disconnected', 'needs_reauth', 'error');
exception when duplicate_object then null; end $$;

do $$ begin
  create type email_category as enum (
    'new_deal', 'existing_deal', 'portfolio_company', 'lp_or_advisor', 'co_investor',
    'founder_follow_up', 'meeting_or_scheduling', 'newsletter_or_market', 'administrative',
    'personal_or_unrelated', 'unknown'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type extraction_confidence as enum ('high', 'medium', 'low');
exception when duplicate_object then null; end $$;

do $$ begin
  create type fact_source_type as enum (
    'founder_claim', 'third_party_claim', 'document', 'model_inference', 'human', 'web'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type recommendation as enum (
    'INSUFFICIENT_DATA', 'PASS', 'MONITOR', 'DIG_DEEPER', 'ADVANCE'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  -- 'invest' is present here but is only ever written by a human action in the
  -- application layer. The AI output schema does not contain the value at all,
  -- so it cannot be produced by a model.
  create type decision_type as enum ('pass', 'monitor', 'dig_deeper', 'advance', 'invest', 'reopen');
exception when duplicate_object then null; end $$;

do $$ begin
  create type task_status as enum ('open', 'complete', 'snoozed', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type portfolio_request_type as enum (
    'fundraising', 'gtm_strategy', 'hiring', 'candidate_request', 'customer_introduction',
    'investor_introduction', 'advisor_request', 'product_feedback', 'board_preparation',
    'urgent_problem', 'general_update'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type knowledge_doc_type as enum (
    'thesis', 'memo', 'pass_note', 'ic_note', 'portfolio_doc', 'market_map', 'playbook',
    'network_csv', 'other'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type draft_kind as enum (
    'missing_information', 'pass', 'follow_up', 'meeting_request', 'portfolio_reply', 'generic_reply'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type sync_status as enum ('running', 'succeeded', 'failed', 'partial');
exception when duplicate_object then null; end $$;

-- -------------------------------------------------------------- helpers --

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Membership predicates used by every RLS policy.
--
-- SECURITY DEFINER with a pinned search_path: the policy needs to read
-- organization_members, but organization_members is itself protected by RLS,
-- which would recurse. Defining the check here breaks the cycle without
-- widening what a caller can read.

create or replace function is_org_member(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from organization_members m
    where m.organization_id = target_org
      and m.user_id = auth.uid()
  );
$$;

create or replace function has_org_role(target_org uuid, minimum org_role)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from organization_members m
    where m.organization_id = target_org
      and m.user_id = auth.uid()
      and case m.role
            when 'owner'  then 4
            when 'admin'  then 3
            when 'member' then 2
            when 'viewer' then 1
          end
          >=
          case minimum
            when 'owner'  then 4
            when 'admin'  then 3
            when 'member' then 2
            when 'viewer' then 1
          end
  );
$$;

comment on function is_org_member(uuid) is
  'True when the current auth.uid() belongs to the organization. Used by every RLS policy.';
comment on function has_org_role(uuid, org_role) is
  'True when the current user holds at least the given role in the organization.';
