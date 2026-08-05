-- Private storage bucket and first-user bootstrap.

-- ------------------------------------------------------------- storage --
--
-- Private bucket. There is no public path and no policy that creates one:
-- every read goes through a server-minted signed URL that expires in fifteen
-- minutes, after an authorization check in the route handler.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'deal-attachments',
  'deal-attachments',
  false,
  26214400, -- 25 MB, matching MAX_ATTACHMENT_BYTES
  array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
    'text/markdown',
    'text/csv',
    'text/html',
    'application/json',
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp'
  ]
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Objects are stored under `<organization_id>/...`, so membership in the
-- leading path segment is the authorization rule.
create policy "attachments readable by org members"
  on storage.objects for select
  using (
    bucket_id = 'deal-attachments'
    and is_org_member((storage.foldername(name))[1]::uuid)
  );

create policy "attachments writable by org members"
  on storage.objects for insert
  with check (
    bucket_id = 'deal-attachments'
    and has_org_role((storage.foldername(name))[1]::uuid, 'member')
  );

create policy "attachments deletable by org members"
  on storage.objects for delete
  using (
    bucket_id = 'deal-attachments'
    and has_org_role((storage.foldername(name))[1]::uuid, 'member')
  );

-- ----------------------------------------------------------- bootstrap --
--
-- On first sign-in, create the user's profile and — if they belong to no
-- organization yet — an organization with them as owner, seeded with the
-- default thesis. This is what makes the app usable immediately after
-- deployment without a manual setup step in the dashboard.

create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_org_id uuid;
  derived_slug text;
begin
  insert into user_profiles (id, email, full_name, avatar_url)
  values (
    new.id,
    coalesce(new.email, ''),
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;

  if exists (select 1 from organization_members where user_id = new.id) then
    return new;
  end if;

  -- Slug from the email domain, uniquified. Falls back to a random suffix.
  derived_slug := regexp_replace(
    lower(coalesce(split_part(new.email, '@', 2), 'workspace')),
    '[^a-z0-9]+', '-', 'g'
  );
  derived_slug := trim(both '-' from derived_slug);
  if derived_slug = '' then derived_slug := 'workspace'; end if;
  if exists (select 1 from organizations where slug = derived_slug) then
    derived_slug := derived_slug || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
  end if;

  insert into organizations (name, slug)
  values (initcap(replace(derived_slug, '-', ' ')), derived_slug)
  returning id into new_org_id;

  insert into organization_members (organization_id, user_id, role)
  values (new_org_id, new.id, 'owner');

  insert into thesis_versions (
    organization_id, version, preferred_stages, preferred_industries,
    thesis_notes, scoring_weights, thresholds, deal_stages, is_active, created_by
  )
  values (
    new_org_id,
    1,
    array['Pre-seed', 'Seed'],
    array['Vertical AI', 'AI-native vertical software', 'Industry-specific platforms'],
    'TipTop VC invests at pre-seed and seed into vertical AI and AI-native vertical software: industry-specific platforms sold to the people who do the work.

We look for founders or experienced operators with strong founder-market fit, products that replace or reinvent meaningful industry workflows, and businesses with the potential to become the intelligent operating system for a vertical.

We prioritise companies where TipTop can add value through GTM strategy, fundraising, hiring, and its operator network.

Check size, ownership target, geography and traction requirements are not set here. Leave them unset rather than assuming a value.',
    '[
      {"key":"thesis_fit","label":"Vertical AI and thesis fit","weight":15,"description":"How squarely the company sits in TipTop''s vertical-AI thesis.","enabled":true},
      {"key":"team","label":"Founder-market fit and team","weight":15,"description":"Operator depth in the vertical; why this team wins here.","enabled":true},
      {"key":"problem","label":"Problem severity and urgency","weight":10,"description":"How painful and how urgent the problem is for the buyer.","enabled":true},
      {"key":"product","label":"Product quality and AI differentiation","weight":12,"description":"Whether AI is load-bearing or decorative.","enabled":true},
      {"key":"market","label":"Market size and expansion potential","weight":10,"description":"Beachhead credibility and the path beyond it.","enabled":true},
      {"key":"traction","label":"Traction and GTM evidence","weight":10,"description":"Revenue, usage, pipeline and repeatability of the motion.","enabled":true},
      {"key":"defensibility","label":"Defensibility, proprietary data, or workflow advantage","weight":8,"description":"What compounds and what stops a fast follower.","enabled":true},
      {"key":"timing","label":"Timing and competitive position","weight":7,"description":"Why now, and position relative to named competitors.","enabled":true},
      {"key":"economics","label":"Stage, round, and investment economics","weight":6,"description":"Stage fit, round construction and entry terms.","enabled":true},
      {"key":"value_add","label":"TipTop value-add potential","weight":7,"description":"Where GTM, fundraising, hiring and the operator network move the needle.","enabled":true}
    ]'::jsonb,
    '{"minimum_completeness":35,"pass_below":45,"monitor_below":58,"dig_deeper_below":74,"advance_at":74}'::jsonb,
    '[
      {"key":"new","label":"New","order":0,"terminal":false},
      {"key":"reviewing","label":"Reviewing","order":1,"terminal":false},
      {"key":"waiting_for_info","label":"Waiting for information","order":2,"terminal":false},
      {"key":"founder_meeting","label":"Founder meeting","order":3,"terminal":false},
      {"key":"diligence","label":"Diligence","order":4,"terminal":false},
      {"key":"ic_review","label":"Partner / IC review","order":5,"terminal":false},
      {"key":"passed","label":"Passed","order":6,"terminal":true},
      {"key":"monitoring","label":"Monitoring","order":7,"terminal":false},
      {"key":"invested","label":"Invested","order":8,"terminal":true}
    ]'::jsonb,
    true,
    new.id
  );

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

comment on function handle_new_user() is
  'Creates a profile and, for a user with no existing membership, an organization with the default TipTop thesis. Runs on auth.users insert.';
