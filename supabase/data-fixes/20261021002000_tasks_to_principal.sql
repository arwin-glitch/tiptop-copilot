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
-- the same before and after it runs. It is not a migration, and lives
-- outside supabase/migrations so `supabase db push` never runs it: it is run
-- by hand, after its previews.
--
-- The principal of each organization, by the app's rule:
--   (a) the member whose profile address (user_profiles.email) is the
--       address of the organization's mailbox: the oldest Google integration
--       that reads Gmail, a connected one first, then one that needs
--       reconnecting, then a disconnected one;
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
--   - it is open or snoozed. A done (complete) task stays where it is: it is
--     history, Completed has no person filter, and moving it would set the
--     proof check (D-065) judging work someone else already did from their
--     own mailbox. A deleted (cancelled) one stays too.
-- Only `assigned_to` changes: no status, due date, title or other column,
-- nothing is deleted, and no other organization's rows are read for a move.
-- Each move writes a `task.assigned` audit row like the app's own assign
-- (src/lib/security/audit.ts): user_id null, entity_type 'task', and
-- metadata {from, to, reason: 'default owner fix'}. That row is also why a
-- second run moves nothing.
--
-- `updated_at` is kept as it was: a correction is not activity, and "Going
-- stale" on the Money & legal tab counts from it. The tasks_updated_at
-- trigger is off for this one transaction only; ALTER TABLE is part of the
-- transaction (and locks the table until it ends, so no other session ever
-- writes while the trigger is off), and if anything fails the trigger is
-- back as it was.
--
-- One transaction, safe to run again, for the Supabase SQL editor. Run the
-- two PREVIEWS first, each on its own (copy it out and remove the leading
-- "-- "): they only read.
--   PREVIEW 1 lists every owner of every organization, the mailbox, the
--   principal and how the rule found them, and how many of the owner's tasks
--   would move, by source and status ('-' and 0 when none would). Check that
--   principal_found_by is 'mailbox address' and principal_email is the
--   mailbox person before going on.
--   PREVIEW 2 lists the tasks themselves, one row each, with who added them
--   (a routine's name, 'keep-in-touch', or the person who asked the chat).
--
-- ------------------------------------------------------- PREVIEW 1: PEOPLE
-- with mailbox as (
--   select distinct on (i.organization_id)
--          i.organization_id, i.user_id, i.status, lower(btrim(i.account_email)) as address
--     from public.integrations i
--    where i.provider = 'google'
--      and 'gmail' = any (i.kinds)
--    order by i.organization_id,
--             case i.status when 'connected' then 0 when 'disconnected' then 2 else 1 end,
--             i.created_at, i.id
-- ),
-- by_address as (
--   select distinct on (m.organization_id) m.organization_id, m.user_id
--     from public.organization_members m
--     join mailbox mb on mb.organization_id = m.organization_id
--     join public.user_profiles p on p.id = m.user_id
--    where mb.address <> ''
--      and lower(btrim(p.email)) = mb.address
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
--      and t.status in ('open', 'snoozed')
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
--        op.email as owner_email,
--        mb.address as mailbox,
--        mb.status as mailbox_status,
--        p.principal_id,
--        pp.email as principal_email,
--        p.basis as principal_found_by,
--        coalesce(mv.source, '-') as source,
--        coalesce(mv.status::text, '-') as status,
--        count(mv.id) as tasks_to_move
--   from public.organization_members ow
--   join principal p on p.organization_id = ow.organization_id
--   left join mailbox mb on mb.organization_id = ow.organization_id
--   left join moves mv on mv.organization_id = ow.organization_id and mv.from_id = ow.user_id
--   left join public.user_profiles op on op.id = ow.user_id
--   left join public.user_profiles pp on pp.id = p.principal_id
--  where ow.role = 'owner'
--  group by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
--  order by 1, 2, 9, 10;
-- ---------------------------------------------------------------------------
--
-- -------------------------------------------------------- PREVIEW 2: TASKS
-- with mailbox as (
--   select distinct on (i.organization_id)
--          i.organization_id, i.user_id, i.status, lower(btrim(i.account_email)) as address
--     from public.integrations i
--    where i.provider = 'google'
--      and 'gmail' = any (i.kinds)
--    order by i.organization_id,
--             case i.status when 'connected' then 0 when 'disconnected' then 2 else 1 end,
--             i.created_at, i.id
-- ),
-- by_address as (
--   select distinct on (m.organization_id) m.organization_id, m.user_id
--     from public.organization_members m
--     join mailbox mb on mb.organization_id = m.organization_id
--     join public.user_profiles p on p.id = m.user_id
--    where mb.address <> ''
--      and lower(btrim(p.email)) = mb.address
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
--          coalesce(a.user_id, c.user_id, w.user_id) as principal_id
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
--      and t.status in ('open', 'snoozed')
--      and not exists (
--        select 1
--          from public.audit_events e
--         where e.organization_id = t.organization_id
--           and e.entity_type = 'task'
--           and e.entity_id = t.id::text
--           and e.action = 'task.assigned'
--      )
-- )
-- select mv.organization_id,
--        mv.id as task_id,
--        t.title,
--        mv.status,
--        coalesce(cp.email, cr.metadata ->> 'source', '- (an Affinity reminder)') as added_by,
--        t.created_at,
--        t.due_at,
--        fp.email as from_email,
--        tp.email as to_email
--   from moves mv
--   join public.tasks t on t.id = mv.id
--   left join lateral (
--     select c.user_id, c.metadata
--       from public.audit_events c
--      where c.organization_id = mv.organization_id
--        and c.entity_type = 'task'
--        and c.entity_id = mv.id::text
--        and c.action = 'task.created'
--      order by c.created_at
--      limit 1
--   ) cr on true
--   left join public.user_profiles cp on cp.id = cr.user_id
--   left join public.user_profiles fp on fp.id = mv.from_id
--   left join public.user_profiles tp on tp.id = mv.to_id
--  order by mv.organization_id, added_by, t.created_at;
-- ---------------------------------------------------------------------------

begin;

alter table public.tasks disable trigger tasks_updated_at;

with mailbox as (
  select distinct on (i.organization_id)
         i.organization_id, i.user_id, i.status, lower(btrim(i.account_email)) as address
    from public.integrations i
   where i.provider = 'google'
     and 'gmail' = any (i.kinds)
   order by i.organization_id,
            case i.status when 'connected' then 0 when 'disconnected' then 2 else 1 end,
            i.created_at, i.id
),
by_address as (
  select distinct on (m.organization_id) m.organization_id, m.user_id
    from public.organization_members m
    join mailbox mb on mb.organization_id = m.organization_id
    join public.user_profiles p on p.id = m.user_id
   where mb.address <> ''
     and lower(btrim(p.email)) = mb.address
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
  select t.id, t.organization_id, t.assigned_to as from_id, p.principal_id as to_id,
         t.source, t.status
    from public.tasks t
    join principal p on p.organization_id = t.organization_id
    join public.organization_members om
      on om.organization_id = t.organization_id
     and om.user_id = t.assigned_to
     and om.role = 'owner'
   where t.assigned_to <> p.principal_id
     and t.source <> 'human'
     and t.status in ('open', 'snoozed')
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
     and t.organization_id = mv.organization_id
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
