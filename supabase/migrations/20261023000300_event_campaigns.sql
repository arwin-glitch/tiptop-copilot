-- Event messages: which event a campaign draft was made from (D-075).
--
-- Every email to an event's guests is an ordinary campaign draft that a
-- person reviews and confirms (20261016000000_campaigns.sql). Nothing here
-- sends, schedules or confirms anything. These three columns only remember
-- where a draft came from, so the event's Messages tab can list its drafts
-- and sends, the "Needs notifying" queue can tell which status changes a
-- sent notice covered, and reminders know which session and offset they are.
--
--   - event_id    the event (events.id). Set null if the event is deleted:
--                 the campaign and its report stay.
--   - event_kind  invite, reminder, notice, update, cancellation, blast or
--                 nudge.
--   - event_meta  what the draft was built from: the audience, the session,
--                 a reminder's offset, a notice's (guest, session, status)
--                 items, the schedule version an update announced.
--
-- The personal RSVP link itself lives in campaign_recipients.merge
-- (merge.rsvp_link), written only by the server when it adds a guest from
-- the event; no column is needed for it.
--
-- Additive and idempotent like every migration here: safe to run again in
-- the SQL editor. Apply after 20261023000000_events.sql (the foreign key).
-- Until it is applied, the rest of Campaigns works exactly as before and the
-- Messages tab says event messages are not set up yet.

alter table campaigns add column if not exists event_id uuid references events(id) on delete set null;
alter table campaigns add column if not exists event_kind text;
alter table campaigns add column if not exists event_meta jsonb not null default '{}'::jsonb;

alter table campaigns drop constraint if exists campaigns_event_kind_check;
alter table campaigns add constraint campaigns_event_kind_check
  check (
    event_kind is null
    or event_kind in ('invite', 'reminder', 'notice', 'update', 'cancellation', 'blast', 'nudge')
  );
alter table campaigns drop constraint if exists campaigns_event_meta_check;
alter table campaigns add constraint campaigns_event_meta_check
  check (jsonb_typeof(event_meta) = 'object');

create index if not exists campaigns_event_idx
  on campaigns (organization_id, event_id, created_at)
  where event_id is not null;

comment on column campaigns.event_id is
  'The event this draft was made from (Events -> Messages, D-075). Null for every other campaign.';
comment on column campaigns.event_kind is
  'invite | reminder | notice | update | cancellation | blast | nudge. Null unless event_id is set.';
comment on column campaigns.event_meta is
  'What the event draft was built from: audience, session, reminder offset, notice items. Read by lib/services/event-comms.ts only.';
