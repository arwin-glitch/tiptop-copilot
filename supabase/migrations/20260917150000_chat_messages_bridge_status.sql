-- The Ask bridge lets a question typed on the Ask page be answered by an
-- external Claude session with live Gmail/Calendar/Slack access, instead of
-- only the in-app Anthropic call (which has no access to unsynced live data
-- and is unconfigured in this deployment).
--
-- An assistant row is inserted with status 'pending' the moment a question is
-- asked; the bridge (a token-authenticated webhook, see
-- src/app/api/integrations/ask-bridge/webhook/route.ts) fills in its content
-- and flips it to 'answered' once a real answer is ready. Every row inserted
-- before this migration — and every user-role row going forward — defaults to
-- 'answered', which is simply true: nothing about them is waiting on anything.

alter table chat_messages
  add column status text not null default 'answered' check (status in ('pending', 'answered'));
