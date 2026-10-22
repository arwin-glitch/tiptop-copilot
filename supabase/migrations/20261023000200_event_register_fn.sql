-- Events: the atomic seat-claiming write (D-075).
--
-- Every change that can take a seat at an event goes through this one
-- function: a public RSVP, a personal link's response (and its edits and
-- cancellations), an owner's approval, promotion or bulk move, and adding
-- guests. The server plans the change from the event's current rows
-- (lib/events/capacity.ts: who is Going, Pending or on the Waitlist, per
-- session, plus-ones included) and passes the plan here as JSON:
--
--   { upsertGuests: [event_guests rows], deleteGuestIds: [uuid],
--     upsertRows:   [event_guest_sessions rows],
--     deleteRows:   [{ guest_id, session_id }],
--     force:        false }
--
-- This function then, in one transaction:
--   1. locks the event row and every one of its session rows FOR UPDATE
--      (always in that order, sessions by id, so two writers cannot
--      deadlock), which serialises every seat-taking write for the event;
--   2. counts who is Going per session, and event-wide, under that lock;
--   3. applies the plan, forcing organization_id and event_id from its own
--      arguments (a plan can never write into another event or tenant) and
--      refusing rows that point outside the event;
--   4. refuses the WHOLE plan if any session, or the event's own capacity,
--      would end up over capacity with more people Going than before.
--      Only `force` (an owner's deliberate "Add directly as Going") skips it.
--
-- A refused plan returns { ok: false, reason: 'capacity' } and nothing is
-- written; the server re-plans from the fresh rows (which now say the
-- session is full, so the guest is waitlisted) up to three times. So two
-- RSVPs for the last seat can never both win, and a plus-one can never push
-- a session past its cap.
--
-- The unique (event_id, email) index answers a second registration with the
-- same email: { ok: false, reason: 'duplicate_email' }, which the RSVP route
-- turns into a neutral "already registered" message that reveals nothing.
--
-- SECURITY DEFINER, called only from the server with the service role:
-- execute is revoked from public, anon and authenticated. Browsers never
-- call it, and there is no anon policy anywhere in the events schema.
--
-- Additive and idempotent: create or replace, grants re-applied. Apply after
-- 20261023000000_events.sql and 20261023000100_event_media_buckets.sql.

create or replace function event_register(p_organization_id uuid, p_event_id uuid, p_plan jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event events%rowtype;
  v_force boolean;
  v_guest event_guests%rowtype;
  v_row event_guest_sessions%rowtype;
  v_session record;
  v_going_before jsonb;
  v_event_before integer;
  v_after integer;
  v_before integer;
  v_count integer;
begin
  if p_plan is null or jsonb_typeof(p_plan) <> 'object' then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'detail', 'plan');
  end if;
  if coalesce(jsonb_array_length(p_plan -> 'upsertGuests'), 0) > 5000
     or coalesce(jsonb_array_length(p_plan -> 'upsertRows'), 0) > 20000
     or coalesce(jsonb_array_length(p_plan -> 'deleteGuestIds'), 0) > 5000
     or coalesce(jsonb_array_length(p_plan -> 'deleteRows'), 0) > 20000 then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'detail', 'too_large');
  end if;
  v_force := coalesce((p_plan ->> 'force')::boolean, false);

  -- 1. The lock: the event, then its sessions in id order.
  select * into v_event
    from events
    where id = p_event_id and organization_id = p_organization_id
    for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  perform 1
    from event_sessions
    where event_id = p_event_id and organization_id = p_organization_id
    order by id
    for update;

  -- 2. Who is Going now, per session and event-wide.
  select coalesce(jsonb_object_agg(t.session_id::text, t.n), '{}'::jsonb)
    into v_going_before
    from (
      select session_id, count(*) as n
        from event_guest_sessions
        where event_id = p_event_id and organization_id = p_organization_id and status = 'going'
        group by session_id
    ) t;
  select count(distinct guest_id) into v_event_before
    from event_guest_sessions
    where event_id = p_event_id and organization_id = p_organization_id and status = 'going';

  -- 3 + 4 in a subtransaction: any refusal rolls the whole plan back.
  begin
    -- Guests removed (plus-ones dropped, hard deletes). Their status rows
    -- and plus-ones go with them (on delete cascade).
    delete from event_guests
      where organization_id = p_organization_id
        and event_id = p_event_id
        and id in (
          select (value #>> '{}')::uuid
            from jsonb_array_elements(coalesce(p_plan -> 'deleteGuestIds', '[]'::jsonb))
        );

    -- Guests added or changed: hosts before their plus-ones (the foreign key).
    for v_guest in
      select *
        from jsonb_populate_recordset(null::event_guests, coalesce(p_plan -> 'upsertGuests', '[]'::jsonb))
        order by (parent_guest_id is not null)
    loop
      if v_guest.id is null then
        raise exception 'event_register: guest without id' using errcode = 'EV002';
      end if;
      insert into event_guests (
        id, organization_id, event_id, parent_guest_id, email, first_name, last_name,
        company, title, phone, record_id, tags, host_note, answers, source,
        token_version, show_on_wall, referral_code, utm, ip_hash, notified_status,
        registered_at
      ) values (
        v_guest.id, p_organization_id, p_event_id, v_guest.parent_guest_id, v_guest.email,
        v_guest.first_name, v_guest.last_name, v_guest.company, v_guest.title, v_guest.phone,
        v_guest.record_id, coalesce(v_guest.tags, '{}'), v_guest.host_note,
        coalesce(v_guest.answers, '{}'::jsonb), coalesce(v_guest.source, 'host'),
        coalesce(v_guest.token_version, 1), coalesce(v_guest.show_on_wall, false),
        v_guest.referral_code, v_guest.utm, v_guest.ip_hash,
        coalesce(v_guest.notified_status, '{}'::jsonb), v_guest.registered_at
      )
      on conflict (id) do update set
        -- Only what a plan legitimately changes. Host notes, notified status,
        -- token version and provenance are written elsewhere and never
        -- clobbered by a plan built from an older read.
        email = excluded.email,
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        company = excluded.company,
        title = excluded.title,
        phone = excluded.phone,
        record_id = excluded.record_id,
        tags = excluded.tags,
        answers = excluded.answers,
        show_on_wall = excluded.show_on_wall,
        registered_at = excluded.registered_at
      where event_guests.organization_id = p_organization_id
        and event_guests.event_id = p_event_id;
      get diagnostics v_count = row_count;
      if v_count = 0 then
        -- The id exists, in another event or tenant.
        raise exception 'event_register: guest outside the event' using errcode = 'EV002';
      end if;
    end loop;

    -- A plus-one's host must be a guest of the same event.
    if exists (
      select 1
        from event_guests c
        join event_guests p on p.id = c.parent_guest_id
        where c.event_id = p_event_id and (p.event_id <> p_event_id or p.parent_guest_id is not null)
    ) then
      raise exception 'event_register: plus-one outside the event' using errcode = 'EV002';
    end if;

    -- Status rows removed.
    delete from event_guest_sessions e
      using jsonb_to_recordset(coalesce(p_plan -> 'deleteRows', '[]'::jsonb))
        as d(guest_id uuid, session_id uuid)
      where e.guest_id = d.guest_id
        and e.session_id = d.session_id
        and e.event_id = p_event_id
        and e.organization_id = p_organization_id;

    -- Status rows added or changed.
    for v_row in
      select *
        from jsonb_populate_recordset(null::event_guest_sessions, coalesce(p_plan -> 'upsertRows', '[]'::jsonb))
    loop
      if not exists (
        select 1 from event_guests
          where id = v_row.guest_id and event_id = p_event_id and organization_id = p_organization_id
      ) or not exists (
        select 1 from event_sessions
          where id = v_row.session_id and event_id = p_event_id and organization_id = p_organization_id
      ) then
        raise exception 'event_register: status row outside the event' using errcode = 'EV002';
      end if;
      insert into event_guest_sessions (
        guest_id, session_id, organization_id, event_id, status, requested_at,
        decided_by, decided_at, decision_note, claim_expires_at, checked_in_at, checked_in_by
      ) values (
        v_row.guest_id, v_row.session_id, p_organization_id, p_event_id,
        coalesce(v_row.status, 'invited'), v_row.requested_at, v_row.decided_by,
        v_row.decided_at, v_row.decision_note, v_row.claim_expires_at,
        v_row.checked_in_at, v_row.checked_in_by
      )
      on conflict (guest_id, session_id) do update set
        status = excluded.status,
        requested_at = excluded.requested_at,
        decided_by = excluded.decided_by,
        decided_at = excluded.decided_at,
        decision_note = excluded.decision_note,
        claim_expires_at = excluded.claim_expires_at,
        -- A check-in made since the plan was read is never undone by it.
        checked_in_at = coalesce(excluded.checked_in_at, event_guest_sessions.checked_in_at),
        checked_in_by = coalesce(excluded.checked_in_by, event_guest_sessions.checked_in_by);
    end loop;

    -- 4. Capacity: no session, and not the event, past its cap with more
    -- people Going than before this plan.
    if not v_force then
      for v_session in
        select id, capacity
          from event_sessions
          where event_id = p_event_id and organization_id = p_organization_id and capacity is not null
      loop
        select count(*) into v_after
          from event_guest_sessions
          where session_id = v_session.id and event_id = p_event_id and status = 'going';
        v_before := coalesce((v_going_before ->> v_session.id::text)::integer, 0);
        if v_after > v_session.capacity and v_after > v_before then
          raise exception 'event_register: capacity' using errcode = 'EV001';
        end if;
      end loop;
      if v_event.capacity is not null then
        select count(distinct guest_id) into v_after
          from event_guest_sessions
          where event_id = p_event_id and organization_id = p_organization_id and status = 'going';
        if v_after > v_event.capacity and v_after > v_event_before then
          raise exception 'event_register: capacity' using errcode = 'EV001';
        end if;
      end if;
    end if;
  exception
    when unique_violation then
      return jsonb_build_object('ok', false, 'reason', 'duplicate_email');
    when sqlstate 'EV001' then
      return jsonb_build_object('ok', false, 'reason', 'capacity');
    when sqlstate 'EV002' then
      return jsonb_build_object('ok', false, 'reason', 'invalid', 'detail', sqlerrm);
    when foreign_key_violation then
      return jsonb_build_object('ok', false, 'reason', 'invalid', 'detail', 'reference');
  end;

  return jsonb_build_object('ok', true);
end;
$$;

comment on function event_register(uuid, uuid, jsonb) is
  'Atomic seat-claiming write for events (D-075): locks the event and its sessions, applies a planned set of guest/status rows, refuses the plan if it would exceed capacity. Server-only (service role).';

-- Server only. Browsers (anon, authenticated) can never call it.
revoke all on function event_register(uuid, uuid, jsonb) from public;
revoke all on function event_register(uuid, uuid, jsonb) from anon, authenticated;
grant execute on function event_register(uuid, uuid, jsonb) to service_role;
