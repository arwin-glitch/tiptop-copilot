# Publish checklist

Everything between the current state of this repository and a live deployment
holding real fund data.

Work top to bottom. Nothing here needs further code — it is configuration,
credentials and verification.

---

## 0. Credentials someone has to supply

None of these can be generated from inside the repository. Collect them first;
everything else waits on them.

| # | What | Where it comes from | Blocks |
| --- | --- | --- | --- |
| 1 | Supabase project URL, anon key, service role key | A new Supabase project | The whole app |
| 2 | `ANTHROPIC_API_KEY` | console.anthropic.com | Real analysis |
| 3 | Google OAuth client ID and secret | Google Cloud Console | Inbox and Calendar |
| 4 | A production domain | Wherever DNS lives | OAuth redirects, cookies |
| 5 | A hosting account | Vercel or equivalent | Deployment |

Generate these yourself:

```bash
# SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"

# APP_ENCRYPTION_KEY — must decode to exactly 32 bytes
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# CRON_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Store all three in a password manager before pasting them anywhere. Losing
`APP_ENCRYPTION_KEY` means every Google connection has to be re-established.

---

## 1. Database

- [ ] Supabase project created, in the region closest to where the fund works
- [ ] Database password stored in a password manager
- [ ] All eight migrations applied in filename order
- [ ] `select count(*) from information_schema.tables where table_schema='public'`
      returns 34
- [ ] `select tablename from pg_tables where schemaname='public' and rowsecurity=false`
      returns **zero rows**
- [ ] `deal_decisions` has `check (actor = 'human')`
- [ ] `generated_drafts` has `check (sent = false)`
- [ ] `deal-attachments` bucket exists and is **private**
- [ ] Plan with point-in-time recovery — a fund's deal history does not belong
      on a free tier
- [ ] A restore tested once, before it is needed

Details: [SUPABASE_SETUP.md](SUPABASE_SETUP.md).

---

## 2. Authentication

- [ ] Google provider enabled in Supabase Auth
- [ ] Site URL and redirect URLs set to the production domain
- [ ] **Public signups disabled**, or the domain restricted — do this before the
      first real deployment, not after
- [ ] First organization row created
- [ ] `organization_members` row created for each real user with the right role

Without a membership row a user authenticates and then sees nothing. That is the
isolation working.

---

## 3. Google Workspace

- [ ] OAuth consent screen configured as **Internal** (correct for a single
      Workspace fund; External requires a security assessment for
      `gmail.readonly`)
- [ ] Only three scopes requested: `gmail.readonly`, `calendar.readonly`,
      `userinfo.email`
- [ ] Privacy policy URL points at `${APP_URL}/privacy`
- [ ] Redirect URI matches `${APP_URL}/api/integrations/google/callback`
      character for character
- [ ] Client ID and secret in the deployment environment

Details: [GOOGLE_OAUTH_SETUP.md](GOOGLE_OAUTH_SETUP.md).

---

## 4. Environment

- [ ] Every variable from [.env.example](.env.example) reviewed
- [ ] **`DEMO_MODE` is false or unset** ← verify this twice
- [ ] `NEXT_PUBLIC_DEMO_MODE` is false or unset
- [ ] `APP_URL` is the production origin, with `https`
- [ ] `SESSION_SECRET` set, at least 32 characters
- [ ] `APP_ENCRYPTION_KEY` set and decodes to exactly 32 bytes
- [ ] `SUPABASE_SERVICE_ROLE_KEY` set **server-side only**, never as
      `NEXT_PUBLIC_`
- [ ] `DAILY_AI_BUDGET_USD` set to a number you are comfortable seeing spent in
      one day
- [ ] `CRON_SECRET` set if scheduled jobs are wanted, omitted otherwise (the
      endpoint then rejects everyone, which is the safe default)

Demo mode left on in production means anyone who reaches the URL gets a
workspace. It is the single most consequential line in the file.

---

## 5. Verification before deploying

```bash
npm ci
npm run verify        # format + lint + typecheck + 423 tests + build
npm run test:e2e      # 38 end-to-end tests
```

- [ ] `npm run verify` passes
- [ ] `npm run test:e2e` passes
- [ ] `npm audit` reviewed, high and critical findings resolved or accepted in
      writing
- [ ] Built bundle searched for secrets:
      `grep -r "SUPABASE_SERVICE_ROLE\|ANTHROPIC_API_KEY\|sk-ant" .next/static/`
      returns nothing

---

## 6. Deploy

- [ ] Environment variables set in the hosting provider — not committed
- [ ] Production domain attached, HTTPS enforced
- [ ] Deployed
- [ ] `/api/health` returns healthy
- [ ] `/diagnostics` shows **ready** for mode, session, encryption, Supabase,
      service role and Anthropic
- [ ] `/diagnostics` shows no secret values anywhere on the page

---

## 7. First real use

- [ ] Sign in with a real Google account
- [ ] Connect Google Workspace; confirm the consent screen lists only the three
      read-only scopes
- [ ] Run a sync; confirm messages appear with sensible categories
- [ ] Open one message; confirm the body arrives only then
- [ ] Turn a real inbound pitch into a deal; check every extracted field against
      the email — **anything the email did not say must be blank**
- [ ] Run an analysis; open the source drawer and verify each citation resolves
      to the record it claims
- [ ] Set the thesis, scoring weights and thresholds in Settings
- [ ] Set check size, ownership target, geography and required traction — these
      ship empty on purpose and are excluded from scoring until set
- [ ] Generate a draft; confirm it is labelled not sent and offers only a copy
      action
- [ ] Record one decision; confirm it appears in the history with your name

---

## 8. Scheduled jobs (optional)

- [ ] `CRON_SECRET` set
- [ ] A scheduler configured to `POST /api/cron/daily` with
      `Authorization: Bearer ${CRON_SECRET}`
- [ ] One manual invocation verified before relying on the schedule

---

## 9. Operations

- [ ] Someone owns this. Name them.
- [ ] AI spend monitored in the Anthropic console for the first fortnight;
      adjust `DAILY_AI_BUDGET_USD` from what you observe rather than from a
      guess
- [ ] A quarterly reminder to review `audit_events` for anything unexpected
- [ ] Key rotation understood: `SESSION_SECRET` signs everyone out;
      `APP_ENCRYPTION_KEY` requires everyone to reconnect Google

---

## 10. What has deliberately not been done

State these to whoever is accepting the deployment, so nobody discovers them
later:

- **No CI pipeline.** The full suite runs locally with one command; nothing runs
  automatically on push.
- **No penetration test.**
- **No load testing.** The design target is a handful of users at a single fund.
- **No automatic data deletion.** Retention is manual.
- **No secret scanning** in a pre-commit hook.
- **Prompt injection is mitigated, not solved.** The fence is a strong control
  and the blast radius is deliberately small — no send, no decision, no
  cross-organization read — but no prompt-level defence is total. See
  [SECURITY.md](SECURITY.md) §10.

---

## Rolling back

The build is stateless; redeploy the previous version.

Migrations are additive and idempotent, so an older build runs against a newer
schema. If a migration must be reversed, restore from the backup taken before it
was applied — which is why step 1 asks for one.
