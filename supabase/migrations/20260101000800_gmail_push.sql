-- Gmail push notifications.
--
-- Gmail delivers change notifications through Cloud Pub/Sub rather than calling
-- an application directly, and a `users.watch` registration expires after seven
-- days. Both facts need somewhere to live.
--
-- The history cursor itself is not new: `integrations.sync_cursor` already
-- holds it, and GmailProvider.listViaHistory already syncs incrementally from
-- it. Push only changes *when* that runs, not how.

alter table integrations
  add column if not exists watch_expires_at timestamptz;

comment on column integrations.watch_expires_at is
  'When the Gmail users.watch registration lapses. Renewed by the daily job; a null means push is not registered and the mailbox is polled instead.';

-- Finding the integration a Pub/Sub notification belongs to: the payload
-- carries an email address and nothing else, so this is the lookup path.
create index if not exists integrations_account_email_idx
  on integrations (account_email)
  where account_email is not null;
