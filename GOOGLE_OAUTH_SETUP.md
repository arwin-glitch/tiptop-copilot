# Google OAuth setup

Read-only Gmail and Calendar access. Fifteen minutes, plus verification time if
you publish the consent screen.

Not required to try the product — `npm run dev:demo` runs Inbox and Calendar on
fixtures.

---

## What is requested, and what is not

```
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/calendar.readonly
https://www.googleapis.com/auth/userinfo.email
```

That is the complete list, fixed in `src/lib/google/oauth.ts`.

**`gmail.send` is not requested and cannot be added through configuration.**
There is no send function in the codebase, `generated_drafts.sent` carries a
database check constraint pinning it to false, and a test asserts that no write
scope appears anywhere in the source. This product drafts email; the partner
sends it from their own client.

`gmail.readonly` is a **restricted** scope in Google's classification. That has
consequences for verification — see §6.

---

## 1. Create the project

1. <https://console.cloud.google.com> → new project, e.g. `TipTop Copilot`.
2. **APIs & Services → Library**, enable:
   - Gmail API
   - Google Calendar API
   - People API (for the account email on the consent screen)

---

## 2. Configure the consent screen

**APIs & Services → OAuth consent screen**.

- **User type: Internal**, if TipTop uses Google Workspace. This is the right
  answer: internal apps skip Google's verification review entirely, and only
  members of your Workspace can grant access. Choose External only if the fund
  is not on Workspace.
- App name: `TipTop Copilot`
- Support email and developer contact: a real monitored address
- Authorised domain: your Workspace domain
- Privacy policy URL: `${APP_URL}/privacy` — the product ships this page, and
  Google requires it for restricted scopes

Add the three scopes above. Add nothing else. Google's review — if you need one —
scales with what you ask for, and every extra scope is a question you will have
to answer.

---

## 3. Create the OAuth client

**APIs & Services → Credentials → Create credentials → OAuth client ID**.

- Application type: **Web application**
- Name: `TipTop Copilot Web`
- Authorised JavaScript origins:
  ```
  http://localhost:3000
  https://your-production-domain
  ```
- Authorised redirect URIs:
  ```
  http://localhost:3000/api/integrations/google/callback
  https://your-production-domain/api/integrations/google/callback
  ```

The redirect URI must match **character for character** — scheme, host, port,
path, and no trailing slash. A mismatch produces `redirect_uri_mismatch`, and it
is by a wide margin the most common failure in this setup.

Copy the client ID and secret.

---

## 4. Configure the app

```bash
GOOGLE_CLIENT_ID=<client id>
GOOGLE_CLIENT_SECRET=<client secret>
APP_URL=http://localhost:3000
# Only if the redirect must differ from ${APP_URL}/api/integrations/google/callback:
# GOOGLE_REDIRECT_URI=
```

`APP_ENCRYPTION_KEY` must also be set — tokens are encrypted before storage and
the connection will refuse to complete without it.

Open `/diagnostics`. Google should read **ready**, and the redirect URI shown
there should exactly match what you entered in the console. Compare them
visually; this is the cheapest place to catch the mismatch.

---

## 5. Connect

1. `npm run dev`, sign in, go to **Settings → Integrations**.
2. **Connect Google Workspace.**
3. Google will show the three read-only scopes. Grant them.
4. You are returned to Settings, connected.
5. Open **Inbox → Sync**.

The first sync fetches metadata for the lookback window
(`DEFAULT_LOOKBACK_DAYS`, 14 by default). Full bodies arrive when you open a
message or when the classifier judges one consequential.

---

## 6. Verification (External only)

If you chose **Internal**, skip this section entirely.

An External app requesting `gmail.readonly` needs Google's verification, which
means:

- A demonstration video of the OAuth flow and how the data is used
- A published privacy policy (the `/privacy` page)
- A security assessment by an approved third-party assessor for restricted
  scopes — this is expensive and takes weeks
- Domain ownership verification

Unverified External apps are capped at 100 users and show an "unverified app"
warning.

**For a single fund on Google Workspace, Internal is the correct choice.** It
avoids all of the above and is a tighter security posture besides.

---

## 7. Disconnecting

**Settings → Integrations → Disconnect** does two things:

1. Calls Google's revoke endpoint (best effort).
2. Deletes the stored tokens locally — **always**, whether or not Google
   answered.

If the revoke call fails, the status detail tells you to finish the job at
<https://myaccount.google.com/permissions>. The local deletion is the part this
product controls and it happens unconditionally; a network failure never leaves
a token sitting in the database.

Disconnecting does **not** delete synced mail. **Delete my data** does that
separately, removing every message, thread and attachment for the organization
and resetting the sync cursor. Deals, portfolio, knowledge and tasks are
untouched.

---

## Troubleshooting

**`redirect_uri_mismatch`** — the URI in the console differs from what the app
sent. Compare `/diagnostics` against the console character by character. Watch
for `http` vs `https`, a trailing slash, and `localhost` vs `127.0.0.1`.

**`access_denied`** — consent was declined, or an External app is being used by
someone outside the test-user list.

**"Provider token could not be decrypted. Reconnect the account."** —
`APP_ENCRYPTION_KEY` changed since the token was stored. Reconnect; there is no
recovery path by design.

**Integration shows `needs_reauth`** — the refresh token was revoked or expired,
usually because access was removed at Google. Reconnect.

**Sync returns nothing** — check the lookback window. `DEFAULT_LOOKBACK_DAYS=14`
means older mail is not fetched.

**"This app is blocked"** — a Workspace admin has restricted third-party API
access. An admin needs to allow the client ID under Security → API controls.
