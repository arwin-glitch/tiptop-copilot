# Supabase setup

From an empty project to a working database, in order. Twenty minutes.

You do not need this to try the product — `npm run dev:demo` works with nothing
configured. You need it to hold real data.

---

## 1. Create the project

1. <https://supabase.com/dashboard> → **New project**.
2. Name it (`tiptop-copilot`), set a strong database password, and **store that
   password in your password manager now**. It is shown once.
3. Pick the region closest to where the fund actually works. Every page in this
   product does several round trips; region choice is the single largest lever
   on how fast it feels.
4. Wait for provisioning.

---

## 2. Collect the keys

**Settings → API**:

| Dashboard label | Variable |
| --- | --- |
| Project URL | `NEXT_PUBLIC_SUPABASE_URL` |
| `anon` `public` | `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| `service_role` `secret` | `SUPABASE_SERVICE_ROLE_KEY` |

The anon key is public by design — row-level security is what protects it, which
is why RLS is enabled on every table in this schema without exception.

**The service role key bypasses RLS entirely.** Treat it like a database
password: server-side only, never in a `NEXT_PUBLIC_` variable, never in a
client bundle, never in a screenshot. If it is ever exposed, rotate it in the
dashboard immediately.

---

## 3. Apply the migrations

Eight files in `supabase/migrations/`, applied in filename order.

### With the Supabase CLI (recommended)

```bash
npx supabase link --project-ref <your-project-ref>
npx supabase db push
```

The project ref is in your dashboard URL.

### Without the CLI

Open **SQL Editor** in the dashboard and run each file's contents in order:

```
20260101000000_extensions_and_helpers.sql
20260101000100_core_tables.sql
20260101000200_email_and_calendar.sql
20260101000300_deals.sql
20260101000400_portfolio_knowledge_thesis.sql
20260101000500_briefs_chat_ops.sql
20260101000600_row_level_security.sql
20260101000700_storage_and_bootstrap.sql
```

Order matters — later files reference objects created earlier. Every statement is
idempotent (`create ... if not exists`), so a re-run is safe.

What they create:

| File | Contents |
| --- | --- |
| `…000000` | `pgcrypto`, `pg_trgm`, `set_updated_at()`, `is_org_member()`, `has_org_role()` |
| `…000100` | Organizations, profiles, membership, integrations, encrypted tokens, sync runs |
| `…000200` | Threads, messages, participants, attachments, calendar events |
| `…000300` | Deals, people, sources, facts, analyses, decisions, notes, tasks |
| `…000400` | Portfolio, knowledge, network contacts, thesis versions and criteria |
| `…000500` | Daily briefs, chat, drafts, AI usage, audit events, feedback |
| `…000600` | Row-level security on every table |
| `…000700` | The private storage bucket and its policies |

---

## 4. Verify

In the SQL editor:

```sql
-- 34 tables
select count(*) from information_schema.tables
where table_schema = 'public';

-- RLS on every one of them: expect zero rows
select tablename from pg_tables
where schemaname = 'public' and rowsecurity = false;

-- The two constraints that carry product invariants
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conname like '%actor%' or conname like '%sent%';
```

The last query must show `check (actor = 'human')` on `deal_decisions` and
`check (sent = false)` on `generated_drafts`. If either is missing, migration
`…000300` or `…000500` did not fully apply — stop and re-run it. Those two
constraints are the database-level guarantees behind "the AI cannot mark a deal
invested" and "there is no send capability".

---

## 5. Storage

Migration `…000700` creates the `deal-attachments` bucket, **private**, with
policies keyed on the organization prefix of the object path.

Confirm under **Storage** that the bucket exists and is not public. If it is
public, make it private before storing anything — attachments are pitch decks
and financial models.

Files are served through short-lived signed URLs generated server-side with the
service role key. There are no public object links anywhere in the product.

---

## 6. Authentication

**Authentication → Providers → Google**: enable it, and supply the same OAuth
client you create in [GOOGLE_OAUTH_SETUP.md](GOOGLE_OAUTH_SETUP.md).

**Authentication → URL Configuration**:
- Site URL: your `APP_URL`
- Redirect URLs: `${APP_URL}/**`

The app's own callback is `${APP_URL}/api/auth/callback`, which `${APP_URL}/**`
covers. Sign-in is served by `/api/auth/google`; the Gmail and Calendar
integration is a separate consent at `/api/integrations/google/callback`.

Since this is an internal tool for one organization, restrict who can sign in.
Do it in **both** places, because they fail differently:

- **`AUTH_ALLOWED_EMAIL_DOMAINS=tiptop.vc`** in the app. The callback rejects
  anything else and signs the session straight back out.
- **Supabase dashboard** — turn off public signups, or add a domain
  restriction. This stops an unwanted `auth.users` row being created at all.

Do this **before** the first real deployment, not after. See §7 for why.

---

## 7. The first organization creates itself

**Do not insert an organization by hand.** Migration
`20260101000700_storage_and_bootstrap.sql` installs an `on_auth_user_created`
trigger that, for every new user with no membership, creates a profile, an
organization named from the email domain, an `owner` membership and the default
thesis.

So the first `@tiptop.vc` sign-in produces an organization with the slug
`tiptop-vc` on its own. An earlier version of this document told you to insert
that row manually; doing so now fails with a duplicate-key error on
`organizations.slug`, because the trigger got there first.

Two consequences worth understanding:

1. **Whoever signs in first becomes the owner.** Make sure that is Nick, or
   whoever should hold it.
2. **Every subsequent new user gets their *own* organization**, not membership
   of yours — the trigger only skips users who already have a membership. To
   add someone to an existing organization, insert their `organization_members`
   row before they first sign in, or move them afterwards:

```sql
-- Find them, then attach them to the right organization.
select id, email from auth.users order by created_at desc limit 10;

insert into organization_members (organization_id, user_id, role)
values ('<organization-id>', '<their-user-id>', 'member')
on conflict do nothing;
```

Without a membership row a user authenticates successfully and then sees
nothing, because every read is scoped through `organization_members`. That is
the isolation working, not a bug.

---

## 8. Configure the app

```bash
NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
SUPABASE_SERVICE_ROLE_KEY=<service role key>
SUPABASE_STORAGE_BUCKET=deal-attachments
```

Then `npm run dev` and open `/diagnostics`. Supabase and the service role key
should both read **ready**.

---

## 9. Backups

Supabase takes daily backups on paid plans. Free-tier projects have no
point-in-time recovery, and a fund's deal history is not something to hold on a
free tier. Before storing anything real:

- Move to a plan with PITR.
- Take a manual backup before applying any future migration.
- Test a restore once, so you know the procedure works before you need it.

---

## Troubleshooting

**"relation does not exist"** — a migration did not apply. Re-run them in order;
they are idempotent.

**Authenticated but every screen is empty** — no `organization_members` row for
your user. See step 7.

**"new row violates row-level security policy"** — the caller has no membership,
or is a `viewer` attempting a write. Check the role in
`organization_members`.

**Storage upload fails** — the bucket is missing or the service role key is not
set. Check `/diagnostics`.

**Slow pages** — check the project region against where you actually work.
