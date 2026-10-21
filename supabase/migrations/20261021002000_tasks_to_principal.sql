-- Tasks the code filed under the organization's owner by default, given to
-- the organization's principal instead (DECISIONS.md D-068).
--
-- Until now, every task a routine suggested was filed under the member with
-- the `owner` role, and a keep-in-touch check-in, a copied Affinity reminder
-- or a task the chat assistant added under whoever set, pressed or asked.
-- The owner is whoever set the organization up; the tasks are the work of
-- the person whose mailbox the app reads: the principal. The app now files
-- them there (src/lib/tasks/principal.ts); this moves the ones already
-- filed. It is a one-off data fix: it changes no schema, and the app works
-- the same before and after it runs.
--
-- The principal of each organization, by the app's rule:
--   (a) the member whose sign-in address (auth.users, or their profile) is
--       the address of the organization's mailbox: the oldest connected
--       Google integration that reads Gmail;
--   (b) else the member who connected that mailbox;
--   (c) else the oldest owner-role member (and then nothing moves).
--
-- A task moves when ALL of these hold:
--   - it is assigned to an owner-role member of its organization who is not
--     the principal;
--   - no person added it: `source` is not 'human'. The code writes
--     'suggested' for a routine's suggestion (task webhook and Slack relay),
--     a keep-in-touch check-in, a copied Affinity reminder and a task the
--     chat assistant creates; 'human' is a follow-up a person added, which
--     stays;
--   - nobody ever chose who it is for: it has no `task.assigned` audit row;
--   - it is open, snoozed or complete. A deleted (cancelled) one stays.
-- Each move writes a `task.assigned` audit row like the app's own assign
-- (src/lib/security/audit.ts): user_id null, entity_type 'task', and
-- metadata {from, to, reason: 'default owner fix'}. That row is also why a
-- second run moves nothing.
--
-- `updated_at` is kept as it was: a correction is not activity, and "Going
-- stale" on the Money & legal tab counts from it. The tasks_updated_at
-- trigger is off for this one transaction only; ALTER TABLE is part of the
-- transaction, so if anything fails the trigger is back as it was.
--
-- One transaction, safe to run again, for the Supabase SQL editor. Run the
-- PREVIEW first, on its own (uncomment it, or copy it out): it only reads.
-- It lists every owner of every organization, the principal and how the
-- rule found them, and how many of the owner's tasks would move, by source
-- and status ('-' and 0 when none would).
--
-- ------------------------------------------------------------------ PREVIEW
-- with mailbox as (
--   select distinct on (i.organization_id)
--          i.organization_id, i.user_id, lower(btrim(i.account_email)) as address
--     from public.integrations i
--    where i.provider = 'google'
--      and 'gmail' = any (i.kinds)
--      and i.status = 'connected'
--    order by i.organization_id, i.created_at, i.id
-- ),
-- by_address as (
--   select distinct on (m.organization_id) m.organization_id, m.user_id
--     from public.organization_members m
--     join mailbox mb on mb.organization_id = m.organization_id
--     left join auth.users u on u.id = m.user_id
--     left join public.user_profiles p on p.id = m.user_id
--    where mb.address <> ''
--      and (lower(btrim(u.email)) = mb.address or lower(btrim(p.email)) = mb.address)
--    order by m.organization_id, m.created_at, m.user_id
-- ),
-- by_connector as (
--   select mb.organization_id, mb.user_id
--     from mailbox mb
--     join public.organization_members m
--       on m.organization_id = mb.organization_id and m.user_id = mb.user_id
-- ),
-- by_owner as (
--   select distinct on (m.organization_id) m.organization_id, m.user_id
--     from public.organization_members m
--    where m.role = 'owner'
--    order by m.organization_id, m.created_at, m.user_id
-- ),
-- principal as (
--   select o.id as organization_id,
--          coalesce(a.user_id, c.user_id, w.user_id) as principal_id,
--          case
--            when a.user_id is not null then 'mailbox address'
--            when c.user_id is not null then 'mailbox connector'
--            when w.user_id is not null then 'owner'
--          end as basis
--     from public.organizations o
--     left join by_address a on a.organization_id = o.id
--     left join by_connector c on c.organization_id = o.id
--     left join by_owner w on w.organization_id = o.id
-- ),
-- moves as (
--   select t.id, t.organization_id, t.assigned_to as from_id, p.principal_id as to_id,
--          t.source, t.status
--     from public.tasks t
--     join principal p on p.organization_id = t.organization_id
--     join public.organization_members om
--       on om.organization_id = t.organization_id
--      and om.user_id = t.assigned_to
--      and om.role = 'owner'
--    where t.assigned_to <> p.principal_id
--      and t.source <> 'human'
--      and t.status in ('open', 'snoozed', 'complete')
--      and not exists (
--        select 1
--          from public.audit_events e
--         where e.organization_id = t.organization_id
--           and e.entity_type = 'task'
--           and e.entity_id = t.id::text
--           and e.action = 'task.assigned'
--      )
-- )
-- select ow.organization_id,
--        ow.user_id as owner_id,
--        ou.email as owner_email,
--        p.principal_id,
--        pu.email as principal_email,
--        p.basis as principal_found_by,
--        coalesce(mv.source, '-') as source,
--        coalesce(mv.status::text, '-') as status,
--        count(mv.id) as tasks_to_move
--   from public.organization_members ow
--   join principal p on p.organization_id = ow.organization_id
--   left join moves mv on mv.organization_id = ow.organization_id and mv.from_id = ow.user_id
--   left join auth.users ou on ou.id = ow.user_id
--   left join auth.users pu on pu.id = p.principal_id
--  where ow.role = 'owner'
--  group by 1, 2, 3, 4, 5, 6, 7, 8
--  order by 1, 2, 7, 8;
-- ---------------------------------------------------------------------------

begin;

alter table public.tasks disable trigger tasks_updated_at;

with mailbox as (
  select distinct on (i.organization_id)
         i.organization_id, i.user_id, lower(btrim(i.account_email)) as address
    from public.integrations i
   where i.provider = 'google'
     and 'gmail' = any (i.kinds)
     and i.status = 'connected'
   order by i.organization_id, i.created_at, i.id
),
by_address as (
  select distinct on (m.organization_id) m.organization_id, m.user_id
    from public.organization_members m
    join mailbox mb on mb.organization_id = m.organization_id
    left join auth.users u on u.id = m.user_id
    left join public.user_profiles p on p.id = m.user_id
   where mb.address <> ''
     and (lower(btrim(u.email)) = mb.address or lower(btrim(p.email)) = mb.address)
   order by m.organization_id, m.created_at, m.user_id
),
by_connector as (
  select mb.organization_id, mb.user_id
    from mailbox mb
    join public.organization_members m
      on m.organization_id = mb.organization_id and m.user_id = mb.user_id
),
by_owner as (
  select distinct on (m.organization_id) m.organization_id, m.user_id
    from public.organization_members m
   where m.role = 'owner'
   order by m.organization_id, m.created_at, m.user_id
),
principal as (
  select o.id as organization_id,
         coalesce(a.user_id, c.user_id, w.user_id) as principal_id
    from public.organizations o
    left join by_address a on a.organization_id = o.id
    left join by_connector c on c.organization_id = o.id
    left join by_owner w on w.organization_id = o.id
),
moves as (
  select t.id, t.organization_id, t.assigned_to as from_id, p.principal_id as to_id
    from public.tasks t
    join principal p on p.organization_id = t.organization_id
    join public.organization_members om
      on om.organization_id = t.organization_id
     and om.user_id = t.assigned_to
     and om.role = 'owner'
   where t.assigned_to <> p.principal_id
     and t.source <> 'human'
     and t.status in ('open', 'snoozed', 'complete')
     and not exists (
       select 1
         from public.audit_events e
        where e.organization_id = t.organization_id
          and e.entity_type = 'task'
          and e.entity_id = t.id::text
          and e.action = 'task.assigned'
     )
),
moved as (
  update public.tasks t
     set assigned_to = mv.to_id
    from moves mv
   where t.id = mv.id
     and t.assigned_to = mv.from_id
  returning t.id, t.organization_id, mv.from_id, mv.to_id
)
insert into public.audit_events (organization_id, user_id, action, entity_type, entity_id, metadata)
select mo.organization_id,
       null,
       'task.assigned',
       'task',
       mo.id::text,
       jsonb_build_object('from', mo.from_id, 'to', mo.to_id, 'reason', 'default owner fix')
  from moved mo;

alter table public.tasks enable trigger tasks_updated_at;

commit;

-- What this fix has moved so far, per organization (every run counted).
select e.organization_id, count(*) as tasks_moved_to_principal
  from public.audit_events e
 where e.action = 'task.assigned'
   and e.metadata ->> 'reason' = 'default owner fix'
 group by e.organization_id
 order by e.organization_id;
