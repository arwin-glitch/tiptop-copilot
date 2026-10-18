-- Desktop app sign-in hand-offs.
--
-- Google refuses to sign anyone in inside an app's own window, so the desktop
-- app (a window onto this site) signs in through the system browser instead:
-- the app asks the server for a Google sign-in URL, the browser signs in and
-- lands on /desktop/callback, which shows a short code, and the person types
-- that code into the app. The app then finishes the sign-in itself, so the
-- session lives in the app's window. lib/auth/desktop-handoff.ts has the
-- whole flow and why the code travels from the browser to the app.
--
-- Hashes only for the secrets: the hand-off id (in the browser's URL) and the
-- app's poll secret (an httpOnly cookie in the app) are stored as SHA-256.
-- Google's authorization code is sealed with APP_ENCRYPTION_KEY, bound to the
-- row id, and cleared the moment the app claims it. The short code is stored
-- as it is: it is shown once, works only together with the app's poll cookie,
-- and three wrong tries end the hand-off.
--
-- A row expires 10 minutes after it is created and is deleted a day later by
-- the start route itself, so the table stays small with no scheduled job.
--
-- There is no organization_id: a hand-off happens before anyone is signed in,
-- so it belongs to no tenant, and the table is listed as scopeless in
-- lib/db/store.ts.
--
-- Additive and idempotent like every migration here; safe to run again in the
-- SQL editor. Until it is applied the web app is unaffected, and Sign in in
-- the desktop app says it is not available right now.

create table if not exists desktop_handoffs (
  id uuid primary key default gen_random_uuid(),
  -- Hex SHA-256 of the hand-off id and of the app's poll secret.
  handoff_hash text not null check (handoff_hash ~ '^[0-9a-f]{64}$'),
  poll_secret_hash text not null check (poll_secret_hash ~ '^[0-9a-f]{64}$'),
  -- Minted when the browser receives Google's code, never before, so the
  -- start of a hand-off cannot reveal it.
  match_code text check (match_code is null or match_code ~ '^[2-9A-HJKMNP-Z]{4}$'),
  attempts smallint not null default 0 check (attempts between 0 and 3),
  -- Supabase's PKCE flow id, so the exchange finds this flow's verifier.
  flow_id text check (flow_id is null or char_length(flow_id) between 1 and 128),
  platform text not null default 'other' check (platform in ('mac', 'windows', 'other')),
  status text not null default 'pending'
    check (status in ('pending', 'code_received', 'claimed', 'signed_in', 'failed')),
  failure_reason text check (failure_reason is null or failure_reason in
    ('cancelled', 'no_code', 'wrong_code', 'rejected', 'superseded', 'exchange', 'domain')),
  -- AES-256-GCM output of lib/security/crypto.ts sealToken; null except
  -- between code_received and claimed.
  auth_code_sealed jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  code_received_at timestamptz,
  consumed_at timestamptz,
  unique (handoff_hash),
  unique (poll_secret_hash)
);

create index if not exists desktop_handoffs_expires_idx on desktop_handoffs (expires_at);

-- ------------------------------------------------------------------- RLS --
--
-- No policies on purpose: browser roles can neither read nor write a row;
-- only the server, under the service role, touches this table.

alter table desktop_handoffs enable row level security;

comment on table desktop_handoffs is
  'Desktop app sign-in hand-offs: hashes and a sealed, short-lived code only. Server only.';

-- No explicit grants: service_role inherits via the default privileges set in
-- 20260101000600, and browser roles deliberately query nothing directly.
